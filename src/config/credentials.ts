import fsp from "node:fs/promises";
import type { Config } from "./config.ts";
import { expandHome } from "./paths.ts";
import { loadSecrets } from "./secrets.ts";

export interface CredentialSpec {
  /** Name the plugin reads, e.g. `apiKey`, `secretId`. */
  name: string;
  /** Environment variable, e.g. `GROQ_API_KEY`. */
  env: string;
  optional?: boolean;
  description?: string;
}

/**
 * Pick a value from a key file. Supports a bare secret, or `NAME=value` lines (dotenv style),
 * so a file like `~/.groq_key` containing `GROQ_API_KEY=gsk_...` just works.
 */
function parseKeyText(content: string): { lines: string[]; pairs: Map<string, string> } {
  const lines = content
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const pairs = new Map<string, string>();
  for (const l of lines) {
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(l);
    if (m) pairs.set(m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, "$2"));
  }
  return { lines, pairs };
}

export function valueFromKeyFile(content: string, env: string): string | undefined {
  const { lines, pairs } = parseKeyText(content);
  if (pairs.has(env)) return pairs.get(env) || undefined;
  if (pairs.size === 1) return [...pairs.values()][0] || undefined;
  if (!pairs.size && lines.length === 1) return lines[0];
  return undefined;
}

/**
 * Values for every credential from text such as piped input. A provider with one credential takes
 * a bare secret (or a single `NAME=value` line); with several, each needs its own `ENV_NAME=value` line.
 */
export function credentialsFromText(content: string, specs: CredentialSpec[]): Record<string, string> {
  const { pairs } = parseKeyText(content);
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const v = specs.length === 1 ? valueFromKeyFile(content, spec.env) : pairs.get(spec.env);
    if (v) out[spec.name] = v;
  }
  return out;
}

/** Where a value came from: environment, `wavescribe auth` (store), a key file, or inline config. */
export type CredentialSource = "env" | "store" | "file" | "config";

export interface ResolvedCredentials {
  values: Record<string, string>;
  sources: Record<string, CredentialSource>;
  missing: CredentialSpec[];
}

/** Resolution order: environment variable → saved by `wavescribe auth` → `<name>File` in config → inline value in config. */
export async function resolveCredentials(
  cfg: Config,
  providerId: string,
  specs: CredentialSpec[],
): Promise<ResolvedCredentials> {
  const pc = cfg.providers[providerId] ?? {};
  const saved = (await loadSecrets())[providerId] ?? {};
  const values: Record<string, string> = {};
  const sources: Record<string, CredentialSource> = {};
  const missing: CredentialSpec[] = [];
  for (const spec of specs) {
    const env = (spec.name === "apiKey" && typeof pc.apiKeyEnv === "string" && pc.apiKeyEnv) || spec.env;
    let v: string | undefined = process.env[env];
    let src: CredentialSource = "env";
    if (!v && saved[spec.name]) {
      v = saved[spec.name];
      src = "store";
    }
    const file = pc[`${spec.name}File`] ?? (spec.name === "apiKey" ? pc.keyFile : undefined);
    if (!v && typeof file === "string") {
      try {
        v = valueFromKeyFile(await fsp.readFile(expandHome(file), "utf8"), env);
        src = "file";
      } catch {
        /* unreadable file counts as missing */
      }
    }
    if (!v && typeof pc[spec.name] === "string") {
      v = pc[spec.name] as string;
      src = "config";
    }
    if (v) {
      values[spec.name] = v;
      sources[spec.name] = src;
    } else if (!spec.optional) {
      missing.push(spec);
    }
  }
  return { values, sources, missing };
}

/** Never print secrets: keep the first 4 characters and the length. */
export const mask = (v: string): string => (v.length <= 8 ? "****" : `${v.slice(0, 4)}…(${v.length})`);
