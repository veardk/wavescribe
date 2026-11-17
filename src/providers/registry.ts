import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Config } from "../config/config.ts";
import { configDir, expandHome } from "../config/paths.ts";
import { WsError } from "../core/errors.ts";
import type { Logger } from "../core/types.ts";
import { BUILTIN_PLUGINS } from "./builtin/index.ts";
import { openAICompatible } from "./openai-compatible.ts";
import { PLUGIN_API_VERSION, type ProviderPlugin } from "./plugin.ts";

export type Registry = Map<string, ProviderPlugin>;

function validate(value: unknown, where: string): ProviderPlugin {
  const problems: string[] = [];
  const p = value as Partial<Record<keyof ProviderPlugin, unknown>> | null;
  if (!p || typeof p !== "object") problems.push("module does not export a plugin object");
  else {
    if (p.apiVersion !== PLUGIN_API_VERSION) problems.push(`apiVersion must be ${PLUGIN_API_VERSION}`);
    if (typeof p.id !== "string" || !/^[a-z0-9][a-z0-9_-]*$/.test(p.id))
      problems.push("id must be lowercase letters, digits, - or _");
    if (!Array.isArray(p.models) || !p.models.length) problems.push("models must be a non-empty array");
    if (typeof p.normalize !== "function") problems.push("normalize() is required");
    if (typeof p.transcribe !== "function" && !(typeof p.submit === "function" && typeof p.poll === "function"))
      problems.push("implement transcribe() or submit() + poll()");
  }
  if (problems.length) throw new WsError("BAD_INPUT", `Invalid provider plugin ${where}: ${problems.join("; ")}`);
  return value as ProviderPlugin;
}

async function importPlugin(spec: string, baseDir: string): Promise<ProviderPlugin[]> {
  const isPath = spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~");
  const target = isPath ? pathToFileURL(path.resolve(baseDir, expandHome(spec))).href : spec;
  const mod = await import(target);
  const exported = mod.default ?? mod.plugin ?? mod.plugins ?? mod;
  const list = Array.isArray(exported) ? exported : [exported];
  return list.map((p) => validate(p, spec));
}

/** Built-in plugins, then config-declared OpenAI-compatible providers, then external plugin modules. */
export async function loadRegistry(cfg: Config, log: Logger): Promise<Registry> {
  const reg: Registry = new Map();
  for (const p of BUILTIN_PLUGINS) reg.set(p.id, p);

  for (const [id, pc] of Object.entries(cfg.providers)) {
    if (pc.type !== "openai-compatible") continue;
    if (!pc.baseUrl) throw new WsError("BAD_INPUT", `providers.${id}: openai-compatible needs a baseUrl`);
    const models = (pc.models?.length ? pc.models : [pc.model ?? "whisper-1"]).map((m, i) => ({
      id: m,
      default: i === 0,
      timestamps: "segment" as const,
      maxBytes: typeof pc.maxBytes === "number" ? pc.maxBytes : 25e6,
    }));
    reg.set(
      id,
      openAICompatible({
        id,
        name: pc.name ?? id,
        baseUrl: pc.baseUrl,
        env: pc.apiKeyEnv ?? `${id.toUpperCase().replace(/-/g, "_")}_API_KEY`,
        models,
      }),
    );
  }

  const specs = [...cfg.plugins];
  const dir = path.join(configDir(), "plugins");
  for (const f of await fsp.readdir(dir).catch(() => [] as string[])) {
    if (/\.(m?js|ts)$/.test(f)) specs.push(path.join(dir, f));
  }
  const baseDir = cfg.file ? path.dirname(cfg.file) : process.cwd();
  for (const spec of specs) {
    try {
      for (const p of await importPlugin(spec, baseDir)) {
        if (reg.has(p.id)) log.debug(`plugin ${spec} replaces provider ${p.id}`);
        reg.set(p.id, p);
      }
    } catch (e) {
      log.warn(`Could not load plugin ${spec}: ${(e as Error).message}`);
    }
  }
  return reg;
}
