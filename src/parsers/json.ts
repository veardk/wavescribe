// JSON transcripts: wavescribe's own output, YouTube json3, Bilibili subtitles,
// Podcasting 2.0 and generic `{start, end, text}` lists.

import { WsError } from "../core/errors.ts";
import type { Segment } from "../core/types.ts";
import { joinLines, paragraphs } from "./text.ts";

type JsonResult = { segments: Segment[]; timed: boolean; language?: string };

export function parseJsonTranscript(raw: any): JsonResult {
  const num = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));
  const timedOf = (segs: Segment[]) => segs.length > 0 && segs.every((s) => s.start !== undefined);

  // wavescribe's own output
  if (raw && raw.version === 1 && Array.isArray(raw.segments) && "timed" in raw) {
    return { segments: raw.segments, timed: !!raw.timed, language: raw.language };
  }
  // YouTube json3
  if (raw && Array.isArray(raw.events)) {
    const segs: Segment[] = [];
    for (const ev of raw.events) {
      if (!Number.isFinite(ev?.tStartMs) || !Array.isArray(ev.segs) || ev.aAppend) continue;
      const text = joinLines(
        ev.segs
          .map((s: any) => String(s?.utf8 ?? ""))
          .join("")
          .split("\n"),
      );
      if (text) segs.push({ start: ev.tStartMs / 1000, end: (ev.tStartMs + (ev.dDurationMs ?? 0)) / 1000, text });
    }
    return { segments: segs, timed: true };
  }
  // Bilibili subtitle JSON
  if (raw && Array.isArray(raw.body)) {
    const segs = raw.body
      .map((b: any) => ({ start: num(b.from)!, end: num(b.to)!, text: String(b.content ?? "").trim() }))
      .filter((s: Segment) => s.text);
    return { segments: segs, timed: true, language: raw.lang };
  }
  const list: any[] | undefined = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.segments)
      ? raw.segments
      : Array.isArray(raw?.cues)
        ? raw.cues
        : undefined;
  if (list) {
    // Podcasting 2.0 JSON transcript ({startTime, endTime, body, speaker}) and generic {start, end, text}
    const segs: Segment[] = list
      .map((s: any) => {
        const text = String(s.text ?? s.body ?? s.content ?? "").trim();
        const start = num(s.start ?? s.startTime ?? s.from ?? s.begin);
        const end = num(s.end ?? s.endTime ?? s.to);
        const seg: Segment = { text };
        if (start !== undefined) {
          seg.start = start;
          seg.end = end ?? start;
        }
        if (s.speaker !== undefined && s.speaker !== null && s.speaker !== "") seg.speaker = String(s.speaker);
        return seg;
      })
      .filter((s) => s.text);
    return { segments: mergePodcastFragments(segs), timed: timedOf(segs), language: raw?.language ?? raw?.langCode };
  }
  if (typeof raw?.text === "string") return { segments: paragraphs(raw.text), timed: false, language: raw.language };
  throw new WsError("UNSUPPORTED_FORMAT", "Unrecognised JSON transcript format");
}

/**
 * Podcasting 2.0 JSON is often word-by-word. Leave it alone unless almost every entry is a single
 * token, then join consecutive fragments of the same speaker into sentences (text unchanged).
 */
function mergePodcastFragments(segs: Segment[]): Segment[] {
  if (segs.length < 20) return segs;
  const short = segs.filter((s) => s.text.length <= 3 || !/\s/.test(s.text.trim())).length;
  if (short / segs.length < 0.8 || segs.some((s) => s.start === undefined)) return segs;
  const out: Segment[] = [];
  let cur: Segment | undefined;
  for (const s of segs) {
    const gap = cur ? s.start! - (cur.end ?? cur.start!) : 0;
    if (!cur || cur.speaker !== s.speaker || gap > 1.5 || /[.!?。！？]$/.test(cur.text) || cur.text.length > 160) {
      cur = {
        start: s.start,
        end: s.end,
        text: s.text,
        ...(s.speaker ? { speaker: s.speaker } : {}),
        words: [{ start: s.start!, end: s.end!, text: s.text }],
      };
      out.push(cur);
    } else {
      cur.text = joinLines([cur.text, s.text]);
      cur.end = s.end;
      cur.words!.push({ start: s.start!, end: s.end!, text: s.text });
    }
  }
  return out;
}
