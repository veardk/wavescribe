// Plain-text helpers shared by every parser: entities, line joining, paragraphs, HTML.

import type { Segment } from "../core/types.ts";

/** Chinese, Japanese and Korean characters: these scripts are written without spaces between words. */
export const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Join caption lines: no space between CJK characters, one space otherwise. */
export function joinLines(lines: string[]): string {
  let out = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (!out) out = line;
    else out += CJK.test(out.at(-1)!) && CJK.test(line[0]!) ? line : ` ${line}`;
  }
  return out.replace(/[ \t]+/g, " ");
}

/** Collapse spaces that span markup left between CJK characters or before punctuation. */
export function tidySpaces(s: string): string {
  return s
    .replace(/\s+/g, " ")
    .replace(/(\p{Script=Han})\s+(?=\p{Script=Han})/gu, "$1")
    .replace(/\s+([,.!?;:，。！？；：、])/g, "$1")
    .trim();
}

export function paragraphs(text: string): Segment[] {
  const t = text.replace(/\r\n/g, "\n").trim();
  if (!t) return [];
  const blocks = /\n\s*\n/.test(t) ? t.split(/\n\s*\n+/) : t.split("\n");
  return blocks
    .map((b) => b.replace(/[ \t]*\n[ \t]*/g, " ").trim())
    .filter(Boolean)
    .map((text) => ({ text }));
}

export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|section|article|tr)>/gi, "\n\n")
      .replace(/<[^>]+>/g, ""),
  ).replace(/[ \t]+/g, " ");
}
