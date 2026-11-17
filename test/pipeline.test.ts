import assert from "node:assert/strict";
import { test } from "node:test";
import type { WsError } from "../src/core/errors.ts";
import { produceTranscript, type RunOptions } from "../src/pipeline.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../src/providers/plugin.ts";
import { env, isolateCache, remoteAudio, source, text } from "./helpers.ts";

isolateCache();

const opts = (o: Partial<RunOptions> = {}): RunOptions => ({
  formats: ["srt"],
  timestamps: false,
  prefer: "captions",
  speakers: false,
  extra: {},
  timeoutSeconds: 5,
  ...o,
});

const echo = definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "echo",
  name: "Echo",
  credentials: [],
  models: [{ id: "m", default: true, input: { delivery: ["url"] }, output: { timestamps: "segment" } }],
  transcribe: async (audio) => ({ url: audio.kind === "url" ? audio.url : "" }),
  normalize: (raw: any) => ({ segments: [{ start: 0, end: 2, text: `heard ${raw.url}` }] }),
});

test("untimed text is skipped when the format needs timestamps", async () => {
  const r = await produceTranscript(source([text("plain", { timed: false }), text("cues")]), opts(), env());
  assert.equal(r.transcript.segments[0]!.text, "cues");
  const md = await produceTranscript(
    source([text("plain", { timed: false }), text("cues")]),
    opts({ formats: ["md"] }),
    env(),
  );
  assert.equal(md.transcript.segments[0]!.text, "plain");
});

test("text whose timing is only known after fetching is checked too", async () => {
  const r = await produceTranscript(
    source([text("late", { timed: false, known: false }), text("cues")]),
    opts(),
    env(),
  );
  assert.equal(r.transcript.segments[0]!.text, "cues");
});

test("a failing candidate falls through to the next one", async () => {
  const r = await produceTranscript(source([text("broken", { fail: "boom" }), remoteAudio()]), opts(), env([echo]));
  assert.equal(r.transcript.origin, "asr");
  assert.equal(r.transcript.provenance.provider, "echo");
});

test("--prefer asr tries audio before captions", async () => {
  const r = await produceTranscript(source([text("cues"), remoteAudio()]), opts({ prefer: "asr" }), env([echo]));
  assert.equal(r.transcript.origin, "asr");
});

test("one failure is reported as itself; several are listed", async () => {
  await assert.rejects(produceTranscript(source([text("a", { fail: "boom" })]), opts(), env()), /boom/);
  await assert.rejects(
    produceTranscript(source([text("a", { fail: "one" }), text("b", { fail: "two" })]), opts(), env()),
    (e: WsError) => e.message.includes("a: one") && e.message.includes("b: two"),
  );
});

test("a missing provider stops the run instead of trying more candidates", async () => {
  await assert.rejects(
    produceTranscript(source([remoteAudio(), text("never reached")]), opts({ prefer: "asr" }), env()),
    (e: WsError) => e.code === "NO_PROVIDER",
  );
});
