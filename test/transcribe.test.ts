import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { emptyConfig } from "../src/config/config.ts";
import type { WsError } from "../src/core/errors.ts";
import { definePlugin, PLUGIN_API_VERSION, type PollResult, type ProviderPlugin } from "../src/providers/plugin.ts";
import { type TranscribeSettings, transcribeAudio } from "../src/transcribe/index.ts";
import { conversionReason } from "../src/transcribe/prepare.ts";
import { remoteAudio, runContext, tempDir } from "./helpers.ts";

const settings = (o: Partial<TranscribeSettings> = {}): TranscribeSettings => ({
  speakers: false,
  extra: {},
  timeoutSeconds: 5,
  ...o,
});
const run = (plugin: ProviderPlugin, workDir: string, s = settings()) =>
  transcribeAudio(
    remoteAudio(),
    runContext(workDir),
    { provider: plugin.id, ...s },
    emptyConfig(),
    new Map([[plugin.id, plugin]]),
  );
const taskFiles = (workDir: string, id: string) =>
  fs.readdirSync(path.join(workDir, "asr", id)).filter((f) => f.endsWith(".task.json"));

test("sync provider: raw response is cached and speakers are renamed", async () => {
  let calls = 0;
  const plugin = definePlugin({
    apiVersion: PLUGIN_API_VERSION,
    id: "sync",
    name: "Sync",
    credentials: [],
    models: [
      { id: "m", default: true, input: { delivery: ["url"] }, output: { timestamps: "segment", speakers: true } },
    ],
    transcribe: async () => {
      calls++;
      return [
        ["x", 0, 1, "hi"],
        ["y", 1, 2, "yo"],
      ];
    },
    normalize: (raw: any) => ({
      segments: raw.map(([speaker, start, end, text]: any) => ({ speaker, start, end, text })),
    }),
  });
  const dir = tempDir();
  const first = await run(plugin, dir);
  const second = await run(plugin, dir);
  assert.equal(calls, 1);
  assert.deepEqual(
    second.segments.map((s) => s.speaker),
    ["S1", "S2"],
  );
  assert.deepEqual(first, second);
});

function asyncPlugin(states: PollResult[], submitted: string[]): ProviderPlugin {
  let i = 0;
  return definePlugin({
    apiVersion: PLUGIN_API_VERSION,
    id: "async",
    name: "Async",
    credentials: [],
    models: [{ id: "m", default: true, input: { delivery: ["url"] }, output: { timestamps: "segment" } }],
    pollIntervalMs: { initial: 1, max: 1 },
    submit: async () => {
      submitted.push(`t${submitted.length + 1}`);
      return { id: submitted.at(-1)! };
    },
    poll: async () => states[Math.min(i++, states.length - 1)]!,
    fetchResult: async (task) => ({ task: task.id }),
    normalize: (raw: any) => ({ segments: [{ start: 0, end: 1, text: raw.task }] }),
  });
}

test("async provider: submit → poll → fetchResult; task file removed when done", async () => {
  const dir = tempDir();
  const submitted: string[] = [];
  const out = await run(asyncPlugin([{ state: "pending" }, { state: "done" }], submitted), dir);
  assert.equal(out.segments[0]!.text, "t1");
  assert.deepEqual(taskFiles(dir, "async"), []);
});

test("async provider: a timeout keeps the task, and the next run resumes it", async () => {
  const dir = tempDir();
  const submitted: string[] = [];
  await assert.rejects(
    run(asyncPlugin([{ state: "pending" }], submitted), dir, settings({ timeoutSeconds: 0 })),
    (e: WsError) => e.code === "TIMEOUT",
  );
  assert.equal(taskFiles(dir, "async").length, 1);
  const out = await run(asyncPlugin([{ state: "done" }], submitted), dir);
  assert.deepEqual(submitted, ["t1"]);
  assert.equal(out.segments[0]!.text, "t1");
});

test("async provider: a failed task is forgotten so the next run resubmits", async () => {
  const dir = tempDir();
  const submitted: string[] = [];
  await assert.rejects(run(asyncPlugin([{ state: "failed", message: "bad audio" }], submitted), dir), /bad audio/);
  assert.deepEqual(taskFiles(dir, "async"), []);
});

test("audio is re-encoded only for a reason, and the step says which", () => {
  const groq = { delivery: ["multipart" as const], maxBytes: 25e6, formats: ["mp3", "m4a", "wav"] };
  const m4a = (size: number) => ({ ext: "m4a", size, hasVideo: false });
  assert.equal(conversionReason(m4a(17.2e6), groq, "mp3"), undefined, "small, accepted audio goes as it is");
  assert.equal(conversionReason(m4a(17.2e6), groq, "mp3", 120), "Cutting out the first 120s (--clip)");
  assert.equal(
    conversionReason(m4a(27.5e6), groq, "mp3"),
    "Compressing 27.5 MB of audio to fit the 25 MB upload limit",
  );
  assert.equal(
    conversionReason({ ext: "mp4", size: 1e6, hasVideo: true }, groq, "mp3"),
    "Extracting the audio track as mp3",
  );
  assert.equal(conversionReason({ ext: "bin", size: 1e6, hasVideo: false }, groq, "mp3"), "Converting .bin to mp3");
  assert.equal(
    conversionReason({ ext: "ogg", size: 1e6, hasVideo: false }, groq, "mp3"),
    "Converting .ogg to mp3 (this model does not accept .ogg)",
  );
});
