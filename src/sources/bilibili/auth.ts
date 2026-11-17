// Bilibili login cookie (SESSDATA): config → BILI_SESSDATA → saved file → local browsers (via yt-dlp) → QR login.

import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Config } from "../../config/config.ts";
import { configDir } from "../../config/paths.ts";
import { WsError } from "../../core/errors.ts";
import type { Logger } from "../../core/types.ts";
import { sleep } from "../../utils/async.ts";
import { readJson, writeJson } from "../../utils/fs.ts";
import { BROWSER_UA, createHttp } from "../../utils/http.ts";
import { run } from "../../utils/process.ts";

const PASSPORT = "https://passport.bilibili.com/x/passport-login/web/qrcode";
const BROWSERS = ["chrome", "edge", "safari", "brave", "firefox", "opera", "vivaldi"];
export const cookieFile = () => path.join(configDir(), "bilibili-cookie.json");

/** Netscape cookie file so yt-dlp can use the same login. Returns yt-dlp arguments (empty without a login). */
export async function ytdlpCookieArgs(sessdata: string | undefined): Promise<string[]> {
  if (!sessdata) return [];
  const file = path.join(configDir(), "bilibili-cookies.txt");
  await fsp.mkdir(configDir(), { recursive: true });
  await fsp.writeFile(file, `# Netscape HTTP Cookie File\n.bilibili.com\tTRUE\t/\tFALSE\t0\tSESSDATA\t${sessdata}\n`, {
    mode: 0o600,
  });
  return ["--cookies", file];
}

export async function savedSessdata(cfg: Config): Promise<string | undefined> {
  return (
    cfg.bilibili?.sessdata ||
    process.env.BILI_SESSDATA ||
    (await readJson<{ sessdata?: string }>(cookieFile()))?.sessdata ||
    undefined
  );
}

async function save(sessdata: string, source: string): Promise<void> {
  await writeJson(cookieFile(), { sessdata, source, updatedAt: new Date().toISOString() }, { mode: 0o600 });
}

/** Ask Bilibili whether a SESSDATA is still a live login (stale browser cookies are common). */
export async function isLoggedIn(sessdata: string): Promise<boolean> {
  try {
    const r = await createHttp().request("https://api.bilibili.com/x/web-interface/nav", {
      headers: { "user-agent": BROWSER_UA, cookie: `SESSDATA=${sessdata}`, referer: "https://www.bilibili.com" },
      retries: 1,
    });
    return !!r.data?.data?.isLogin;
  } catch {
    return false;
  }
}

/** Read a logged-in SESSDATA from local browsers using yt-dlp's cookie extraction. */
export async function syncFromBrowsers(ytDlp: string, log: Logger): Promise<string | undefined> {
  const tmp = path.join(os.tmpdir(), `wavescribe-bili-${process.pid}.txt`);
  try {
    for (const browser of BROWSERS) {
      await run(
        ytDlp,
        ["--cookies-from-browser", browser, "--cookies", tmp, "--skip-download", "https://www.bilibili.com"],
        { timeoutMs: 60_000 },
      ).catch(() => undefined);
      const content = await fsp.readFile(tmp, "utf8").catch(() => "");
      const m = /\.bilibili\.com\s+(?:TRUE|FALSE)\s+\/\s+(?:TRUE|FALSE)\s+\d+\s+SESSDATA\s+(\S+)/.exec(content);
      if (m) {
        const sessdata = decodeURIComponent(m[1]!);
        if (!(await isLoggedIn(sessdata))) {
          log.debug(`Bilibili cookie in ${browser} is no longer logged in`);
          continue;
        }
        await save(sessdata, browser);
        log.info(`Found a Bilibili login in ${browser}`);
        return sessdata;
      }
    }
    return undefined;
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

/** Open a URL in the default browser without going through a shell. */
function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true })
    .on("error", () => {})
    .unref();
}

/** QR-code login in the default browser; waits up to 3 minutes for the Bilibili app to confirm. */
export async function qrLogin(log: Logger): Promise<string> {
  const http = createHttp(log);
  const headers = { "user-agent": BROWSER_UA };
  const gen = (await http.request(`${PASSPORT}/generate`, { headers })).data;
  if (gen?.code !== 0) throw new WsError("PROVIDER_ERROR", `Could not create a login QR code: ${gen?.message}`);
  log.info(`Opening the Bilibili QR login page: ${gen.data.url}`);
  openUrl(gen.data.url);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const res = await http.request(`${PASSPORT}/poll`, { query: { qrcode_key: gen.data.qrcode_key }, headers });
    const j = res.data;
    const code = j?.data?.code;
    if (code === 0) {
      let sessdata = "";
      try {
        sessdata = new URL(j.data.url).searchParams.get("SESSDATA") ?? "";
      } catch {
        /* use cookies */
      }
      if (!sessdata)
        for (const c of res.headers.getSetCookie?.() ?? []) sessdata ||= /SESSDATA=([^;]+)/.exec(c)?.[1] ?? "";
      if (!sessdata) throw new WsError("LOGIN_REQUIRED", "Logged in, but no SESSDATA cookie was returned");
      await save(sessdata, "qrcode");
      return sessdata;
    }
    if (code === 86038) throw new WsError("EXPIRED", "The QR code expired; run the login again");
  }
  throw new WsError("TIMEOUT", "Login timed out after 3 minutes");
}
