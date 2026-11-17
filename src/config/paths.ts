import os from "node:os";
import path from "node:path";

export const expandHome = (p: string): string =>
  p.startsWith("~/") || p === "~" ? path.join(os.homedir(), p.slice(1)) : p;

export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "wavescribe");
}

export function configFile(): string {
  return process.env.WAVESCRIBE_CONFIG
    ? expandHome(process.env.WAVESCRIBE_CONFIG)
    : path.join(configDir(), "config.json");
}

export function cacheDir(): string {
  if (process.env.WAVESCRIBE_CACHE) return expandHome(process.env.WAVESCRIBE_CACHE);
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "wavescribe");
}
