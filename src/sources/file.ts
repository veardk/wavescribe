import fsp from "node:fs/promises";
import path from "node:path";
import { expandHome } from "../config/paths.ts";
import { WsError } from "../core/errors.ts";
import type { ResolvedSource, SourceMeta } from "../core/types.ts";
import { parseText } from "../parsers/index.ts";
import { extOf, hash, MEDIA_EXTENSIONS, SUBTITLE_EXTENSIONS } from "../utils/fs.ts";
import { audioFromFile } from "./candidates.ts";

export async function isLocalFile(input: string): Promise<boolean> {
  try {
    return (await fsp.stat(expandHome(input))).isFile();
  } catch {
    return false;
  }
}

export async function resolveFile(input: string): Promise<ResolvedSource> {
  const file = path.resolve(expandHome(input));
  const st = await fsp.stat(file);
  const ext = extOf(file);
  const meta: SourceMeta = {
    input,
    id: `file:${hash(file, st.size, st.mtimeMs).slice(0, 16)}`,
    kind: "file",
    title: path.basename(file, path.extname(file)),
  };
  if (SUBTITLE_EXTENSIONS.has(ext) && !MEDIA_EXTENSIONS.has(ext)) {
    return {
      meta,
      candidates: [
        {
          type: "text",
          label: `subtitle file ${path.basename(file)}`,
          async fetch() {
            const content = await fsp.readFile(file, "utf8");
            const parsed = parseText(content, ext);
            if (!parsed.segments.length) throw new WsError("NO_TEXT", `${path.basename(file)} has no text`);
            return {
              segments: parsed.segments,
              timed: parsed.timed,
              language: parsed.language,
              origin: "publisher",
              fetcher: `file:${parsed.format}`,
            };
          },
        },
      ],
    };
  }
  // Anything else is treated as media; ffprobe decides whether it has audio.
  return { meta, candidates: [audioFromFile(file)] };
}
