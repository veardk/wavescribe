// ① source → ② acquire (text, or audio → ③ transcribe) → ④ export.

import path from "node:path";
import { type Config, resolveTools } from "./config/config.ts";
import { cacheDir, expandHome } from "./config/paths.ts";
import { asWsError, WsError } from "./core/errors.ts";
import { normalizeLanguage } from "./core/lang.ts";
import type { Logger, Provenance, ResolvedSource, RunContext, Segment, Transcript } from "./core/types.ts";
import { exporterFor } from "./exporters/index.ts";
import type { Registry } from "./providers/registry.ts";
import { resolveSource } from "./sources/index.ts";
import type { ChooseEpisode } from "./sources/types.ts";
import { type TranscribeSettings, transcribeAudio } from "./transcribe/index.ts";
import { ensureDir, hash, slugify, writeJson, writeText } from "./utils/fs.ts";

/** Everything one run needs: what to produce, and how to transcribe when there is no text. */
export interface RunOptions extends TranscribeSettings {
  /** Output formats (`srt`, `vtt`, `json`, `txt`, `md`). */
  formats: string[];
  /** Directory, a file name (single format), or `-` for stdout. */
  output?: string;
  /** Add timestamps to txt / md output. */
  timestamps: boolean;
  /** Feed episode selector. */
  episode?: string;
  /** `asr` skips existing captions and transcribes the audio. */
  prefer: "captions" | "asr";
}

export interface Env {
  cfg: Config;
  reg: Registry;
  log: Logger;
  useCache: boolean;
  signal?: AbortSignal;
  /** Interactive front ends can let the user pick a feed episode when none was selected. */
  chooseEpisode?: ChooseEpisode;
}

export interface RunResult {
  transcript: Transcript;
  files: string[];
  stdout?: string;
  workDir: string;
}

/** Errors that would fail the same way for every remaining candidate. */
const FATAL = new Set(["AUTH", "NO_PROVIDER", "TIMEOUT", "DEPENDENCY"]);

export const workDirFor = (id: string) => path.join(cacheDir(), "work", `${id.split(":")[0]}-${hash(id).slice(0, 12)}`);

export function resolveInput(
  input: string,
  opts: Pick<RunOptions, "language" | "episode">,
  env: Env,
): Promise<ResolvedSource> {
  return resolveSource(input, {
    cfg: env.cfg,
    log: env.log,
    tools: resolveTools(env.cfg),
    language: opts.language,
    episode: opts.episode,
    chooseEpisode: env.chooseEpisode,
    signal: env.signal,
  });
}

function makeTranscript(
  resolved: ResolvedSource,
  body: Pick<Transcript, "origin" | "language" | "timed"> & { segments: Segment[] },
  provenance: Omit<Provenance, "createdAt">,
): Transcript {
  return {
    version: 1,
    source: resolved.meta,
    ...body,
    provenance: { ...provenance, createdAt: new Date().toISOString() },
  };
}

/** Try the source's candidates in order until one yields a transcript the requested formats can use. */
export async function produceTranscript(
  resolved: ResolvedSource,
  opts: RunOptions,
  env: Env,
): Promise<{ transcript: Transcript; workDir: string }> {
  const workDir = workDirFor(resolved.meta.id);
  await ensureDir(workDir);
  const ctx: RunContext = {
    log: env.log,
    workDir,
    useCache: env.useCache,
    tools: resolveTools(env.cfg),
    signal: env.signal,
  };
  const needTimed = opts.formats.some((f) => exporterFor(f).needsTimestamps);
  const candidates =
    opts.prefer === "asr"
      ? [...resolved.candidates].sort((a, b) => Number(b.type === "audio") - Number(a.type === "audio"))
      : resolved.candidates;
  if (!candidates.length) throw new WsError("NO_TEXT", "This source offers neither text nor audio");

  const failures: string[] = [];
  let lastErr: WsError | undefined;
  for (const cand of candidates) {
    if (cand.type === "text" && needTimed && cand.timed === false) {
      env.log.debug(`skip ${cand.label}: no timestamps, but ${opts.formats.join("/")} needs them`);
      continue;
    }
    try {
      if (cand.type === "text") {
        env.log.progress({ type: "step", label: `Fetching ${cand.label}` });
        const parsed = await cand.fetch(ctx);
        if (needTimed && !parsed.timed) {
          env.log.info(`  ${cand.label} has no timestamps; trying the next option`);
          continue;
        }
        if (parsed.raw)
          await writeText(path.join(workDir, "source", `transcript.${parsed.raw.ext}`), parsed.raw.content);
        const transcript = makeTranscript(
          resolved,
          {
            origin: parsed.origin,
            language: normalizeLanguage(parsed.language),
            timed: parsed.timed,
            segments: parsed.segments,
          },
          { fetcher: parsed.fetcher },
        );
        return { workDir, transcript };
      }

      const out = await transcribeAudio(cand, ctx, opts, env.cfg, env.reg);
      if (needTimed && !out.timed) {
        throw new WsError(
          "NO_TEXT",
          `${out.provider} ${out.model} returned text without timestamps, so ${opts.formats.join("/")} cannot be written`,
          { hint: "Ask for json/txt/md, or pick a model with timestamps (see `wavescribe providers`)" },
        );
      }
      const options = {
        ...(opts.language ? { language: opts.language } : {}),
        ...(opts.speakers ? { speakers: true } : {}),
        ...(opts.clipSeconds ? { clipSeconds: opts.clipSeconds } : {}),
      };
      const transcript = makeTranscript(
        resolved,
        { origin: "asr", language: out.language, timed: out.timed, segments: out.segments },
        { provider: out.provider, model: out.model, options },
      );
      return { workDir, transcript };
    } catch (e) {
      lastErr = asWsError(e);
      failures.push(`${cand.label}: ${lastErr.message}`);
      if (cand.type === "audio" && FATAL.has(lastErr.code)) throw lastErr;
      env.log.warn(`${cand.label} failed: ${lastErr.message}`);
    }
  }
  if (lastErr && failures.length === 1) throw lastErr;
  throw new WsError(
    lastErr?.code ?? "NO_TEXT",
    failures.length
      ? `Every option failed:\n  - ${failures.join("\n  - ")}`
      : "No usable text: the only transcripts have no timestamps",
    { hint: lastErr?.hint ?? (failures.length ? undefined : "Ask for json/txt/md output, or use --prefer asr") },
  );
}

/** Write each requested format. `-` writes the (single) format to stdout. */
export async function writeOutputs(
  t: Transcript,
  opts: Pick<RunOptions, "formats" | "output" | "timestamps">,
  cfg: Config,
  workDir: string,
): Promise<{ files: string[]; stdout?: string }> {
  await writeJson(path.join(workDir, "transcript.json"), t);
  const exporters = opts.formats.map(exporterFor);
  const eopts = { timestamps: opts.timestamps };
  if (opts.output === "-") {
    if (exporters.length !== 1) throw new WsError("BAD_INPUT", "-o - (stdout) works with a single --format");
    return { files: [], stdout: exporters[0]!.render(t, eopts) };
  }
  const out = expandHome(opts.output ?? cfg.defaults.outDir ?? ".");
  const single = exporters.length === 1 && path.extname(out).slice(1).toLowerCase() === exporters[0]!.ext;
  const files: string[] = [];
  for (const e of exporters) {
    const file = single ? path.resolve(out) : path.resolve(out, `${slugify(t.source.title)}.${e.ext}`);
    await writeText(file, e.render(t, eopts));
    files.push(file);
  }
  return { files };
}

export async function runInput(input: string, opts: RunOptions, env: Env): Promise<RunResult> {
  const resolved = await resolveInput(input, opts, env);
  const { title, episode } = resolved.meta;
  if (title) env.log.info(`${title}${episode ? ` · episode ${episode.index}` : ""}`);
  const { transcript, workDir } = await produceTranscript(resolved, opts, env);
  const { files, stdout } = await writeOutputs(transcript, opts, env.cfg, workDir);
  return { transcript, files, stdout, workDir };
}
