// Core data model shared by every stage: sources → acquire → transcribe → export.
// Times are always seconds (float) once inside wavescribe.

/** Where the words came from. Tells downstream tools how much to trust them. */
export type Origin = "human" | "auto-caption" | "publisher" | "asr";

export interface Word {
  start: number;
  end: number;
  text: string;
  speaker?: string;
}

export interface Segment {
  /** Absent only for untimed transcripts (plain text sources). */
  start?: number;
  end?: number;
  text: string;
  speaker?: string;
  words?: Word[];
}

export interface EpisodeInfo {
  index: number; // 1 = newest
  title: string;
  guid?: string;
  published?: string; // ISO date
  duration?: number; // seconds
  audioUrl?: string;
}

export type SourceKind = "file" | "url" | "rss" | "apple" | "ximalaya" | "youtube" | "bilibili" | "spotify" | "video";

export interface SourceMeta {
  input: string;
  /** Stable id used for caching, e.g. `youtube:<id>`, `rss:<feed>#<guid>`, `file:<sha1>`. */
  id: string;
  kind: SourceKind;
  title?: string;
  url?: string;
  uploader?: string;
  published?: string;
  duration?: number;
  episode?: EpisodeInfo;
}

export interface Provenance {
  fetcher?: string; // e.g. base-youtube-transcript, yt-dlp, rss-transcript
  provider?: string;
  model?: string;
  createdAt: string;
  options?: Record<string, unknown>;
}

export interface Transcript {
  version: 1;
  source: SourceMeta;
  origin: Origin;
  language?: string;
  timed: boolean;
  segments: Segment[];
  provenance: Provenance;
}

/** Text that a source can hand over directly, already parsed into segments. */
export interface ParsedText {
  segments: Segment[];
  timed: boolean;
  language?: string;
  origin: Origin;
  fetcher: string;
  /** Original file content, kept next to the transcript for reference. */
  raw?: { content: string; ext: string };
}

export interface TextCandidate {
  type: "text";
  label: string;
  /** Known before fetching? Lets the pipeline skip untimed text when timestamps are required. */
  timed?: boolean;
  fetch(ctx: RunContext): Promise<ParsedText>;
}

export interface AudioCandidate {
  type: "audio";
  label: string;
  /** Public URL a provider could fetch by itself. */
  publicUrl?: string;
  /** Downloads (or extracts) the audio and returns a local file path. */
  download(ctx: RunContext): Promise<string>;
}

export type Candidate = TextCandidate | AudioCandidate;

export interface ResolvedSource {
  meta: SourceMeta;
  candidates: Candidate[];
  /** Feed-like sources list their episodes for `wavescribe info`. */
  episodes?: EpisodeInfo[];
}

/**
 * Structured progress, so a terminal, GUI or log file can each show it their own way.
 * A `step` starts a new unit of work and ends the previous one; `bytes` / `parts` update the current one.
 */
export type Progress =
  | { type: "step"; label: string }
  | { type: "bytes"; done: number; total?: number }
  | { type: "parts"; done: number; total: number }
  | { type: "end"; ok: boolean };

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  debug(msg: string): void;
  progress(event: Progress): void;
}

/** External programs wavescribe shells out to (paths or command names). */
export interface Tools {
  ffmpeg: string;
  ffprobe: string;
  ytDlp: string;
}

/** Per-source context handed to candidates when they fetch text or download audio. */
export interface RunContext {
  log: Logger;
  /** Working directory for this source (downloads, chunks, raw responses). */
  workDir: string;
  useCache: boolean;
  tools: Tools;
  signal?: AbortSignal;
}
