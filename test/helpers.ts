// Shared fixtures: a throwaway cache, a silent logger, and fake candidates / plugins.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after } from "node:test";
import { emptyConfig } from "../src/config/config.ts";
import type {
  AudioCandidate,
  Candidate,
  Logger,
  ResolvedSource,
  RunContext,
  TextCandidate,
} from "../src/core/types.ts";
import type { Env } from "../src/pipeline.ts";
import type { ProviderPlugin } from "../src/providers/plugin.ts";

export const silent: Logger = { info() {}, warn() {}, debug() {}, progress() {} };

/** A fresh temporary directory, removed when the test file finishes. */
export function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavescribe-test-"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Tests never read or write the user's real config, saved keys or logins.
process.env.XDG_CONFIG_HOME = tempDir();
delete process.env.WAVESCRIBE_CONFIG;

/** Point the cache at a temporary directory for this test file. */
export function isolateCache(): string {
  const dir = tempDir();
  process.env.WAVESCRIBE_CACHE = dir;
  return dir;
}

export const tools = { ffmpeg: "ffmpeg", ffprobe: "ffprobe", ytDlp: "yt-dlp" };

export function runContext(workDir: string): RunContext {
  return { log: silent, workDir, useCache: true, tools };
}

export function env(plugins: ProviderPlugin[] = []): Env {
  return { cfg: emptyConfig(), reg: new Map(plugins.map((p) => [p.id, p])), log: silent, useCache: true };
}

export function text(label: string, opts: { timed?: boolean; fail?: string; known?: boolean } = {}): TextCandidate {
  const timed = opts.timed ?? true;
  return {
    type: "text",
    label,
    timed: opts.known === false ? undefined : timed,
    async fetch() {
      if (opts.fail) throw new Error(opts.fail);
      return {
        segments: [timed ? { start: 0, end: 1, text: label } : { text: label }],
        timed,
        origin: "publisher",
        fetcher: "test",
      };
    },
  };
}

/** Audio the provider can fetch by URL, so no ffmpeg is needed. */
export const remoteAudio = (url = "https://example.com/a.mp3"): AudioCandidate => ({
  type: "audio",
  label: "remote audio",
  publicUrl: url,
  download: async () => {
    throw new Error("should not download");
  },
});

export function source(candidates: Candidate[], id = `test:${Math.random()}`): ResolvedSource {
  return { meta: { input: "x", id, kind: "url", title: "Test" }, candidates };
}
