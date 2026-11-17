// Library entry: run wavescribe programmatically, or import types and helpers for plugins.

export { type Config, loadConfig, resolveTools } from "./config/config.ts";
export { asWsError, type ErrorCode, WsError } from "./core/errors.ts";
export { createLogger, type LogLevel, silentLogger } from "./core/log.ts";
export { fromDuration, fromFrames10ms, fromMs, fromSecString } from "./core/time.ts";
export type * from "./core/types.ts";
export { EXPORTERS, type Exporter, exporterFor } from "./exporters/index.ts";
export { parseText } from "./parsers/index.ts";
export {
  type Env,
  produceTranscript,
  type RunOptions,
  type RunResult,
  resolveInput,
  runInput,
  writeOutputs,
} from "./pipeline.ts";
export { attachWords, groupWords, joinWords } from "./providers/helpers.ts";
export type * from "./providers/plugin.ts";
export { definePlugin, PLUGIN_API_VERSION } from "./providers/plugin.ts";
export { loadRegistry, type Registry } from "./providers/registry.ts";
export type { TranscribeSettings } from "./transcribe/index.ts";
export { VERSION } from "./version.ts";
