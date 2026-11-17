// Any site yt-dlp understands: its subtitles first (human, then automatic), else its audio.

import fsp from "node:fs/promises";
import path from "node:path";
import { WsError } from "../core/errors.ts";
import { baseLanguage } from "../core/lang.ts";
import type {
  AudioCandidate,
  Candidate,
  Origin,
  ParsedText,
  ResolvedSource,
  RunContext,
  TextCandidate,
} from "../core/types.ts";
import { parseText } from "../parsers/index.ts";
import { ensureDir, extOf, findCompleteFile, hash } from "../utils/fs.ts";
import { run, tail } from "../utils/process.ts";
import type { SourceContext } from "./types.ts";

const SUB_FILE = /\.(json3|vtt|srt|ttml|json)$/;

const ytdlp = (bin: string, args: string[], timeoutMs = 600_000) =>
  run(bin, ["--no-warnings", "--no-playlist", ...args], { timeoutMs });

/** The last `ERROR:` line without the `[extractor] id:` prefix, else the end of stderr. */
function errorLine(stderr: string, n = 300): string {
  const line = stderr
    .split("\n")
    .filter((l) => l.startsWith("ERROR:"))
    .at(-1);
  return line ? line.replace(/^ERROR:\s*(\[[^\]]+\]\s*[^:]+:\s*)?/, "") : tail(stderr, n);
}

/** 'ai-zh' → zh, 'en-orig' → en, 'zh-Hans' → zh-Hans */
export const trackLang = (key: string) => key.replace(/^ai-/, "").replace(/-orig$/, "");

const originOf = (key: string): Origin => (key.startsWith("ai-") ? "auto-caption" : "human");

/** Best subtitle tracks for the wanted (or spoken) language: human first, then automatic. */
export function pickTracks(info: any, wanted?: string): { key: string; origin: Origin }[] {
  const manual: Record<string, unknown> = Object.fromEntries(
    Object.entries(info.subtitles ?? {}).filter(([k]) => k !== "live_chat" && k !== "danmaku"),
  );
  const auto: Record<string, unknown> = info.automatic_captions ?? {};
  const spoken = wanted ?? info.language ?? undefined;
  const match = (tracks: Record<string, unknown>, lang?: string): string | undefined => {
    if (!lang) return undefined;
    for (const k of [lang, `${lang}-orig`]) if (k in tracks) return k;
    const b = baseLanguage(lang);
    return Object.keys(tracks).find((k) => baseLanguage(trackLang(k)) === b);
  };
  const out: { key: string; origin: Origin }[] = [];
  const push = (key: string | undefined, origin: Origin) => {
    if (key && !out.some((o) => o.key === key)) out.push({ key, origin });
  };
  const manualKeys = Object.keys(manual);
  const m = match(manual, spoken);
  if (m) push(m, originOf(m));
  if (!wanted && manualKeys.length === 1) push(manualKeys[0], originOf(manualKeys[0]!));
  push(match(auto, spoken), "auto-caption");
  if (!wanted)
    push(
      Object.keys(auto).find((k) => k.endsWith("-orig")),
      "auto-caption",
    );
  if (!wanted && !out.length && manualKeys.length) {
    const k = manualKeys.find((k) => k.startsWith("ai-")) ?? manualKeys[0]!;
    push(k, originOf(k));
  }
  return out;
}

/**
 * Run yt-dlp's subtitle download into a fresh directory, then parse the best file.
 * `rank` orders the downloaded files by their language key (lower is better).
 */
async function downloadSubtitle(
  ctx: RunContext,
  dirName: string,
  args: string[],
  rank: (lang: string) => number,
  origin?: Origin,
): Promise<ParsedText> {
  const dir = path.join(ctx.workDir, "source", dirName);
  await fsp.rm(dir, { recursive: true, force: true });
  await ensureDir(dir);
  const r = await ytdlp(ctx.tools.ytDlp, ["--skip-download", ...args, "-o", path.join(dir, "sub.%(ext)s")]);
  const langOf = (f: string) => f.replace(/^sub\./, "").replace(/\.[^.]+$/, "");
  const files = (await fsp.readdir(dir))
    .filter((f) => SUB_FILE.test(f))
    .sort((a, b) => rank(langOf(a)) - rank(langOf(b)));
  if (!files.length) {
    throw new WsError("NO_TEXT", `yt-dlp found no subtitles${r.code ? `: ${errorLine(r.stderr, 200)}` : ""}`);
  }
  const best = files[0]!;
  const content = await fsp.readFile(path.join(dir, best), "utf8");
  const parsed = parseText(content, extOf(best));
  const lang = langOf(best);
  return {
    segments: parsed.segments,
    timed: parsed.timed,
    language: trackLang(lang),
    origin: origin ?? originOf(lang),
    fetcher: "yt-dlp",
    raw: { content, ext: extOf(best) },
  };
}

/** One known subtitle track (`key` from yt-dlp's `-J` output). */
export function ytdlpSubtitle(url: string, key: string, origin: Origin, extraArgs: string[] = []): TextCandidate {
  return {
    type: "text",
    label: `${origin === "human" ? "subtitles" : "automatic captions"} [${key}] via yt-dlp`,
    timed: true,
    fetch: (ctx) =>
      downloadSubtitle(
        ctx,
        `sub-${hash(key).slice(0, 8)}`,
        [
          ...extraArgs,
          origin === "human" ? "--write-subs" : "--write-auto-subs",
          "--sub-langs",
          key,
          "--sub-format",
          "json3/vtt/srt/best",
          url,
        ],
        () => 0,
        origin,
      ),
  };
}

/**
 * Download every subtitle matching a yt-dlp `--sub-langs` pattern and keep the best one by `rank`.
 * For extractors whose `-J` output omits subtitles (Bilibili).
 */
export function ytdlpSubtitleBest(
  url: string,
  langs: string,
  rank: (lang: string) => number,
  extraArgs: string[] = [],
): TextCandidate {
  return {
    type: "text",
    label: "subtitles via yt-dlp",
    timed: true,
    fetch: (ctx) =>
      downloadSubtitle(
        ctx,
        "subs-any",
        [...extraArgs, "--write-subs", "--sub-langs", langs, "--sub-format", "json3/srt/vtt/best", url],
        rank,
      ),
  };
}

export function ytdlpAudio(url: string, extraArgs: string[] = []): AudioCandidate {
  return {
    type: "audio",
    label: "audio via yt-dlp",
    async download(ctx) {
      const dir = path.join(ctx.workDir, "source");
      await ensureDir(dir);
      const earlier = ctx.useCache ? await findCompleteFile(dir, "ytaudio") : undefined;
      if (earlier) return earlier;
      ctx.log.progress({ type: "step", label: "Downloading audio with yt-dlp" });
      const r = await ytdlp(
        ctx.tools.ytDlp,
        [...extraArgs, "-f", "bestaudio/best", "-o", path.join(dir, "ytaudio.%(ext)s"), url],
        3_600_000,
      );
      const file = await findCompleteFile(dir, "ytaudio");
      if (r.code !== 0 || !file)
        throw new WsError("NOT_FOUND", `yt-dlp could not download audio: ${errorLine(r.stderr)}`);
      return file;
    },
  };
}

export async function ytdlpInfo(bin: string, url: string, extraArgs: string[] = []): Promise<any> {
  const r = await ytdlp(bin, [...extraArgs, "-J", "--skip-download", url], 120_000);
  if (r.code !== 0) throw new WsError("UNSUPPORTED_SOURCE", `yt-dlp cannot read this link: ${errorLine(r.stderr)}`);
  return JSON.parse(r.stdout);
}

const isoDate = (yyyymmdd?: string) =>
  yyyymmdd ? `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}` : undefined;

export async function resolveYtDlp(input: string, ctx: SourceContext): Promise<ResolvedSource> {
  const info = await ytdlpInfo(ctx.tools.ytDlp, input);
  const url: string = info.webpage_url ?? input;
  const candidates: Candidate[] = pickTracks(info, ctx.language).map((t) => ytdlpSubtitle(url, t.key, t.origin));
  candidates.push(ytdlpAudio(url));
  return {
    meta: {
      input,
      id: `${String(info.extractor_key ?? info.extractor ?? "video").toLowerCase()}:${info.id ?? hash(url).slice(0, 12)}`,
      kind: "video",
      title: info.title,
      url,
      uploader: info.uploader ?? info.channel,
      published: isoDate(info.upload_date),
      duration: info.duration,
    },
    candidates,
  };
}
