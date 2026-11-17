import { baseLanguage } from "../../core/lang.ts";
import type { Segment, Word } from "../../core/types.ts";
import { num, spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION, type PluginContext } from "../plugin.ts";

// https://docs.gladia.io/api-reference/v2/pre-recorded/init — async; (upload) → submit → poll. Seconds.
const BASE = "https://api.gladia.io";
const key = (ctx: PluginContext) => ({ "x-gladia-key": ctx.credentials.apiKey! });

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "gladia",
  name: "Gladia",
  homepage: "https://docs.gladia.io",
  credentials: [{ name: "apiKey", env: "GLADIA_API_KEY" }],
  models: [
    {
      id: "solaria-1",
      default: true,
      input: { delivery: ["url", "upload"], maxBytes: 1e9, maxSeconds: 135 * 60 },
      output: { timestamps: "word", speakers: true, detectLanguage: true },
    },
  ],
  mapLanguage: (lang) => baseLanguage(lang),
  async verify(ctx) {
    await ctx.http.request(`${BASE}/v2/pre-recorded`, {
      query: { limit: 1 },
      headers: key(ctx),
      retries: 1,
      timeoutMs: 20_000,
      expect: "none",
    });
  },
  pollIntervalMs: { initial: 3000, max: 10_000 },

  async upload(file, ctx) {
    const form = new FormData();
    form.append("audio", await ctx.blob(file.path, file.mime), file.filename);
    return (await ctx.http.request(`${BASE}/v2/upload`, { method: "POST", headers: key(ctx), body: form })).data
      .audio_url;
  },

  async submit(audio, opts, ctx) {
    const audio_url = audio.kind === "url" ? audio.url : audio.kind === "ref" ? audio.ref : undefined;
    const body: Record<string, unknown> = { audio_url, model: opts.model };
    if (opts.providerLanguage) body.language_config = { languages: [opts.providerLanguage], code_switching: false };
    if (opts.speakers) body.diarization = true;
    if (opts.prompt) {
      body.custom_vocabulary = true;
      body.custom_vocabulary_config = {
        vocabulary: opts.prompt
          .split(/[,，\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }
    for (const [k, v] of Object.entries(opts.extra)) body[k] = v === "true" ? true : v === "false" ? false : v;
    const res = await ctx.http.request(`${BASE}/v2/pre-recorded`, { method: "POST", headers: key(ctx), json: body });
    return { id: res.data.id };
  },

  async poll(task, ctx) {
    const r = (await ctx.http.request(`${BASE}/v2/pre-recorded/${task.id}`, { headers: key(ctx) })).data;
    if (r.status === "done") return { state: "done", raw: r };
    if (r.status === "error") return { state: "failed", message: str(r.error_code ?? r.error ?? "error") };
    return { state: "pending", detail: r.status };
  },

  normalize(raw: any) {
    const tr = raw?.result?.transcription ?? {};
    const segments: Segment[] = (tr.utterances ?? []).map((u: any) => {
      const words: Word[] = (u.words ?? []).map((w: any) => ({
        start: num(w.start),
        end: num(w.end),
        text: str(w.word).trim(),
      }));
      const s: Segment = { start: num(u.start), end: num(u.end), text: str(u.text).trim(), words };
      if (spk(u.speaker)) s.speaker = spk(u.speaker);
      return s;
    });
    return { segments, language: tr.languages?.[0], duration: raw?.result?.metadata?.audio_duration };
  },
});
