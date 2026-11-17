import { baseLanguage } from "../../core/lang.ts";
import { fromMs } from "../../core/time.ts";
import type { Segment, Word } from "../../core/types.ts";
import { joinWords, spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION, type PluginContext } from "../plugin.ts";

// Alibaba Cloud Model Studio (DashScope) recorded-file recognition: Paraformer / Fun-ASR / Qwen3-ASR filetrans.
// Async: submit (X-DashScope-Async) → GET /tasks/{id} → download transcription_url (valid 24 h). Times in ms.
// Local files go through DashScope's temporary upload (oss:// URL, valid 48 h).
const base = (ctx: PluginContext) => (ctx.settings.baseUrl ?? "https://dashscope.aliyuncs.com").replace(/\/+$/, "");
const auth = (ctx: PluginContext) => ({ authorization: `Bearer ${ctx.credentials.apiKey}` });

const spec = (id: string, def = false) => ({
  id,
  default: def,
  input: { delivery: ["url", "upload"] as ("url" | "upload")[], maxBytes: 2e9, maxSeconds: 12 * 3600 },
  output: { timestamps: "word" as const, speakers: true, detectLanguage: false },
});

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "aliyun",
  name: "阿里云百炼 (Paraformer / Fun-ASR)",
  homepage: "https://help.aliyun.com/zh/model-studio/recording-file-recognition",
  credentials: [{ name: "apiKey", env: "DASHSCOPE_API_KEY" }],
  settings: [
    {
      name: "baseUrl",
      env: "DASHSCOPE_BASE_URL",
      default: "https://dashscope.aliyuncs.com",
      description: "Singapore: https://dashscope-intl.aliyuncs.com",
    },
  ],
  models: [spec("paraformer-v2", true), spec("fun-asr"), spec("qwen3-asr-flash-filetrans")],
  mapLanguage: (lang) => baseLanguage(lang),
  pollIntervalMs: { initial: 3000, max: 15_000 },

  async upload(file, ctx) {
    const policy = (
      await ctx.http.request(`${base(ctx)}/api/v1/uploads`, {
        headers: auth(ctx),
        query: { action: "getPolicy", model: ctx.settings.uploadModel ?? "paraformer-v2" },
      })
    ).data?.data;
    const key = `${policy.upload_dir}/${file.filename}`;
    const form = new FormData();
    form.append("OSSAccessKeyId", policy.oss_access_key_id);
    form.append("Signature", policy.signature);
    form.append("policy", policy.policy);
    form.append("x-oss-object-acl", policy.x_oss_object_acl);
    form.append("x-oss-forbid-overwrite", policy.x_oss_forbid_overwrite);
    form.append("key", key);
    form.append("success_action_status", "200");
    form.append("file", await ctx.blob(file.path, file.mime), file.filename);
    await ctx.http.request(policy.upload_host, { method: "POST", body: form, expect: "none" });
    return `oss://${key}`;
  },

  async submit(audio, opts, ctx) {
    const url = audio.kind === "url" ? audio.url : audio.kind === "ref" ? audio.ref : "";
    const qwen = opts.model.startsWith("qwen");
    const parameters: Record<string, unknown> = {};
    if (qwen) {
      parameters.enable_words = true;
      if (opts.providerLanguage) parameters.language = opts.providerLanguage;
    } else {
      if (opts.providerLanguage) parameters.language_hints = [opts.providerLanguage];
      if (opts.speakers) parameters.diarization_enabled = true;
    }
    for (const [k, v] of Object.entries(opts.extra)) parameters[k] = v === "true" ? true : v === "false" ? false : v;
    const body = { model: opts.model, input: qwen ? { file_url: url } : { file_urls: [url] }, parameters };
    const headers: Record<string, string> = { ...auth(ctx), "X-DashScope-Async": "enable" };
    if (url.startsWith("oss://")) headers["X-DashScope-OssResourceResolve"] = "enable";
    const r = await ctx.http.request(`${base(ctx)}/api/v1/services/audio/asr/transcription`, {
      method: "POST",
      headers,
      json: body,
    });
    return { id: r.data.output.task_id };
  },

  async poll(task, ctx) {
    const out =
      (await ctx.http.request(`${base(ctx)}/api/v1/tasks/${task.id}`, { headers: auth(ctx) })).data?.output ?? {};
    const st = out.task_status;
    if (st === "SUCCEEDED") {
      const sub = out.results?.[0] ?? out.result ?? {};
      if (sub.subtask_status && sub.subtask_status !== "SUCCEEDED")
        return { state: "failed", message: str(sub.message ?? sub.code ?? sub.subtask_status) };
      const url = sub.transcription_url;
      if (!url) return { state: "failed", message: "no transcription_url in result" };
      return { state: "done", raw: (await ctx.http.request(url, { headers: {} })).data };
    }
    if (st === "FAILED" || st === "UNKNOWN") return { state: "failed", message: str(out.message ?? out.code ?? st) };
    return { state: "pending", detail: st };
  },

  normalize(raw: any) {
    const segments: Segment[] = [];
    for (const t of raw?.transcripts ?? []) {
      for (const s of t.sentences ?? []) {
        const words: Word[] = (s.words ?? []).map((w: any) => ({
          start: fromMs(w.begin_time),
          end: fromMs(w.end_time),
          text: `${str(w.text)}${str(w.punctuation)}`,
        }));
        const seg: Segment = {
          start: fromMs(s.begin_time),
          end: fromMs(s.end_time),
          text: str(s.text).trim() || joinWords(words.map((w) => w.text)),
          words,
        };
        if (spk(s.speaker_id)) seg.speaker = spk(s.speaker_id);
        segments.push(seg);
      }
    }
    segments.sort((a, b) => a.start! - b.start!);
    const dur = raw?.properties?.original_duration_in_milliseconds;
    return { segments, duration: dur ? fromMs(dur) : undefined };
  },
});
