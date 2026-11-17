// Runs one audio candidate through a provider plugin: choose model, prepare audio, upload if
// needed, call sync or async APIs (with resumable polling), normalise and stitch chunks.

import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "../config/config.ts";
import { WsError } from "../core/errors.ts";
import { normalizeLanguage } from "../core/lang.ts";
import type { AudioCandidate, RunContext, Segment } from "../core/types.ts";
import type {
  AudioPayload,
  ModelSpec,
  PluginContext,
  ProviderPlugin,
  TaskRef,
  TranscribeOptions,
} from "../providers/plugin.ts";
import type { Registry } from "../providers/registry.ts";
import { chooseProvider, configuredModel, modelMode, pickModel, pluginContext } from "../providers/select.ts";
import { sleep } from "../utils/async.ts";
import { hash, readJson, writeJson } from "../utils/fs.ts";
import { type PreparedChunk, prepareAudio } from "./prepare.ts";
import { normalizeSpeakers, shiftSegments } from "./stitch.ts";

/** What the user asked of speech-to-text. */
export interface TranscribeSettings {
  provider?: string;
  model?: string;
  language?: string;
  speakers: boolean;
  prompt?: string;
  /** Only the first N seconds (for testing). */
  clipSeconds?: number;
  /** Free-form `--opt key=value` pairs passed to the provider. */
  extra: Record<string, string>;
  /** Give up waiting on an asynchronous task after this long. */
  timeoutSeconds: number;
}

export interface AsrOutcome {
  segments: Segment[];
  language?: string;
  timed: boolean;
  provider: string;
  model: string;
}

interface Call {
  plugin: ProviderPlugin;
  model: ModelSpec;
  opts: TranscribeOptions;
  pctx: PluginContext;
  ctx: RunContext;
  timeoutSeconds: number;
}

export async function transcribeAudio(
  candidate: AudioCandidate,
  ctx: RunContext,
  settings: TranscribeSettings,
  cfg: Config,
  reg: Registry,
): Promise<AsrOutcome> {
  const plugin = await chooseProvider(reg, cfg, settings.provider);
  const model = pickModel(plugin, settings.model ?? configuredModel(plugin, cfg), ctx.log);
  const pctx = await pluginContext(plugin, cfg, ctx);
  const language = normalizeLanguage(settings.language);
  const opts: TranscribeOptions = {
    model: model.id,
    language,
    providerLanguage: language ? (plugin.mapLanguage ? plugin.mapLanguage(language, model.id) : language) : undefined,
    speakers: settings.speakers,
    prompt: settings.prompt,
    extra: settings.extra,
  };
  if (settings.speakers && !model.output.speakers) {
    ctx.log.warn(`${plugin.name} ${model.id} does not separate speakers; --speakers is ignored`);
  }

  const prepared = await prepareAudio(candidate, model, ctx, settings.clipSeconds);
  const parts = prepared.chunks.length;
  ctx.log.progress({
    type: "step",
    label: `Transcribing with ${plugin.name} · ${model.id}${parts > 1 ? ` (${parts} parts)` : ""}`,
  });

  const call: Call = { plugin, model, opts, pctx, ctx, timeoutSeconds: settings.timeoutSeconds };
  const cacheKey = {
    model: model.id,
    language: opts.providerLanguage,
    speakers: opts.speakers,
    prompt: opts.prompt,
    extra: opts.extra,
  };
  const results = [];
  for (const [i, chunk] of prepared.chunks.entries()) {
    const base = path.join(ctx.workDir, "asr", plugin.id, hash(plugin.id, chunk.identity, cacheKey).slice(0, 20));
    const cached = ctx.useCache ? await readJson<{ raw: unknown }>(`${base}.json`) : undefined;
    let raw: unknown;
    if (cached) {
      ctx.log.debug(`part ${i + 1}: using cached ${plugin.id} response`);
      raw = cached.raw;
    } else {
      const t0 = Date.now();
      raw = await callProvider(call, chunk, prepared.delivery === "upload", `${base}.task.json`);
      await writeJson(`${base}.json`, {
        provider: plugin.id,
        model: model.id,
        createdAt: new Date().toISOString(),
        raw,
      });
      ctx.log.debug(`part ${i + 1}/${parts} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    }
    ctx.log.progress({ type: "parts", done: i + 1, total: parts });
    results.push({ result: plugin.normalize(raw, opts), offset: chunk.offset });
  }

  const segments = normalizeSpeakers(
    results.flatMap((r) => shiftSegments(r.result.segments, r.offset)).filter((s) => s.text.trim()),
  );
  return {
    segments,
    language: normalizeLanguage(results.find((r) => r.result.language)?.result.language) ?? language,
    timed: results.every((r) => r.result.timed ?? r.result.segments.every((s) => s.start !== undefined)),
    provider: plugin.id,
    model: model.id,
  };
}

/** One request (sync) or one task (async) for one chunk; returns the vendor's raw response. */
async function callProvider(call: Call, chunk: PreparedChunk, upload: boolean, taskFile: string): Promise<unknown> {
  const { plugin, model, opts, pctx, ctx } = call;
  let payload: AudioPayload = chunk.payload;
  if (upload && payload.kind === "file") {
    if (!plugin.upload) throw new WsError("INTERNAL", `${plugin.id} lists "upload" delivery but has no upload()`);
    payload = { kind: "ref", ref: await plugin.upload(payload, pctx), format: payload.format };
  }

  if (modelMode(plugin, model) === "sync") {
    if (!plugin.transcribe)
      throw new WsError("INTERNAL", `${plugin.id} ${model.id} is sync but the plugin has no transcribe()`);
    return plugin.transcribe(payload, opts, pctx);
  }

  if (!plugin.submit || !plugin.poll) {
    throw new WsError("INTERNAL", `${plugin.id} ${model.id} is async but the plugin has no submit()/poll()`);
  }
  let task = ctx.useCache ? await readJson<TaskRef>(taskFile) : undefined;
  if (task) {
    ctx.log.info(`Resuming ${plugin.name} task ${task.id}…`);
  } else {
    task = await plugin.submit(payload, opts, pctx);
    await writeJson(taskFile, task);
    ctx.log.debug(`${plugin.id} task submitted: ${task.id}`);
  }
  try {
    const raw = await waitForTask(call, task, taskFile);
    await fsp.rm(taskFile, { force: true });
    return raw;
  } catch (e) {
    // A vanished task cannot be resumed; timeouts and transient errors can.
    if (e instanceof WsError && e.code === "NOT_FOUND") await fsp.rm(taskFile, { force: true });
    throw e;
  }
}

async function waitForTask(
  { plugin, pctx, ctx, timeoutSeconds }: Call,
  task: TaskRef,
  taskFile: string,
): Promise<unknown> {
  const max = plugin.pollIntervalMs?.max ?? 15_000;
  const deadline = Date.now() + timeoutSeconds * 1000;
  let wait = plugin.pollIntervalMs?.initial ?? 2000;
  let lastDetail = "";
  for (;;) {
    const r = await plugin.poll!(task, pctx);
    if (r.state === "done") return r.raw ?? (plugin.fetchResult ? await plugin.fetchResult(task, pctx) : undefined);
    if (r.state === "failed") {
      await fsp.rm(taskFile, { force: true });
      throw new WsError("PROVIDER_ERROR", `${plugin.name} task failed: ${r.message}`);
    }
    if (r.detail && r.detail !== lastDetail) {
      ctx.log.debug(`${plugin.id} task ${task.id}: ${r.detail}`);
      lastDetail = r.detail;
    }
    if (Date.now() > deadline) {
      throw new WsError("TIMEOUT", `${plugin.name} task ${task.id} still running after ${timeoutSeconds}s`, {
        hint: "Run the same command again later: wavescribe resumes the pending task instead of resubmitting",
      });
    }
    await sleep(wait, ctx.signal);
    wait = Math.min(max, wait * 1.5);
  }
}
