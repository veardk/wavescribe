// RSS / podcast feeds: list episodes, pick one, prefer a published transcript, else the enclosure audio.

import { WsError } from "../core/errors.ts";
import { parseClock } from "../core/time.ts";
import type { Candidate, EpisodeInfo, ResolvedSource, SourceKind } from "../core/types.ts";
import { hash } from "../utils/fs.ts";
import { attr, parseXml, textOf } from "../utils/xml.ts";
import { audioFromUrl, fetchText, textFromUrl } from "./candidates.ts";
import type { SourceContext } from "./types.ts";

export interface FeedItem extends EpisodeInfo {
  link?: string;
  transcripts: { url: string; type: string; language?: string; rel?: string }[];
}

export interface Feed {
  title?: string;
  author?: string;
  link?: string;
  items: FeedItem[];
}

export const looksLikeFeed = (text: string) =>
  /<(rss|feed)\b[\s\S]{0,2000}?(<channel\b|xmlns="http:\/\/www\.w3\.org\/2005\/Atom")/i.test(text.slice(0, 5000));

const durationOf = (v: string | undefined): number | undefined => {
  if (!v) return undefined;
  return /^\d+(\.\d+)?$/.test(v.trim()) ? Number(v) : parseClock(v);
};

export function parseFeed(xml: string): Feed {
  const doc = parseXml(xml);
  const ch = doc?.rss?.channel ?? doc?.feed;
  if (!ch) throw new WsError("BAD_INPUT", "Not an RSS/Atom feed");
  const rawItems: any[] = ch.item ?? ch.entry ?? [];
  const items: FeedItem[] = rawItems.map((it, i) => {
    const enclosures: any[] = it.enclosure ?? [];
    const audio = enclosures.find((e) => /^(audio|video)\//.test(attr(e, "type") ?? "")) ?? enclosures[0];
    const links: any[] = it.link ?? [];
    const atomAudio = links.find((l) => attr(l, "rel") === "enclosure");
    const date = textOf(it.pubDate ?? it.published ?? it.updated);
    const ts = date ? Date.parse(date) : NaN;
    return {
      index: i + 1,
      title: textOf(it.title).trim(),
      guid: textOf(it.guid ?? it.id).trim() || undefined,
      published: Number.isFinite(ts) ? new Date(ts).toISOString() : undefined,
      duration: durationOf(textOf(it["itunes:duration"])),
      audioUrl: attr(audio, "url") ?? attr(atomAudio, "href"),
      link: textOf(links[0]) || attr(links[0], "href"),
      transcripts: (it["podcast:transcript"] ?? [])
        .map((t: any) => ({
          url: attr(t, "url")!,
          type: attr(t, "type") ?? "",
          language: attr(t, "language"),
          rel: attr(t, "rel"),
        }))
        .filter((t: any) => t.url),
    };
  });
  // Feeds are newest-first by convention; enforce it when dates exist so `latest` / `3` mean what they say.
  if (items.every((i) => i.published)) {
    items.sort((a, b) => Date.parse(b.published!) - Date.parse(a.published!));
    for (const [i, it] of items.entries()) it.index = i + 1;
  }
  return {
    title: textOf(ch.title).trim() || undefined,
    author: textOf(ch["itunes:author"] ?? ch.author?.name).trim() || undefined,
    link: textOf(ch.link?.[0]) || undefined,
    items,
  };
}

/** `latest` | `3` (1 = newest) | `guid:<guid>` | `2026-11-01` | title keywords. */
export function selectEpisode(items: FeedItem[], selector: string | undefined): FeedItem {
  if (!items.length) throw new WsError("NOT_FOUND", "The feed has no episodes");
  const sel = (selector ?? "latest").trim();
  if (sel === "latest" || sel === "") return items[0]!;
  if (/^\d+$/.test(sel)) {
    const it = items[Number(sel) - 1];
    if (!it) throw new WsError("NOT_FOUND", `Episode ${sel} does not exist (the feed has ${items.length})`);
    return it;
  }
  if (sel.startsWith("guid:")) {
    const it = items.find((i) => i.guid === sel.slice(5));
    if (!it) throw new WsError("NOT_FOUND", `No episode with guid ${sel.slice(5)}`);
    return it;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(sel)) {
    const it = items.find((i) => i.published?.startsWith(sel));
    if (!it) throw new WsError("NOT_FOUND", `No episode published on ${sel}`);
    return it;
  }
  const needle = sel.toLowerCase();
  const hits = items.filter((i) => i.title.toLowerCase().includes(needle));
  if (!hits.length)
    throw new WsError("NOT_FOUND", `No episode title contains "${sel}"`, {
      hint: "Run `wavescribe info <feed>` to list episodes",
    });
  return hits[0]!;
}

const episodeInfo = ({ transcripts: _t, link: _l, ...e }: FeedItem): EpisodeInfo => e;

/** The `--episode` selector; without one, ask the caller (interactive runs), else the newest episode. */
export async function chooseItem(
  items: FeedItem[],
  ctx: Pick<SourceContext, "episode" | "chooseEpisode">,
): Promise<FeedItem> {
  if (ctx.episode || !ctx.chooseEpisode || items.length < 2) return selectEpisode(items, ctx.episode);
  const index = await ctx.chooseEpisode(items.map(episodeInfo));
  return items[(index ?? 1) - 1] ?? items[0]!;
}

const TRANSCRIPT_RANK = (type: string): number => {
  const t = type.toLowerCase();
  if (t.includes("json")) return 0;
  if (t.includes("vtt")) return 1;
  if (t.includes("srt") || t.includes("subrip")) return 2;
  if (t.includes("html")) return 3;
  return 4;
};
const timedType = (type: string) => /json|vtt|srt|subrip/i.test(type);
const extForType = (type: string) =>
  /json/i.test(type)
    ? "json"
    : /vtt/i.test(type)
      ? "vtt"
      : /srt|subrip/i.test(type)
        ? "srt"
        : /html/i.test(type)
          ? "html"
          : "txt";

export function candidatesForItem(item: FeedItem): Candidate[] {
  const out: Candidate[] = [...item.transcripts]
    .sort((a, b) => TRANSCRIPT_RANK(a.type) - TRANSCRIPT_RANK(b.type))
    .map((t) =>
      textFromUrl(t.url, `published transcript (${t.type || "unknown type"})`, "publisher", "rss-transcript", {
        ext: extForType(t.type),
        timed: timedType(t.type),
        language: t.language,
      }),
    );
  if (item.audioUrl) out.push(audioFromUrl(item.audioUrl, "episode audio"));
  return out;
}

export function feedSource(
  input: string,
  feedUrl: string,
  feed: Feed,
  item: FeedItem,
  kind: SourceKind = "rss",
): ResolvedSource {
  return {
    meta: {
      input,
      id: `rss:${hash(feedUrl, item.guid ?? item.audioUrl ?? item.title).slice(0, 16)}`,
      kind,
      title: item.title,
      url: item.link ?? item.audioUrl,
      uploader: feed.title,
      published: item.published,
      duration: item.duration,
      episode: {
        index: item.index,
        title: item.title,
        guid: item.guid,
        published: item.published,
        duration: item.duration,
        audioUrl: item.audioUrl,
      },
    },
    candidates: candidatesForItem(item),
    episodes: feed.items.map(episodeInfo),
  };
}

export interface FeedOptions {
  /** Source kind recorded in the metadata (feeds reached through Apple / Ximalaya links). */
  kind?: SourceKind;
  /** Choose the episode directly instead of using the `--episode` selector. */
  pick?: (items: FeedItem[]) => FeedItem | undefined;
}

export async function resolveFeedUrl(
  input: string,
  feedUrl: string,
  ctx: SourceContext,
  opts: FeedOptions = {},
): Promise<ResolvedSource> {
  const feed = parseFeed(await fetchText(feedUrl, ctx));
  const item = opts.pick?.(feed.items) ?? (await chooseItem(feed.items, ctx));
  return feedSource(input, feedUrl, feed, item, opts.kind);
}
