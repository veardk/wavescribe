import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export async function exists(p: string): Promise<boolean> {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function nonEmptyFile(p: string): Promise<boolean> {
  try {
    return (await fsp.stat(p)).size > 0;
  } catch {
    return false;
  }
}

/** First complete (non-empty, not `.part`) file in `dir` named `<base>.<ext>`, e.g. an earlier download. */
export async function findCompleteFile(dir: string, base: string): Promise<string | undefined> {
  for (const f of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (f.startsWith(`${base}.`) && !f.endsWith(".part") && (await nonEmptyFile(path.join(dir, f))))
      return path.join(dir, f);
  }
  return undefined;
}

export const ensureDir = (p: string) => fsp.mkdir(p, { recursive: true });

export async function readJson<T = unknown>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Write atomically so an interrupted run never leaves half a file. `mode` (e.g. 0o600 for secrets)
 * is applied before the file appears under its final name.
 */
export async function writeJson(p: string, data: unknown, opts: { mode?: number } = {}): Promise<void> {
  await ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: opts.mode });
  if (opts.mode !== undefined) await fsp.chmod(tmp, opts.mode);
  await fsp.rename(tmp, p);
}

export async function writeText(p: string, text: string): Promise<void> {
  await ensureDir(path.dirname(p));
  await fsp.writeFile(p, text);
}

export const hash = (...parts: unknown[]): string =>
  crypto
    .createHash("sha1")
    .update(parts.map((p) => (typeof p === "string" ? p : JSON.stringify(p))).join("\u0000"))
    .digest("hex");

export function sha1File(p: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha1");
    fs.createReadStream(p)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve(h.digest("hex")));
  });
}

/** Filesystem-safe name that keeps CJK characters. */
export function slugify(s: string | undefined, fallback = "transcript"): string {
  const out = (s ?? "")
    .normalize("NFKC")
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are not allowed in file names
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[ .]+$/g, "")
    .slice(0, 80)
    .trim();
  return out || fallback;
}

const AUDIO_EXT = [
  "mp3",
  "m4a",
  "aac",
  "wav",
  "flac",
  "ogg",
  "oga",
  "opus",
  "webm",
  "mp4",
  "m4v",
  "mov",
  "mkv",
  "avi",
  "wma",
  "amr",
  "mpga",
  "mpeg",
  "3gp",
  "aiff",
];
export const MEDIA_EXTENSIONS = new Set(AUDIO_EXT);
export const SUBTITLE_EXTENSIONS = new Set([
  "srt",
  "vtt",
  "ttml",
  "dfxp",
  "xml",
  "json",
  "json3",
  "txt",
  "md",
  "markdown",
  "html",
  "htm",
]);

export function extOf(p: string): string {
  try {
    p = new URL(p).pathname;
  } catch {
    /* plain path */
  }
  return path.extname(p).slice(1).toLowerCase();
}

const CT_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "webm",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "audio/amr": "amr",
};
export function extFromContentType(ct: string | null | undefined): string | undefined {
  if (!ct) return undefined;
  return CT_EXT[ct.split(";")[0]!.trim().toLowerCase()];
}

const EXT_MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  flac: "audio/flac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  webm: "audio/webm",
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  amr: "audio/amr",
};
export const mimeOf = (p: string): string => EXT_MIME[extOf(p)] ?? "application/octet-stream";
