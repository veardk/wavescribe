import { WsError } from "../../core/errors.ts";
import { baseLanguage } from "../../core/lang.ts";
import type { Segment, Word } from "../../core/types.ts";
import { attachWords, groupWords, num, paragraphs, str } from "../helpers.ts";
import { definePlugin, PLUGIN_API_VERSION } from "../plugin.ts";

// https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/ — base64 JSON; {success, result} envelope.
export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "cloudflare",
  name: "Cloudflare Workers AI",
  homepage: "https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/",
  credentials: [
    { name: "apiToken", env: "CLOUDFLARE_API_TOKEN" },
    { name: "accountId", env: "CLOUDFLARE_ACCOUNT_ID" },
  ],
  models: [
    {
      id: "whisper-large-v3-turbo",
      default: true,
      input: { delivery: ["base64"], maxBytes: 20e6, formats: ["mp3", "wav", "flac", "ogg", "m4a"] },
      output: { timestamps: "segment", detectLanguage: true },
    },
  ],
  mapLanguage: (lang) => baseLanguage(lang),

  async transcribe(audio, opts, ctx) {
    if (audio.kind !== "file") throw new WsError("BAD_INPUT", "cloudflare: needs a local file");
    const body: Record<string, unknown> = { audio: await ctx.base64(audio.path), task: "transcribe" };
    if (opts.providerLanguage) body.language = opts.providerLanguage;
    if (opts.prompt) body.initial_prompt = opts.prompt;
    for (const [k, v] of Object.entries(opts.extra)) body[k] = v === "true" ? true : v === "false" ? false : v;
    const url = `https://api.cloudflare.com/client/v4/accounts/${ctx.credentials.accountId}/ai/run/@cf/openai/${opts.model}`;
    const res = await ctx.http.request(url, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.credentials.apiToken}` },
      json: body,
    });
    if (res.data?.success === false)
      throw new WsError("PROVIDER_ERROR", `Cloudflare: ${JSON.stringify(res.data.errors ?? res.data)}`);
    return res.data;
  },

  normalize(raw: any) {
    const r = raw?.result ?? raw ?? {};
    const info = r.transcription_info ?? {};
    const words: Word[] = (r.words ?? []).map((w: any) => ({
      start: num(w.start),
      end: num(w.end),
      text: str(w.word).trim(),
    }));
    let segments: Segment[];
    if (Array.isArray(r.segments) && r.segments.length) {
      segments = r.segments.map((s: any) => ({
        start: num(s.start),
        end: num(s.end),
        text: str(s.text).trim(),
        ...(Array.isArray(s.words)
          ? { words: s.words.map((w: any) => ({ start: num(w.start), end: num(w.end), text: str(w.word).trim() })) }
          : {}),
      }));
      if (!segments.some((s) => s.words)) segments = attachWords(segments, words);
    } else if (words.length) {
      segments = groupWords(words);
    } else {
      return { segments: paragraphs(str(r.text)), timed: false };
    }
    return { segments, language: info.language, duration: info.duration };
  },
});
