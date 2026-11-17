// One adapter for every vendor that speaks OpenAI's /audio/transcriptions dialect.
// Each vendor is a preset (base URL, key variable, models, quirks); users can declare more in config.

import { WsError } from "../core/errors.ts";
import { baseLanguage, languageName } from "../core/lang.ts";
import type { Segment, Word } from "../core/types.ts";
import { attachWords, num, paragraphs, spk, str } from "./helpers.ts";
import {
  type AudioPayload,
  definePlugin,
  type ModelSpec,
  PLUGIN_API_VERSION,
  type PluginContext,
  type ProviderPlugin,
  type TranscribeOptions,
} from "./plugin.ts";

export interface CompatModel {
  id: string;
  default?: boolean;
  label?: string;
  timestamps: "none" | "segment" | "word";
  /** Ask for word timestamps too (only where supported). */
  words?: boolean;
  maxBytes?: number;
  maxSeconds?: number;
  /** response_format to request; `null` = vendor has no such field. Default: verbose_json / json. */
  responseFormat?: string | null;
  /** How to request diarization, if the model supports it. */
  speakers?: { field: string; value: string } | { responseFormat: string; extra?: Record<string, string> };
}

export interface CompatPreset {
  id: string;
  name: string;
  baseUrl: string;
  env: string;
  homepage?: string;
  models: CompatModel[];
  /** Vendor also accepts a public URL in this form field. */
  urlField?: string;
  /** How the language is written: ISO-639-1 (default) or English name (Lemonfox). */
  language?: "iso" | "name";
  /** Vendor rejects `language` together with timestamp_granularities (Mistral). */
  languageBlocksTimestamps?: boolean;
  sendModel?: boolean;
  /** Vendor accepts only `file` and `model` (no language / prompt / extra fields). */
  minimal?: boolean;
}

export function openAICompatible(preset: CompatPreset): ProviderPlugin {
  const models: ModelSpec[] = preset.models.map((m) => ({
    id: m.id,
    label: m.label,
    default: m.default,
    input: {
      delivery: preset.urlField ? ["multipart", "url"] : ["multipart"],
      maxBytes: m.maxBytes ?? 25e6,
      maxSeconds: m.maxSeconds,
      formats: ["mp3", "mp4", "mpeg", "mpga", "m4a", "wav", "webm", "flac", "ogg"],
    },
    output: { timestamps: m.timestamps, speakers: !!m.speakers, detectLanguage: true },
  }));
  const spec = (id: string): CompatModel =>
    preset.models.find((m) => m.id === id) ?? preset.models.find((m) => m.default) ?? preset.models[0]!;

  return definePlugin({
    apiVersion: PLUGIN_API_VERSION,
    id: preset.id,
    name: preset.name,
    homepage: preset.homepage,
    credentials: [{ name: "apiKey", env: preset.env }],
    settings: [
      {
        name: "baseUrl",
        env: `${preset.id.toUpperCase().replace(/-/g, "_")}_BASE_URL`,
        default: preset.baseUrl,
        description: "API base URL (…/v1)",
      },
    ],
    models,
    mapLanguage: (lang) => (preset.language === "name" ? languageName(lang) : baseLanguage(lang)),

    async verify(ctx: PluginContext) {
      const base = (ctx.settings.baseUrl ?? preset.baseUrl).replace(/\/+$/, "");
      await ctx.http.request(`${base}/models`, {
        headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
        retries: 1,
        timeoutMs: 20_000,
        expect: "none",
      });
    },

    async transcribe(audio: AudioPayload, opts: TranscribeOptions, ctx: PluginContext) {
      const m = spec(opts.model);
      const form = new FormData();
      if (audio.kind === "file") form.append("file", await ctx.blob(audio.path, audio.mime), audio.filename);
      else if (audio.kind === "url" && preset.urlField) form.append(preset.urlField, audio.url);
      else throw new WsError("BAD_INPUT", `${preset.name} needs a file upload`);
      if (preset.sendModel !== false) form.append("model", opts.model);

      const wantsTimestamps = m.timestamps !== "none";
      let responseFormat =
        m.responseFormat === undefined ? (wantsTimestamps ? "verbose_json" : "json") : m.responseFormat;
      if (opts.speakers && m.speakers) {
        if ("field" in m.speakers) form.append(m.speakers.field, m.speakers.value);
        else {
          responseFormat = m.speakers.responseFormat;
          for (const [k, v] of Object.entries(m.speakers.extra ?? {})) form.append(k, v);
        }
      }
      if (responseFormat) form.append("response_format", responseFormat);
      if (wantsTimestamps && responseFormat !== "diarized_json") {
        form.append("timestamp_granularities[]", "segment");
        if (m.words || m.timestamps === "word") form.append("timestamp_granularities[]", "word");
      }
      if (!preset.minimal) {
        if (opts.providerLanguage && !(preset.languageBlocksTimestamps && wantsTimestamps))
          form.append("language", opts.providerLanguage);
        else if (opts.providerLanguage)
          ctx.log.debug(`${preset.name}: language is not allowed with timestamps; letting it auto-detect`);
        if (opts.prompt) form.append("prompt", opts.prompt);
      }
      for (const [k, v] of Object.entries(opts.extra)) form.append(k, v);

      const base = (ctx.settings.baseUrl ?? preset.baseUrl).replace(/\/+$/, "");
      const res = await ctx.http.request(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
        body: form,
        expect: "text",
      });
      const text = String(res.data ?? "");
      try {
        return JSON.parse(text);
      } catch {
        return { text };
      }
    },

    normalize: (raw) => normalizeOpenAI(raw),
  });
}

/** OpenAI verbose_json / json / diarized_json → segments. */
export function normalizeOpenAI(raw: any) {
  const lang = raw?.language ? String(raw.language) : undefined;
  const words: Word[] = Array.isArray(raw?.words)
    ? raw.words
        .map((w: any) => ({
          start: num(w.start),
          end: num(w.end),
          text: str(w.word ?? w.text).trim(),
          ...(spk(w.speaker) ? { speaker: spk(w.speaker) } : {}),
        }))
        .filter((w: Word) => w.text)
    : [];
  if (Array.isArray(raw?.segments) && raw.segments.length) {
    const segs: Segment[] = raw.segments
      .map((s: any) => {
        const seg: Segment = { start: num(s.start), end: num(s.end), text: str(s.text).trim() };
        const sp = spk(s.speaker ?? s.speaker_id);
        if (sp) seg.speaker = sp;
        return seg;
      })
      .filter((s: Segment) => s.text);
    return {
      segments: attachWords(segs, words),
      language: lang,
      duration: raw.duration ? num(raw.duration) : undefined,
    };
  }
  const text = typeof raw === "string" ? raw : str(raw?.text);
  return { segments: paragraphs(text), language: lang, timed: false };
}

// ------------------------------------------------------------------ presets

export const COMPAT_PRESETS: CompatPreset[] = [
  {
    id: "groq",
    name: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    env: "GROQ_API_KEY",
    homepage: "https://console.groq.com/docs/speech-to-text",
    urlField: "url",
    models: [
      { id: "whisper-large-v3", default: true, timestamps: "segment", maxBytes: 25e6 },
      { id: "whisper-large-v3-turbo", timestamps: "segment", maxBytes: 25e6 },
    ],
  },
  {
    id: "openai",
    name: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    env: "OPENAI_API_KEY",
    homepage: "https://platform.openai.com/docs/guides/speech-to-text",
    models: [
      { id: "whisper-1", default: true, timestamps: "segment", words: false },
      { id: "gpt-4o-transcribe", timestamps: "none" },
      { id: "gpt-4o-mini-transcribe", timestamps: "none" },
      {
        id: "gpt-4o-transcribe-diarize",
        timestamps: "segment",
        responseFormat: "diarized_json",
        speakers: { responseFormat: "diarized_json", extra: { chunking_strategy: "auto" } },
      },
    ],
  },
  {
    id: "deepinfra",
    name: "DeepInfra",
    baseUrl: "https://api.deepinfra.com/v1",
    env: "DEEPINFRA_API_KEY",
    homepage: "https://docs.deepinfra.com/api-reference/audio/openai-audio-transcriptions",
    models: [
      { id: "openai/whisper-large-v3", default: true, timestamps: "segment" },
      { id: "openai/whisper-large-v3-turbo", timestamps: "segment" },
    ],
  },
  {
    id: "together",
    name: "Together",
    baseUrl: "https://api.together.ai/v1",
    env: "TOGETHER_API_KEY",
    homepage: "https://docs.together.ai/reference/audio-transcriptions",
    models: [
      { id: "openai/whisper-large-v3", default: true, timestamps: "segment", maxBytes: 80e6, maxSeconds: 4 * 3600 },
    ],
  },
  {
    id: "lemonfox",
    name: "Lemonfox",
    baseUrl: "https://api.lemonfox.ai/v1",
    env: "LEMONFOX_API_KEY",
    homepage: "https://www.lemonfox.ai/apis/speech-to-text",
    language: "name",
    sendModel: false,
    models: [
      {
        id: "whisper-large-v3",
        default: true,
        timestamps: "segment",
        maxBytes: 100e6,
        speakers: { field: "speaker_labels", value: "true" },
      },
    ],
  },
  {
    id: "mistral",
    name: "Mistral Voxtral",
    baseUrl: "https://api.mistral.ai/v1",
    env: "MISTRAL_API_KEY",
    homepage: "https://docs.mistral.ai/capabilities/audio_transcription",
    languageBlocksTimestamps: true,
    models: [
      {
        id: "voxtral-mini-latest",
        default: true,
        timestamps: "segment",
        responseFormat: null,
        speakers: { field: "diarize", value: "true" },
      },
    ],
  },
  {
    id: "siliconflow",
    name: "SiliconFlow 硅基流动",
    baseUrl: "https://api.siliconflow.cn/v1",
    env: "SILICONFLOW_API_KEY",
    homepage: "https://docs.siliconflow.cn/docs/api/audio-transcriptions-post",
    minimal: true,
    models: [
      {
        id: "FunAudioLLM/SenseVoiceSmall",
        default: true,
        timestamps: "none",
        responseFormat: null,
        maxBytes: 50e6,
        maxSeconds: 3600,
      },
      { id: "TeleAI/TeleSpeechASR", timestamps: "none", responseFormat: null, maxBytes: 50e6, maxSeconds: 3600 },
    ],
  },
];
