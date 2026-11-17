import { baseLanguage } from "../../core/lang.ts";
import { fromMs } from "../../core/time.ts";
import type { Word } from "../../core/types.ts";
import { groupWords, spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION, type PluginContext } from "../plugin.ts";

// https://docs.soniox.com/stt/async/async-transcription — async; sub-word tokens with their own spacing; ms.
const base = (ctx: PluginContext) => `${(ctx.settings.baseUrl ?? "https://api.soniox.com").replace(/\/+$/, "")}/v1`;
const auth = (ctx: PluginContext) => ({ authorization: `Bearer ${ctx.credentials.apiKey}` });

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "soniox",
  name: "Soniox",
  homepage: "https://docs.soniox.com",
  credentials: [{ name: "apiKey", env: "SONIOX_API_KEY" }],
  settings: [{ name: "baseUrl", env: "SONIOX_BASE_URL", default: "https://api.soniox.com" }],
  models: [
    {
      id: "stt-async-v6",
      default: true,
      input: { delivery: ["url", "upload"], maxBytes: 1e9, maxSeconds: 300 * 60 },
      output: { timestamps: "word", speakers: true, detectLanguage: true },
    },
  ],
  mapLanguage: (lang) => baseLanguage(lang),
  async verify(ctx) {
    await ctx.http.request(`${base(ctx)}/models`, {
      headers: auth(ctx),
      retries: 1,
      timeoutMs: 20_000,
      expect: "none",
    });
  },
  pollIntervalMs: { initial: 3000, max: 10_000 },

  async upload(file, ctx) {
    const form = new FormData();
    form.append("file", await ctx.blob(file.path, file.mime), file.filename);
    const r = await ctx.http.request(`${base(ctx)}/files`, { method: "POST", headers: auth(ctx), body: form });
    return `file:${r.data.id}`;
  },

  async submit(audio, opts, ctx) {
    const body: Record<string, unknown> = { model: opts.model };
    if (audio.kind === "url") body.audio_url = audio.url;
    else if (audio.kind === "ref") body.file_id = audio.ref.replace(/^file:/, "");
    if (opts.providerLanguage) body.language_hints = [opts.providerLanguage];
    if (opts.speakers) body.enable_speaker_diarization = true;
    if (opts.prompt)
      body.context = {
        terms: opts.prompt
          .split(/[,，\n]/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    for (const [k, v] of Object.entries(opts.extra)) body[k] = v === "true" ? true : v === "false" ? false : v;
    const r = await ctx.http.request(`${base(ctx)}/transcriptions`, { method: "POST", headers: auth(ctx), json: body });
    return { id: r.data.id };
  },

  async poll(task, ctx) {
    const t = (await ctx.http.request(`${base(ctx)}/transcriptions/${task.id}`, { headers: auth(ctx) })).data;
    if (t.status === "completed") return { state: "done" };
    if (t.status === "error") return { state: "failed", message: str(t.error_message ?? t.error_type ?? "error") };
    return { state: "pending", detail: t.status };
  },

  async fetchResult(task, ctx) {
    return (await ctx.http.request(`${base(ctx)}/transcriptions/${task.id}/transcript`, { headers: auth(ctx) })).data;
  },

  normalize(raw: any) {
    const tokens: Word[] = (raw?.tokens ?? [])
      .filter((t: any) => str(t.text) !== "")
      .map((t: any) => ({
        start: fromMs(t.start_ms),
        end: fromMs(t.end_ms),
        text: str(t.text),
        ...(spk(t.speaker) ? { speaker: spk(t.speaker) } : {}),
      }));
    const language = (raw?.tokens ?? []).find((t: any) => t.language)?.language;
    return { segments: groupWords(tokens, { join: "raw" }), language };
  },
});
