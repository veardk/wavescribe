# Writing a speech-to-text provider plugin

Every speech-to-text provider in wavescribe is a plugin. A plugin only **describes** what the provider accepts, how to call it, and how to translate its results. The core handles the rest, so plugins don't have to:

- downloading, transcoding and compressing, and splitting at silences when over a limit;
- retries (respecting Retry-After);
- polling async jobs, with resumable waiting after an interruption;
- caching raw responses per part;
- reading credentials;
- renaming speakers to S1/S2 and mapping timestamps back onto the original timeline.

The 17 built-in providers (`src/providers/builtin/`) use the same interface and work as references.

## Loading

A plugin is an ES module (`.js` / `.mjs`; with Node ≥ 22.18, `.ts` also works directly) whose default export is a plugin object (or an array of them). There are two ways to load one:

- put it in `~/.config/wavescribe/plugins/`;
- list it in `plugins` in the config (relative paths resolve from the config file's directory; npm package names also work).

A plugin whose id matches a built-in provider overrides the built-in one. A plugin that fails to load only prints a warning and does not affect other providers.

## Minimal example (synchronous API)

```ts
import { definePlugin, PLUGIN_API_VERSION, groupWords, num, str } from "wavescribe/plugin";

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "acme",
  name: "Acme ASR",
  credentials: [{ name: "apiKey", env: "ACME_API_KEY" }],
  settings: [{ name: "baseUrl", env: "ACME_BASE_URL", default: "https://api.acme.example" }],
  models: [
    {
      id: "v1",
      default: true,
      input: { delivery: ["multipart", "url"], maxBytes: 50e6, formats: ["mp3", "wav"] },
      output: { timestamps: "word", speakers: true },
    },
  ],

  // Return the provider's raw response; the core caches it and hands it straight to normalize on reruns, without a new request.
  async transcribe(audio, opts, ctx) {
    const form = new FormData();
    if (audio.kind === "file") form.append("file", await ctx.blob(audio.path, audio.mime), audio.filename);
    else if (audio.kind === "url") form.append("url", audio.url);
    if (opts.providerLanguage) form.append("language", opts.providerLanguage);
    const res = await ctx.http.request(`${ctx.settings.baseUrl}/v1/stt`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
      body: form,
    });
    return res.data;
  },

  // Pure function: raw response → segments in seconds. No I/O of any kind.
  normalize: (raw: any) => ({
    segments: groupWords(
      (raw.words ?? []).map((w: any) => ({
        start: num(w.start),
        end: num(w.end),
        text: str(w.text),
        speaker: w.speaker,
      })),
    ),
    language: raw.language,
  }),
});
```

`definePlugin` only provides type checking. A plugin that doesn't want to depend on the wavescribe package can export a plain object with `apiVersion: 1`.

## Interface essentials

| Field                                            | Description                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `credentials`                                    | Required secrets: `name` is the name the plugin reads, `env` is the environment variable, `optional` marks it optional. Users save them with `wavescribe auth`, or use the environment variable or `<name>File`.                                                                            |
| `settings`                                       | Non-secret settings (region, base URL, etc.), read in order: config → environment variable → `default`.                                                                                                                                                                                     |
| `models[].input.delivery`                        | In order of preference: `multipart`, `raw`, `base64`, `url` (the provider fetches a public URL itself), `upload` (call the plugin's `upload()` first).                                                                                                                                      |
| `models[].input.maxBytes / maxSeconds / formats` | Per-request limits and accepted formats. When exceeded, the core transcodes, compresses and splits.                                                                                                                                                                                         |
| `models[].output.timestamps`                     | `none` / `segment` / `word`. Models with `none` cannot produce srt/vtt.                                                                                                                                                                                                                     |
| `models[].mode`                                  | When the plugin implements both the sync and async APIs, picks which one this model uses.                                                                                                                                                                                                   |
| `mapLanguage(lang, model)`                       | Converts BCP-47 (`zh`, `en-US`) to the provider's notation; return `undefined` to let the provider detect the language.                                                                                                                                                                     |
| `checkCredentials(values)`                       | When there are several valid key combinations (for example an API key, or AppId + Token), return a description of the problem, or `undefined` if there is none.                                                                                                                             |
| `verify(ctx)`                                    | Optional. Sends a free request (such as listing models) to prove the key works, so `wavescribe auth` can verify it on the spot. Use `ctx.http` directly; 401/403 counts as a rejected key. Providers without this method only find out whether the key is valid on the first transcription. |

## Async providers

Implement `submit` → `poll` → (optionally) `fetchResult` instead of `transcribe`:

```ts
async submit(audio, opts, ctx) {
  const res = await ctx.http.request(`${base}/jobs`, { json: { url: audio.kind === "url" ? audio.url : undefined } });
  return { id: res.data.id };               // written to the cache directory; a rerun after an interruption keeps waiting on this job
},
async poll(task, ctx) {
  const s = (await ctx.http.request(`${base}/jobs/${task.id}`)).data;
  if (s.status === "done") return { state: "done", raw: s };   // with raw, fetchResult is not called
  if (s.status === "error") return { state: "failed", message: s.error };
  return { state: "pending", detail: s.status };
},
pollIntervalMs: { initial: 3000, max: 20000 },
```

The poll interval starts at `initial` and grows by 1.5× up to `max`. `--timeout` controls the total wait.

## Errors

`ctx.http.request` throws a `WsError` on any non-2xx response, mapped from the status code to `AUTH`, `RATE_LIMIT`, `INPUT_TOO_LARGE`, etc. When the plugin detects an error itself, it should also throw `WsError` (imported from `wavescribe/plugin`) and give a `hint` where possible.

## Helpers (`wavescribe/plugin`)

- `groupWords(words, { maxGap, maxChars, join })`: groups a word stream into sentence-level segments. No spaces are added between CJK characters; `join: "raw"` keeps each token's original spacing.
- `attachWords(segments, words)`: attaches a flat word list to the matching segments.
- `joinWords`, `paragraphs`, `num`, `str`, `spk`: join words, split plain text into paragraphs, and safely convert numbers, strings and speaker labels.
- `fromMs`, `fromDuration("1.2s")`, `fromSecString`, `fromFrames10ms`: convert various time notations to seconds.

## When you don't need a plugin

If the service implements OpenAI's `/audio/transcriptions` endpoint, declaring it in the config is enough:

```json
{
  "providers": {
    "my-whisper": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:8000/v1",
      "models": ["large-v3"],
      "apiKeyEnv": "MY_WHISPER_KEY",
      "maxBytes": 100000000
    }
  }
}
```

## Tests

`normalize` is a pure function, so a snapshot test with a real response is the easiest approach; see `test/providers.test.ts`.
