// TTML / DFXP, including the Apple Podcasts flavour (tick-based times, timed spans).

import { parseClock } from "../core/time.ts";
import type { Segment } from "../core/types.ts";
import { decodeEntities, joinLines, tidySpaces } from "./text.ts";

export function parseTtml(xml: string): { segments: Segment[]; language?: string } {
  const tickRate = Number(/ttp:tickRate="(\d+)"/.exec(xml)?.[1] ?? 10_000_000);
  const lang = /<tt\b[^>]*\bxml:lang="([^"]+)"/.exec(xml)?.[1];
  const time = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const t = /^([\d.]+)t$/.exec(v.trim());
    return t ? Number(t[1]) / tickRate : parseClock(v);
  };
  const segments: Segment[] = [];
  const re = /<p\b([^>]*)>([\s\S]*?)<\/p>/g;
  for (const m of xml.matchAll(re)) {
    const attrs = m[1]!;
    const a = (name: string) => new RegExp(`(?:^|\\s)(?:[\\w-]+:)?${name}="([^"]*)"`).exec(attrs)?.[1];
    let start = time(a("begin"));
    let end = time(a("end"));
    const dur = time(a("dur"));
    const inner = m[2]!;
    if (start === undefined) {
      // Some files time the spans instead of the paragraph.
      const spans = [...inner.matchAll(/<span\b[^>]*\bbegin="([^"]+)"[^>]*\bend="([^"]+)"/g)];
      if (spans.length) {
        start = time(spans[0]![1]);
        end = time(spans.at(-1)![2]);
      }
    }
    if (end === undefined && start !== undefined && dur !== undefined) end = start + dur;
    const text = joinLines(
      decodeEntities(inner.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " "))
        .split("\n")
        .map((l) => l.replace(/\s+/g, " ")),
    );
    const speaker = a("agent");
    if (!text || start === undefined) continue;
    segments.push({ start, end: end ?? start, text: tidySpaces(text), ...(speaker ? { speaker } : {}) });
  }
  return { segments, language: lang };
}
