// Spotify podcast episodes: the web player's own auto-generated transcript (needs a login).
// Ported from Textcast's base-spotify-transcript. Spotify audio is DRM-protected, so there is no audio fallback.

import { WsError } from "../../core/errors.ts";
import type { ParsedText, ResolvedSource, Segment, TextCandidate } from "../../core/types.ts";
import { BROWSER_UA } from "../../utils/http.ts";
import { http } from "../candidates.ts";
import type { SourceContext } from "../types.ts";
import { accessToken, findSession } from "./auth.ts";

const transcriptUrl = (id: string) =>
  `https://spclient.wg.spotify.com/transcript-read-along/v2/episode/${id}?format=json&maxSentenceLength=500&excludeCC=true`;

export function spotifyEpisodeId(input: string): string | undefined {
  const t = input.trim();
  return (
    /^https?:\/\/open\.spotify\.com\/(?:intl-[\w-]+\/)?episode\/([0-9A-Za-z]{22})/.exec(t)?.[1] ??
    /^spotify:episode:([0-9A-Za-z]{22})$/.exec(t)?.[1]
  );
}

/**
 * Spotify sections → timed sentences. Only spoken sentences are kept; "Speaker N" labels, chapter
 * headings and music cues are not text. A sentence ends 800 ms after its last highlighted word,
 * or where the next one starts.
 */
export function spotifySegments(raw: any): Segment[] {
  const sentences: { startMs: number; spokenEndMs: number; text: string }[] = [];
  for (const sec of raw?.section ?? []) {
    const s = sec.text?.sentence;
    const text = String(s?.text ?? "").trim();
    if (!text) continue;
    const last = (s.highlight ?? []).reduce((m: number, h: any) => Math.max(m, Number(h.startMs) || 0), s.startMs);
    sentences.push({ startMs: s.startMs, spokenEndMs: last + 800, text });
  }
  return sentences.map((s, i) => {
    const next = sentences[i + 1]?.startMs ?? Number.POSITIVE_INFINITY;
    return { start: s.startMs / 1000, end: Math.min(next, s.spokenEndMs) / 1000, text: s.text };
  });
}

function transcriptCandidate(id: string, ctx: SourceContext): TextCandidate {
  return {
    type: "text",
    label: "Spotify transcript",
    timed: true,
    async fetch(rctx): Promise<ParsedText> {
      const session = await findSession(ctx.cfg, rctx.log);
      rctx.log.debug(`spotify: session from ${session.source}`);
      const request = async (token: string) =>
        http(rctx).request<string>(transcriptUrl(id), {
          headers: {
            authorization: `Bearer ${token}`,
            accept: "application/json",
            "app-platform": "WebPlayer",
            "user-agent": BROWSER_UA,
          },
          okStatuses: [401, 403, 404],
          expect: "text",
          timeoutMs: 60_000,
        });
      let res = await request(await accessToken(session, rctx.log));
      if (res.status === 401 || res.status === 403) {
        rctx.log.debug("spotify: token rejected; minting a new one");
        res = await request(await accessToken(session, rctx.log, true));
      }
      if (res.status === 401 || res.status === 403)
        throw new WsError("AUTH", `Spotify refused the transcript request (HTTP ${res.status})`, {
          hint: "The login is stale: sign in at https://open.spotify.com, then run `wavescribe login spotify`",
        });
      if (res.status === 404) throw new WsError("NO_TEXT", "This episode has no transcript on Spotify");
      const raw = JSON.parse(res.data);
      const segments = spotifySegments(raw);
      if (!segments.length) throw new WsError("NO_TEXT", "This episode has no transcript on Spotify");
      return {
        segments,
        timed: true,
        language: raw.language || undefined,
        origin: "auto-caption",
        fetcher: "base-spotify-transcript",
        raw: { content: res.data, ext: "json" },
      };
    },
  };
}

export async function resolveSpotify(input: string, ctx: SourceContext): Promise<ResolvedSource> {
  const id = spotifyEpisodeId(input);
  if (!id) throw new WsError("BAD_INPUT", "Not a Spotify episode link");
  const url = `https://open.spotify.com/episode/${id}`;
  // oEmbed gives the title without a login; the transcript itself needs one.
  let title: string | undefined;
  try {
    title = (
      await http(ctx).request("https://open.spotify.com/oembed", { query: { url }, retries: 1, timeoutMs: 30_000 })
    ).data?.title;
  } catch (e) {
    ctx.log.debug(`spotify oembed failed: ${(e as Error).message}`);
  }
  return {
    meta: { input, id: `spotify:${id}`, kind: "spotify", title, url },
    candidates: [transcriptCandidate(id, ctx)],
  };
}
