// Apple Podcasts links → the show's public RSS feed (iTunes Lookup) → the episode.
// Apple's own transcripts need an Apple account, so the feed's transcript or audio is used.

import { WsError } from "../core/errors.ts";
import type { ResolvedSource } from "../core/types.ts";
import { hash } from "../utils/fs.ts";
import { BROWSER_UA } from "../utils/http.ts";
import { audioFromUrl, fetchText, http } from "./candidates.ts";
import { type FeedItem, feedSource, parseFeed, resolveFeedUrl } from "./rss.ts";
import type { SourceContext } from "./types.ts";

export const isApple = (input: string) => /^https?:\/\/(podcasts|itunes)\.apple\.com\//i.test(input);

export function parseAppleUrl(input: string): { showId: string; episodeId?: string; country: string } {
  const u = new URL(input);
  const showId = /\/id(\d+)/.exec(u.pathname)?.[1];
  if (!showId) throw new WsError("BAD_INPUT", "Apple Podcasts link has no show id (…/id123456)");
  return {
    showId,
    episodeId: u.searchParams.get("i") ?? undefined,
    country: /^\/([a-z]{2})\//.exec(u.pathname)?.[1] ?? "us",
  };
}

export async function resolveApple(input: string, ctx: SourceContext): Promise<ResolvedSource> {
  const { showId, episodeId, country } = parseAppleUrl(input);
  const lookup = (
    await http(ctx).request(`https://itunes.apple.com/lookup`, {
      query: { id: showId, entity: "podcastEpisode", limit: 200, country },
    })
  ).data;
  const results: any[] = lookup?.results ?? [];
  const show = results.find((r) => r.wrapperType === "track" || r.kind === "podcast") ?? results[0];
  const feedUrl: string | undefined = show?.feedUrl;

  if (!episodeId) {
    if (!feedUrl) throw new WsError("NOT_FOUND", "Apple did not return an RSS feed for this show");
    return resolveFeedUrl(input, feedUrl, ctx, { kind: "apple" });
  }

  const ep = results.find((r) => String(r.trackId) === episodeId);
  if (feedUrl) {
    try {
      const feed = parseFeed(await fetchText(feedUrl, ctx));
      const guid = ep?.episodeGuid;
      const match = (items: FeedItem[]) =>
        items.find((i) => guid && i.guid === guid) ??
        items.find((i) => ep?.episodeUrl && i.audioUrl === ep.episodeUrl) ??
        items.find((i) => ep?.trackName && i.title === ep.trackName);
      const item = match(feed.items);
      if (item) {
        const r = feedSource(input, feedUrl, feed, item, "apple");
        r.meta.url = input;
        return r;
      }
    } catch (e) {
      ctx.log.debug(`feed lookup failed: ${(e as Error).message}`);
    }
  }

  // Not in the feed window: use Lookup's episode data, or read the audio URL from the episode page.
  let title: string | undefined = ep?.trackName;
  let audio: string | undefined = ep?.episodeUrl;
  if (!audio) {
    const html = await fetchText(input, ctx, { "user-agent": BROWSER_UA });
    audio = /"streamUrl":"([^"]+)"/.exec(html)?.[1]?.replace(/\\u002F/g, "/");
    title ??= /<title>([^<]+?)(?: - [^-<]+ - Apple[^<]*)?<\/title>/.exec(html)?.[1];
  }
  if (!audio) {
    throw new WsError("NOT_FOUND", "Could not find this episode's audio", {
      hint: "The episode may be Apple-exclusive or subscription-only",
    });
  }
  return {
    meta: {
      input,
      id: `apple:${hash(episodeId).slice(0, 12)}`,
      kind: "apple",
      title: title ?? `Apple episode ${episodeId}`,
      url: input,
      uploader: show?.collectionName,
      published: ep?.releaseDate,
      duration: ep?.trackTimeMillis ? ep.trackTimeMillis / 1000 : undefined,
    },
    candidates: [audioFromUrl(audio, "episode audio")],
  };
}
