// Plain http(s) links: sniff what the URL serves (audio/video file, feed, subtitle file, web page).

import { WsError } from "../core/errors.ts";
import type { ResolvedSource } from "../core/types.ts";
import { extFromContentType, extOf, hash, MEDIA_EXTENSIONS, SUBTITLE_EXTENSIONS } from "../utils/fs.ts";
import { BROWSER_UA } from "../utils/http.ts";
import { audioFromUrl, textFromUrl } from "./candidates.ts";
import { looksLikeFeed, resolveFeedUrl } from "./rss.ts";
import type { SourceContext } from "./types.ts";
import { resolveYtDlp } from "./ytdlp.ts";

async function sniff(
  url: string,
  signal?: AbortSignal,
): Promise<{ contentType: string; head: string; finalUrl: string }> {
  const res = await fetch(url, {
    headers: { "user-agent": BROWSER_UA, range: "bytes=0-16383" },
    redirect: "follow",
    signal: AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]),
  });
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  let head = "";
  if (!/^(audio|video)\//.test(contentType) && res.body) {
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < 16384) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
    }
    head = Buffer.concat(chunks).toString("utf8");
    await reader.cancel().catch(() => {});
  } else {
    await res.body?.cancel().catch(() => {});
  }
  return { contentType, head, finalUrl: res.url || url };
}

export async function resolveWeb(input: string, ctx: SourceContext): Promise<ResolvedSource> {
  const ext = extOf(input);
  const id = `url:${hash(input).slice(0, 16)}`;
  if (MEDIA_EXTENSIONS.has(ext)) {
    return {
      meta: {
        input,
        id,
        kind: "url",
        title: decodeURIComponent(new URL(input).pathname.split("/").pop() ?? ""),
        url: input,
      },
      candidates: [audioFromUrl(input, "audio file")],
    };
  }
  let s: Awaited<ReturnType<typeof sniff>> | undefined;
  try {
    s = await sniff(input, ctx.signal);
  } catch (e) {
    ctx.log.debug(`sniff failed: ${(e as Error).message}`);
  }
  if (s && (/^(audio|video)\//.test(s.contentType) || extFromContentType(s.contentType))) {
    return { meta: { input, id, kind: "url", url: input }, candidates: [audioFromUrl(s.finalUrl, "audio file")] };
  }
  if (s && (/xml|rss|atom/.test(s.contentType) || looksLikeFeed(s.head))) {
    return resolveFeedUrl(input, s.finalUrl, ctx);
  }
  const subtitleLike = SUBTITLE_EXTENSIONS.has(ext) && ext !== "html" && ext !== "htm";
  if (
    s &&
    (subtitleLike || /text\/vtt|application\/x-subrip|ttml/.test(s.contentType) || s.head.startsWith("WEBVTT"))
  ) {
    return {
      meta: { input, id, kind: "url", url: input },
      candidates: [textFromUrl(s.finalUrl, "subtitle file", "publisher", "url")],
    };
  }
  try {
    return await resolveYtDlp(input, ctx);
  } catch (e) {
    if (e instanceof WsError && e.code === "DEPENDENCY") throw e;
    const reason = (e as Error).message.replace(/^yt-dlp cannot read this link:\s*/, "").trim();
    const host = new URL(input).host;
    if (/log ?in|sign ?in|cookies|authenticat|private|members/i.test(reason)) {
      throw new WsError("LOGIN_REQUIRED", `${host} needs a login before yt-dlp can read it: ${reason}`, {
        cause: e,
        hint: "Download the media yourself and pass the local file",
      });
    }
    const detail = /unsupported url/i.test(reason) ? "" : ` (yt-dlp: ${reason})`;
    throw new WsError(
      "UNSUPPORTED_SOURCE",
      `Don't know how to read ${host}: not audio, a feed, a subtitle file, or a video page yt-dlp supports${detail}`,
      { cause: e },
    );
  }
}
