<h1 align="center">wavescribe</h1>
<p align="center">
  <a href="https://github.com/veardk/wavescribe/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/veardk/wavescribe/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/veardk/wavescribe/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/veardk/wavescribe/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://www.npmjs.com/package/wavescribe"><img alt="npm" src="https://img.shields.io/npm/v/wavescribe?style=flat-square" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.18-blue?style=flat-square" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

<h3 align="center">Audio, video, podcasts, subtitles → timestamped transcripts</h3>

Turns audio, video, podcasts and subtitle files into timestamped transcripts (srt / vtt / json / txt / md).

The order is: **use existing captions when there are any; call a speech-to-text API only when there aren't.** The tool never changes the content. It only does the formatting work that is needed, such as removing rolling-caption repeats and decoding entities.

```
① Detect source → ② Fetch (existing transcript, or audio) → ③ Transcribe (API) → ④ Export
```

## Install

Requires Node ≥ 22.18 and ffmpeg. The YouTube fallback, Bilibili and other video sites also need yt-dlp.

```bash
npm install -g wavescribe
wavescribe auth        # add a speech-to-text API key (interactive; only needed when there are no captions)
wavescribe doctor      # check ffmpeg / yt-dlp / config / keys
```

Run from source:

```bash
git clone https://github.com/veardk/wavescribe.git && cd wavescribe
npm install
npm run dev -- <file|url> [options]
```

## Usage

```bash
wavescribe talk.mp3                                  # → ./talk.srt
wavescribe https://youtu.be/UF8uR6Z6KLc -f srt,txt -o out/
wavescribe "https://podcasts.apple.com/cn/podcast/…?i=1000800642062" -l zh
wavescribe https://example.com/feed.xml -e 3         # the 3rd newest episode
wavescribe https://example.com/feed.xml -e "guid:abc" -f json -o -
wavescribe info https://example.com/feed.xml         # list episodes, available captions and audio
wavescribe video.mp4 -p deepgram --speakers -f vtt
wavescribe old.srt -f vtt -o -                       # convert between subtitle formats
```

Common options (see `wavescribe -h` for the full list):

| Option                                          | Description                                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------------------- |
| `-f srt,vtt,json,txt,md`                        | Output formats, default srt                                                     |
| `-o <dir\|file\|->`                             | Output location; a file name works when there is only one format; `-` is stdout |
| `-p / -m`                                       | Speech-to-text provider / model                                                 |
| `-l zh`                                         | Language; also decides which caption language is preferred                      |
| `-e latest\|3\|guid:…\|2026-11-01\|title words` | Pick a podcast episode                                                          |
| `--prefer asr`                                  | Skip existing captions and transcribe the audio                                 |
| `--speakers`                                    | Speaker diarization (provider must support it)                                  |
| `--clip 2m`                                     | Transcribe only the first 2 minutes (for testing)                               |
| `--opt k=v`                                     | Extra parameters passed to the provider as is                                   |
| `--no-input`                                    | Never ask questions (for scripts and CI)                                        |

**Terminal vs. scripts**: when you run it by hand in a terminal, it shows progress bars and colors, and a podcast RSS feed without `-e` opens an episode list to pick from (type to filter). When the output is piped, in CI, or with `--no-input`, nothing is interactive: it takes the latest episode and prints progress line by line to stderr. Colors follow `NO_COLOR` / `FORCE_COLOR`.

srt / vtt need timestamps, so transcripts without timestamps (such as HTML / plain-text transcripts) are skipped and the next source is tried. When you only ask for txt / md / json, those transcripts are used directly.

## Supported sources

| Input                                        | How it is fetched (tried in order)                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Local subtitles `.srt .vtt .ttml .json .txt` | Parsed directly                                                                           |
| Local audio/video / direct links             | ffmpeg converts to mono 16 kHz, then transcribed                                          |
| RSS / Atom                                   | `podcast:transcript` (json > vtt > srt > html > txt) → enclosure audio                    |
| Apple Podcasts                               | iTunes Lookup finds the RSS feed and matches the episode, then handled as RSS             |
| Ximalaya (喜马拉雅)                          | Match the episode in the album RSS → yt-dlp                                               |
| YouTube                                      | Manual captions → auto captions (Innertube) → yt-dlp captions → audio transcription       |
| Bilibili                                     | CC subtitles (AI subtitles need login) → yt-dlp subtitles → audio transcription           |
| Spotify episodes                             | Spotify's auto-generated transcript (needs login); the audio has DRM, so no transcription |
| Other web pages                              | Sites supported by yt-dlp: captions → audio                                               |

Xiaoyuzhou (小宇宙) is not supported.

**Bilibili login**: AI subtitles need a login. `wavescribe login bilibili` syncs cookies from a browser on this machine; add `--qr` to log in by scanning a QR code instead. The login is saved in `~/.config/wavescribe/` (mode 600).

**Spotify login**: transcripts need the `sp_dc` cookie from open.spotify.com. The first run reads it automatically from a browser on this machine (Chrome, Edge, Brave, Arc, Vivaldi, Opera, ego lite, Firefox; requires `sqlite3` on the system) and reuses it afterwards. You can also run `wavescribe login spotify`: if no login is found in a browser, it opens the Spotify web player and continues once you have logged in. Or pass it by hand with `--cookie <sp_dc>`. The `SPOTIFY_SP_DC` environment variable and `spotify.spDc` in the config file also work.

## Speech-to-text providers

`wavescribe providers` lists every provider, its models and capabilities, and whether its key is configured.

| Category          | Provider (id)                                                     | Key variables                                                                                 |
| ----------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| OpenAI-compatible | groq, openai, deepinfra, together, lemonfox, mistral, siliconflow | `<ID>_API_KEY`                                                                                |
| Dedicated APIs    | deepgram, assemblyai, elevenlabs, gladia, speechmatics, soniox    | `<ID>_API_KEY`                                                                                |
|                   | cloudflare                                                        | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`                                              |
| China             | aliyun (Bailian Paraformer / Fun-ASR)                             | `DASHSCOPE_API_KEY`                                                                           |
|                   | volcengine (Doubao recorded-file recognition)                     | `VOLC_API_KEY`, or `VOLC_APP_ID` + `VOLC_ACCESS_TOKEN`                                        |
|                   | tencent (recorded-file recognition / flash)                       | `TENCENTCLOUD_SECRET_ID` + `TENCENTCLOUD_SECRET_KEY` (flash also needs `TENCENTCLOUD_APP_ID`) |

Without `-p`, it uses `defaults.provider` from the config, or else the first provider that has a key configured.

Each plugin declares the provider's file size / duration limits and upload method (multipart, raw bytes, base64, public URL, upload first). Based on that, the core automatically handles:

- downloading, transcoding and compressing;
- splitting at silences and mapping each part's timestamps back onto the original timeline;
- polling async jobs (a rerun after an interruption keeps waiting on the same job);
- caching the provider's raw response per part, so reruns are not billed again.

## API keys

When there are no existing captions, a speech-to-text service is called, which needs that provider's API key.

```bash
wavescribe auth                                  # interactive: pick a provider → paste the key (not echoed) → verify it → save
wavescribe auth add groq                         # configure one provider directly
printf %s "$KEY" | wavescribe auth add groq --stdin   # for scripts: read from a pipe; not saved if verification fails
wavescribe auth list                             # configured keys and where they come from, only the first 4 characters shown
wavescribe auth test [groq]                      # call the provider once to check the key works (no transcription, no charge)
wavescribe auth remove groq
```

Keys are saved in `~/.config/wavescribe/credentials.json` (mode 600), separate from config.json, so sharing the config file does not leak keys. For providers with several keys (such as Volcengine), write one `NAME=value` per line when using `--stdin`.

When you run `wavescribe <link>` in a terminal and it needs to transcribe but no key is configured yet, it asks whether to set one up now and continues once that is done.

**Lookup order: environment variable → saved by `wavescribe auth` → the file that `<name>File` (such as `apiKeyFile`) points to → the value written directly in the config.**

## Configuration

```bash
wavescribe config                                # interactive menu: default provider, language, output formats, output directory, etc.
wavescribe config set defaults.provider groq
wavescribe config set defaults.formats srt,txt
wavescribe config get defaults.provider
wavescribe config unset defaults.language
wavescribe config list | path | edit             # list / show the path / open in $EDITOR
```

`config set` does not accept secret fields (`apiKey`, `token`, etc.); use `wavescribe auth` for those.

The config file is `~/.config/wavescribe/config.json` (set `WAVESCRIBE_CONFIG` to use another path):

```json
{
  "defaults": { "provider": "groq", "language": "zh", "formats": ["srt"], "outDir": "~/Transcripts" },
  "providers": {
    "groq": { "apiKeyFile": "~/.groq_key" },
    "speechmatics": { "region": "eu1" },
    "tencent": { "engine": "16k_zh_large" },
    "my-whisper": {
      "type": "openai-compatible",
      "name": "Self-hosted Whisper",
      "baseUrl": "http://localhost:8000/v1",
      "models": ["large-v3"],
      "apiKeyEnv": "MY_WHISPER_KEY",
      "maxBytes": 100000000
    }
  },
  "plugins": ["./my-plugin.js"],
  "paths": { "ffmpeg": "ffmpeg", "ytDlp": "yt-dlp" }
}
```

A key file can hold just the key, or a dotenv line such as `GROQ_API_KEY=gsk_…`; set its mode to 600. Writing keys directly into config.json is not recommended.

The cache directory `~/.cache/wavescribe/work/<source>-<hash>/` holds `source/`, `media/`, `asr/<provider>/` and `transcript.json`. `--no-cache` ignores the cache.

## Writing plugins

Providers are added as plugins; see [docs/plugins.md](docs/plugins.md) for the interface and examples. A service that only implements the OpenAI `/audio/transcriptions` endpoint needs no plugin: declare `"type": "openai-compatible"` in the config (see the config example above).

## Using it as a library

```ts
import { createLogger, loadConfig, loadRegistry, runInput } from "wavescribe";

const plain = createLogger(); // text lines go to stderr
// progress comes as structured events (step / bytes / parts / end) that a UI can turn into progress bars
const log = { ...plain, progress: (e) => (e.type === "bytes" ? updateBar(e.done, e.total) : plain.progress(e)) };
const cfg = await loadConfig();
const env = { cfg, reg: await loadRegistry(cfg, log), log, useCache: true };
const { transcript, files } = await runInput(
  "talk.mp3",
  {
    formats: ["srt"],
    timestamps: false,
    prefer: "captions",
    speakers: false,
    extra: {},
    timeoutSeconds: 1800,
  },
  env,
);
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
