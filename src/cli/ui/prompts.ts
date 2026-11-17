// Interactive questions (built on @clack/prompts). They draw on stderr, so stdout stays clean for
// data, and they are only used when a person is at the terminal.

import * as clack from "@clack/prompts";
import { WsError } from "../../core/errors.ts";

const io = { input: process.stdin, output: process.stderr };

/**
 * A person can answer questions: stdin and stderr are terminals, `--no-input` was not given, and
 * this is not CI. Scripts, pipes and agents never get a question; they get an error with a hint.
 */
export function isInteractive(noInput?: boolean): boolean {
  return !noInput && !!process.stdin.isTTY && !!process.stderr.isTTY && !process.env.CI;
}

/** Ctrl+C / Esc in a prompt ends the command like an interrupt (exit code 130). */
function answer<T>(value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel("Cancelled", io);
    process.exitCode = 130;
    throw new WsError("INTERNAL", "Cancelled");
  }
  return value as T;
}

export interface Choice<T> {
  value: T;
  label: string;
  hint?: string;
}

export const select = async <T>(message: string, options: Choice<T>[], initialValue?: T): Promise<T> =>
  answer<T>(await clack.select<T>({ ...io, message, options: options as clack.Option<T>[], initialValue }));

/** A long list the user can filter by typing. */
export const search = async <T>(message: string, options: Choice<T>[], maxItems = 10): Promise<T> =>
  answer<T>(await clack.autocomplete<T>({ ...io, message, options: options as clack.Option<T>[], maxItems }));

export const multiselect = async <T>(message: string, options: Choice<T>[], initialValues: T[]): Promise<T[]> =>
  answer<T[]>(
    await clack.multiselect<T>({
      ...io,
      message,
      options: options as clack.Option<T>[],
      initialValues,
      required: false,
    }),
  );

export const confirm = async (message: string, initialValue = true): Promise<boolean> =>
  answer<boolean>(await clack.confirm({ ...io, message, initialValue }));

export const text = async (message: string, opts: { initialValue?: string; placeholder?: string } = {}) =>
  answer<string>(await clack.text({ ...io, message, ...opts })).trim();

/** Hidden input for secrets. */
export const secret = async (message: string, required: boolean): Promise<string> =>
  answer<string>(
    await clack.password({
      ...io,
      message,
      validate: (v) => (required && !v?.trim() ? "Required" : undefined),
    }),
  ).trim();

export const intro = (title: string) => clack.intro(title, io);
export const outro = (message: string) => clack.outro(message, io);
export const note = (message: string, title?: string) => clack.note(message, title, io);
export const step = {
  info: (m: string) => clack.log.info(m, io),
  success: (m: string) => clack.log.success(m, io),
  warn: (m: string) => clack.log.warn(m, io),
  error: (m: string) => clack.log.error(m, io),
};

/** A spinner for one task: `start(label)`, then `stop(text)` (done) or `error(text)`. */
export const spinner = () => clack.spinner(io);
