import crypto from "node:crypto";
import { WsError } from "../../core/errors.ts";
import { baseLanguage } from "../../core/lang.ts";
import { fromMs } from "../../core/time.ts";
import type { Segment, Word } from "../../core/types.ts";
import { spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION, type PluginContext, type TaskRef } from "../plugin.ts";

// Volcengine Doubao recorded-file recognition (大模型录音文件识别).
// submit/query; status lives in the X-Api-Status-Code response header; the client picks the task id.
const BASE = "https://openspeech.bytedance.com/api/v3/auc/bigmodel";
const RESOURCE: Record<string, string> = { bigasr: "volc.bigasr.auc", seedasr: "volc.seedasr.auc" };

function headers(ctx: PluginContext, model: string, requestId: string): Record<string, string> {
  const h: Record<string, string> = {
    "X-Api-Resource-Id": ctx.settings.resourceId ?? RESOURCE[model] ?? model,
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": "-1",
  };
  if (ctx.credentials.apiKey) h["X-Api-Key"] = ctx.credentials.apiKey;
  else {
    h["X-Api-App-Key"] = ctx.credentials.appId!;
    h["X-Api-Access-Key"] = ctx.credentials.accessToken!;
  }
  return h;
}

const spec = (id: string, def = false) => ({
  id,
  default: def,
  input: { delivery: ["url", "base64"] as ("url" | "base64")[], maxBytes: 60e6, formats: ["mp3", "wav", "ogg"] },
  output: { timestamps: "word" as const, speakers: true, detectLanguage: true },
});

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "volcengine",
  name: "火山引擎 豆包录音文件识别",
  homepage: "https://www.volcengine.com/docs/6561/1354868",
  credentials: [
    { name: "apiKey", env: "VOLC_API_KEY", optional: true, description: "new console: API Key" },
    { name: "appId", env: "VOLC_APP_ID", optional: true, description: "old console: APP ID" },
    { name: "accessToken", env: "VOLC_ACCESS_TOKEN", optional: true, description: "old console: Access Token" },
  ],
  checkCredentials: (v) =>
    v.apiKey || (v.appId && v.accessToken) ? undefined : "set VOLC_API_KEY, or VOLC_APP_ID + VOLC_ACCESS_TOKEN",
  settings: [{ name: "resourceId", env: "VOLC_RESOURCE_ID", description: "override X-Api-Resource-Id" }],
  // model id → resource: bigasr = 豆包录音文件识别 1.0, seedasr = 2.0
  models: [spec("bigasr", true), spec("seedasr")],
  mapLanguage: (lang) => baseLanguage(lang),
  pollIntervalMs: { initial: 3000, max: 10_000 },

  async submit(audio, opts, ctx) {
    const requestId = crypto.randomUUID();
    const audioField: Record<string, unknown> =
      audio.kind === "url"
        ? { url: audio.url, format: audio.format ?? "mp3" }
        : audio.kind === "file"
          ? { data: await ctx.base64(audio.path), format: audio.format }
          : {};
    const request: Record<string, unknown> = {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      show_utterances: true,
    };
    if (opts.speakers) request.enable_speaker_info = true;
    if (opts.prompt)
      request.corpus = {
        context: JSON.stringify({
          hotwords: opts.prompt
            .split(/[,，\n]/)
            .map((w) => ({ word: w.trim() }))
            .filter((w) => w.word),
        }),
      };
    for (const [k, v] of Object.entries(opts.extra)) request[k] = v === "true" ? true : v === "false" ? false : v;
    const res = await ctx.http.request(`${BASE}/submit`, {
      method: "POST",
      headers: headers(ctx, opts.model, requestId),
      json: { user: { uid: "wavescribe" }, audio: audioField, request },
      expect: "text",
    });
    const code = res.headers.get("x-api-status-code");
    if (code !== "20000000")
      throw new WsError(
        "PROVIDER_ERROR",
        `Volcengine submit failed: ${code} ${res.headers.get("x-api-message") ?? ""}`,
      );
    return { id: requestId, data: { model: opts.model } };
  },

  async poll(task: TaskRef, ctx) {
    const res = await ctx.http.request(`${BASE}/query`, {
      method: "POST",
      headers: headers(ctx, String(task.data?.model ?? "bigasr"), task.id),
      json: {},
    });
    const code = res.headers.get("x-api-status-code");
    if (code === "20000000" || code === "20000003") return { state: "done", raw: res.data ?? {} };
    if (code === "20000001" || code === "20000002")
      return { state: "pending", detail: code === "20000001" ? "processing" : "queued" };
    return { state: "failed", message: `${code} ${res.headers.get("x-api-message") ?? ""}`.trim() };
  },

  normalize(raw: any) {
    const segments: Segment[] = (raw?.result?.utterances ?? []).map((u: any) => {
      const words: Word[] = (u.words ?? []).map((w: any) => ({
        start: fromMs(w.start_time),
        end: fromMs(w.end_time),
        text: str(w.text),
      }));
      const s: Segment = { start: fromMs(u.start_time), end: fromMs(u.end_time), text: str(u.text).trim(), words };
      const sp = spk(u.speaker ?? u.additions?.speaker);
      if (sp) s.speaker = sp;
      return s;
    });
    const duration = raw?.audio_info?.duration;
    return {
      segments,
      duration: duration ? fromMs(duration) : undefined,
      language: raw?.result?.additions?.language ?? undefined,
    };
  },
});
