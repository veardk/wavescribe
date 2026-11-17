// Plugin SDK entry (`wavescribe/plugin`): everything a provider plugin needs, nothing more.

export { WsError } from "./core/errors.ts";
export { fromDuration, fromFrames10ms, fromMs, fromSecString } from "./core/time.ts";
export type { Segment, Word } from "./core/types.ts";
export { attachWords, groupWords, joinWords, num, paragraphs, spk, str } from "./providers/helpers.ts";
export * from "./providers/plugin.ts";
