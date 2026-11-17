#!/usr/bin/env node
// wavescribe command-line entry point.

import { loadConfig } from "../config/config.ts";
import { asWsError, WsError } from "../core/errors.ts";
import { createLogger, type LogLevel } from "../core/log.ts";
import type { Env } from "../pipeline.ts";
import { loadRegistry } from "../providers/registry.ts";
import { VERSION } from "../version.ts";
import { cmdAuth } from "./commands/auth.ts";
import { cmdConfig } from "./commands/config.ts";
import { cmdDoctor } from "./commands/doctor.ts";
import { cmdInfo } from "./commands/info.ts";
import { cmdLogin } from "./commands/login.ts";
import { cmdProviders } from "./commands/providers.ts";
import { cmdRun } from "./commands/run.ts";
import { COMMAND_NAMES, commandHelp, helpText } from "./help.ts";
import { parseCommandLine } from "./options.ts";
import { errorJson, print, printJson, reportError } from "./output.ts";
import { createTerminalLogger } from "./ui/progress.ts";

/** Exit codes: 0 ok, 1 failure, 2 bad usage, 130 interrupted. */
async function main(argv: string[]): Promise<number> {
  let parsed: ReturnType<typeof parseCommandLine>;
  try {
    parsed = parseCommandLine(argv);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\nRun wavescribe --help\n`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  if (v.version) {
    print(VERSION);
    return 0;
  }
  const [cmd, ...rest] = positionals;
  if (cmd === "help" || v.help || (!positionals.length && !v["input-file"])) {
    // `help <command>` and `<command> --help` show that command's page; anything else, the overview.
    const topic = cmd === "help" ? rest[0] : cmd;
    const page = topic ? commandHelp(topic) : undefined;
    if (cmd === "help" && topic && !page) {
      process.stderr.write(`No help for "${topic}". Commands: ${COMMAND_NAMES.join(", ")}\n`);
      return 2;
    }
    process.stdout.write(page ?? helpText());
    return v.help || cmd === "help" ? 0 : 2;
  }
  const level: LogLevel = v.quiet ? "quiet" : v.verbose ? "verbose" : "normal";
  // A live status line at a terminal; plain lines when stderr goes to a file, a pipe or an agent.
  const log = process.stderr.isTTY && level !== "quiet" ? createTerminalLogger(level) : createLogger(level);
  const ac = new AbortController();
  process.once("SIGINT", () => {
    ac.abort(new WsError("INTERNAL", "Interrupted"));
    process.exitCode = 130;
  });
  try {
    const cfg = await loadConfig();
    const env: Env = { cfg, reg: await loadRegistry(cfg, log), log, useCache: !v["no-cache"], signal: ac.signal };
    switch (cmd) {
      case "info":
        return await cmdInfo(rest[0], v, env);
      case "providers":
        return await cmdProviders(v, env);
      case "doctor":
        return await cmdDoctor(v, env);
      case "auth":
        return await cmdAuth(rest, v, env);
      case "config":
        return await cmdConfig(rest, v, env);
      case "login":
        return await cmdLogin(rest[0], v, env);
      case "run":
        return await cmdRun(rest, v, env);
      default:
        return await cmdRun(positionals, v, env);
    }
  } catch (e) {
    if (process.exitCode === 130) return 130; // interrupted, or cancelled at a prompt
    const err = asWsError(e);
    if (v.json) printJson({ ok: false, error: errorJson(err) });
    reportError(err, log);
    if (level === "verbose" && err.stack) process.stderr.write(`${err.stack}\n`);
    return err.code === "BAD_INPUT" ? 2 : 1;
  }
}

// The reader of stdout went away (e.g. `wavescribe … -o - | head`): stop quietly, like other CLI tools.
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(process.exitCode ?? 0);
  throw e;
});

main(process.argv.slice(2)).then((code) => {
  process.exitCode ||= code;
});
