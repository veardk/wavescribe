import assert from "node:assert/strict";
import { test } from "node:test";
import { detectFormat, parseText } from "../src/parsers/index.ts";

test("srt with tags and entities", () => {
  const r = parseText(
    "1\n00:00:01,000 --> 00:00:02,500\n<i>Hello</i> &amp; welcome\n\n2\n00:00:03,000 --> 00:00:04,000\n第二句\n",
    "srt",
  );
  assert.equal(r.format, "srt");
  assert.deepEqual(
    r.segments.map((s) => [s.start, s.end, s.text]),
    [
      [1, 2.5, "Hello & welcome"],
      [3, 4, "第二句"],
    ],
  );
});

test("vtt rolling auto-captions are de-duplicated", () => {
  const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000 align:start
hello world

00:00:02.000 --> 00:00:03.000
hello world
this is new

00:00:03.000 --> 00:00:04.000
this is new
`;
  const segs = parseText(vtt).segments;
  assert.deepEqual(
    segs.map((s) => s.text),
    ["hello world", "this is new"],
  );
});

test("vtt voice tag becomes speaker; CJK lines join without spaces", () => {
  const segs = parseText("WEBVTT\n\n00:01.000 --> 00:02.000\n<v Alice>我们今天\n聊一聊\n").segments;
  assert.equal(segs[0]!.speaker, "Alice");
  assert.equal(segs[0]!.text, "我们今天聊一聊");
});

test("ttml (Apple style) with spans and agents", () => {
  const ttml = `<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml" xml:lang="en"><body><div>
    <p begin="0.420" end="5.520" ttm:agent="SPEAKER_1"><span begin="0.42" end="1.0">Hello</span> <span>there,</span> <span>friend.</span></p>
    <p begin="00:00:06.000" end="00:00:07.500">Second &amp; last</p></div></body></tt>`;
  const r = parseText(ttml, "ttml");
  assert.equal(r.format, "ttml");
  assert.equal(r.language, "en");
  assert.deepEqual(
    r.segments.map((s) => [s.start, s.end, s.text, s.speaker]),
    [
      [0.42, 5.52, "Hello there, friend.", "SPEAKER_1"],
      [6, 7.5, "Second & last", undefined],
    ],
  );
});

test("ttml tick times", () => {
  const r = parseText(`<tt ttp:tickRate="10000000"><body><p begin="10000000t" end="25000000t">x</p></body></tt>`);
  assert.deepEqual([r.segments[0]!.start, r.segments[0]!.end], [1, 2.5]);
});

test("json dialects: youtube json3, bilibili, podcast 2.0, generic", () => {
  const yt = parseText(
    JSON.stringify({
      events: [
        { tStartMs: 1000, dDurationMs: 500, segs: [{ utf8: "hi" }] },
        { tStartMs: 2000, aAppend: 1, segs: [{ utf8: "\n" }] },
      ],
    }),
  );
  assert.deepEqual(yt.segments, [{ start: 1, end: 1.5, text: "hi" }]);
  const bili = parseText(JSON.stringify({ body: [{ from: 1.5, to: 3, content: "你好" }] }));
  assert.deepEqual(bili.segments, [{ start: 1.5, end: 3, text: "你好" }]);
  const pc = parseText(
    JSON.stringify({
      version: "1.0.0",
      segments: [{ speaker: "Adam", startTime: 0.5, endTime: 2, body: "Welcome back." }],
    }),
  );
  assert.deepEqual(pc.segments, [{ start: 0.5, end: 2, text: "Welcome back.", speaker: "Adam" }]);
  assert.equal(pc.timed, true);
});

test("podcast 2.0 word-level json is merged into sentences, text unchanged", () => {
  const words = "This is a test. And another one here".split(" ");
  const segs = words.flatMap((w, i) => [{ startTime: i, endTime: i + 0.5, body: w }]);
  while (segs.length < 24) segs.push({ startTime: segs.length, endTime: segs.length + 0.5, body: "x" });
  const r = parseText(JSON.stringify({ segments: segs }));
  assert.equal(r.segments[0]!.text, "This is a test.");
  assert.equal(r.segments.map((s) => s.text).join(" "), segs.map((s) => s.body).join(" "));
});

test("plain text and html are untimed paragraphs", () => {
  const t = parseText("First para\nstill first.\n\nSecond.", "txt");
  assert.equal(t.timed, false);
  assert.deepEqual(
    t.segments.map((s) => s.text),
    ["First para still first.", "Second."],
  );
  const h = parseText("<html><body><p>One &amp; two</p><p>Three</p></body></html>", "html");
  assert.deepEqual(
    h.segments.map((s) => s.text),
    ["One & two", "Three"],
  );
});

test("format detection", () => {
  assert.equal(detectFormat("WEBVTT\n\n"), "vtt");
  assert.equal(detectFormat("1\n00:00:01,000 --> 00:00:02,000\nx"), "srt");
  assert.equal(detectFormat("<tt xmlns=''>"), "ttml");
  assert.equal(detectFormat('{"a":1}'), "json");
  assert.equal(detectFormat("hello"), "txt");
});
