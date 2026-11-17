// Reading and changing single config keys (`wavescribe config get/set/unset`). Works on the raw
// JSON object so unknown keys and plugin settings survive a rewrite.

import { WsError } from "../core/errors.ts";
import { readJson, writeJson } from "../utils/fs.ts";
import { configFile } from "./paths.ts";

export type RawConfig = Record<string, unknown>;

export interface ConfigKey {
  key: string;
  kind: "string" | "list";
  description: string;
}

/** Keys with a known meaning; any other dotted path is accepted too (e.g. `providers.groq.model`). */
export const CONFIG_KEYS: ConfigKey[] = [
  { key: "defaults.provider", kind: "string", description: "speech-to-text provider used when -p is not given" },
  { key: "defaults.model", kind: "string", description: "model for the default provider" },
  { key: "defaults.language", kind: "string", description: "spoken language, e.g. zh, en (empty = detect)" },
  { key: "defaults.formats", kind: "list", description: "output formats, e.g. srt,txt" },
  { key: "defaults.outDir", kind: "string", description: "where output files go (default: current directory)" },
  { key: "paths.ffmpeg", kind: "string", description: "ffmpeg executable" },
  { key: "paths.ffprobe", kind: "string", description: "ffprobe executable" },
  { key: "paths.ytDlp", kind: "string", description: "yt-dlp executable" },
];

/** Secrets belong in `wavescribe auth`, not in a config file that may be shared. */
export const isSecretKey = (key: string) =>
  /(?:key|token|secret|password|sessdata|spdc)$/i.test(key.split(".").at(-1) ?? "");

export async function loadRawConfig(file = configFile()): Promise<RawConfig> {
  const raw = await readJson<unknown>(file);
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as RawConfig) : {};
}

export const saveRawConfig = (raw: RawConfig, file = configFile()) => writeJson(file, raw);

function splitKey(key: string): string[] {
  const parts = key.split(".");
  if (!key || parts.some((p) => !p)) throw new WsError("BAD_INPUT", `Not a config key: "${key}"`);
  return parts;
}

export function getKey(raw: RawConfig, key: string): unknown {
  let cur: unknown = raw;
  for (const p of splitKey(key)) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as RawConfig)[p];
  }
  return cur;
}

/** Turn command-line text into a value: lists for list keys, JSON literals for unknown keys, else a string. */
export function parseValue(key: string, text: string): unknown {
  const known = CONFIG_KEYS.find((k) => k.key === key);
  if (known?.kind === "list")
    return text
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  if (known) return text;
  if (/^(true|false|null|-?\d+(\.\d+)?)$/.test(text) || /^[[{"]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* not JSON: keep the text */
    }
  }
  return text;
}

export function setKey(raw: RawConfig, key: string, value: unknown): void {
  const parts = splitKey(key);
  const last = parts.at(-1)!;
  if (isSecretKey(key))
    throw new WsError("BAD_INPUT", `"${key}" looks like a secret; it does not belong in the config file`, {
      hint: "Save API keys with `wavescribe auth`",
    });
  let cur = raw;
  for (const p of parts.slice(0, -1)) {
    const next = cur[p];
    if (next !== undefined && (typeof next !== "object" || next === null || Array.isArray(next)))
      throw new WsError("BAD_INPUT", `Cannot set "${key}": "${p}" is not an object`);
    if (next === undefined) cur[p] = {};
    cur = cur[p] as RawConfig;
  }
  cur[last] = value;
}

/** Remove a key, and parent objects it leaves empty. Returns false when the key was not set. */
export function unsetKey(raw: RawConfig, key: string): boolean {
  const parts = splitKey(key);
  const chain: RawConfig[] = [raw];
  for (const p of parts.slice(0, -1)) {
    const next = chain.at(-1)![p];
    if (!next || typeof next !== "object") return false;
    chain.push(next as RawConfig);
  }
  const last = parts.at(-1)!;
  if (!(last in chain.at(-1)!)) return false;
  delete chain.at(-1)![last];
  for (let i = chain.length - 1; i > 0; i--) {
    if (Object.keys(chain[i]!).length) break;
    delete chain[i - 1]![parts[i - 1]!];
  }
  return true;
}

/** Every leaf as `dotted.key → value` (arrays count as leaves). */
export function flattenConfig(raw: RawConfig, prefix = ""): [string, unknown][] {
  const out: [string, unknown][] = [];
  for (const [k, v] of Object.entries(raw)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...flattenConfig(v as RawConfig, key));
    else out.push([key, v]);
  }
  return out;
}
