// Subtitle / transcript parsers: srt, vtt, ttml, json (several dialects), txt/md, html.
// Parsing only decodes the format (tags, entities, rolling duplicates); it never edits wording.

import type { Segment } from "../core/types.ts";
import { parseCues } from "./cues.ts";
import { parseJsonTranscript } from "./json.ts";
import { htmlToText, paragraphs } from "./text.ts";
import { parseTtml } from "./ttml.ts";

export { dedupeRolling, parseCues } from "./cues.ts";
export { parseJsonTranscript } from "./json.ts";
export { decodeEntities, htmlToText, joinLines, paragraphs } from "./text.ts";
export { parseTtml } from "./ttml.ts";

export type TextFormat = "srt" | "vtt" | "ttml" | "json" | "txt" | "html";

export interface ParseResult {
  format: TextFormat;
  segments: Segment[];
  timed: boolean;
  language?: string;
}

export function detectFormat(content: string, ext?: string): TextFormat {
  const e = (ext ?? "").toLowerCase();
  const head = content.replace(/^﻿/, "").trimStart().slice(0, 400);
  if (head.startsWith("WEBVTT")) return "vtt";
  if (e === "vtt") return "vtt";
  if (e === "srt") return "srt";
  if (e === "json" || e === "json3" || head.startsWith("{") || head.startsWith("[")) return "json";
  if (e === "ttml" || e === "dfxp" || /<tt[\s>]/.test(head)) return "ttml";
  if (e === "html" || e === "htm" || /^<(!doctype html|html|body|div|p)\b/i.test(head)) return "html";
  if (e === "xml" && /<p\b[^>]*\bbegin=/.test(content)) return "ttml";
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(head)) return "srt";
  if (/\d{1,2}:\d{2}[,.]\d{3}\s*-->/.test(head)) return "vtt";
  return "txt";
}

export function parseText(content: string, ext?: string): ParseResult {
  const text = content.replace(/^﻿/, "");
  const format = detectFormat(text, ext);
  switch (format) {
    case "srt":
    case "vtt":
      return { format, timed: true, segments: parseCues(text) };
    case "ttml":
      return { format, timed: true, ...parseTtml(text) };
    case "json":
      return { format, ...parseJsonTranscript(JSON.parse(text)) };
    case "html":
      return { format, timed: false, segments: paragraphs(htmlToText(text)) };
    default:
      return { format, timed: false, segments: paragraphs(text) };
  }
}
