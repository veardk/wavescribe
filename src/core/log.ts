import type { Logger, Progress } from "./types.ts";

export type LogLevel = "quiet" | "normal" | "verbose";

/**
 * Plain line-by-line logger: progress and diagnostics go to stderr, stdout is reserved for data.
 * Progress becomes text lines (steps and finished parts); byte counts are left to richer UIs.
 */
export function createLogger(level: LogLevel = "normal"): Logger {
  const out = (prefix: string, msg: string) => process.stderr.write(`${prefix}${msg}\n`);
  const info = (msg: string) => {
    if (level !== "quiet") out("", msg);
  };
  return {
    info,
    warn: (msg) => out("! ", msg),
    debug: (msg) => {
      if (level === "verbose") out("· ", msg);
    },
    progress: (e: Progress) => {
      if (e.type === "step") info(`${e.label}…`);
      else if (e.type === "parts" && e.total > 1) info(`  part ${e.done}/${e.total} done`);
    },
  };
}

export const silentLogger: Logger = { info() {}, warn() {}, debug() {}, progress() {} };
