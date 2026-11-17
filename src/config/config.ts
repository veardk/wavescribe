import fsp from "node:fs/promises";
import { WsError } from "../core/errors.ts";
import type { Tools } from "../core/types.ts";
import { configFile, expandHome } from "./paths.ts";

/** Per-provider settings. Known keys are documented; anything else is passed to the plugin as a setting. */
export interface ProviderConfig {
  /** Declare a provider without writing a plugin. */
  type?: "openai-compatible";
  name?: string;
  baseUrl?: string;
  model?: string;
  models?: string[];
  apiKeyEnv?: string;
  [key: string]: unknown;
}

export interface Config {
  defaults: {
    provider?: string;
    model?: string;
    language?: string;
    formats?: string[];
    outDir?: string;
  };
  providers: Record<string, ProviderConfig>;
  /** Extra plugin modules: file paths or package names. */
  plugins: string[];
  bilibili?: { sessdata?: string };
  /** Spotify `sp_dc` cookie of an open.spotify.com login. */
  spotify?: { spDc?: string };
  paths: { ffmpeg?: string; ffprobe?: string; ytDlp?: string };
  file?: string;
}

export const emptyConfig = (): Config => ({ defaults: {}, providers: {}, plugins: [], paths: {} });

export async function loadConfig(file = configFile()): Promise<Config> {
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch {
    return { ...emptyConfig(), file };
  }
  let raw: Partial<Config>;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new WsError("BAD_INPUT", `Config file is not valid JSON: ${file}`, { cause: e });
  }
  return {
    defaults: raw.defaults ?? {},
    providers: raw.providers ?? {},
    plugins: raw.plugins ?? [],
    bilibili: raw.bilibili,
    spotify: raw.spotify,
    paths: raw.paths ?? {},
    file,
  };
}

/** Paths of the external programs, from `paths` in the config or the plain command names. */
export function resolveTools(cfg: Config): Tools {
  return {
    ffmpeg: expandHome(cfg.paths.ffmpeg ?? "ffmpeg"),
    ffprobe: expandHome(cfg.paths.ffprobe ?? "ffprobe"),
    ytDlp: expandHome(cfg.paths.ytDlp ?? "yt-dlp"),
  };
}
