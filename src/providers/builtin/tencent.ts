import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { WsError } from "../../core/errors.ts";
import { baseLanguage } from "../../core/lang.ts";
import { fromMs } from "../../core/time.ts";
import type { Segment, Word } from "../../core/types.ts";
import { spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION, type PluginContext } from "../plugin.ts";

// Tencent Cloud ASR.
//  model "flash": 录音文件识别极速版 — synchronous, raw bytes, HMAC-SHA1 signature (≤100 MB, ≤2 h).
//  model "async": 录音文件识别 CreateRecTask / DescribeTaskStatus — TC3-HMAC-SHA256 (URL ≤1 GB / base64 ≤5 MB).
const ENGINE: Record<string, string> = { zh: "16k_zh", en: "16k_en", yue: "16k_yue", ja: "16k_ja", ko: "16k_ko" };
const hmac = (key: crypto.BinaryLike, data: string) => crypto.createHmac("sha256", key).update(data).digest();
const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

/** TC3-HMAC-SHA256 request against asr.tencentcloudapi.com. Exported for tests. */
export function tc3Headers(
  action: string,
  payload: string,
  secretId: string,
  secretKey: string,
  timestamp = Math.floor(Date.now() / 1000),
  region?: string,
) {
  const host = "asr.tencentcloudapi.com";
  const service = "asr";
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const ct = "application/json; charset=utf-8";
  const canonical = ["POST", "/", "", `content-type:${ct}\nhost:${host}\n`, "content-type;host", sha256(payload)].join(
    "\n",
  );
  const scope = `${date}/${service}/tc3_request`;
  const toSign = ["TC3-HMAC-SHA256", String(timestamp), scope, sha256(canonical)].join("\n");
  const kSigning = hmac(hmac(hmac(`TC3${secretKey}`, date), service), "tc3_request");
  const signature = crypto.createHmac("sha256", kSigning).update(toSign).digest("hex");
  return {
    Authorization: `TC3-HMAC-SHA256 Credential=${secretId}/${scope}, SignedHeaders=content-type;host, Signature=${signature}`,
    "Content-Type": ct,
    Host: host,
    "X-TC-Action": action,
    "X-TC-Version": "2019-06-14",
    "X-TC-Timestamp": String(timestamp),
    ...(region ? { "X-TC-Region": region } : {}),
  };
}

/** Flash API signature: HMAC-SHA1 over "POST" + host + path + "?" + sorted query. Exported for tests. */
export function flashSignature(appId: string, query: Record<string, string>, secretKey: string): string {
  const qs = Object.keys(query)
    .sort()
    .map((k) => `${k}=${query[k]}`)
    .join("&");
  return crypto
    .createHmac("sha1", secretKey)
    .update(`POSTasr.cloud.tencent.com/asr/flash/v1/${appId}?${qs}`)
    .digest("base64");
}

async function api(ctx: PluginContext, action: string, body: Record<string, unknown>) {
  const payload = JSON.stringify(body);
  const res = await ctx.http.request("https://asr.tencentcloudapi.com", {
    method: "POST",
    headers: tc3Headers(
      action,
      payload,
      ctx.credentials.secretId!,
      ctx.credentials.secretKey!,
      undefined,
      ctx.settings.region,
    ),
    body: payload,
  });
  const r = res.data?.Response ?? {};
  if (r.Error) {
    const code = String(r.Error.Code ?? "");
    throw new WsError(
      code.startsWith("AuthFailure") ? "AUTH" : "PROVIDER_ERROR",
      `Tencent ${action}: ${code} ${r.Error.Message}`,
    );
  }
  return r;
}

const engineFor = (opts: { providerLanguage?: string; extra: Record<string, string> }, ctx: PluginContext) =>
  opts.extra.engine ?? ctx.settings.engine ?? ENGINE[opts.providerLanguage ?? "zh"] ?? "16k_zh";

const voiceFormat = (fmt: string | undefined) => (fmt === "ogg" || fmt === "opus" ? "ogg-opus" : (fmt ?? "mp3"));

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "tencent",
  name: "腾讯云 录音文件识别",
  homepage: "https://cloud.tencent.com/document/product/1093/52097",
  credentials: [
    { name: "secretId", env: "TENCENTCLOUD_SECRET_ID" },
    { name: "secretKey", env: "TENCENTCLOUD_SECRET_KEY" },
    { name: "appId", env: "TENCENTCLOUD_APP_ID", optional: true, description: "required by the flash model" },
  ],
  settings: [
    { name: "engine", env: "TENCENT_ASR_ENGINE", description: "engine type, e.g. 16k_zh, 16k_zh_en, 16k_zh_large" },
    { name: "region", env: "TENCENTCLOUD_REGION" },
  ],
  models: [
    {
      id: "flash",
      default: true,
      mode: "sync",
      input: {
        delivery: ["raw"],
        maxBytes: 100e6,
        maxSeconds: 2 * 3600,
        formats: ["mp3", "wav", "m4a", "aac", "ogg", "amr"],
      },
      output: { timestamps: "word", speakers: true },
    },
    {
      id: "async",
      mode: "async",
      input: { delivery: ["url", "base64"], maxBytes: 5e6, maxSeconds: 5 * 3600 },
      output: { timestamps: "word", speakers: true },
    },
  ],
  mapLanguage: (lang) => baseLanguage(lang),
  pollIntervalMs: { initial: 3000, max: 15_000 },

  // flash: synchronous
  async transcribe(audio, opts, ctx) {
    if (opts.model !== "flash") throw new WsError("INTERNAL", "tencent: only the flash model is synchronous");
    if (audio.kind !== "file") throw new WsError("BAD_INPUT", "tencent flash needs a local file");
    const appId = ctx.credentials.appId;
    if (!appId)
      throw new WsError("AUTH", "tencent flash needs TENCENTCLOUD_APP_ID", {
        hint: "Export TENCENTCLOUD_APP_ID, or use the async model (-m async)",
      });
    const query: Record<string, string> = {
      secretid: ctx.credentials.secretId!,
      timestamp: String(Math.floor(Date.now() / 1000)),
      engine_type: engineFor(opts, ctx),
      voice_format: voiceFormat(audio.format),
      speaker_diarization: opts.speakers ? "1" : "0",
      filter_dirty: "0",
      filter_modal: "0",
      filter_punc: "0",
      convert_num_mode: "1",
      word_info: "2",
      first_channel_only: "1",
      ...Object.fromEntries(Object.entries(opts.extra).filter(([k]) => k !== "engine")),
    };
    const signature = flashSignature(appId, query, ctx.credentials.secretKey!);
    const res = await ctx.http.request(`https://asr.cloud.tencent.com/asr/flash/v1/${appId}`, {
      method: "POST",
      query,
      headers: { authorization: signature, "content-type": "application/octet-stream" },
      body: await fsp.readFile(audio.path),
    });
    if (res.data?.code !== 0)
      throw new WsError("PROVIDER_ERROR", `Tencent flash: ${res.data?.code} ${res.data?.message}`);
    return res.data;
  },

  // async: CreateRecTask → DescribeTaskStatus
  async submit(audio, opts, ctx) {
    const body: Record<string, unknown> = { EngineModelType: engineFor(opts, ctx), ChannelNum: 1, ResTextFormat: 2 };
    if (audio.kind === "url") Object.assign(body, { SourceType: 0, Url: audio.url });
    else if (audio.kind === "file")
      Object.assign(body, { SourceType: 1, Data: await ctx.base64(audio.path), DataLen: audio.size });
    if (opts.speakers) Object.assign(body, { SpeakerDiarization: 1, SpeakerNumber: 0 });
    for (const [k, v] of Object.entries(opts.extra)) if (k !== "engine") body[k] = /^\d+$/.test(v) ? Number(v) : v;
    const r = await api(ctx, "CreateRecTask", body);
    return { id: String(r.Data.TaskId) };
  },

  async poll(task, ctx) {
    const r = await api(ctx, "DescribeTaskStatus", { TaskId: Number(task.id) });
    const d = r.Data ?? {};
    if (d.Status === 2) return { state: "done", raw: { async: d } };
    if (d.Status === 3) return { state: "failed", message: str(d.ErrorMsg ?? "failed") };
    return { state: "pending", detail: d.StatusStr };
  },

  normalize(raw: any, opts) {
    const segments: Segment[] = [];
    const who = (v: unknown) => (opts.speakers ? spk(v) : undefined);
    if (raw?.async) {
      for (const s of raw.async.ResultDetail ?? []) {
        const start = fromMs(s.StartMs);
        const words: Word[] = (s.Words ?? []).map((w: any) => ({
          start: start + fromMs(w.OffsetStartMs),
          end: start + fromMs(w.OffsetEndMs),
          text: str(w.Word),
        }));
        const seg: Segment = { start, end: fromMs(s.EndMs), text: str(s.FinalSentence).trim(), words };
        if (who(s.SpeakerId)) seg.speaker = who(s.SpeakerId);
        segments.push(seg);
      }
      return { segments, duration: raw.async.AudioDuration ? Number(raw.async.AudioDuration) : undefined };
    }
    for (const ch of raw?.flash_result ?? []) {
      for (const s of ch.sentence_list ?? []) {
        const words: Word[] = (s.word_list ?? []).map((w: any) => ({
          start: fromMs(w.start_time),
          end: fromMs(w.end_time),
          text: str(w.word),
        }));
        const seg: Segment = { start: fromMs(s.start_time), end: fromMs(s.end_time), text: str(s.text).trim(), words };
        if (who(s.speaker_id)) seg.speaker = who(s.speaker_id);
        segments.push(seg);
      }
    }
    return { segments, duration: raw?.audio_duration ? fromMs(raw.audio_duration) : undefined };
  },
});
