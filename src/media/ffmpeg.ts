// Thin wrappers around ffprobe / ffmpeg: inspect, transcode to speech audio, find silences.

import fsp from "node:fs/promises";
import path from "node:path";
import { WsError } from "../core/errors.ts";
import type { Tools } from "../core/types.ts";
import { run, tail } from "../utils/process.ts";

export interface ProbeInfo {
  duration: number;
  size: number;
  container: string;
  hasVideo: boolean;
  hasAudio: boolean;
  audioCodec?: string;
}

type MediaTools = Pick<Tools, "ffmpeg" | "ffprobe">;

export async function probe(tools: MediaTools, file: string): Promise<ProbeInfo> {
  const r = await run(
    tools.ffprobe,
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,size,format_name:stream=codec_type,codec_name",
      "-of",
      "json",
      file,
    ],
    { timeoutMs: 60_000 },
  );
  if (r.code !== 0)
    throw new WsError("UNSUPPORTED_FORMAT", `Cannot read media file ${path.basename(file)}: ${tail(r.stderr)}`);
  const j = JSON.parse(r.stdout || "{}");
  const streams: { codec_type?: string; codec_name?: string }[] = j.streams ?? [];
  const audio = streams.find((s) => s.codec_type === "audio");
  return {
    duration: Number(j.format?.duration ?? 0),
    size: Number(j.format?.size ?? (await fsp.stat(file)).size),
    container: String(j.format?.format_name ?? ""),
    hasVideo: streams.some((s) => s.codec_type === "video" && !/^(mjpeg|png|bmp)$/.test(s.codec_name ?? "")),
    hasAudio: !!audio,
    audioCodec: audio?.codec_name,
  };
}

export type AudioCodec = "mp3" | "ogg" | "flac" | "wav" | "m4a" | "opus";

const CODEC_ARGS: Record<AudioCodec, string[]> = {
  mp3: ["-c:a", "libmp3lame", "-b:a", "48k"],
  ogg: ["-c:a", "libopus", "-b:a", "32k"],
  opus: ["-c:a", "libopus", "-b:a", "32k"],
  m4a: ["-c:a", "aac", "-b:a", "48k"],
  flac: ["-c:a", "flac"],
  wav: ["-c:a", "pcm_s16le"],
};

/** Re-encode to mono 16 kHz speech audio. `start`/`duration` cut a range (seconds). */
export async function transcode(
  tools: MediaTools,
  input: string,
  output: string,
  codec: AudioCodec,
  range: { start?: number; duration?: number } = {},
): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (range.start) args.push("-ss", String(range.start));
  args.push("-i", input);
  if (range.duration) args.push("-t", String(range.duration));
  args.push("-vn", "-map", "0:a:0", "-ac", "1", "-ar", "16000", ...CODEC_ARGS[codec], output);
  const r = await run(tools.ffmpeg, args, { timeoutMs: 3_600_000 });
  if (r.code !== 0)
    throw new WsError("UNSUPPORTED_FORMAT", `ffmpeg could not convert ${path.basename(input)}: ${tail(r.stderr)}`);
}

/** Silence intervals (seconds), used to cut long audio between sentences. */
export async function detectSilences(tools: MediaTools, input: string): Promise<{ start: number; end: number }[]> {
  const r = await run(
    tools.ffmpeg,
    ["-hide_banner", "-nostats", "-i", input, "-af", "silencedetect=noise=-32dB:d=0.35", "-f", "null", "-"],
    { timeoutMs: 3_600_000 },
  );
  const out: { start: number; end: number }[] = [];
  let start: number | undefined;
  for (const line of r.stderr.split("\n")) {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    if (s) start = Math.max(0, Number(s[1]));
    const e = /silence_end: ([\d.]+)/.exec(line);
    if (e && start !== undefined) {
      out.push({ start, end: Number(e[1]) });
      start = undefined;
    }
  }
  return out;
}

/**
 * Choose cut points no more than `maxLen` apart, preferring the middle of a silence that falls in
 * the last 30% of each window; falls back to a hard cut when the speech never pauses.
 */
export function planCuts(duration: number, maxLen: number, silences: { start: number; end: number }[]): number[] {
  const cuts: number[] = [];
  let pos = 0;
  while (duration - pos > maxLen) {
    const lo = pos + maxLen * 0.7;
    const hi = pos + maxLen;
    const inWindow = silences.map((s) => (s.start + s.end) / 2).filter((m) => m > lo && m <= hi);
    const cut = inWindow.length ? inWindow.at(-1)! : hi;
    cuts.push(Math.round(cut * 1000) / 1000);
    pos = cut;
  }
  return cuts;
}
