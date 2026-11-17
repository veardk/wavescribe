import type { WsError } from "../core/errors.ts";
import type { Logger } from "../core/types.ts";

/** Data goes to stdout; progress and errors go to stderr through the logger. */
export const print = (s: string) => process.stdout.write(s.endsWith("\n") ? s : `${s}\n`);

export const printJson = (data: unknown) => print(JSON.stringify(data, null, 2));

export function reportError(err: WsError, log: Logger): void {
  log.warn(`${err.message}${err.code !== "INTERNAL" ? ` [${err.code}]` : ""}`);
  if (err.hint) log.warn(`hint: ${err.hint}`);
}

export const errorJson = (err: WsError) => ({ code: err.code, message: err.message, hint: err.hint });
