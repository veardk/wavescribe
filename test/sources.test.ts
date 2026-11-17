import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAppleUrl } from "../src/sources/apple.ts";
import { bvidOf } from "../src/sources/bilibili/index.ts";
import { candidatesForItem, chooseItem, parseFeed, selectEpisode } from "../src/sources/rss.ts";
import { orderTracks, youtubeId } from "../src/sources/youtube.ts";
import { pickTracks } from "../src/sources/ytdlp.ts";

const FEED = `<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0"><channel>
<title>Show</title>
<item><title>Old one</title><guid>g1</guid><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><enclosure url="https://x/1.mp3" type="audio/mpeg"/></item>
<item><title>New &amp; shiny</title><guid>g2</guid><pubDate>Tue, 02 Sep 2026 10:00:00 GMT</pubDate><itunes:duration>01:02:03</itunes:duration>
  <enclosure url="https://x/2.mp3" type="audio/mpeg"/>
  <podcast:transcript url="https://x/2.html" type="text/html"/>
  <podcast:transcript url="https://x/2.vtt" type="text/vtt" language="en"/>
</item></channel></rss>`;

test("feed parsing sorts newest first and reads podcast:transcript", () => {
  const f = parseFeed(FEED);
  assert.equal(f.title, "Show");
  assert.deepEqual(
    f.items.map((i) => [i.index, i.title]),
    [
      [1, "New & shiny"],
      [2, "Old one"],
    ],
  );
  assert.equal(f.items[0]!.duration, 3723);
  assert.equal(f.items[0]!.transcripts.length, 2);
  const c = candidatesForItem(f.items[0]!);
  assert.deepEqual(
    c.map((x) => [x.type, x.type === "text" ? x.timed : undefined]),
    [
      ["text", true],
      ["text", false],
      ["audio", undefined],
    ],
  );
});

test("episode selectors", () => {
  const items = parseFeed(FEED).items;
  assert.equal(selectEpisode(items, undefined).guid, "g2");
  assert.equal(selectEpisode(items, "2").guid, "g1");
  assert.equal(selectEpisode(items, "guid:g1").title, "Old one");
  assert.equal(selectEpisode(items, "2026-09-01").guid, "g1");
  assert.equal(selectEpisode(items, "shiny").guid, "g2");
  assert.throws(() => selectEpisode(items, "9"), /does not exist/);
});

test("url recognisers", () => {
  assert.equal(youtubeId("https://youtu.be/UF8uR6Z6KLc?t=3"), "UF8uR6Z6KLc");
  assert.equal(youtubeId("https://www.youtube.com/shorts/UF8uR6Z6KLc"), "UF8uR6Z6KLc");
  assert.equal(youtubeId("https://example.com/watch?v=UF8uR6Z6KLc"), undefined);
  assert.equal(bvidOf("https://www.bilibili.com/video/BV1GJ411x7h7?p=2"), "BV1GJ411x7h7");
  assert.equal(bvidOf("https://www.bilibili.com/video/av170001"), "BV17x411w7KC");
  assert.deepEqual(parseAppleUrl("https://podcasts.apple.com/cn/podcast/x/id6816777519?i=1000800642062"), {
    showId: "6816777519",
    episodeId: "1000800642062",
    country: "cn",
  });
});

test("caption track choice: wanted → spoken → English; human before auto", () => {
  const tracks = [
    { baseUrl: "a", languageCode: "en", kind: "asr" },
    { baseUrl: "b", languageCode: "en" },
    { baseUrl: "c", languageCode: "zh-Hans" },
  ];
  assert.deepEqual(
    orderTracks(tracks).map((t) => t.baseUrl),
    ["b", "a"],
  );
  assert.deepEqual(
    orderTracks(tracks, "zh").map((t) => t.baseUrl),
    ["c"],
  );
  assert.deepEqual(
    pickTracks({ subtitles: { "zh-CN": [] }, automatic_captions: { "zh-CN": [], "en-orig": [] }, language: "zh" })[0],
    { key: "zh-CN", origin: "human" },
  );
  assert.deepEqual(pickTracks({ subtitles: { "zh-CN": [] }, automatic_captions: { "zh-CN": [] } }, "zh"), [
    { key: "zh-CN", origin: "human" },
  ]);
  assert.deepEqual(pickTracks({ subtitles: {}, automatic_captions: { "en-orig": [], fr: [] } }), [
    { key: "en-orig", origin: "auto-caption" },
  ]);
});

test("feed episodes: -e wins, else the interactive chooser, else the newest", async () => {
  const items = parseFeed(FEED).items;
  let asked: string[] = [];
  const chooseEpisode = async (eps: { title: string }[]) => {
    asked = eps.map((e) => e.title);
    return 2;
  };
  assert.equal((await chooseItem(items, { chooseEpisode })).title, "Old one");
  assert.deepEqual(asked, ["New & shiny", "Old one"]);
  assert.equal((await chooseItem(items, { episode: "1", chooseEpisode })).title, "New & shiny");
  assert.equal((await chooseItem(items, {})).title, "New & shiny");
  assert.equal((await chooseItem(items, { chooseEpisode: async () => undefined })).title, "New & shiny");
});
