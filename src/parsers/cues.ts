// SubRip (.srt) and WebVTT (.vtt) cues.

import { parseClock } from "../core/time.ts";
import type { Segment } from "../core/types.ts";
import { decodeEntities, joinLines } from "./text.ts";

const CUE_TIME = /((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

export function parseCues(text: string): Segment[] {
  const lines = text.split(/\r?\n/);
  const cues: Segment[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = CUE_TIME.exec(lines[i]!);
    if (!m) continue;
    const body: string[] = [];
    let speaker: string | undefined;
    while (i + 1 < lines.length && lines[i + 1]!.trim() !== "") {
      i++;
      let line = lines[i]!;
      const voice = /<v(?:\.[^ >]+)?\s+([^>]+)>/.exec(line);
      if (voice && !speaker) speaker = voice[1]!.trim();
      line = decodeEntities(line.replace(/<[^>]+>/g, ""));
      body.push(line);
    }
    const textOut = joinLines(body);
    if (!textOut) continue;
    cues.push({
      start: parseClock(m[1]!.replace(",", "."))!,
      end: parseClock(m[2]!.replace(",", "."))!,
      text: textOut,
      ...(speaker ? { speaker } : {}),
    });
  }
  return dedupeRolling(cues);
}

/**
 * Auto-generated VTT (YouTube) repeats the previous line at the start of each cue.
 * Keep only the new text so every sentence appears once. Not a content edit — a format artefact.
 */
export function dedupeRolling(cues: Segment[]): Segment[] {
  const out: Segment[] = [];
  let prev = "";
  for (const c of cues) {
    let t = c.text.trim();
    const last = out.at(-1);
    // Same text again in a contiguous cue: the caption is still on screen, extend it.
    if (last && (t === prev || t === last.text) && (c.start ?? 0) <= (last.end ?? 0) + 0.05) {
      if (c.end !== undefined && (last.end ?? 0) < c.end) last.end = c.end;
      prev = t;
      continue;
    }
    for (const p of [prev, last?.text]) {
      if (p && t.startsWith(p) && t !== p) {
        t = t.slice(p.length).trim();
        break;
      }
    }
    if (t) out.push({ ...c, text: t });
    prev = c.text.trim();
  }
  return out;
}
