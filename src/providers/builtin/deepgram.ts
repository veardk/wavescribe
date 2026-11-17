import { WsError } from "../../core/errors.ts";
import { baseLanguage } from "../../core/lang.ts";
import type { Segment, Word } from "../../core/types.ts";
import { groupWords, num, spk, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../plugin.ts";

// https://developers.deepgram.com/docs/pre-recorded-audio — synchronous, raw bytes or {url}.
export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "deepgram",
  name: "Deepgram",
  homepage: "https://developers.deepgram.com/reference/speech-to-text/listen-pre-recorded",
  credentials: [{ name: "apiKey", env: "DEEPGRAM_API_KEY" }],
  settings: [{ name: "baseUrl", env: "DEEPGRAM_BASE_URL", default: "https://api.deepgram.com" }],
  models: [
    {
      id: "nova-3",
      default: true,
      input: { delivery: ["raw", "url"], maxBytes: 2e9 },
      output: { timestamps: "word", speakers: true, detectLanguage: true },
    },
    {
      id: "nova-2",
      input: { delivery: ["raw", "url"], maxBytes: 2e9 },
      output: { timestamps: "word", speakers: true, detectLanguage: true },
    },
  ],
  // Deepgram takes BCP-47 tags such as `zh-CN`, `en-US`, or a bare `zh`.
  mapLanguage: (lang) => lang,
  async verify(ctx) {
    const base = (ctx.settings.baseUrl ?? "https://api.deepgram.com").replace(/\/+$/, "");
    await ctx.http.request(`${base}/v1/projects`, {
      headers: { authorization: `Token ${ctx.credentials.apiKey}` },
      retries: 1,
      timeoutMs: 20_000,
      expect: "none",
    });
  },

  async transcribe(audio, opts, ctx) {
    const query: Record<string, string> = {
      model: opts.model,
      smart_format: "true",
      punctuate: "true",
      utterances: "true",
    };
    if (opts.providerLanguage) query.language = opts.providerLanguage;
    else query.detect_language = "true";
    if (opts.speakers) query.diarize = "true";
    Object.assign(query, opts.extra);
    const base = (ctx.settings.baseUrl ?? "https://api.deepgram.com").replace(/\/+$/, "");
    const headers: Record<string, string> = { authorization: `Token ${ctx.credentials.apiKey}` };
    if (audio.kind === "url") {
      return (await ctx.http.request(`${base}/v1/listen`, { method: "POST", query, headers, json: { url: audio.url } }))
        .data;
    }
    if (audio.kind !== "file") throw new WsError("INTERNAL", "deepgram: unexpected payload");
    headers["content-type"] = audio.mime;
    return (
      await ctx.http.request(`${base}/v1/listen`, {
        method: "POST",
        query,
        headers,
        body: await ctx.blob(audio.path, audio.mime),
      })
    ).data;
  },

  normalize(raw: any) {
    const toWord = (w: any): Word => ({
      start: num(w.start),
      end: num(w.end),
      text: str(w.punctuated_word ?? w.word),
      ...(spk(w.speaker) ? { speaker: spk(w.speaker) } : {}),
    });
    const channel = raw?.results?.channels?.[0];
    const language = channel?.detected_language ?? undefined;
    let segments: Segment[];
    if (Array.isArray(raw?.results?.utterances) && raw.results.utterances.length) {
      segments = raw.results.utterances.map((u: any) => {
        const words: Word[] = (u.words ?? []).map(toWord);
        const s: Segment = { start: num(u.start), end: num(u.end), text: str(u.transcript).trim(), words };
        if (spk(u.speaker)) s.speaker = spk(u.speaker);
        return s;
      });
    } else {
      segments = groupWords((channel?.alternatives?.[0]?.words ?? []).map(toWord));
    }
    return { segments, language: language ? baseLanguage(language) : undefined, duration: raw?.metadata?.duration };
  },
});
