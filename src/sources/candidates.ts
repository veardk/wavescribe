// Building blocks resolvers use to offer text and audio candidates.

import path from "node:path";
import { WsError } from "../core/errors.ts";
import type { AudioCandidate, Logger, Origin, ParsedText, TextCandidate } from "../core/types.ts";
import { parseText } from "../parsers/index.ts";
import { downloadFile } from "../utils/download.ts";
import { extOf } from "../utils/fs.ts";
import { BROWSER_UA, createHttp } from "../utils/http.ts";

type NetContext = { log: Logger; signal?: AbortSignal };

export const http = (ctx: NetContext) => createHttp(ctx.log, { signal: ctx.signal });

export async function fetchText(url: string, ctx: NetContext, headers: Record<string, string> = {}): Promise<string> {
  const r = await http(ctx).request<string>(url, {
    headers: { "user-agent": BROWSER_UA, ...headers },
    expect: "text",
    timeoutMs: 60_000,
  });
  return r.data;
}

/** A transcript/subtitle file at a URL. `timed` known up-front lets the pipeline skip it cheaply. */
export function textFromUrl(
  url: string,
  label: string,
  origin: Origin,
  fetcher: string,
  opts: { ext?: string; timed?: boolean; language?: string } = {},
): TextCandidate {
  return {
    type: "text",
    label,
    timed: opts.timed,
    async fetch(ctx): Promise<ParsedText> {
      const content = await fetchText(url, ctx);
      const ext = opts.ext ?? extOf(url);
      const parsed = parseText(content, ext);
      if (!parsed.segments.length) throw new WsError("NO_TEXT", `${label}: file is empty`);
      return {
        segments: parsed.segments,
        timed: parsed.timed,
        language: parsed.language ?? opts.language,
        origin,
        fetcher,
        raw: { content, ext: parsed.format },
      };
    },
  };
}

/** Audio at a public URL: providers may fetch it themselves, otherwise it is downloaded once. */
export function audioFromUrl(url: string, label: string): AudioCandidate {
  return {
    type: "audio",
    label,
    publicUrl: url,
    download: (ctx) =>
      downloadFile(url, path.join(ctx.workDir, "source"), "audio", {
        log: ctx.log,
        useCache: ctx.useCache,
        signal: ctx.signal,
      }),
  };
}

export function audioFromFile(file: string): AudioCandidate {
  return { type: "audio", label: `local media ${path.basename(file)}`, download: async () => file };
}
