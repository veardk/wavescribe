// Contract tests: every built-in plugin turns a documented response shape into seconds-based segments.
import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyConfig } from "../src/config/config.ts";
import { WsError } from "../src/core/errors.ts";
import { BUILTIN_PLUGINS } from "../src/providers/builtin/index.ts";
import { flashSignature, tc3Headers } from "../src/providers/builtin/tencent.ts";
import {
  PLUGIN_API_VERSION,
  type PluginContext,
  type ProviderPlugin,
  type TranscribeOptions,
} from "../src/providers/plugin.ts";
import { verifyProvider } from "../src/providers/select.ts";
import { silent } from "./helpers.ts";

const get = (id: string) => BUILTIN_PLUGINS.find((p) => p.id === id)!;
const opts = (o: Partial<TranscribeOptions> = {}): TranscribeOptions => ({
  model: "m",
  speakers: false,
  extra: {},
  ...o,
});
const brief = (r: ReturnType<ProviderPlugin["normalize"]>) =>
  r.segments.map((s) => [s.start, s.end, s.text, s.speaker]);

test("every built-in plugin is well-formed", () => {
  const ids = new Set<string>();
  for (const p of BUILTIN_PLUGINS) {
    assert.equal(p.apiVersion, PLUGIN_API_VERSION, p.id);
    assert.ok(!ids.has(p.id), `duplicate id ${p.id}`);
    ids.add(p.id);
    assert.ok(p.models.length && p.models.filter((m) => m.default).length <= 1, `${p.id} models`);
    for (const m of p.models) {
      const mode = m.mode ?? (p.transcribe ? "sync" : "async");
      assert.ok(mode === "sync" ? p.transcribe : p.submit && p.poll, `${p.id}/${m.id} implements ${mode}`);
      if (m.input.delivery.includes("upload")) assert.ok(p.upload, `${p.id} needs upload()`);
    }
  }
  assert.equal(BUILTIN_PLUGINS.length, 17);
});

test("openai-compatible verbose_json (Groq/OpenAI)", () => {
  const r = get("groq").normalize(
    {
      language: "Chinese",
      duration: 3,
      segments: [
        { start: 0, end: 1.2, text: " 你好" },
        { start: 1.2, end: 3, text: "世界" },
      ],
      words: [{ word: "你", start: 0, end: 0.5 }],
    },
    opts(),
  );
  assert.deepEqual(brief(r), [
    [0, 1.2, "你好", undefined],
    [1.2, 3, "世界", undefined],
  ]);
  assert.equal(r.language, "Chinese");
  assert.equal(r.segments[0]!.words!.length, 1);
  const plain = get("siliconflow").normalize({ text: "只有文字" }, opts());
  assert.equal(plain.timed, false);
  const diar = get("openai").normalize({ segments: [{ start: 0, end: 1, text: "a", speaker: "A" }] }, opts());
  assert.equal(diar.segments[0]!.speaker, "A");
});

test("openai-compatible builds the multipart request", async () => {
  let captured: { url: string; form: FormData; headers: Record<string, string> } | undefined;
  const ctx = {
    credentials: { apiKey: "k" },
    settings: {},
    log: silent,
    http: {
      request: async (url: string, req: any) => {
        captured = { url, form: req.body, headers: req.headers };
        return { status: 200, headers: new Headers(), data: '{"text":"x"}', url };
      },
    },
    blob: async () => new Blob(["abc"], { type: "audio/mpeg" }),
    base64: async () => "",
  } as unknown as PluginContext;
  await get("groq").transcribe!(
    { kind: "file", path: "/x.mp3", filename: "x.mp3", mime: "audio/mpeg", size: 3, format: "mp3" },
    opts({ model: "whisper-large-v3", providerLanguage: "zh", prompt: "人名" }),
    ctx,
  );
  assert.equal(captured!.url, "https://api.groq.com/openai/v1/audio/transcriptions");
  assert.equal(captured!.headers.authorization, "Bearer k");
  assert.equal(captured!.form.get("response_format"), "verbose_json");
  assert.deepEqual(captured!.form.getAll("timestamp_granularities[]"), ["segment"]);
  assert.equal(captured!.form.get("language"), "zh");
  assert.equal(get("lemonfox").mapLanguage!("zh-CN", "m"), "chinese");
});

test("deepgram utterances and word fallback", () => {
  const r = get("deepgram").normalize(
    {
      metadata: { duration: 4 },
      results: {
        channels: [{ detected_language: "en", alternatives: [{ words: [] }] }],
        utterances: [
          {
            start: 0.1,
            end: 1.9,
            transcript: "Hello there.",
            speaker: 0,
            words: [{ word: "hello", punctuated_word: "Hello", start: 0.1, end: 0.5, speaker: 0 }],
          },
        ],
      },
    },
    opts(),
  );
  assert.deepEqual(brief(r), [[0.1, 1.9, "Hello there.", "0"]]);
  const w = get("deepgram").normalize(
    {
      results: {
        channels: [
          {
            alternatives: [
              {
                words: [
                  { word: "a", punctuated_word: "A.", start: 0, end: 0.3 },
                  { word: "b", punctuated_word: "B", start: 0.4, end: 0.6 },
                ],
              },
            ],
          },
        ],
      },
    },
    opts(),
  );
  assert.deepEqual(
    w.segments.map((s) => s.text),
    ["A.", "B"],
  );
});

test("assemblyai: milliseconds, sentences or utterances", () => {
  const r = get("assemblyai").normalize(
    {
      transcript: { language_code: "en_us", audio_duration: 5 },
      sentences: [{ text: "Hi.", start: 250, end: 1250, words: [{ text: "Hi.", start: 250, end: 1250 }] }],
    },
    opts(),
  );
  assert.deepEqual(brief(r), [[0.25, 1.25, "Hi.", undefined]]);
  const u = get("assemblyai").normalize(
    { transcript: { utterances: [{ text: "Yo", start: 0, end: 500, speaker: "A" }] } },
    opts(),
  );
  assert.equal(u.segments[0]!.speaker, "A");
});

test("elevenlabs: words (skip spacing) grouped into sentences", () => {
  const r = get("elevenlabs").normalize(
    {
      language_code: "eng",
      words: [
        { text: "Hello", type: "word", start: 0, end: 0.4, speaker_id: "speaker_0" },
        { text: " ", type: "spacing", start: 0.4, end: 0.5 },
        { text: "world.", type: "word", start: 0.5, end: 0.9, speaker_id: "speaker_0" },
        { text: "Bye", type: "word", start: 1.0, end: 1.2, speaker_id: "speaker_1" },
      ],
    },
    opts(),
  );
  assert.deepEqual(brief(r), [
    [0, 0.9, "Hello world.", "speaker_0"],
    [1, 1.2, "Bye", "speaker_1"],
  ]);
});

test("gladia utterances (seconds)", () => {
  const r = get("gladia").normalize(
    {
      result: {
        metadata: { audio_duration: 9 },
        transcription: {
          languages: ["zh"],
          utterances: [
            { start: 12.34, end: 15.6, text: "你好", speaker: 0, words: [{ word: "你好", start: 12.34, end: 12.9 }] },
          ],
        },
      },
    },
    opts(),
  );
  assert.deepEqual(brief(r), [[12.34, 15.6, "你好", "0"]]);
  assert.equal(r.language, "zh");
});

test("speechmatics word + punctuation stream", () => {
  const r = get("speechmatics").normalize(
    {
      metadata: { transcription_config: { language: "en" } },
      results: [
        { type: "word", start_time: 0, end_time: 0.4, alternatives: [{ content: "Hello", speaker: "S1" }] },
        { type: "punctuation", start_time: 0.4, end_time: 0.4, alternatives: [{ content: ".", speaker: "S1" }] },
        { type: "word", start_time: 0.6, end_time: 1, alternatives: [{ content: "Next", speaker: "S1" }] },
      ],
    },
    opts(),
  );
  assert.deepEqual(
    r.segments.map((s) => s.text),
    ["Hello.", "Next"],
  );
  assert.equal(get("speechmatics").mapLanguage!("zh-CN", "enhanced"), "cmn");
});

test("soniox sub-word tokens keep their own spacing (ms)", () => {
  const r = get("soniox").normalize(
    {
      tokens: [
        { text: "He", start_ms: 0, end_ms: 100 },
        { text: "llo", start_ms: 100, end_ms: 200 },
        { text: " world", start_ms: 300, end_ms: 600, language: "en" },
        { text: ".", start_ms: 600, end_ms: 610 },
      ],
    },
    opts(),
  );
  assert.deepEqual(brief(r), [[0, 0.61, "Hello world.", undefined]]);
  assert.equal(r.language, "en");
});

test("cloudflare envelope", () => {
  const r = get("cloudflare").normalize(
    {
      success: true,
      result: {
        text: "hi",
        transcription_info: { language: "en", duration: 2 },
        segments: [{ start: 0, end: 2, text: "hi", words: [{ word: "hi", start: 0, end: 1 }] }],
      },
    },
    opts(),
  );
  assert.deepEqual(brief(r), [[0, 2, "hi", undefined]]);
});

test("aliyun sentences (ms), multi-channel merged by time", () => {
  const r = get("aliyun").normalize(
    {
      properties: { original_duration_in_milliseconds: 9000 },
      transcripts: [
        { channel_id: 0, sentences: [{ begin_time: 3000, end_time: 4000, text: "第二句", speaker_id: 1 }] },
        {
          channel_id: 1,
          sentences: [
            {
              begin_time: 100,
              end_time: 2800,
              text: "第一句",
              words: [{ begin_time: 100, end_time: 500, text: "第一", punctuation: "" }],
            },
          ],
        },
      ],
    },
    opts(),
  );
  assert.deepEqual(brief(r), [
    [0.1, 2.8, "第一句", undefined],
    [3, 4, "第二句", "1"],
  ]);
  assert.equal(r.duration, 9);
});

test("volcengine utterances (ms)", () => {
  const r = get("volcengine").normalize(
    {
      audio_info: { duration: 3696 },
      result: { text: "x", utterances: [{ start_time: 0, end_time: 1500, text: "你好", words: [] }] },
    },
    opts(),
  );
  assert.deepEqual(brief(r), [[0, 1.5, "你好", undefined]]);
});

test("tencent flash and async results; speakers only when requested", () => {
  const flash = {
    code: 0,
    audio_duration: 4000,
    flash_result: [
      {
        sentence_list: [
          {
            text: "你好。",
            start_time: 0,
            end_time: 1200,
            speaker_id: 0,
            word_list: [{ word: "你好", start_time: 0, end_time: 800 }],
          },
        ],
      },
    ],
  };
  assert.deepEqual(brief(get("tencent").normalize(flash, opts())), [[0, 1.2, "你好。", undefined]]);
  assert.equal(get("tencent").normalize(flash, opts({ speakers: true })).segments[0]!.speaker, "0");
  const asy = {
    async: {
      AudioDuration: 4,
      ResultDetail: [
        {
          FinalSentence: "第二",
          StartMs: 2000,
          EndMs: 3000,
          SpeakerId: 1,
          Words: [{ Word: "第二", OffsetStartMs: 100, OffsetEndMs: 600 }],
        },
      ],
    },
  };
  const r = get("tencent").normalize(asy, opts({ speakers: true }));
  assert.deepEqual(brief(r), [[2, 3, "第二", "1"]]);
  assert.deepEqual([r.segments[0]!.words![0]!.start, r.segments[0]!.words![0]!.end], [2.1, 2.6]);
});

test("tencent signatures are deterministic and well-formed", () => {
  const h = tc3Headers("CreateRecTask", "{}", "AKIDtest", "secret", 1_700_000_000);
  assert.match(
    h.Authorization,
    /^TC3-HMAC-SHA256 Credential=AKIDtest\/2023-11-14\/asr\/tc3_request, SignedHeaders=content-type;host, Signature=[0-9a-f]{64}$/,
  );
  assert.equal(h.Authorization, tc3Headers("CreateRecTask", "{}", "AKIDtest", "secret", 1_700_000_000).Authorization);
  assert.match(flashSignature("123", { b: "2", a: "1" }, "k"), /^[A-Za-z0-9+/]+=*$/);
  assert.equal(flashSignature("123", { b: "2", a: "1" }, "k"), flashSignature("123", { a: "1", b: "2" }, "k"));
});

test("verifying a key: valid, rejected (401/403), or unknown", async () => {
  const base = get("groq");
  const check = (verify: ProviderPlugin["verify"]) =>
    verifyProvider({ ...base, verify }, emptyConfig(), { log: silent }, { apiKey: "k" });
  assert.equal((await check(async () => {})).status, "valid");
  const rejected = await check(async () => {
    throw new WsError("AUTH", "HTTP 401 from api.groq.com: Invalid API Key", { status: 401 });
  });
  assert.deepEqual(rejected, { status: "invalid", detail: "HTTP 401 from api.groq.com: Invalid API Key" });
  assert.equal((await check(async () => Promise.reject(new WsError("NETWORK", "offline")))).status, "unknown");
  assert.equal((await check(undefined)).status, "unknown");
});

test("openai-compatible verify lists models with the key", async () => {
  let seen: { url: string; auth: string } | undefined;
  const ctx = {
    credentials: { apiKey: "gsk_1" },
    settings: {},
    log: silent,
    http: {
      request: async (url: string, req: any) => {
        seen = { url, auth: req.headers.authorization };
        return { status: 200, headers: new Headers(), data: undefined, url };
      },
    },
  } as unknown as PluginContext;
  await get("groq").verify!(ctx);
  assert.deepEqual(seen, { url: "https://api.groq.com/openai/v1/models", auth: "Bearer gsk_1" });
});
