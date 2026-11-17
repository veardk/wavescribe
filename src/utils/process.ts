import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { WsError } from "../core/errors.ts";

export interface ProcResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string; signal?: AbortSignal } = {},
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessByStdio<null, Readable, Readable>;
    try {
      child = spawn(cmd, args, { cwd: opts.cwd, signal: opts.signal, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new WsError("DEPENDENCY", `Cannot run ${cmd}: ${(e as Error).message}`));
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => {
      stdout += d;
    });
    child.stderr.setEncoding("utf8").on("data", (d: string) => {
      stderr += d;
    });
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        e.code === "ENOENT"
          ? new WsError("DEPENDENCY", `${cmd} is not installed or not on PATH`, { hint: depHint(cmd) })
          : new WsError("INTERNAL", `${cmd} failed: ${e.message}`),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

function depHint(cmd: string): string | undefined {
  if (/ffmpeg|ffprobe/.test(cmd)) return "Install ffmpeg: brew install ffmpeg";
  if (/yt-dlp/.test(cmd)) return "Install yt-dlp: brew install yt-dlp";
  return undefined;
}

export async function which(cmd: string): Promise<boolean> {
  try {
    const r = await run(cmd, ["--version"], { timeoutMs: 15_000 });
    return r.code === 0 || r.stdout.length > 0;
  } catch {
    try {
      const r = await run(cmd, ["-version"], { timeoutMs: 15_000 });
      return r.code === 0;
    } catch {
      return false;
    }
  }
}

export const tail = (s: string, n = 400): string => s.trim().slice(-n);
