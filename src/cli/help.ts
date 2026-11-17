// Help text: the overview (`wavescribe --help`) and one page per command (`wavescribe help <command>`,
// or `wavescribe <command> --help`).

import { configFile } from "../config/paths.ts";
import { VERSION } from "../version.ts";

const RUN_OPTIONS = `Options
  -f, --format <list>     srt, vtt, json, txt, md (comma-separated)           default: srt
  -o, --output <path>     output directory, or a file name for one format; "-" = stdout
  -p, --provider <id>     speech-to-text provider (see \`wavescribe providers\`)
  -m, --model <id>        provider model
  -l, --lang <code>       spoken language, e.g. zh, en, ja (also picks the caption language)
  -e, --episode <sel>     feeds: latest | 3 | guid:<id> | 2026-11-01 | title words    default: latest
      --prefer <what>     captions (default) or asr: skip existing captions and transcribe the audio
      --speakers          ask the provider to separate speakers
      --prompt <text>     vocabulary / context hint for the provider
      --clip <dur>        only the first part of the audio, e.g. 2m, 90s (testing)
      --opt <k=v>         provider-specific option (repeatable)
      --timestamps        include timestamps in txt / md output
      --timeout <dur>     give up waiting on asynchronous providers after this long   default: 30m
      --input-file <f>    process every input listed in a file (one per line)
      --no-cache          ignore cached downloads and provider responses
      --json              print a machine-readable result on stdout
      --no-input          never ask questions (also when stdin is not a terminal, or in CI)
  -q, --quiet / -v, --verbose
  -h, --help / --version`;

const INPUTS = `Inputs
  local audio / video / subtitle files (.mp3 .m4a .mp4 .srt .vtt .ttml .json .txt …), direct media URLs,
  RSS feeds, Apple Podcasts links, 喜马拉雅 links, YouTube, Bilibili, Spotify episodes (transcript only),
  and any video site yt-dlp supports.`;

export const helpText = () => `wavescribe ${VERSION} — audio, video, podcasts and subtitles → timestamped transcripts

Usage
  wavescribe <file|url> [options]        transcribe (captions first, speech-to-text API when there are none)
  wavescribe info <file|url>             show what a source is: title, episodes, available text and audio
  wavescribe auth                        add, list, check or remove speech-to-text API keys
  wavescribe config                      read and change settings
  wavescribe providers                   list speech-to-text providers, models and whether keys are set
  wavescribe doctor                      check ffmpeg, yt-dlp, config and keys
  wavescribe login bilibili|spotify      save a site login (for subtitles / transcripts behind a login)
  wavescribe help <command>              details for one command

${INPUTS}

${RUN_OPTIONS}

Config: ${configFile()}
`;

const COMMANDS: Record<string, () => string> = {
  run: () => `Usage
  wavescribe [run] <file|url>… [options]

Turns each input into transcript files. Existing captions or published transcripts are used first;
only when there are none is the audio downloaded and sent to a speech-to-text provider.

${INPUTS}

${RUN_OPTIONS}

Examples
  wavescribe talk.mp3                                   → ./talk.srt
  wavescribe https://youtu.be/UF8uR6Z6KLc -f srt,txt -o out/
  wavescribe https://example.com/feed.xml -e 3          third-newest episode
  wavescribe old.srt -f vtt -o -                        convert subtitles to stdout
`,

  info: () => `Usage
  wavescribe info <file|url> [-e <episode>] [-l <lang>] [--json]

Shows what an input is without downloading or transcribing: title, length, the text and audio it
offers (in the order they would be tried), and the episode list of feeds.
`,

  auth: () => `Usage
  wavescribe auth                          add a key interactively (lists keys when not at a terminal)
  wavescribe auth add <provider>           add or replace the key of one provider
  wavescribe auth add <provider> --stdin   read it from a pipe: printf %s "$KEY" | wavescribe auth add groq --stdin
  wavescribe auth list [--json]            keys found, where they come from (first 4 characters only)
  wavescribe auth test [provider]          ask the provider whether the key works (no transcription, no cost)
  wavescribe auth remove <provider>        forget a saved key

Keys are checked before they are saved, and stored in ~/.config/wavescribe/credentials.json (mode 600).
Providers with several values (e.g. volcengine) take NAME=value lines on --stdin.
Lookup order: environment variable → saved key → <name>File in the config → value in the config.
`,

  config: () => `Usage
  wavescribe config                        interactive menu (prints the settings when not at a terminal)
  wavescribe config list [--json]          every setting that is set
  wavescribe config get <key>              one value (exit code 1 when it is not set)
  wavescribe config set <key> <value>      e.g. defaults.provider groq, defaults.formats srt,txt
  wavescribe config unset <key>
  wavescribe config path                   where the config file is
  wavescribe config edit                   open it in $VISUAL / $EDITOR

Common keys: defaults.provider, defaults.model, defaults.language, defaults.formats, defaults.outDir,
paths.ffmpeg, paths.ffprobe, paths.ytDlp, providers.<id>.<setting>.
API keys are not accepted here; use \`wavescribe auth\`.

Config: ${configFile()}
`,

  providers: () => `Usage
  wavescribe providers [--json]

Lists every speech-to-text provider: its models, whether they give timestamps or separate speakers,
how audio is sent, size limits, and whether its key is set.
`,

  doctor: () => `Usage
  wavescribe doctor [--json]

Checks node, ffmpeg, ffprobe, yt-dlp, the config file, the cache directory, API keys and site logins.
Exit code 1 when something required is missing.
`,

  login: () => `Usage
  wavescribe login bilibili                read the login from your browsers
  wavescribe login bilibili --qr           log in by scanning a QR code with the Bilibili app
  wavescribe login spotify                 read the login from your browsers, or open Spotify and wait
  wavescribe login spotify --cookie <v>    use a pasted sp_dc cookie
  wavescribe login spotify --browser <b>   only look in one browser (chrome, edge, firefox, …)

Bilibili needs a login for AI subtitles; Spotify needs one for any transcript.
Logins are saved in ~/.config/wavescribe/ (mode 600).
`,
};

export const COMMAND_NAMES = Object.keys(COMMANDS);

/** The help page of one command, or undefined for unknown names. */
export const commandHelp = (name: string): string | undefined => COMMANDS[name]?.();
