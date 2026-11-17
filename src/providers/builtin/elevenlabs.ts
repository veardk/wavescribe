import { baseLanguage } from "../../core/lang.ts";
import type { Word } from "../../core/types.ts";
import { groupWords, num, spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../plugin.ts";

// https://elevenlabs.io/docs/api-reference/speech-to-text/convert — synchronous multipart; times in seconds.
const spec = (id: string, def = false) => ({
  id,
  default: def,
  input: { delivery: ["multipart", "url"] as ("multipart" | "url")[], maxBytes: 3e9 },
  output: { timestamps: "word" as const, speakers: true, detectLanguage: true },
});

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "elevenlabs",
  name: "ElevenLabs Scribe",
  homepage: "https://elevenlabs.io/docs/api-reference/speech-to-text/convert",
  credentials: [{ name: "apiKey", env: "ELEVENLABS_API_KEY" }],
  settings: [{ name: "baseUrl", env: "ELEVENLABS_BASE_URL", default: "https://api.elevenlabs.io" }],
  models: [spec("scribe_v2", true), spec("scribe_v3")],
  mapLanguage: (lang) => baseLanguage(lang),

  async transcribe(audio, opts, ctx) {
    const form = new FormData();
    form.append("model_id", opts.model);
    if (audio.kind === "file") form.append("file", await ctx.blob(audio.path, audio.mime), audio.filename);
    else if (audio.kind === "url") form.append("source_url", audio.url);
    if (opts.providerLanguage) form.append("language_code", opts.providerLanguage);
    if (opts.speakers) form.append("diarize", "true");
    form.append("timestamps_granularity", "word");
    for (const [k, v] of Object.entries(opts.extra)) form.append(k, v);
    const base = (ctx.settings.baseUrl ?? "https://api.elevenlabs.io").replace(/\/+$/, "");
    return (
      await ctx.http.request(`${base}/v1/speech-to-text`, {
        method: "POST",
        headers: { "xi-api-key": ctx.credentials.apiKey! },
        body: form,
      })
    ).data;
  },

  normalize(raw: any) {
    const words: Word[] = (raw?.words ?? [])
      .filter((w: any) => w.type !== "spacing" && str(w.text).trim())
      .map((w: any) => ({
        start: num(w.start),
        end: num(w.end),
        text: str(w.text),
        ...(spk(w.speaker_id) ? { speaker: spk(w.speaker_id) } : {}),
      }));
    return { segments: groupWords(words), language: raw?.language_code, duration: raw?.audio_duration_secs };
  },
});
