import assert from "node:assert/strict";
import { test } from "node:test";
import { valueFromKeyFile } from "../src/config/credentials.ts";
import { normalizeLanguage } from "../src/core/lang.ts";
import { formatSrtTime, fromDuration, parseClock, parseDurationArg } from "../src/core/time.ts";
import type { Transcript } from "../src/core/types.ts";
import { EXPORTERS } from "../src/exporters/index.ts";
import { planCuts } from "../src/media/ffmpeg.ts";
import { attachWords, groupWords, joinWords } from "../src/providers/helpers.ts";
import { normalizeSpeakers } from "../src/transcribe/stitch.ts";
import { idleWatchdog } from "../src/utils/download.ts";
import { slugify } from "../src/utils/fs.ts";

test("time parsing and formatting", () => {
  assert.equal(parseClock("01:02:03.5"), 3723.5);
  assert.equal(parseClock("02:03,250"), 123.25);
  assert.equal(parseClock("12.5s"), 12.5);
  assert.equal(parseClock("1500ms"), 1.5);
  assert.equal(fromDuration("1.200s"), 1.2);
  assert.equal(formatSrtTime(3723.5), "01:02:03,500");
  assert.equal(parseDurationArg("1m30s"), 90);
  assert.equal(parseDurationArg("2m"), 120);
  assert.equal(parseDurationArg("01:30"), 90);
});

test("language normalisation", () => {
  assert.equal(normalizeLanguage("Chinese"), "zh");
  assert.equal(normalizeLanguage("zh_cn"), "zh-CN");
  assert.equal(normalizeLanguage("zh-hans"), "zh-Hans");
  assert.equal(normalizeLanguage("cmn"), "zh");
  assert.equal(normalizeLanguage("zho"), "zh");
  assert.equal(normalizeLanguage("ai-zh"), "zh");
  assert.equal(normalizeLanguage("??"), undefined);
});

test("key files: bare secret or NAME=value lines", () => {
  assert.equal(valueFromKeyFile("gsk_abc\n", "GROQ_API_KEY"), "gsk_abc");
  assert.equal(valueFromKeyFile("GROQ_API_KEY=gsk_abc\n", "GROQ_API_KEY"), "gsk_abc");
  assert.equal(valueFromKeyFile("export A=1\nGROQ_API_KEY='gsk_q'\n", "GROQ_API_KEY"), "gsk_q");
  assert.equal(valueFromKeyFile("A=1\nB=2", "C"), undefined);
});

test("cut planning prefers silences in the last 30% of each window", () => {
  assert.deepEqual(
    planCuts(100, 40, [
      { start: 35, end: 37 },
      { start: 70, end: 71 },
    ]),
    [36, 70.5],
  );
  assert.deepEqual(planCuts(100, 40, []), [40, 80]);
  assert.deepEqual(planCuts(30, 40, []), []);
});

test("word grouping and joining", () => {
  assert.equal(joinWords(["Hello", ",", "world", "!"]), "Hello, world!");
  assert.equal(joinWords(["我们", "今天", "，", "聊"]), "我们今天，聊");
  const segs = groupWords([
    { start: 0, end: 0.4, text: "Hi" },
    { start: 0.5, end: 0.9, text: "there." },
    { start: 1.0, end: 1.3, text: "Next", speaker: "1" },
    { start: 3.0, end: 3.2, text: "far" },
  ]);
  assert.deepEqual(
    segs.map((s) => s.text),
    ["Hi there.", "Next", "far"],
  );
  assert.equal(
    groupWords(
      [
        { start: 0, end: 1, text: " he" },
        { start: 1, end: 2, text: "llo" },
        { start: 2, end: 3, text: " you" },
      ],
      { join: "raw" },
    )[0]!.text,
    "hello you",
  );
  const att = attachWords(
    [
      { start: 0, end: 1, text: "a b" },
      { start: 1, end: 2, text: "c" },
    ],
    [
      { start: 0, end: 0.5, text: "a" },
      { start: 0.5, end: 1, text: "b" },
      { start: 1.2, end: 1.8, text: "c" },
    ],
  );
  assert.deepEqual(
    att.map((s) => s.words?.length),
    [2, 1],
  );
});

test("speakers become S1, S2 by first appearance", () => {
  const out = normalizeSpeakers([
    { text: "a", speaker: "B" },
    { text: "b", speaker: "A" },
    { text: "c", speaker: "B" },
    { text: "d" },
  ]);
  assert.deepEqual(
    out.map((s) => s.speaker),
    ["S1", "S2", "S1", undefined],
  );
});

test("slugify keeps CJK and strips unsafe characters", () => {
  assert.equal(slugify("EP03.饕客与讨海人: a/b?"), "EP03.饕客与讨海人 a b");
  assert.equal(slugify(""), "transcript");
});

test("exporters", () => {
  const t: Transcript = {
    version: 1,
    source: { input: "x", id: "x", kind: "file", title: "T" },
    origin: "asr",
    timed: true,
    language: "en",
    segments: [
      { start: 0, end: 1.5, text: "Hello", speaker: "S1" },
      { start: 2, text: "World" },
    ],
    provenance: { provider: "groq", model: "m", createdAt: "2026-01-01" },
  };
  assert.equal(
    EXPORTERS.srt!.render(t, { timestamps: false }),
    "1\n00:00:00,000 --> 00:00:01,500\n[S1] Hello\n\n2\n00:00:02,000 --> 00:00:04,000\nWorld\n",
  );
  assert.match(
    EXPORTERS.vtt!.render(t, { timestamps: false }),
    /^WEBVTT\n\n00:00:00.000 --> 00:00:01.500\n<v S1>Hello/,
  );
  assert.equal(EXPORTERS.txt!.render(t, { timestamps: true }), "[00:00] [S1] Hello\n[00:02] World\n");
  assert.match(EXPORTERS.md!.render(t, { timestamps: false }), /^# T\n/);
});

test("download watchdog aborts only after a quiet period", async () => {
  const quiet = new AbortController();
  idleWatchdog(quiet, 20);
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(quiet.signal.aborted);

  const busy = new AbortController();
  const w = idleWatchdog(busy, 30);
  for (let i = 0; i < 4; i++) {
    w.write(Buffer.from("x"));
    await new Promise((r) => setTimeout(r, 15));
  }
  w.end();
  assert.ok(!busy.signal.aborted);
});
