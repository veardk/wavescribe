// Output formats. Exporters only lay out the transcript; they never change the words.

import { WsError } from "../core/errors.ts";
import { formatClock, formatSrtTime, formatVttTime } from "../core/time.ts";
import type { Segment, Transcript } from "../core/types.ts";

export interface ExportOptions {
  timestamps: boolean;
}

export interface Exporter {
  id: string;
  ext: string;
  needsTimestamps: boolean;
  render(t: Transcript, opts: ExportOptions): string;
}

const speakerPrefix = (s: Segment) => (s.speaker ? `[${s.speaker}] ` : "");

function cueEnd(segs: Segment[], i: number): number {
  const s = segs[i]!;
  if (s.end !== undefined && s.end > s.start!) return s.end;
  const next = segs[i + 1]?.start;
  return next !== undefined && next > s.start! ? next : s.start! + 2;
}

export const EXPORTERS: Record<string, Exporter> = {
  json: {
    id: "json",
    ext: "json",
    needsTimestamps: false,
    render: (t) => `${JSON.stringify(t, null, 2)}\n`,
  },
  srt: {
    id: "srt",
    ext: "srt",
    needsTimestamps: true,
    render: (t) =>
      t.segments
        .map(
          (s, i) =>
            `${i + 1}\n${formatSrtTime(s.start!)} --> ${formatSrtTime(cueEnd(t.segments, i))}\n${speakerPrefix(s)}${s.text}\n`,
        )
        .join("\n"),
  },
  vtt: {
    id: "vtt",
    ext: "vtt",
    needsTimestamps: true,
    render: (t) =>
      `WEBVTT\n\n${t.segments.map((s, i) => `${formatVttTime(s.start!)} --> ${formatVttTime(cueEnd(t.segments, i))}\n${s.speaker ? `<v ${s.speaker}>` : ""}${s.text}\n`).join("\n")}`,
  },
  txt: {
    id: "txt",
    ext: "txt",
    needsTimestamps: false,
    render: (t, o) =>
      `${t.segments.map((s) => `${o.timestamps && s.start !== undefined ? `[${formatClock(s.start)}] ` : ""}${speakerPrefix(s)}${s.text}`).join("\n")}\n`,
  },
  md: {
    id: "md",
    ext: "md",
    needsTimestamps: false,
    render: (t, o) => {
      const src = t.source;
      const meta = [
        src.uploader && `- Source: ${src.uploader}`,
        src.url && `- Link: ${src.url}`,
        src.published && `- Published: ${src.published.slice(0, 10)}`,
        src.duration && `- Duration: ${formatClock(src.duration)}`,
        `- Text origin: ${t.origin}${t.provenance.provider ? ` (${t.provenance.provider} · ${t.provenance.model})` : t.provenance.fetcher ? ` (${t.provenance.fetcher})` : ""}`,
      ].filter(Boolean);
      const body = t.segments
        .map(
          (s) =>
            `${o.timestamps && s.start !== undefined ? `\`${formatClock(s.start)}\` ` : ""}${s.speaker ? `**${s.speaker}:** ` : ""}${s.text}`,
        )
        .join("\n\n");
      return `# ${src.title ?? "Transcript"}\n\n${meta.join("\n")}\n\n---\n\n${body}\n`;
    },
  },
};

export function exporterFor(format: string): Exporter {
  const e = EXPORTERS[format.toLowerCase()];
  if (!e)
    throw new WsError("BAD_INPUT", `Unknown format "${format}"`, {
      hint: `Use one of: ${Object.keys(EXPORTERS).join(", ")}`,
    });
  return e;
}
