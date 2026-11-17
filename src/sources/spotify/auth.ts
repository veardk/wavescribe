// Spotify web-player login: the long-lived `sp_dc` cookie is exchanged for a short-lived access token
// at open.spotify.com/api/token, signed with the same TOTP the web player sends. Ported from Textcast's
// base-spotify-transcript. Lookup order: config → SPOTIFY_SP_DC → saved file → local browsers.

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import type { Config } from "../../config/config.ts";
import { configDir } from "../../config/paths.ts";
import { WsError } from "../../core/errors.ts";
import type { Logger } from "../../core/types.ts";
import { sleep } from "../../utils/async.ts";
import { readJson, writeJson } from "../../utils/fs.ts";
import { BROWSER_UA, createHttp } from "../../utils/http.ts";
import { normalizeCookieInput, readSpDcFromBrowsers } from "./cookies.ts";

const TOKEN_API = "https://open.spotify.com/api/token";
/** The token lives about an hour; reuse it for 40 minutes so a batch of episodes mints it once. */
const TOKEN_TTL_MS = 40 * 60_000;
const LOGIN_TIMEOUT_MS = 5 * 60_000;

export const credentialsFile = () => path.join(configDir(), "spotify-credentials.json");

export interface TotpSecret {
  version: number;
  secret: string;
}

// Secrets embedded in the web player bundle (version → secret literal), newest first.
// They change when Spotify ships a new player; discoverTotpSecrets() re-reads the bundle.
const BUILTIN_TOTP_SECRETS: TotpSecret[] = [
  { version: 61, secret: ',7/*F("rLJ2oxaKL^f+E1xvP@N' },
  { version: 60, secret: 'OmE{ZA.J^":0FG\\Uz?[@WW' },
  { version: 59, secret: "{iOFn;4}<1PFYKPV?5{%u14]M>/V0hDH" },
];

interface SavedCredentials {
  spDc?: string;
  source?: string;
  totp?: TotpSecret;
  token?: { value: string; mintedAt: number };
  updatedAt?: string;
}

export interface Session {
  spDc: string;
  source: string;
  totp?: TotpSecret;
  token?: { value: string; mintedAt: number };
}

/* ---------------- TOTP ---------------- */

// The bundle stores the secret XOR-obfuscated: char ^ (index % 33 + 9), digits concatenated.
export function totpSecretBytes(secret: string): Buffer {
  const joined = [...secret].map((ch, i) => ch.charCodeAt(0) ^ ((i % 33) + 9)).join("");
  return Buffer.from(joined, "utf8");
}

export function totpCode(secretBytes: Buffer, timestamp = Date.now(), period = 30): string {
  const counter = Math.floor(timestamp / 1000 / period);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);
  const hmac = crypto.createHmac("sha1", secretBytes).update(buf).digest();
  const o = hmac[hmac.length - 1]! & 15;
  const value =
    (((hmac[o]! & 127) << 24) | ((hmac[o + 1]! & 255) << 16) | ((hmac[o + 2]! & 255) << 8) | (hmac[o + 3]! & 255)) %
    1e6;
  return String(value).padStart(6, "0");
}

function unquoteJsLiteral(raw: string): string {
  const body = raw.slice(1, -1);
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[++i];
    if (next === "u" && /^[0-9a-fA-F]{4}$/.test(body.slice(i + 1, i + 5))) {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 5), 16));
      i += 4;
    } else if (next === "x" && /^[0-9a-fA-F]{2}$/.test(body.slice(i + 1, i + 3))) {
      out += String.fromCharCode(Number.parseInt(body.slice(i + 1, i + 3), 16));
      i += 2;
    } else if (next === "n") out += "\n";
    else if (next === "t") out += "\t";
    else if (next === "r") out += "\r";
    else out += next ?? "";
  }
  return out;
}

export function extractTotpSecretsFromBundle(source: string): TotpSecret[] {
  const found: TotpSecret[] = [];
  const re = /secret:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')\s*,\s*version:\s*(\d{1,5})/g;
  for (const m of source.matchAll(re)) {
    const secret = unquoteJsLiteral(m[1]!);
    const version = Number(m[2]);
    if (secret && version) found.push({ version, secret });
  }
  return found.sort((a, b) => b.version - a.version);
}

/** Safety net: pull the current secrets out of the live web player bundle. */
async function discoverTotpSecrets(log: Logger): Promise<TotpSecret[]> {
  const http = createHttp(log);
  try {
    const html = (
      await http.request<string>("https://open.spotify.com/", {
        headers: { "user-agent": BROWSER_UA, accept: "text/html" },
        expect: "text",
        timeoutMs: 30_000,
        retries: 1,
      })
    ).data;
    const urls = [...html.matchAll(/https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/[^\s"']+\.js/g)]
      .map((m) => m[0])
      .sort((a, b) => Number(/encore~|vendor~/.test(a)) - Number(/encore~|vendor~/.test(b)));
    for (const url of [...new Set(urls)].slice(0, 4)) {
      const js = await http
        .request<string>(url, { headers: { "user-agent": BROWSER_UA }, expect: "text", timeoutMs: 60_000, retries: 1 })
        .catch(() => undefined);
      const secrets = js ? extractTotpSecretsFromBundle(js.data) : [];
      if (secrets.length) return secrets;
    }
  } catch (e) {
    log.debug(`spotify: could not read the web player bundle (${(e as Error).message})`);
  }
  return [];
}

/* ---------------- credentials ---------------- */

async function loadSaved(): Promise<SavedCredentials> {
  return (await readJson<SavedCredentials>(credentialsFile())) ?? {};
}

async function save(session: Session): Promise<void> {
  const data: SavedCredentials = { ...session, updatedAt: new Date().toISOString() };
  await writeJson(credentialsFile(), data, { mode: 0o600 });
}

/** The saved / configured cookie, without touching browsers. */
export async function savedSession(cfg: Config): Promise<Session | undefined> {
  if (cfg.spotify?.spDc) return { spDc: normalizeCookieInput(cfg.spotify.spDc), source: "config" };
  if (process.env.SPOTIFY_SP_DC)
    return { spDc: normalizeCookieInput(process.env.SPOTIFY_SP_DC), source: "SPOTIFY_SP_DC" };
  const saved = await loadSaved();
  return saved.spDc
    ? { spDc: saved.spDc, source: saved.source ?? "saved", totp: saved.totp, token: saved.token }
    : undefined;
}

/** Saved login, or one read from local browsers (then saved). */
export async function findSession(cfg: Config, log: Logger): Promise<Session> {
  const saved = await savedSession(cfg);
  if (saved) return saved;
  log.info("Looking for a logged-in Spotify session in your browsers…");
  const hit = await readSpDcFromBrowsers(log);
  if (hit) {
    log.info(`Found a Spotify login in ${hit.source}`);
    await save(hit);
    return hit;
  }
  throw new WsError("LOGIN_REQUIRED", "Spotify transcripts need a login to open.spotify.com", {
    hint: "Run `wavescribe login spotify` (or `wavescribe login spotify --cookie <sp_dc>`)",
  });
}

/* ---------------- tokens ---------------- */

async function mint(spDc: string, secrets: TotpSecret[], log: Logger): Promise<{ token: string; totp: TotpSecret }> {
  const http = createHttp(log);
  const tried: string[] = [];
  for (const totp of secrets) {
    const code = totpCode(totpSecretBytes(totp.secret));
    // 400/403 usually mean a stale TOTP secret: try the next one. 401 means the cookie itself is bad.
    const res = await http.request<string>(TOKEN_API, {
      query: { reason: "init", productType: "web-player", totp: code, totpServer: code, totpVer: totp.version },
      headers: { cookie: `sp_dc=${spDc}`, "user-agent": BROWSER_UA, accept: "application/json" },
      okStatuses: [400, 401, 403],
      expect: "text",
      retries: 2,
      timeoutMs: 30_000,
    });
    if (res.status < 300) {
      let json: any;
      try {
        json = JSON.parse(res.data);
      } catch {}
      if (!json?.accessToken) throw new WsError("AUTH", "Spotify returned no access token");
      if (json.isAnonymous) log.warn("Spotify treated the cookie as anonymous; the login may have expired");
      return { token: json.accessToken, totp };
    }
    tried.push(`v${totp.version}: HTTP ${res.status}`);
    if (res.status === 401) break;
  }
  throw new WsError("AUTH", `Could not exchange the Spotify cookie for an access token (${tried.join(", ")})`, {
    hint: "The login may be stale: sign in at https://open.spotify.com, then run `wavescribe login spotify`",
  });
}

/** A web-player access token: cached unless `force`, with built-in → saved → live-bundle TOTP secrets. */
export async function accessToken(session: Session, log: Logger, force = false): Promise<string> {
  const age = session.token ? Date.now() - session.token.mintedAt : Number.POSITIVE_INFINITY;
  if (!force && session.token && age < TOKEN_TTL_MS) {
    log.debug(`spotify: reusing the access token minted ${Math.round(age / 60_000)} min ago`);
    return session.token.value;
  }
  const secrets: TotpSecret[] = [];
  if (session.totp) secrets.push(session.totp);
  for (const s of BUILTIN_TOTP_SECRETS)
    if (!secrets.some((x) => x.version === s.version && x.secret === s.secret)) secrets.push(s);
  let minted: { token: string; totp: TotpSecret };
  try {
    minted = await mint(session.spDc, secrets, log);
  } catch (e) {
    // Spotify rotated the player: re-read the bundle and try the fresh secrets once.
    const fresh = (await discoverTotpSecrets(log)).filter(
      (d) => !secrets.some((s) => s.version === d.version && s.secret === d.secret),
    );
    if (!fresh.length) throw e;
    log.info("Trying the TOTP secret from the current Spotify web player");
    minted = await mint(session.spDc, fresh, log);
  }
  session.totp = minted.totp;
  session.token = { value: minted.token, mintedAt: Date.now() };
  if (session.source !== "config" && session.source !== "SPOTIFY_SP_DC") await save(session);
  return minted.token;
}

/* ---------------- login command ---------------- */

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

/**
 * `wavescribe login spotify`: a pasted cookie, or one read from local browsers. With nothing found,
 * open open.spotify.com and poll the browser cookie stores until the login lands (up to 5 minutes).
 */
export async function login(log: Logger, opts: { cookie?: string; browser?: string } = {}): Promise<Session> {
  let session: Session | undefined;
  if (opts.cookie) {
    const spDc = normalizeCookieInput(opts.cookie);
    if (!spDc) throw new WsError("BAD_INPUT", "--cookie did not contain an sp_dc value");
    session = { spDc, source: "--cookie" };
  } else {
    session = await readSpDcFromBrowsers(log, opts.browser);
    if (!session) {
      log.info("Opening https://open.spotify.com — sign in there; this continues on its own (Ctrl+C to cancel)");
      openUrl("https://open.spotify.com/");
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (!session && Date.now() < deadline) {
        await sleep(2000);
        session = await readSpDcFromBrowsers(log, opts.browser);
      }
      if (!session) throw new WsError("TIMEOUT", "Timed out after 5 minutes waiting for the Spotify login");
    }
    log.info(`Found a Spotify login in ${session.source}`);
  }
  await accessToken(session, log, true); // proves the cookie works, and saves it
  return session;
}
