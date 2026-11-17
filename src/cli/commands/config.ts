// `wavescribe config`: read and change settings without editing JSON by hand.

import { spawn } from "node:child_process";
import { loadConfig } from "../../config/config.ts";
import { mask } from "../../config/credentials.ts";
import {
  CONFIG_KEYS,
  flattenConfig,
  getKey,
  isSecretKey,
  loadRawConfig,
  parseValue,
  type RawConfig,
  saveRawConfig,
  setKey,
  unsetKey,
} from "../../config/edit.ts";
import { configFile } from "../../config/paths.ts";
import { WsError } from "../../core/errors.ts";
import { EXPORTERS } from "../../exporters/index.ts";
import type { Env } from "../../pipeline.ts";
import { exists } from "../../utils/fs.ts";
import type { Values } from "../options.ts";
import { print, printJson } from "../output.ts";
import { intro, isInteractive, multiselect, outro, select, step, text } from "../ui/prompts.ts";

const USAGE = "wavescribe config [list | get <key> | set <key> <value> | unset <key> | path | edit]";

export async function cmdConfig(args: string[], v: Values, env: Env): Promise<number> {
  const [sub, key, ...rest] = args;
  const file = env.cfg.file ?? configFile();
  switch (sub) {
    case undefined:
      return isInteractive(v["no-input"]) ? configMenu(env, file) : listConfig(v, file);
    case "list":
    case "ls":
      return listConfig(v, file);
    case "path":
      print(file);
      return 0;
    case "get":
      return getConfig(need(key, "get <key>"), v, file);
    case "set":
      return setConfig(need(key, "set <key> <value>"), rest.join(" "), env, file);
    case "unset":
      return unsetConfig(need(key, "unset <key>"), env, file);
    case "edit":
      return editConfig(file, env);
    default:
      throw new WsError("BAD_INPUT", `Unknown command "config ${sub}"`, { hint: USAGE });
  }
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new WsError("BAD_INPUT", `Usage: wavescribe config ${usage}`);
  return value;
}

const show = (key: string, value: unknown): string =>
  isSecretKey(key) && typeof value === "string"
    ? mask(value)
    : Array.isArray(value)
      ? value.join(",")
      : typeof value === "string"
        ? value
        : JSON.stringify(value);

/** Reject values that would only fail later, at run time. */
function validate(key: string, value: unknown, env: Env): void {
  if (key === "defaults.provider" && typeof value === "string" && !env.reg.has(value))
    throw new WsError("BAD_INPUT", `Unknown provider "${value}"`, {
      hint: `Available: ${[...env.reg.keys()].join(", ")}`,
    });
  if (key === "defaults.formats" && Array.isArray(value)) {
    const bad = value.filter((f) => !EXPORTERS[String(f)]);
    if (bad.length)
      throw new WsError("BAD_INPUT", `Unknown format ${bad.join(", ")}`, {
        hint: `Use: ${Object.keys(EXPORTERS).join(", ")}`,
      });
  }
}

async function listConfig(v: Values, file: string): Promise<number> {
  const entries = flattenConfig(await loadRawConfig(file));
  if (v.json) printJson(Object.fromEntries(entries.map(([k, val]) => [k, isSecretKey(k) ? show(k, val) : val])));
  else if (!entries.length) print(`Nothing set yet (${file}). Try: wavescribe config`);
  else print(entries.map(([k, val]) => `${k} = ${show(k, val)}`).join("\n"));
  return 0;
}

async function getConfig(key: string, v: Values, file: string): Promise<number> {
  const value = getKey(await loadRawConfig(file), key);
  if (value === undefined) return 1;
  print(v.json ? JSON.stringify(value) : show(key, value));
  return 0;
}

async function update(file: string, change: (raw: RawConfig) => void): Promise<void> {
  const raw = await loadRawConfig(file);
  change(raw);
  await saveRawConfig(raw, file);
}

async function setConfig(key: string, input: string, env: Env, file: string): Promise<number> {
  if (!input) throw new WsError("BAD_INPUT", `Usage: wavescribe config set ${key} <value>`);
  const value = parseValue(key, input);
  validate(key, value, env);
  await update(file, (raw) => setKey(raw, key, value));
  env.log.info(`✓ ${key} = ${show(key, value)}`);
  return 0;
}

async function unsetConfig(key: string, env: Env, file: string): Promise<number> {
  let removed = false;
  await update(file, (raw) => {
    removed = unsetKey(raw, key);
  });
  env.log.info(removed ? `✓ Removed ${key}` : `${key} was not set`);
  return 0;
}

async function editConfig(file: string, env: Env): Promise<number> {
  if (!(await exists(file))) await saveRawConfig({}, file);
  const editor = process.env.VISUAL || process.env.EDITOR || (process.platform === "win32" ? "notepad" : "vi");
  const [cmd, ...args] = editor.split(/\s+/);
  const code = await new Promise<number>((resolve, reject) => {
    spawn(cmd!, [...args, file], { stdio: "inherit" })
      .on("error", (e) => reject(new WsError("DEPENDENCY", `Cannot start the editor "${editor}": ${e.message}`)))
      .on("exit", (c) => resolve(c ?? 1));
  });
  await loadConfig(file).catch((e: WsError) => env.log.warn(`${e.message} — fix it before the next run`));
  return code;
}

/** Ask for a new value; `undefined` means "unset". */
async function askValue(key: string, current: unknown, env: Env): Promise<unknown> {
  if (key === "defaults.provider") {
    const options = [
      { value: "", label: "automatic", hint: "the first provider that has a key" },
      ...[...env.reg.values()].map((p) => ({ value: p.id, label: `${p.name} (${p.id})` })),
    ];
    return (await select("Default provider", options, typeof current === "string" ? current : "")) || undefined;
  }
  if (key === "defaults.formats") {
    const chosen = await multiselect(
      "Output formats",
      Object.keys(EXPORTERS).map((f) => ({ value: f, label: f })),
      Array.isArray(current) ? current.map(String) : ["srt"],
    );
    return chosen.length ? chosen : undefined;
  }
  const meta = CONFIG_KEYS.find((k) => k.key === key);
  const value = await text(`${key} — ${meta?.description ?? ""} (empty = unset)`, {
    initialValue: current === undefined ? "" : show(key, current),
  });
  return value ? parseValue(key, value) : undefined;
}

async function configMenu(env: Env, file: string): Promise<number> {
  intro("wavescribe · settings");
  for (;;) {
    const raw = await loadRawConfig(file);
    const options = [
      ...CONFIG_KEYS.map((k) => {
        const value = getKey(raw, k.key);
        return { value: k.key, label: k.key, hint: value === undefined ? k.description : show(k.key, value) };
      }),
      { value: "", label: "Done" },
    ];
    const key = await select("Choose a setting", options);
    if (!key) break;
    const value = await askValue(key, getKey(raw, key), env);
    if (value === undefined) {
      unsetKey(raw, key);
      step.success(`${key} unset`);
    } else {
      try {
        validate(key, value, env);
      } catch (e) {
        step.error((e as WsError).message);
        continue;
      }
      setKey(raw, key, value);
      step.success(`${key} = ${show(key, value)}`);
    }
    await saveRawConfig(raw, file);
  }
  outro(`Saved to ${file}`);
  return 0;
}
