import { baseLanguage } from "../../core/lang.ts";
import type { Word } from "../../core/types.ts";
import { groupWords, num, spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION, type PluginContext } from "../plugin.ts";

// https://docs.speechmatics.com/speech-to-text/batch — async jobs; words + punctuation stream. Seconds.
const base = (ctx: PluginContext) => `https://${ctx.settings.region ?? "eu1"}.asr.api.speechmatics.com/v2`;
const auth = (ctx: PluginContext) => ({ authorization: `Bearer ${ctx.credentials.apiKey}` });
const spec = (id: string, def = false) => ({
  id,
  default: def,
  input: { delivery: ["multipart", "url"] as ("multipart" | "url")[], maxBytes: 1e9 },
  output: { timestamps: "word" as const, speakers: true, detectLanguage: true },
});

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "speechmatics",
  name: "Speechmatics",
  homepage: "https://docs.speechmatics.com",
  credentials: [{ name: "apiKey", env: "SPEECHMATICS_API_KEY" }],
  settings: [{ name: "region", env: "SPEECHMATICS_REGION", default: "eu1", description: "eu1 | us1 | au1" }],
  // model id = operating point
  models: [spec("enhanced", true), spec("standard")],
  // Mandarin is `cmn`, Cantonese `yue`; others ISO-639-1.
  async verify(ctx) {
    await ctx.http.request(`${base(ctx)}/jobs`, {
      query: { limit: 1 },
      headers: auth(ctx),
      retries: 1,
      timeoutMs: 20_000,
      expect: "none",
    });
  },
  mapLanguage: (lang) => {
    const b = baseLanguage(lang);
    return b === "zh" ? "cmn" : b;
  },
  pollIntervalMs: { initial: 5000, max: 15_000 },

  async submit(audio, opts, ctx) {
    const config: Record<string, any> = {
      type: "transcription",
      transcription_config: {
        language: opts.providerLanguage ?? "auto",
        operating_point: opts.model,
        ...(opts.speakers ? { diarization: "speaker" } : {}),
      },
    };
    if (opts.prompt)
      config.transcription_config.additional_vocab = opts.prompt
        .split(/[,，\n]/)
        .map((s) => ({ content: s.trim() }))
        .filter((v) => v.content);
    for (const [k, v] of Object.entries(opts.extra)) config.transcription_config[k] = v;
    const form = new FormData();
    if (audio.kind === "url") config.fetch_data = { url: audio.url };
    else if (audio.kind === "file") form.append("data_file", await ctx.blob(audio.path, audio.mime), audio.filename);
    form.append("config", JSON.stringify(config));
    const res = await ctx.http.request(`${base(ctx)}/jobs`, { method: "POST", headers: auth(ctx), body: form });
    return { id: res.data.id };
  },

  async poll(task, ctx) {
    const job = (await ctx.http.request(`${base(ctx)}/jobs/${task.id}`, { headers: auth(ctx) })).data?.job ?? {};
    if (job.status === "done") return { state: "done" };
    if (job.status === "rejected" || job.status === "deleted" || job.status === "expired")
      return { state: "failed", message: `${job.status}${job.errors ? `: ${JSON.stringify(job.errors)}` : ""}` };
    return { state: "pending", detail: job.status };
  },

  async fetchResult(task, ctx) {
    return (
      await ctx.http.request(`${base(ctx)}/jobs/${task.id}/transcript`, {
        headers: auth(ctx),
        query: { format: "json-v2" },
      })
    ).data;
  },

  normalize(raw: any) {
    const words: Word[] = (raw?.results ?? [])
      .map((r: any) => {
        const alt = r.alternatives?.[0] ?? {};
        return {
          start: num(r.start_time),
          end: num(r.end_time),
          text: str(alt.content),
          ...(spk(alt.speaker) ? { speaker: spk(alt.speaker) } : {}),
        };
      })
      .filter((w: Word) => w.text);
    return {
      segments: groupWords(words),
      language: raw?.metadata?.transcription_config?.language,
      duration: raw?.job?.duration,
    };
  },
});
