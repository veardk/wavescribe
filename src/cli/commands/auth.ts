// `wavescribe auth`: save, list, check and remove speech-to-text API keys.

import { credentialsFromText, mask, resolveCredentials } from "../../config/credentials.ts";
import { loadRawConfig, saveRawConfig, setKey } from "../../config/edit.ts";
import { configFile } from "../../config/paths.ts";
import { removeSecrets, saveSecrets, secretsFile } from "../../config/secrets.ts";
import { asWsError, WsError } from "../../core/errors.ts";
import type { Env } from "../../pipeline.ts";
import type { ProviderPlugin } from "../../providers/plugin.ts";
import { isConfigured, type VerifyResult, verifyProvider } from "../../providers/select.ts";
import type { Values } from "../options.ts";
import { print, printJson } from "../output.ts";
import { confirm, intro, isInteractive, outro, search, secret, spinner, step } from "../ui/prompts.ts";

const USAGE = "wavescribe auth [add <provider> [--stdin] | list | test [provider] | remove <provider>]";
const RECOMMENDED = "groq";
const SOURCE_LABEL = { env: "environment", store: "saved", file: "key file", config: "config" } as const;

export async function cmdAuth(args: string[], v: Values, env: Env): Promise<number> {
  const [sub, id] = args;
  switch (sub) {
    case undefined:
      if (!isInteractive(v["no-input"])) return listKeys(v, env);
      await authWizard(env);
      return 0;
    case "add":
      return addKey(id, v, env);
    case "list":
    case "ls":
      return listKeys(v, env);
    case "test":
      return testKeys(id, v, env);
    case "remove":
    case "rm":
      return removeKey(id, env);
    default:
      throw new WsError("BAD_INPUT", `Unknown command "auth ${sub}"`, { hint: USAGE });
  }
}

function providerOf(env: Env, id: string | undefined): ProviderPlugin {
  if (!id) throw new WsError("BAD_INPUT", "Which provider?", { hint: USAGE });
  const p = env.reg.get(id);
  if (!p)
    throw new WsError("BAD_INPUT", `Unknown provider "${id}"`, {
      hint: `Available: ${[...env.reg.keys()].join(", ")}`,
    });
  return p;
}

/** Environment variables win over saved keys; say so, or the saved key would seem to be ignored. */
function shadowingEnv(plugin: ProviderPlugin, values: Record<string, string>): string[] {
  return plugin.credentials.filter((c) => values[c.name] && process.env[c.env]).map((c) => c.env);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** `auth add <id> --stdin` for scripts; without --stdin it is the interactive flow for that provider. */
async function addKey(id: string | undefined, v: Values, env: Env): Promise<number> {
  if (!v.stdin) {
    if (!isInteractive(v["no-input"]))
      throw new WsError("BAD_INPUT", "No terminal to ask for the key", {
        hint: `Pipe it in: printf %s "$KEY" | wavescribe auth add ${id ?? "<provider>"} --stdin`,
      });
    await authWizard(env, id && providerOf(env, id).id);
    return 0;
  }
  const plugin = providerOf(env, id);
  const values = credentialsFromText(await readStdin(), plugin.credentials);
  const missing = plugin.credentials.filter((c) => !c.optional && !values[c.name]).map((c) => c.env);
  if (missing.length || !Object.keys(values).length)
    throw new WsError(
      "BAD_INPUT",
      `No value for ${missing.join(", ") || plugin.credentials.map((c) => c.env).join(" / ")} on stdin`,
      {
        hint:
          plugin.credentials.length > 1
            ? `Send one NAME=value line each: ${plugin.credentials.map((c) => `${c.env}=…`).join(", ")}`
            : 'Send the key itself, e.g. printf %s "$KEY" | …',
      },
    );
  const problem = plugin.checkCredentials?.(values);
  if (problem) throw new WsError("BAD_INPUT", `${plugin.name}: ${problem}`);
  const check = await verifyProvider(plugin, env.cfg, env, values);
  if (check.status === "invalid") throw new WsError("AUTH", `${plugin.name} rejected the key: ${check.detail}`);
  if (check.status === "unknown") env.log.warn(`Saved without checking: ${check.detail}`);
  await saveSecrets(plugin.id, values);
  env.log.info(`✓ Saved the ${plugin.name} key to ${secretsFile()}`);
  for (const name of shadowingEnv(plugin, values))
    env.log.warn(`${name} is set in your environment and is used instead`);
  return 0;
}

async function pickProvider(env: Env): Promise<ProviderPlugin> {
  const plugins = [...env.reg.values()].sort((a, b) => Number(b.id === RECOMMENDED) - Number(a.id === RECOMMENDED));
  const options = [];
  for (const p of plugins) {
    const hints = [
      (await isConfigured(p, env.cfg)) && "✓ has a key",
      p.id === RECOMMENDED && "fast, free tier",
      p.models.some((m) => m.output.speakers) && "speakers",
    ].filter(Boolean);
    options.push({ value: p, label: `${p.name} (${p.id})`, hint: hints.join(" · ") || undefined });
  }
  return search("Which speech-to-text provider? (type to filter)", options);
}

async function askCredentials(plugin: ProviderPlugin): Promise<Record<string, string>> {
  if (plugin.homepage) step.info(`Get a key: ${plugin.homepage}`);
  const values: Record<string, string> = {};
  for (const c of plugin.credentials) {
    const label = `${c.env}${c.description ? ` — ${c.description}` : ""}${c.optional ? " (optional, Enter to skip)" : ""}`;
    const value = await secret(label, !c.optional);
    if (value) values[c.name] = value;
  }
  const problem = Object.keys(values).length ? plugin.checkCredentials?.(values) : "nothing was entered";
  if (problem) throw new WsError("BAD_INPUT", `${plugin.name}: ${problem}`);
  return values;
}

async function check(plugin: ProviderPlugin, values: Record<string, string>, env: Env): Promise<VerifyResult> {
  const s = spinner();
  s.start(`Checking the key with ${plugin.name}…`);
  const r = await verifyProvider(plugin, env.cfg, env, values).catch(
    (e): VerifyResult => ({ status: "unknown", detail: asWsError(e).message }),
  );
  if (r.status === "valid") s.stop("The key works");
  else if (r.status === "invalid") s.error(`Rejected: ${r.detail}`);
  else s.stop(`Not checked: ${r.detail}`);
  return r;
}

async function setDefaultProvider(env: Env, id: string): Promise<void> {
  const file = env.cfg.file ?? configFile();
  const raw = await loadRawConfig(file);
  setKey(raw, "defaults.provider", id);
  await saveRawConfig(raw, file);
  env.cfg.defaults.provider = id;
}

/** Interactive: choose a provider, paste the key (hidden), check it, save it, optionally make it the default. */
export async function authWizard(env: Env, providerId?: string): Promise<ProviderPlugin> {
  intro("wavescribe · add a speech-to-text key");
  const plugin = providerId ? providerOf(env, providerId) : await pickProvider(env);
  const values = await askCredentials(plugin);
  const result = await check(plugin, values, env);
  if (result.status === "invalid" && !(await confirm("Save it anyway?", false)))
    throw new WsError("AUTH", `${plugin.name} rejected the key`, {
      hint: "Copy the key again and rerun `wavescribe auth`",
    });
  await saveSecrets(plugin.id, values);
  for (const name of shadowingEnv(plugin, values)) step.warn(`${name} is set in your environment and is used instead`);

  const current = env.cfg.defaults.provider;
  let othersReady = false;
  for (const p of env.reg.values()) if (p.id !== plugin.id && (await isConfigured(p, env.cfg))) othersReady = true;
  if ((current ? current !== plugin.id : othersReady) && (await confirm(`Use ${plugin.name} by default?`))) {
    await setDefaultProvider(env, plugin.id);
  }
  outro(`Saved to ${secretsFile()}`);
  return plugin;
}

interface KeyRow {
  id: string;
  name: string;
  ready: boolean;
  default: boolean;
  keys: { env: string; from?: string; preview?: string }[];
}

async function keyRows(env: Env): Promise<KeyRow[]> {
  const rows: KeyRow[] = [];
  for (const p of env.reg.values()) {
    const creds = await resolveCredentials(env.cfg, p.id, p.credentials);
    rows.push({
      id: p.id,
      name: p.name,
      ready: await isConfigured(p, env.cfg),
      default: env.cfg.defaults.provider === p.id,
      keys: p.credentials.map((c) => {
        const value = creds.values[c.name];
        const source = creds.sources[c.name];
        return { env: c.env, from: source && SOURCE_LABEL[source], preview: value && mask(value) };
      }),
    });
  }
  return rows;
}

async function listKeys(v: Values, env: Env): Promise<number> {
  const rows = await keyRows(env);
  if (v.json) {
    printJson(rows);
    return 0;
  }
  const withKeys = rows.filter((r) => r.keys.some((k) => k.preview));
  const lines = withKeys.map((r) => {
    const keys = r.keys
      .filter((k) => k.preview)
      .map((k) => `${k.env} ${k.preview} (${k.from})`)
      .join(", ");
    return `${r.ready ? "✓" : "!"} ${r.id.padEnd(13)} ${keys}${r.default ? "  ← default" : ""}`;
  });
  if (!withKeys.length) lines.push("No API keys yet.");
  lines.push(
    "",
    `Add one: wavescribe auth   ·   ${rows.length - withKeys.length} more providers: wavescribe providers`,
    `Saved keys: ${secretsFile()}`,
  );
  print(lines.join("\n"));
  return 0;
}

async function testKeys(id: string | undefined, v: Values, env: Env): Promise<number> {
  const plugins = id ? [providerOf(env, id)] : [];
  if (!id) for (const p of env.reg.values()) if (await isConfigured(p, env.cfg)) plugins.push(p);
  if (!plugins.length)
    throw new WsError("NO_PROVIDER", "No API keys to check", { hint: "Add one with `wavescribe auth`" });
  const results = [];
  for (const p of plugins) {
    const r = await verifyProvider(p, env.cfg, env).catch(
      (e): VerifyResult => ({ status: "invalid", detail: asWsError(e).message }),
    );
    results.push({ id: p.id, ...r });
  }
  if (v.json) printJson(results);
  else {
    const icon = { valid: "✓", invalid: "✗", unknown: "?" } as const;
    print(
      results
        .map((r) => `${icon[r.status]} ${r.id.padEnd(13)} ${r.status === "valid" ? "works" : (r.detail ?? "")}`)
        .join("\n"),
    );
  }
  return results.some((r) => r.status === "invalid") ? 1 : 0;
}

async function removeKey(id: string | undefined, env: Env): Promise<number> {
  const plugin = providerOf(env, id);
  const removed = await removeSecrets(plugin.id);
  env.log.info(removed ? `✓ Removed the saved ${plugin.name} key` : `No saved key for ${plugin.name}`);
  const fromEnv = plugin.credentials.filter((c) => process.env[c.env]).map((c) => c.env);
  if (fromEnv.length) env.log.warn(`${fromEnv.join(", ")} is still set in your environment`);
  return 0;
}
