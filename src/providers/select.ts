// Choosing a provider and model, and building the context a plugin runs with.

import fs from "node:fs";
import fsp from "node:fs/promises";
import type { Config } from "../config/config.ts";
import { resolveCredentials } from "../config/credentials.ts";
import { asWsError, WsError } from "../core/errors.ts";
import type { Logger } from "../core/types.ts";
import { createHttp } from "../utils/http.ts";
import type { ModelSpec, PluginContext, ProviderPlugin } from "./plugin.ts";
import type { Registry } from "./registry.ts";

/** A model's call style: declared, or sync when the plugin implements `transcribe`. */
export const modelMode = (plugin: ProviderPlugin, model: ModelSpec): "sync" | "async" =>
  model.mode ?? (plugin.transcribe ? "sync" : "async");

/** The requested model, or the default. Unknown ids keep the default model's capabilities. */
export function pickModel(plugin: ProviderPlugin, wanted: string | undefined, log?: Logger): ModelSpec {
  const def = plugin.models.find((m) => m.default) ?? plugin.models[0]!;
  if (!wanted) return def;
  const found = plugin.models.find((m) => m.id === wanted);
  if (found) return found;
  log?.debug(`model ${wanted} is not in ${plugin.id}'s list; using ${def.id}'s capabilities`);
  return { ...def, id: wanted, default: false };
}

/** Model from `providers.<id>.model`, or `defaults.model` when this is the default provider. */
export function configuredModel(plugin: ProviderPlugin, cfg: Config): string | undefined {
  const m = cfg.providers[plugin.id]?.model ?? (cfg.defaults.provider === plugin.id ? cfg.defaults.model : undefined);
  return typeof m === "string" ? m : undefined;
}

/** Plugin settings: config value → environment variable → declared default. */
export function resolveSettings(plugin: ProviderPlugin, cfg: Config): Record<string, string> {
  const pc = cfg.providers[plugin.id] ?? {};
  const out: Record<string, string> = {};
  for (const s of plugin.settings ?? []) {
    const fromConfig =
      typeof pc[s.name] === "string" || typeof pc[s.name] === "number" ? String(pc[s.name]) : undefined;
    const v = fromConfig ?? (s.env ? process.env[s.env] : undefined) ?? s.default;
    if (v !== undefined) out[s.name] = v;
  }
  return out;
}

export async function isConfigured(plugin: ProviderPlugin, cfg: Config): Promise<boolean> {
  const c = await resolveCredentials(cfg, plugin.id, plugin.credentials);
  // All-optional credentials (alternatives) still need at least one value; plugins that need none are ready.
  const hasAny = plugin.credentials.length === 0 || Object.keys(c.values).length > 0;
  return !c.missing.length && hasAny && !plugin.checkCredentials?.(c.values);
}

/** Explicit choice → config default → first provider whose credentials are configured. */
export async function chooseProvider(reg: Registry, cfg: Config, wanted: string | undefined): Promise<ProviderPlugin> {
  const id = wanted ?? cfg.defaults.provider;
  if (id) {
    const p = reg.get(id);
    if (!p)
      throw new WsError("NO_PROVIDER", `Unknown provider "${id}"`, {
        hint: `Available: ${[...reg.keys()].join(", ")}`,
      });
    return p;
  }
  for (const p of reg.values()) if (await isConfigured(p, cfg)) return p;
  throw new WsError("NO_PROVIDER", "No speech-to-text provider is configured", {
    hint: "Run `wavescribe auth` to add an API key (or set one, e.g. GROQ_API_KEY)",
  });
}

/** Context for one plugin call. `credentials` overrides the configured ones (checking a key before saving it). */
export async function pluginContext(
  plugin: ProviderPlugin,
  cfg: Config,
  ctx: { log: Logger; signal?: AbortSignal },
  credentials?: Record<string, string>,
): Promise<PluginContext> {
  let values = credentials;
  if (!values) {
    const creds = await resolveCredentials(cfg, plugin.id, plugin.credentials);
    if (creds.missing.length) {
      const names = creds.missing.map((m) => m.env).join(", ");
      throw new WsError("AUTH", `${plugin.name} needs ${names}`, {
        hint: `Run \`wavescribe auth add ${plugin.id}\`, or export ${names}`,
      });
    }
    values = creds.values;
  }
  const problem = plugin.checkCredentials?.(values);
  if (problem) throw new WsError("AUTH", `${plugin.name}: ${problem}`);
  return {
    credentials: values,
    settings: resolveSettings(plugin, cfg),
    http: createHttp(ctx.log, { signal: ctx.signal }),
    log: ctx.log,
    signal: ctx.signal,
    blob: (p, mime) => fs.openAsBlob(p, mime ? { type: mime } : undefined),
    base64: async (p) => (await fsp.readFile(p)).toString("base64"),
  };
}

export interface VerifyResult {
  /** `unknown`: the provider has no check, or the check itself failed (network, endpoint missing). */
  status: "valid" | "invalid" | "unknown";
  detail?: string;
}

/** Ask the provider whether the credentials work, without transcribing anything. */
export async function verifyProvider(
  plugin: ProviderPlugin,
  cfg: Config,
  ctx: { log: Logger; signal?: AbortSignal },
  credentials?: Record<string, string>,
): Promise<VerifyResult> {
  const pctx = await pluginContext(plugin, cfg, ctx, credentials);
  if (!plugin.verify)
    return { status: "unknown", detail: "no quick check for this provider; it is tried on first use" };
  try {
    await plugin.verify(pctx);
    return { status: "valid" };
  } catch (e) {
    const err = asWsError(e);
    return { status: err.code === "AUTH" ? "invalid" : "unknown", detail: err.message };
  }
}
