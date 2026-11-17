// Read the `sp_dc` cookie of a logged-in open.spotify.com session straight out of local browsers:
// Chromium-family cookie DBs (decrypted with the OS key) and Firefox. Ported from Textcast's
// base-spotify-transcript. Needs the `sqlite3` command; on macOS the keychain may ask once.

import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../core/types.ts";
import { run } from "../../utils/process.ts";

interface ChromiumBrowser {
  name: string;
  keychain: string;
  darwin?: string[];
  linux?: string[];
  win32?: string[];
}

export const CHROMIUM_BROWSERS: ChromiumBrowser[] = [
  {
    name: "ego lite",
    keychain: "ego safe storage",
    darwin: ["~/Library/Application Support/Citro Labs/ego lite"],
    linux: ["~/.config/ego-lite"],
    win32: ["%APPDATA%\\ego lite"],
  },
  {
    name: "chrome",
    keychain: "Chrome Safe Storage",
    darwin: ["~/Library/Application Support/Google/Chrome"],
    linux: ["~/.config/google-chrome"],
    win32: ["%LOCALAPPDATA%\\Google\\Chrome\\User Data"],
  },
  {
    name: "chromium",
    keychain: "Chromium Safe Storage",
    darwin: ["~/Library/Application Support/Chromium"],
    linux: ["~/.config/chromium"],
  },
  {
    name: "edge",
    keychain: "Microsoft Edge Safe Storage",
    darwin: ["~/Library/Application Support/Microsoft Edge"],
    linux: ["~/.config/microsoft-edge"],
    win32: ["%LOCALAPPDATA%\\Microsoft\\Edge\\User Data"],
  },
  {
    name: "brave",
    keychain: "Brave Safe Storage",
    darwin: ["~/Library/Application Support/BraveSoftware/Brave-Browser"],
    linux: ["~/.config/BraveSoftware/Brave-Browser"],
    win32: ["%LOCALAPPDATA%\\BraveSoftware\\Brave-Browser\\User Data"],
  },
  {
    name: "vivaldi",
    keychain: "Vivaldi Safe Storage",
    darwin: ["~/Library/Application Support/Vivaldi"],
    linux: ["~/.config/vivaldi"],
    win32: ["%LOCALAPPDATA%\\Vivaldi\\User Data"],
  },
  { name: "arc", keychain: "Arc Safe Storage", darwin: ["~/Library/Application Support/Arc/User Data"] },
  {
    name: "opera",
    keychain: "Opera Safe Storage",
    darwin: ["~/Library/Application Support/com.operasoftware.Opera"],
    linux: ["~/.config/opera"],
    win32: ["%APPDATA%\\Opera Software\\Opera Stable"],
  },
];

const FIREFOX_ROOTS: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["~/Library/Application Support/Firefox"],
  linux: ["~/.mozilla/firefox", "~/snap/firefox/common/.mozilla/firefox"],
  win32: ["%APPDATA%\\Mozilla\\Firefox"],
};

const CHROME_EPOCH_OFFSET_MS = 11644473600000; // microseconds since 1601 → unix ms

export interface CookieHit {
  spDc: string;
  source: string;
}

const expand = (p: string) =>
  p.replace(/^~/, os.homedir()).replace(/%([^%]+)%/g, (_, v: string) => process.env[v] || "");

const exists = (p: string) =>
  fsp.access(p).then(
    () => true,
    () => false,
  );

async function sqlite(dbPath: string, query: string): Promise<string> {
  const attempt = async (file: string) => {
    const r = await run("sqlite3", ["-readonly", "-cmd", ".timeout 2000", file, query], { timeoutMs: 30_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || `sqlite3 exited with ${r.code}`);
    return r.stdout;
  };
  try {
    return await attempt(dbPath);
  } catch {
    // Chrome keeps the cookie DB in WAL mode and may hold it open: read a copy instead.
    const tmp = path.join(os.tmpdir(), `wavescribe-cookies-${process.pid}-${Date.now()}.sqlite`);
    try {
      await fsp.copyFile(dbPath, tmp);
      for (const suffix of ["-wal", "-shm"])
        await fsp.copyFile(`${dbPath}${suffix}`, `${tmp}${suffix}`).catch(() => {});
      return await attempt(tmp);
    } finally {
      for (const suffix of ["", "-wal", "-shm"]) await fsp.rm(`${tmp}${suffix}`, { force: true });
    }
  }
}

const keychainCache = new Map<string, string | null>();

async function macKeychainSecret(service: string): Promise<string | null> {
  if (keychainCache.has(service)) return keychainCache.get(service) ?? null;
  const r = await run("security", ["find-generic-password", "-w", "-s", service], { timeoutMs: 15_000 }).catch(
    () => undefined,
  );
  const secret = r?.code === 0 ? r.stdout.replace(/\n$/, "") || null : null;
  keychainCache.set(service, secret);
  return secret;
}

async function chromiumKey(browser: ChromiumBrowser): Promise<Buffer | null> {
  if (process.platform === "darwin") {
    const password = await macKeychainSecret(browser.keychain);
    return password ? crypto.pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1") : null;
  }
  // Chromium on Linux uses a hard-coded placeholder password ("peanuts").
  if (process.platform === "linux") return crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");
  return null; // Windows uses DPAPI / AES-GCM: not supported, pass the cookie by hand
}

export function decryptChromiumValue(encrypted: Buffer, key: Buffer | null, hostKey: string): string {
  if (encrypted.length === 0) return "";
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix !== "v10" && prefix !== "v11") return encrypted.toString("utf8");
  if (!key) return "";
  const decipher = crypto.createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, " "));
  let plain: Buffer;
  try {
    plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  } catch {
    return "";
  }
  // DB schema v24+ stores SHA256(host_key) in front of the value.
  const digest = crypto.createHash("sha256").update(hostKey).digest();
  if (plain.length > 32 && plain.subarray(0, 32).equals(digest)) plain = plain.subarray(32);
  return plain.toString("utf8");
}

async function chromiumCookieDb(profileDir: string): Promise<string | undefined> {
  for (const candidate of [path.join(profileDir, "Network", "Cookies"), path.join(profileDir, "Cookies")]) {
    if (await exists(candidate)) return candidate;
  }
  return undefined;
}

async function fromChromium(browser: ChromiumBrowser, log: Logger): Promise<CookieHit | undefined> {
  const nowUtc = (Date.now() + CHROME_EPOCH_OFFSET_MS) * 1000;
  let sawCookie = false;
  for (const root of (browser[process.platform as "darwin" | "linux" | "win32"] ?? []).map(expand)) {
    if (!(await exists(root))) continue;
    const key = await chromiumKey(browser);
    const profiles = ["Default", ...Array.from({ length: 8 }, (_, i) => `Profile ${i + 1}`)];
    for (const profile of profiles) {
      const db = await chromiumCookieDb(path.join(root, profile));
      if (!db) continue;
      let rows: string;
      try {
        rows = await sqlite(
          db,
          "select host_key, name, hex(encrypted_value), value, expires_utc from cookies where name='sp_dc';",
        );
      } catch {
        continue;
      }
      for (const line of rows.split("\n")) {
        if (!line.trim()) continue;
        const [hostKey = "", , hexValue, plainValue, expiresUtc] = line.split("|");
        if (Number(expiresUtc) > 0 && Number(expiresUtc) < nowUtc) continue;
        sawCookie = true;
        const value = hexValue ? decryptChromiumValue(Buffer.from(hexValue, "hex"), key, hostKey) : plainValue;
        if (value) return { spDc: value, source: `${browser.name} (${profile})` };
      }
    }
  }
  if (sawCookie) {
    log.warn(
      `Found a Spotify cookie in ${browser.name} but could not decrypt it ` +
        (process.platform === "darwin"
          ? "(keychain access denied? allow the prompt, then run again)"
          : "(not supported on this OS; pass it with `wavescribe login spotify --cookie <sp_dc>`)"),
    );
  }
  return undefined;
}

async function fromFirefox(): Promise<CookieHit | undefined> {
  for (const root of (FIREFOX_ROOTS[process.platform] ?? []).map(expand)) {
    if (!(await exists(root))) continue;
    const dbs: string[] = [];
    for (const d of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!d.isDirectory()) continue;
      // Firefox keeps profiles under Profiles/<random>.default-release on some installs.
      if (d.name === "Profiles") {
        for (const s of await fsp.readdir(path.join(root, "Profiles")).catch(() => []))
          dbs.push(path.join(root, "Profiles", s, "cookies.sqlite"));
      } else dbs.push(path.join(root, d.name, "cookies.sqlite"));
    }
    for (const db of dbs) {
      if (!(await exists(db))) continue;
      try {
        const rows = await sqlite(db, "select name, value from moz_cookies where name='sp_dc';");
        const value = rows
          .split("\n")
          .find((l) => l.trim())
          ?.split("|")[1];
        if (value) return { spDc: value, source: `firefox (${path.basename(path.dirname(db))})` };
      } catch {}
    }
  }
  return undefined;
}

const wants = (only: string, name: string) => !only || name.includes(only) || only.includes(name);

/** First `sp_dc` found across supported browsers, optionally limited to one (`chrome`, `firefox`, …). */
export async function readSpDcFromBrowsers(log: Logger, onlyBrowser = ""): Promise<CookieHit | undefined> {
  const only = onlyBrowser.toLowerCase();
  for (const browser of CHROMIUM_BROWSERS.filter((b) => wants(only, b.name))) {
    const hit = await fromChromium(browser, log).catch(() => undefined);
    if (hit) return hit;
  }
  if (wants(only, "firefox")) return fromFirefox().catch(() => undefined);
  return undefined;
}

/** Accepts `sp_dc=…`, a full Cookie header, `{"sp_dc": …}` or the bare value. */
export function normalizeCookieInput(raw: string): string {
  const text = raw.trim();
  if (!text) return "";
  const named = /(?:^|;\s*)sp_dc=([^;\s]+)/.exec(text);
  if (named) return named[1]!;
  if (text.startsWith("{")) {
    try {
      const json = JSON.parse(text);
      if (json.sp_dc || json.spDc) return String(json.sp_dc || json.spDc);
    } catch {}
  }
  // Netscape cookies.txt
  for (const line of text.split("\n")) {
    const parts = line.split("\t");
    if (!line.startsWith("#") && parts.length >= 7 && parts[5] === "sp_dc") return parts[6]!.trim();
  }
  return text;
}
