import { WsError } from "../../core/errors.ts";
import { formatClock } from "../../core/time.ts";
import { type Env, resolveInput } from "../../pipeline.ts";
import type { Values } from "../options.ts";
import { print, printJson } from "../output.ts";

const MAX_EPISODES = 20;

export async function cmdInfo(input: string | undefined, v: Values, env: Env): Promise<number> {
  if (!input) throw new WsError("BAD_INPUT", "wavescribe info <file|url>");
  const r = await resolveInput(input, { language: v.lang ?? env.cfg.defaults.language, episode: v.episode }, env);
  if (v.json) {
    printJson({
      meta: r.meta,
      candidates: r.candidates.map((c) => ({
        type: c.type,
        label: c.label,
        ...(c.type === "audio" && c.publicUrl ? { url: c.publicUrl } : {}),
      })),
      episodes: r.episodes,
    });
    return 0;
  }
  const m = r.meta;
  const lines = [
    `${m.title ?? "(untitled)"}`,
    `  kind      ${m.kind}`,
    m.uploader && `  from      ${m.uploader}`,
    m.url && `  link      ${m.url}`,
    m.published && `  published ${m.published.slice(0, 10)}`,
    m.duration && `  duration  ${formatClock(m.duration)}`,
    m.episode && `  episode   #${m.episode.index}`,
    `  cache id  ${m.id}`,
    "",
    "Will try, in order:",
    ...r.candidates.map((c, i) => `  ${i + 1}. ${c.type === "text" ? "text " : "audio"}  ${c.label}`),
  ].filter((l): l is string => typeof l === "string");
  if (r.episodes?.length) {
    lines.push("", `Episodes (${r.episodes.length}; choose with -e):`);
    for (const e of r.episodes.slice(0, MAX_EPISODES)) {
      const date = e.published?.slice(0, 10) ?? " ".repeat(10);
      const duration = e.duration ? formatClock(e.duration).padStart(8) : " ".repeat(8);
      lines.push(`  ${String(e.index).padStart(3)}  ${date}  ${duration}  ${e.title}`);
    }
    if (r.episodes.length > MAX_EPISODES) lines.push(`  … ${r.episodes.length - MAX_EPISODES} more`);
  }
  print(lines.join("\n"));
  return 0;
}
