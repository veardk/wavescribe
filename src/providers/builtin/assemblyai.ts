import { WsError } from "../../core/errors.ts";
import { baseLanguage } from "../../core/lang.ts";
import { fromMs } from "../../core/time.ts";
import type { Segment, Word } from "../../core/types.ts";
import { num, spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION, type PluginContext } from "../plugin.ts";

// https://www.assemblyai.com/docs — async: (upload) → POST /v2/transcript → poll → sentences. Times in ms.
const base = (ctx: PluginContext) => (ctx.settings.baseUrl ?? "https://api.assemblyai.com").replace(/\/+$/, "");
const auth = (ctx: PluginContext) => ({ authorization: ctx.credentials.apiKey! });

const model = (id: string) => ({
  id,
  default: id === "default",
  label: id === "default" ? "vendor default model" : undefined,
  input: { delivery: ["url", "upload"] as ("url" | "upload")[], maxBytes: 2.2e9 },
  output: { timestamps: "word" as const, speakers: true, detectLanguage: true },
});

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "assemblyai",
  name: "AssemblyAI",
  homepage: "https://www.assemblyai.com/docs/pre-recorded-audio",
  credentials: [{ name: "apiKey", env: "ASSEMBLYAI_API_KEY" }],
  settings: [
    {
      name: "baseUrl",
      env: "ASSEMBLYAI_BASE_URL",
      default: "https://api.assemblyai.com",
      description: "EU: https://api.eu.assemblyai.com",
    },
  ],
  models: [model("default"), model("universal-3-5-pro"), model("universal-2")],
  mapLanguage: (lang) => baseLanguage(lang),
  async verify(ctx) {
    await ctx.http.request(`${base(ctx)}/v2/transcript`, {
      query: { limit: 1 },
      headers: auth(ctx),
      retries: 1,
      timeoutMs: 20_000,
      expect: "none",
    });
  },
  pollIntervalMs: { initial: 3000, max: 10_000 },

  async upload(file, ctx) {
    const res = await ctx.http.request(`${base(ctx)}/v2/upload`, {
      method: "POST",
      headers: { ...auth(ctx), "content-type": "application/octet-stream" },
      body: await ctx.blob(file.path),
    });
    return res.data.upload_url;
  },

  async submit(audio, opts, ctx) {
    const audio_url = audio.kind === "url" ? audio.url : audio.kind === "ref" ? audio.ref : undefined;
    if (!audio_url) throw new WsError("INTERNAL", "assemblyai: audio must be uploaded first");
    const body: Record<string, unknown> = { audio_url, punctuate: true, format_text: true };
    if (opts.model !== "default") body.speech_models = [opts.model];
    if (opts.providerLanguage) body.language_code = opts.providerLanguage;
    else body.language_detection = true;
    if (opts.speakers) body.speaker_labels = true;
    if (opts.prompt)
      body.keyterms_prompt = opts.prompt
        .split(/[,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean);
    for (const [k, v] of Object.entries(opts.extra)) body[k] = v === "true" ? true : v === "false" ? false : v;
    const res = await ctx.http.request(`${base(ctx)}/v2/transcript`, {
      method: "POST",
      headers: auth(ctx),
      json: body,
    });
    return { id: res.data.id };
  },

  async poll(task, ctx) {
    const t = (await ctx.http.request(`${base(ctx)}/v2/transcript/${task.id}`, { headers: auth(ctx) })).data;
    if (t.status === "completed") return { state: "done" };
    if (t.status === "error") return { state: "failed", message: t.error ?? "unknown error" };
    return { state: "pending", detail: t.status };
  },

  async fetchResult(task, ctx) {
    const transcript = (await ctx.http.request(`${base(ctx)}/v2/transcript/${task.id}`, { headers: auth(ctx) })).data;
    const sentences = (
      await ctx.http.request(`${base(ctx)}/v2/transcript/${task.id}/sentences`, { headers: auth(ctx) })
    ).data;
    return { transcript, sentences: sentences?.sentences ?? [] };
  },

  normalize(raw: any) {
    const t = raw?.transcript ?? {};
    const toWord = (w: any): Word => ({
      start: fromMs(w.start),
      end: fromMs(w.end),
      text: str(w.text),
      ...(spk(w.speaker) ? { speaker: spk(w.speaker) } : {}),
    });
    const toSeg = (u: any): Segment => {
      const s: Segment = {
        start: fromMs(u.start),
        end: fromMs(u.end),
        text: str(u.text).trim(),
        words: (u.words ?? []).map(toWord),
      };
      if (spk(u.speaker)) s.speaker = spk(u.speaker);
      return s;
    };
    const list = Array.isArray(t.utterances) && t.utterances.length ? t.utterances : (raw?.sentences ?? []);
    return {
      segments: list.map(toSeg),
      language: t.language_code ? baseLanguage(t.language_code) : undefined,
      duration: t.audio_duration ? num(t.audio_duration) : undefined,
    };
  },
});
