import os from "node:os";
import { resolveTools } from "../../config/config.ts";
import { cacheDir, configFile } from "../../config/paths.ts";
import type { Env } from "../../pipeline.ts";
import { isConfigured } from "../../providers/select.ts";
import { cookieFile, savedSessdata } from "../../sources/bilibili/auth.ts";
import { savedSession as savedSpotify } from "../../sources/spotify/auth.ts";
import { exists } from "../../utils/fs.ts";
import { run } from "../../utils/process.ts";
import type { Values } from "../options.ts";
import { print, printJson } from "../output.ts";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A failed required check makes `doctor` exit non-zero. */
  required?: boolean;
}

async function versionOf(name: string, cmd: string, args: string[], required = false): Promise<Check> {
  try {
    const r = await run(cmd, args, { timeoutMs: 15_000 });
    return { name, ok: r.code === 0, detail: (r.stdout || r.stderr).split("\n")[0]!.trim(), required };
  } catch (e) {
    return { name, ok: false, detail: (e as Error).message, required };
  }
}

export async function cmdDoctor(v: Values, env: Env): Promise<number> {
  const tools = resolveTools(env.cfg);
  const configured = [];
  for (const p of env.reg.values()) if (await isConfigured(p, env.cfg)) configured.push(p.id);
  const hasConfig = await exists(configFile());
  const spotify = await savedSpotify(env.cfg);
  const checks: Check[] = [
    { name: "system", ok: true, detail: `${os.type()} ${os.release()} (${process.arch})` },
    { name: "node", ok: true, detail: process.version },
    await versionOf("ffmpeg", tools.ffmpeg, ["-version"], true),
    await versionOf("ffprobe", tools.ffprobe, ["-version"], true),
    await versionOf("yt-dlp", tools.ytDlp, ["--version"]),
    { name: "config", ok: true, detail: `${configFile()}${hasConfig ? "" : " (not created yet — optional)"}` },
    { name: "cache", ok: true, detail: cacheDir() },
    {
      name: "providers",
      ok: configured.length > 0,
      detail: configured.length
        ? configured.join(", ")
        : "no API keys yet: `wavescribe auth` (needed only when a source has no captions)",
    },
    {
      name: "bilibili",
      ok: true,
      detail: (await savedSessdata(env.cfg))
        ? `login saved (${cookieFile()})`
        : "not logged in (only needed for some Bilibili subtitles)",
    },
    {
      name: "spotify",
      ok: true,
      detail: spotify
        ? `login saved (${spotify.source})`
        : "not logged in (needed for Spotify transcripts: wavescribe login spotify)",
    },
  ];
  if (v.json) printJson(checks);
  else print(checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.name.padEnd(10)} ${c.detail}`).join("\n"));
  return checks.every((c) => c.ok || !c.required) ? 0 : 1;
}
