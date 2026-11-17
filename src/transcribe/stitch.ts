// Putting per-chunk provider results back on the original audio's timeline.

import type { Segment } from "../core/types.ts";

/** Move segments (and their words) `offset` seconds later. */
export function shiftSegments(segments: Segment[], offset: number): Segment[] {
  if (!offset) return segments;
  return segments.map((s) => ({
    ...s,
    ...(s.start !== undefined ? { start: s.start + offset, end: (s.end ?? s.start) + offset } : {}),
    ...(s.words ? { words: s.words.map((w) => ({ ...w, start: w.start + offset, end: w.end + offset })) } : {}),
  }));
}

/** Speakers become S1, S2… in order of first appearance, whatever the vendor called them. */
export function normalizeSpeakers(segments: Segment[]): Segment[] {
  const map = new Map<string, string>();
  const label = (v: string) => {
    if (!map.has(v)) map.set(v, `S${map.size + 1}`);
    return map.get(v)!;
  };
  return segments.map((s) => {
    const out: Segment = { ...s };
    if (s.speaker !== undefined) out.speaker = label(s.speaker);
    else delete out.speaker;
    if (s.words) out.words = s.words.map((w) => (w.speaker !== undefined ? { ...w, speaker: label(w.speaker) } : w));
    return out;
  });
}
