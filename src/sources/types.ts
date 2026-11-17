import type { Config } from "../config/config.ts";
import type { EpisodeInfo, Logger, ResolvedSource, Tools } from "../core/types.ts";

export type ChooseEpisode = (episodes: EpisodeInfo[]) => Promise<number | undefined>;

/** What a resolver may use while working out what an input is. */
export interface SourceContext {
  cfg: Config;
  log: Logger;
  tools: Tools;
  /** Preferred caption / spoken language (BCP-47). */
  language?: string;
  /** Feed episode selector (`latest`, `3`, `guid:…`, a date or title words). */
  episode?: string;
  /** Asked when a feed has several episodes and no `episode` selector was given; returns an index (1 = newest). */
  chooseEpisode?: ChooseEpisode;
  signal?: AbortSignal;
}

export interface SourceResolver {
  id: string;
  match(input: string): boolean | Promise<boolean>;
  resolve(input: string, ctx: SourceContext): Promise<ResolvedSource>;
}
