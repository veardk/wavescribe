import fsp from "node:fs/promises";
import { asWsError, WsError } from "../../core/errors.ts";
import { formatClock } from "../../core/time.ts";
import type { EpisodeInfo } from "../../core/types.ts";
import { type Env, type RunOptions, type RunResult, runInput } from "../../pipeline.ts";
import { toRunOptions, type Values } from "../options.ts";
import { errorJson, printJson, reportError } from "../output.ts";
import { confirm, isInteractive, search } from "../ui/prompts.ts";
import { authWizard } from "./auth.ts";

async function readInputFile(file: string): Promise<string[]> {
  return (await fsp.readFile(file, "utf8"))
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

/** Feed without `-e` at a terminal: let the user pick (type to filter). */
function episodePicker(env: Env) {
  return (episodes: EpisodeInfo[]): Promise<number> => {
    env.log.progress({ type: "end", ok: true });
    return search(
      `Which episode? (${episodes.length}, newest first — type to filter)`,
      episodes.map((e) => ({
        value: e.index,
        label: e.title,
        hint: [e.published?.slice(0, 10), e.duration && formatClock(e.duration)].filter(Boolean).join(" · "),
      })),
    );
  };
}

/** One input; at a terminal, a missing API key starts the key setup and then retries once. */
async function runOne(input: string, opts: RunOptions, env: Env, interactive: boolean): Promise<RunResult> {
  try {
    return await runInput(input, opts, env);
  } catch (e) {
    const err = asWsError(e);
    env.log.progress({ type: "end", ok: false });
    if (!interactive || err.code !== "NO_PROVIDER" || opts.provider) throw err;
    if (!(await confirm("This needs speech-to-text, but no API key is set up yet. Add one now?"))) throw err;
    await authWizard(env);
    return runInput(input, opts, env);
  }
}

export async function cmdRun(positionals: string[], v: Values, env: Env): Promise<number> {
  const opts = toRunOptions(v, env.cfg.defaults);
  const inputs = [...positionals, ...(v["input-file"] ? await readInputFile(v["input-file"]) : [])];
  if (!inputs.length)
    throw new WsError("BAD_INPUT", "Nothing to transcribe", { hint: "wavescribe <file|url>  (see --help)" });
  if (inputs.length > 1 && opts.output === "-") throw new WsError("BAD_INPUT", "-o - works with a single input");
  const interactive = isInteractive(v["no-input"]);
  const runEnv: Env = interactive ? { ...env, chooseEpisode: episodePicker(env) } : env;

  const results: unknown[] = [];
  let failed = 0;
  for (const input of inputs) {
    try {
      const r = await runOne(input, opts, runEnv, interactive);
      env.log.progress({ type: "end", ok: true });
      const t = r.transcript;
      const { provider, model, fetcher } = t.provenance;
      if (r.stdout !== undefined) process.stdout.write(r.stdout);
      const via = provider ? `${provider} · ${model}` : fetcher;
      const files = r.files.map((f) => `\n  ${f}`).join("");
      env.log.info(`✓ ${t.segments.length} segments (${t.origin}${via ? `, ${via}` : ""})${files}`);
      results.push({
        ok: true,
        input,
        title: t.source.title,
        origin: t.origin,
        provider,
        model,
        fetcher,
        language: t.language,
        timed: t.timed,
        segments: t.segments.length,
        files: r.files,
      });
    } catch (e) {
      failed++;
      const err = asWsError(e);
      env.log.progress({ type: "end", ok: false });
      if (process.exitCode === 130) throw err; // cancelled at a prompt: stop the whole batch
      reportError(err, env.log);
      results.push({ ok: false, input, error: errorJson(err) });
    }
  }
  if (v.json && opts.output !== "-") printJson(results.length === 1 ? results[0] : results);
  return failed ? 1 : 0;
}
