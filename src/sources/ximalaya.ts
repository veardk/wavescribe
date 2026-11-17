// 喜马拉雅: album links → the album RSS feed; track links → find the album, then the track in its feed.

import { WsError } from "../core/errors.ts";
import type { ResolvedSource } from "../core/types.ts";
import { BROWSER_UA } from "../utils/http.ts";
import { http } from "./candidates.ts";
import { type FeedItem, resolveFeedUrl } from "./rss.ts";
import type { SourceContext } from "./types.ts";
import { resolveYtDlp } from "./ytdlp.ts";

export const isXimalaya = (input: string) => /^https?:\/\/([a-z]+\.)?ximalaya\.com\//i.test(input);

export async function resolveXimalaya(input: string, ctx: SourceContext): Promise<ResolvedSource> {
  const u = new URL(input);
  const trackId = /\/sound\/(\d+)/.exec(u.pathname)?.[1];
  let albumId = /\/album\/(\d+)/.exec(u.pathname)?.[1];
  let trackTitle: string | undefined;
  if (trackId) {
    const info = (
      await http(ctx).request(`https://www.ximalaya.com/revision/track/simple`, {
        query: { trackId },
        headers: { "user-agent": BROWSER_UA },
      })
    ).data?.data;
    albumId ??= info?.albumInfo?.albumId ? String(info.albumInfo.albumId) : undefined;
    trackTitle = info?.trackInfo?.title;
  }
  if (!albumId) throw new WsError("BAD_INPUT", "Not a Ximalaya album or track link");
  const feedUrl = `https://www.ximalaya.com/album/${albumId}.xml`;
  const isTrack = (i: FeedItem) =>
    i.guid === `xmly_track_${trackId}` ||
    i.link?.endsWith(`/sound/${trackId}`) ||
    i.audioUrl?.includes(`track_id=${trackId}`);
  const pick = trackId
    ? (items: FeedItem[]) => {
        const hit = items.find(isTrack);
        if (!hit) throw new WsError("NOT_FOUND", `Track ${trackId} is not in the album feed`);
        return hit;
      }
    : undefined;
  try {
    const r = await resolveFeedUrl(input, feedUrl, ctx, { kind: "ximalaya", pick });
    r.meta.url = input;
    return r;
  } catch (e) {
    if (!trackId) throw e;
    ctx.log.debug(`Ximalaya feed did not have the track (${(e as Error).message}); trying yt-dlp`);
    const r = await resolveYtDlp(input, ctx);
    r.meta.kind = "ximalaya";
    r.meta.title ??= trackTitle;
    return r;
  }
}
