// Helpers for plugins: grouping words into sentences, attaching words to segments, safe numbers.

import type { Segment, Word } from "../core/types.ts";
import { CJK } from "../parsers/text.ts";

export { paragraphs } from "../parsers/text.ts";

const PUNCT_ATTACH = /^[,.!?;:%)\]}，。！？；：、）」』”’…]/;
const SENTENCE_END = /[.!?。！？…]["'”’」』)]?$/;

/** Join word tokens: no space around CJK or before punctuation. `raw` keeps the tokens' own spacing. */
export function joinWords(words: string[], mode: "smart" | "raw" = "smart"): string {
  if (mode === "raw") return words.join("").replace(/\s+/g, " ").trim();
  let out = "";
  for (const w0 of words) {
    const w = w0.trim();
    if (!w) continue;
    if (!out) {
      out = w;
      continue;
    }
    const glue =
      PUNCT_ATTACH.test(w) ||
      (CJK.test(out.at(-1)!) && CJK.test(w[0]!)) ||
      /[([{（「『“‘，。！？；：、）」』”…]$/.test(out)
        ? ""
        : " ";
    out += glue + w;
  }
  return out;
}

export interface GroupOptions {
  /** Start a new segment after a pause longer than this (seconds). */
  maxGap?: number;
  /** Start a new segment once it gets this long (characters). */
  maxChars?: number;
  join?: "smart" | "raw";
}

/** Build sentence-like segments from a word / token stream (for vendors that only return words). */
export function groupWords(words: Word[], opts: GroupOptions = {}): Segment[] {
  const maxGap = opts.maxGap ?? 1.0;
  const maxChars = opts.maxChars ?? 120;
  const join = opts.join ?? "smart";
  const out: Segment[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = joinWords(
      cur.map((w) => w.text),
      join,
    );
    if (text)
      out.push({
        start: cur[0]!.start,
        end: cur.at(-1)!.end,
        text,
        ...(cur[0]!.speaker ? { speaker: cur[0]!.speaker } : {}),
        words: cur,
      });
    cur = [];
  };
  for (const w of words) {
    if (!w.text) continue;
    const prev = cur.at(-1);
    if (prev) {
      const gap = w.start - prev.end;
      const len = joinWords(
        cur.map((x) => x.text),
        join,
      ).length;
      const isPunct = PUNCT_ATTACH.test(w.text.trim());
      if (
        !isPunct &&
        (w.speaker !== prev.speaker || gap > maxGap || SENTENCE_END.test(prev.text.trim()) || len >= maxChars)
      )
        flush();
    }
    cur.push(w);
  }
  flush();
  return out;
}

/** Put a flat word list into the segments whose time range contains each word's midpoint. */
export function attachWords(segments: Segment[], words: Word[]): Segment[] {
  if (!words.length) return segments;
  let i = 0;
  return segments.map((s) => {
    const mine: Word[] = [];
    while (i < words.length) {
      const w = words[i]!;
      const mid = (w.start + w.end) / 2;
      if (s.end !== undefined && mid > s.end + 0.05) break;
      mine.push(w);
      i++;
    }
    return mine.length ? { ...s, words: mine } : s;
  });
}

export const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : fallback;
};

export const str = (v: unknown): string => (v == null ? "" : String(v));

/** Speaker label as a string, or undefined. */
export const spk = (v: unknown): string | undefined =>
  v === undefined || v === null || v === "" ? undefined : String(v);
