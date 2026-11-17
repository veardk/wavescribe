// Source resolution: the first resolver that recognises the input wins; generic web sniffing is last.

import { WsError } from "../core/errors.ts";
import type { ResolvedSource } from "../core/types.ts";
import { isApple, resolveApple } from "./apple.ts";
import { isBilibili, resolveBilibili } from "./bilibili/index.ts";
import { isLocalFile, resolveFile } from "./file.ts";
import { resolveSpotify, spotifyEpisodeId } from "./spotify/index.ts";
import type { SourceContext, SourceResolver } from "./types.ts";
import { resolveWeb } from "./web.ts";
import { isXimalaya, resolveXimalaya } from "./ximalaya.ts";
import { resolveYoutube, youtubeId } from "./youtube.ts";

export const RESOLVERS: SourceResolver[] = [
  { id: "file", match: isLocalFile, resolve: (i) => resolveFile(i) },
  { id: "youtube", match: (i) => !!youtubeId(i), resolve: (i, c) => resolveYoutube(i, youtubeId(i)!, c) },
  { id: "bilibili", match: isBilibili, resolve: resolveBilibili },
  { id: "spotify", match: (i) => !!spotifyEpisodeId(i), resolve: resolveSpotify },
  { id: "apple", match: isApple, resolve: resolveApple },
  { id: "ximalaya", match: isXimalaya, resolve: resolveXimalaya },
  { id: "web", match: (i) => /^https?:\/\//i.test(i), resolve: resolveWeb },
];

export async function resolveSource(input: string, ctx: SourceContext): Promise<ResolvedSource> {
  for (const r of RESOLVERS) {
    if (await r.match(input)) {
      ctx.log.debug(`source: ${r.id}`);
      return r.resolve(input, ctx);
    }
  }
  throw new WsError("UNSUPPORTED_SOURCE", `Not a file or URL: ${input}`, {
    hint: "Pass a local audio/video/subtitle file, or an http(s) link",
  });
}
