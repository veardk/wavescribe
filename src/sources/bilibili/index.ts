// Bilibili: subtitle tracks (human and AI) through the player API with WBI signing; audio via yt-dlp.
// Ported from Textcast's base-bilibili-transcript.

import { WsError } from "../../core/errors.ts";
import { baseLanguage } from "../../core/lang.ts";
import type { Candidate, Origin, ResolvedSource, Segment, TextCandidate } from "../../core/types.ts";
import { BROWSER_UA } from "../../utils/http.ts";
import { http } from "../candidates.ts";
import type { SourceContext } from "../types.ts";
import { ytdlpAudio, ytdlpSubtitleBest } from "../ytdlp.ts";
import { bvidOf, playerInfo, type Subtitle } from "./api.ts";
import { isLoggedIn, savedSessdata, syncFromBrowsers, ytdlpCookieArgs } from "./auth.ts";

export { bvidOf, isBilibili } from "./api.ts";

const isAi = (lan: string) => lan.startsWith("ai-");

/** Lower is better: wanted language → Chinese → English; human before AI; zh-CN / zh-Hans first among Chinese. */
function languageRank(lan: string, wanted?: string): number {
  const prefs = [wanted, "zh", "en"].filter(Boolean) as string[];
  const code = lan.replace(/^ai-/, "");
  const i = prefs.findIndex((p) => baseLanguage(code) === baseLanguage(p));
  return (i < 0 ? 50 : i) * 2 + (isAi(lan) ? 1 : 0) + (/^zh-(CN|Hans)$/.test(code) ? 0 : 0.5);
}

function subCandidate(sub: Subtitle, headers: Record<string, string>): TextCandidate {
  const origin: Origin = isAi(sub.lan) ? "auto-caption" : "human";
  const url = sub.subtitle_url.startsWith("//") ? `https:${sub.subtitle_url}` : sub.subtitle_url;
  return {
    type: "text",
    label: `Bilibili ${origin === "human" ? "subtitles" : "AI subtitles"} [${sub.lan}${sub.lan_doc ? ` ${sub.lan_doc}` : ""}]`,
    timed: true,
    async fetch(ctx) {
      const j = (await http(ctx).request(url, { headers })).data;
      const segments: Segment[] = (j?.body ?? [])
        .map((b: any) => ({ start: Number(b.from) || 0, end: Number(b.to) || 0, text: String(b.content ?? "").trim() }))
        .filter((s: Segment) => s.text);
      if (!segments.length) throw new WsError("NO_TEXT", "Bilibili subtitle file is empty");
      return {
        segments,
        timed: true,
        language: sub.lan.replace(/^ai-/, ""),
        origin,
        fetcher: "base-bilibili-transcript",
        raw: { content: JSON.stringify(j), ext: "json" },
      };
    },
  };
}

export async function resolveBilibili(input: string, ctx: SourceContext): Promise<ResolvedSource> {
  let url = input;
  if (/b23\.tv/.test(input)) {
    // Short links redirect to the video page; only the final URL matters.
    url = (await http(ctx).request(input, { headers: { "user-agent": BROWSER_UA }, expect: "none", timeoutMs: 30_000 }))
      .url;
  }
  const bvid = bvidOf(url);
  if (!bvid) throw new WsError("BAD_INPUT", "Not a Bilibili video link");
  const page = Number(/[?&]p=(\d+)/.exec(url)?.[1] ?? 1);
  let sessdata = await savedSessdata(ctx.cfg);
  if (sessdata && !(await isLoggedIn(sessdata))) {
    ctx.log.warn("The saved Bilibili login has expired (run `wavescribe login bilibili`)");
    sessdata = undefined;
  }
  let info = await playerInfo(bvid, page, sessdata, ctx);
  let subs: Subtitle[] = info.player?.subtitle?.subtitles ?? [];
  if (!subs.length && info.player?.need_login_subtitle && !sessdata) {
    ctx.log.info("Bilibili needs a login to show subtitles; checking local browsers…");
    sessdata = await syncFromBrowsers(ctx.tools.ytDlp, ctx.log);
    if (sessdata) {
      info = await playerInfo(bvid, page, sessdata, ctx);
      subs = info.player?.subtitle?.subtitles ?? [];
    } else {
      ctx.log.warn(
        "No Bilibili login found; subtitles are unavailable (run `wavescribe login bilibili`). Falling back to audio.",
      );
    }
  }
  // Logged out, Bilibili's player API hands back AI subtitles of unrelated videos. Only trust them with a live login.
  if (!sessdata && subs.some((s) => isAi(s.lan))) {
    ctx.log.warn(
      "Skipping Bilibili AI subtitles: without a valid login they can belong to another video (run `wavescribe login bilibili`)",
    );
    subs = subs.filter((s) => !isAi(s.lan));
  }
  const pageUrl = `https://www.bilibili.com/video/${bvid}${info.page > 1 ? `?p=${info.page}` : ""}`;
  const ytArgs = await ytdlpCookieArgs(sessdata);
  const candidates: Candidate[] = [];
  if (info.signed) {
    const ordered = subs
      .filter((s) => s.subtitle_url)
      .sort((a, b) => languageRank(a.lan, ctx.language) - languageRank(b.lan, ctx.language));
    candidates.push(...ordered.map((s) => subCandidate(s, info.headers)));
  } else {
    // The unsigned player API (used when the signed one is rate-limited, HTTP 412) returns subtitles of
    // random other videos. Ask yt-dlp instead, which keeps up with Bilibili's signing.
    ctx.log.debug("bilibili: signed player API unavailable; using yt-dlp for subtitles");
    const pattern = sessdata ? "all,-danmaku" : "all,-danmaku,-ai-.*";
    const rank = (lan: string) => languageRank(lan, ctx.language);
    candidates.push({ ...ytdlpSubtitleBest(pageUrl, pattern, rank, ytArgs), label: "Bilibili subtitles via yt-dlp" });
  }
  candidates.push(ytdlpAudio(pageUrl, ytArgs));
  return {
    meta: {
      input,
      id: `bilibili:${bvid}:${info.page}`,
      kind: "bilibili",
      title: info.title,
      url: pageUrl,
      uploader: info.view?.owner?.name,
      duration: info.duration,
    },
    candidates,
  };
}
