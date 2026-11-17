// YouTube: captions through the Innertube ANDROID client (no PO token), yt-dlp as fallback,
// audio through yt-dlp when a video has no captions. Ported from Textcast's base-youtube-transcript.

import { WsError } from "../core/errors.ts";
import { baseLanguage } from "../core/lang.ts";
import type { Candidate, Origin, ResolvedSource, Segment, TextCandidate } from "../core/types.ts";
import { decodeEntities, joinLines, parseJsonTranscript } from "../parsers/index.ts";
import { BROWSER_UA } from "../utils/http.ts";
import { http } from "./candidates.ts";
import type { SourceContext } from "./types.ts";
import { pickTracks, resolveYtDlp, ytdlpAudio, ytdlpInfo, ytdlpSubtitle } from "./ytdlp.ts";

const HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);
const ID = /^[A-Za-z0-9_-]{11}$/;
const FALLBACK_ORDER = [
  "en",
  "zh-Hans",
  "zh-CN",
  "zh",
  "zh-Hant",
  "zh-TW",
  "es",
  "ja",
  "ko",
  "fr",
  "de",
  "ru",
  "pt",
  "it",
  "ar",
  "hi",
];

export function youtubeId(input: string): string | undefined {
  const t = input.trim();
  if (ID.test(t)) return undefined; // bare ids are ambiguous with file names; require a URL
  try {
    const u = new URL(t);
    if (!HOSTS.has(u.hostname)) return undefined;
    if (u.hostname === "youtu.be") return ID.test(u.pathname.slice(1, 12)) ? u.pathname.slice(1, 12) : undefined;
    const v = u.searchParams.get("v");
    if (v && ID.test(v)) return v;
    return /^\/(?:shorts|embed|live|v)\/([A-Za-z0-9_-]{11})/.exec(u.pathname)?.[1];
  } catch {
    return undefined;
  }
}

export function parseSrv3(xml: string): Segment[] {
  const out: Segment[] = [];
  for (const m of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const t = Number(/\bt="(\d+)"/.exec(m[1]!)?.[1]);
    const d = Number(/\bd="(\d+)"/.exec(m[1]!)?.[1] ?? 0);
    const text = joinLines(decodeEntities(m[2]!.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "")).split("\n"));
    if (Number.isFinite(t) && text) out.push({ start: t / 1000, end: (t + d) / 1000, text });
  }
  return out;
}

interface Track {
  baseUrl: string;
  languageCode: string;
  kind?: string;
  name?: { runs?: { text: string }[] };
}

/** Order tracks: wanted language → spoken language (the ASR track's) → English → common languages. Human before auto. */
export function orderTracks(tracks: Track[], wanted?: string): Track[] {
  const spoken = tracks.find((t) => t.kind === "asr")?.languageCode;
  const prefs = [wanted, spoken, ...FALLBACK_ORDER].filter(Boolean) as string[];
  const rank = (t: Track) => {
    const code = t.languageCode.toLowerCase();
    const i = prefs.findIndex((p) => code === p.toLowerCase() || baseLanguage(code) === baseLanguage(p));
    return (i < 0 ? 100 : i) * 2 + (t.kind === "asr" ? 1 : 0);
  };
  const sorted = [...tracks].sort((a, b) => rank(a) - rank(b));
  // keep at most one human and one auto track for the top language
  const top = baseLanguage(sorted[0]?.languageCode);
  return sorted.filter((t) => baseLanguage(t.languageCode) === top).slice(0, 2);
}

function innertubeTrack(track: Track): TextCandidate {
  const origin: Origin = track.kind === "asr" ? "auto-caption" : "human";
  return {
    type: "text",
    label: `YouTube ${origin === "human" ? "subtitles" : "automatic captions"} [${track.languageCode}]`,
    timed: true,
    async fetch(ctx) {
      const r = await http(ctx).request<string>(track.baseUrl, {
        headers: { "user-agent": BROWSER_UA },
        expect: "text",
      });
      const raw = r.data;
      const segments = raw.trim().startsWith("{") ? parseJsonTranscript(JSON.parse(raw)).segments : parseSrv3(raw);
      if (!segments.length) throw new WsError("NO_TEXT", "YouTube returned an empty caption track");
      return {
        segments,
        timed: true,
        language: track.languageCode,
        origin,
        fetcher: "base-youtube-transcript",
        raw: { content: raw, ext: raw.trim().startsWith("{") ? "json" : "xml" },
      };
    },
  };
}

export async function resolveYoutube(input: string, id: string, ctx: SourceContext): Promise<ResolvedSource> {
  const url = `https://www.youtube.com/watch?v=${id}`;
  let data: any;
  try {
    data = (
      await http(ctx).request("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
        method: "POST",
        headers: { "user-agent": "com.google.android.youtube/21.26.364 (Linux; U; Android 11)" },
        json: {
          context: {
            client: {
              clientName: "ANDROID",
              clientVersion: "21.26.364",
              androidSdkVersion: 30,
              osName: "Android",
              osVersion: "11",
              hl: "en",
            },
          },
          videoId: id,
        },
        retries: 1,
      })
    ).data;
  } catch (e) {
    ctx.log.warn(`YouTube player API failed (${(e as Error).message}); falling back to yt-dlp`);
  }
  const tracks: Track[] = data?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  if (!data?.videoDetails) {
    const r = await resolveYtDlp(url, ctx);
    return { ...r, meta: { ...r.meta, input, kind: "youtube", id: `youtube:${id}` } };
  }
  const candidates: Candidate[] = orderTracks(tracks, ctx.language).map(innertubeTrack);
  // yt-dlp fallback for captions (rate limits, odd formats), resolved lazily
  candidates.push({
    type: "text",
    label: "YouTube captions via yt-dlp",
    timed: true,
    async fetch(rctx) {
      const info = await ytdlpInfo(rctx.tools.ytDlp, url);
      const pick = pickTracks(info, ctx.language)[0];
      if (!pick) throw new WsError("NO_TEXT", "No caption track available through yt-dlp");
      rctx.log.info("Innertube captions failed; using yt-dlp");
      return ytdlpSubtitle(url, pick.key, pick.origin).fetch(rctx);
    },
  });
  candidates.push(ytdlpAudio(url));
  const v = data.videoDetails;
  return {
    meta: {
      input,
      id: `youtube:${id}`,
      kind: "youtube",
      title: v.title,
      url,
      uploader: v.author,
      duration: v.lengthSeconds ? Number(v.lengthSeconds) : undefined,
    },
    candidates,
  };
}
