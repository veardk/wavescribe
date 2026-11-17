// Command-line options and their translation into RunOptions.

import { parseArgs } from "node:util";
import { WsError } from "../core/errors.ts";
import { parseDurationArg } from "../core/time.ts";
import { EXPORTERS } from "../exporters/index.ts";
import type { RunOptions } from "../pipeline.ts";

export const OPTIONS = {
  format: { type: "string", short: "f", multiple: true },
  output: { type: "string", short: "o" },
  provider: { type: "string", short: "p" },
  model: { type: "string", short: "m" },
  lang: { type: "string", short: "l" },
  episode: { type: "string", short: "e" },
  prefer: { type: "string" },
  speakers: { type: "boolean" },
  prompt: { type: "string" },
  clip: { type: "string" },
  opt: { type: "string", multiple: true },
  timestamps: { type: "boolean" },
  timeout: { type: "string" },
  "input-file": { type: "string" },
  "no-cache": { type: "boolean" },
  json: { type: "boolean" },
  qr: { type: "boolean" },
  cookie: { type: "string" },
  browser: { type: "string" },
  stdin: { type: "boolean" },
  "no-input": { type: "boolean" },
  quiet: { type: "boolean", short: "q" },
  verbose: { type: "boolean", short: "v" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

export type Values = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>["values"];

export const parseCommandLine = (argv: string[]) =>
  parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });

function parseExtra(pairs: string[] = []): Record<string, string> {
  const extra: Record<string, string> = {};
  for (const kv of pairs) {
    const i = kv.indexOf("=");
    if (i <= 0) throw new WsError("BAD_INPUT", `--opt expects key=value, got "${kv}"`);
    extra[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return extra;
}

export function toRunOptions(v: Values, defaults: { formats?: string[]; language?: string }): RunOptions {
  const formats = (v.format?.length ? v.format.flatMap((f) => f.split(",")) : (defaults.formats ?? ["srt"]))
    .map((f) => f.trim().toLowerCase())
    .filter(Boolean);
  for (const f of formats) {
    if (!EXPORTERS[f])
      throw new WsError("BAD_INPUT", `Unknown format "${f}"`, { hint: `Use: ${Object.keys(EXPORTERS).join(", ")}` });
  }
  if (v.prefer && v.prefer !== "captions" && v.prefer !== "asr") {
    throw new WsError("BAD_INPUT", "--prefer must be captions or asr");
  }
  return {
    formats: [...new Set(formats)],
    output: v.output,
    provider: v.provider,
    model: v.model,
    language: v.lang ?? defaults.language,
    episode: v.episode,
    prefer: v.prefer === "asr" ? "asr" : "captions",
    speakers: !!v.speakers,
    prompt: v.prompt,
    clipSeconds: v.clip ? parseDurationArg(v.clip) : undefined,
    extra: parseExtra(v.opt),
    timeoutSeconds: v.timeout ? parseDurationArg(v.timeout) : 1800,
    timestamps: !!v.timestamps,
  };
}
