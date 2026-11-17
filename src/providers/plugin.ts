// Public plugin API. A provider plugin only describes what a vendor accepts, how to call it,
// and how to translate its answer. Retries, polling, chunking, transcoding, caching and
// credentials are handled by wavescribe's core.

import type { CredentialSpec } from "../config/credentials.ts";
import type { Logger, Segment } from "../core/types.ts";
import type { Http } from "../utils/http.ts";

export const PLUGIN_API_VERSION = 1;

/** How audio can be handed to the vendor, in the plugin's order of preference. */
export type Delivery =
  | "multipart" // multipart/form-data upload
  | "raw" // raw bytes as the request body
  | "base64" // base64 inside a JSON body
  | "url" // a public URL the vendor fetches itself
  | "upload"; // the plugin's own upload step returns a reference (see `upload`)

export interface ModelSpec {
  id: string;
  label?: string;
  default?: boolean;
  /** Which call style this model uses when the plugin implements both. Default: sync if `transcribe` exists. */
  mode?: "sync" | "async";
  input: {
    delivery: Delivery[];
    /** Per-file limit for local deliveries (bytes). Larger audio is compressed, then split. */
    maxBytes?: number;
    /** Per-request duration limit (seconds). */
    maxSeconds?: number;
    /** Accepted file extensions; omitted = anything ffmpeg-readable is fine. */
    formats?: string[];
  };
  output: {
    timestamps: "none" | "segment" | "word";
    speakers?: boolean;
    detectLanguage?: boolean;
  };
}

export interface SettingSpec {
  name: string;
  env?: string;
  default?: string;
  description?: string;
}

export type AudioPayload =
  | { kind: "file"; path: string; filename: string; mime: string; size: number; format: string; duration?: number }
  | { kind: "url"; url: string; format?: string }
  | { kind: "ref"; ref: string; format?: string };

export interface TranscribeOptions {
  model: string;
  /** BCP-47 language from the user (already mapped through `mapLanguage` into `providerLanguage`). */
  language?: string;
  providerLanguage?: string;
  speakers: boolean;
  prompt?: string;
  /** Free-form `--opt key=value` pairs for vendor-specific switches. */
  extra: Record<string, string>;
}

export interface PluginContext {
  credentials: Record<string, string>;
  settings: Record<string, string>;
  http: Http;
  log: Logger;
  signal?: AbortSignal;
  /** File as a re-sendable Blob (for multipart / raw bodies). */
  blob(path: string, mime?: string): Promise<Blob>;
  base64(path: string): Promise<string>;
}

export interface TaskRef {
  id: string;
  data?: Record<string, unknown>;
}

export type PollResult =
  | { state: "pending"; detail?: string }
  | { state: "done"; raw?: unknown }
  | { state: "failed"; message: string };

export interface ProviderResult {
  segments: Segment[];
  language?: string;
  duration?: number;
  /** Defaults to "every segment has a start time". */
  timed?: boolean;
}

export interface ProviderPlugin {
  apiVersion: number;
  id: string;
  name: string;
  homepage?: string;
  credentials: CredentialSpec[];
  settings?: SettingSpec[];
  models: ModelSpec[];
  /** Extra check when credentials are alternatives (e.g. an API key OR an app id + token). Return a problem, or undefined. */
  checkCredentials?(values: Record<string, string>): string | undefined;
  /**
   * Optional cheap, free request that proves the credentials work (e.g. list models), used by
   * `wavescribe auth`. Let the HTTP helper throw: a 401/403 means the key was rejected.
   */
  verify?(ctx: PluginContext): Promise<void>;
  /** Map a BCP-47 tag to the vendor's code; return undefined to let the vendor auto-detect. */
  mapLanguage?(language: string, model: string): string | undefined;
  /** For the "upload" delivery: send a local file to the vendor, return a URL or id. */
  upload?(file: AudioPayload & { kind: "file" }, ctx: PluginContext): Promise<string>;

  /** Synchronous vendors: one call returns the raw response. */
  transcribe?(audio: AudioPayload, opts: TranscribeOptions, ctx: PluginContext): Promise<unknown>;
  /** Asynchronous vendors: submit → poll → (optionally) fetch the result. */
  submit?(audio: AudioPayload, opts: TranscribeOptions, ctx: PluginContext): Promise<TaskRef>;
  poll?(task: TaskRef, ctx: PluginContext): Promise<PollResult>;
  fetchResult?(task: TaskRef, ctx: PluginContext): Promise<unknown>;
  /** First poll delay and cap (ms). */
  pollIntervalMs?: { initial: number; max: number };

  /** Pure translation of the vendor's raw response. Must not do I/O (it is run on cached raw data too). */
  normalize(raw: unknown, opts: TranscribeOptions): ProviderResult;
}

/** Identity helper that gives plugin authors type checking. */
export const definePlugin = <T extends ProviderPlugin>(plugin: T): T => plugin;
