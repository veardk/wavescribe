// Turn an audio candidate into payloads a given model accepts: pick a delivery, download,
// transcode / compress when needed, split long audio at silences.

import fsp from "node:fs/promises";
import path from "node:path";
import { WsError } from "../core/errors.ts";
import type { AudioCandidate, RunContext } from "../core/types.ts";
import { type AudioCodec, detectSilences, planCuts, probe, transcode } from "../media/ffmpeg.ts";
import type { AudioPayload, Delivery, ModelSpec } from "../providers/plugin.ts";
import { ensureDir, extOf, mimeOf, nonEmptyFile, sha1File } from "../utils/fs.ts";

export interface PreparedChunk {
  payload: AudioPayload;
  /** Seconds to add to this chunk's timestamps. */
  offset: number;
  /** Cache identity (file hash or URL). */
  identity: string;
}

export interface PreparedAudio {
  delivery: Delivery;
  chunks: PreparedChunk[];
}

const LOCAL: Delivery[] = ["multipart", "raw", "base64", "upload"];
const AUDIO_ONLY = new Set(["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "amr", "wma", "mpga", "aiff"]);
const CODEC_ORDER: AudioCodec[] = ["mp3", "m4a", "ogg", "opus", "flac", "wav"];

function pickCodec(formats?: string[]): AudioCodec {
  if (!formats?.length) return "mp3";
  const c = CODEC_ORDER.find((c) => formats.includes(c));
  if (!c)
    throw new WsError(
      "UNSUPPORTED_FORMAT",
      `This model only accepts ${formats.join(", ")}, which wavescribe cannot produce`,
    );
  return c;
}

const formatOk = (ext: string, formats?: string[]) => !formats?.length || formats.includes(ext);
const mb = (bytes: number) => String(Math.round(bytes / 1e5) / 10);

/**
 * Why the audio has to be re-encoded before it is sent (shown as the progress step), or undefined
 * when the downloaded file can be sent as it is.
 */
export function conversionReason(
  audio: { ext: string; size: number; hasVideo: boolean },
  input: ModelSpec["input"],
  codec: AudioCodec,
  clip?: number,
): string | undefined {
  if (clip) return `Cutting out the first ${clip}s (--clip)`;
  if (audio.hasVideo) return `Extracting the audio track as ${codec}`;
  if (!AUDIO_ONLY.has(audio.ext)) return `Converting .${audio.ext || "?"} to ${codec}`;
  if (!formatOk(audio.ext, input.formats))
    return `Converting .${audio.ext} to ${codec} (this model does not accept .${audio.ext})`;
  if (input.maxBytes !== undefined && audio.size > input.maxBytes)
    return `Compressing ${mb(audio.size)} MB of audio to fit the ${mb(input.maxBytes)} MB upload limit`;
  return undefined;
}

export async function prepareAudio(
  candidate: AudioCandidate,
  model: ModelSpec,
  ctx: RunContext,
  clip?: number,
): Promise<PreparedAudio> {
  const { delivery: deliveries, maxBytes, maxSeconds, formats } = model.input;
  const { tools } = ctx;

  // 1. Let the vendor fetch a public URL itself when it prefers that (no download, no upload).
  const firstLocal = deliveries.findIndex((d) => LOCAL.includes(d));
  const urlIdx = deliveries.indexOf("url");
  const urlExt = candidate.publicUrl ? extOf(candidate.publicUrl) : "";
  if (
    candidate.publicUrl &&
    urlIdx >= 0 &&
    !clip &&
    (firstLocal < 0 || urlIdx < firstLocal) &&
    (!urlExt || formatOk(urlExt, formats))
  ) {
    return {
      delivery: "url",
      chunks: [
        {
          payload: { kind: "url", url: candidate.publicUrl, format: urlExt || undefined },
          offset: 0,
          identity: candidate.publicUrl,
        },
      ],
    };
  }
  if (firstLocal < 0) {
    throw new WsError("BAD_INPUT", "This provider only accepts public URLs, and this input has none", {
      hint: "Use a provider that accepts file uploads (e.g. groq, openai, deepgram), or pass a public audio URL",
    });
  }
  const delivery = deliveries[firstLocal]!;

  // 2. Local file, converted when the container/format/size/clip requires it.
  const original = await candidate.download(ctx);
  const info = await probe(tools, original);
  if (!info.hasAudio) throw new WsError("UNSUPPORTED_FORMAT", `No audio track in ${path.basename(original)}`);
  const ext = extOf(original);
  const mediaDir = path.join(ctx.workDir, "media");
  await ensureDir(mediaDir);

  let file = original;
  let duration = info.duration;
  let size = info.size;
  const codec = pickCodec(formats);
  const reason = conversionReason({ ext, size, hasVideo: info.hasVideo }, model.input, codec, clip);
  if (reason) {
    const out = path.join(mediaDir, `audio${clip ? `-clip${clip}` : ""}.${codec === "opus" ? "ogg" : codec}`);
    if (!(ctx.useCache && (await nonEmptyFile(out)))) {
      ctx.log.progress({ type: "step", label: reason });
      await transcode(tools, original, out, codec, clip ? { duration: clip } : {});
    }
    file = out;
    const p = await probe(tools, out);
    duration = p.duration;
    size = p.size;
  }

  // 3. Split when one request cannot carry the whole file.
  const bytesPerSec = duration > 0 ? size / duration : 0;
  let maxLen = Infinity;
  if (maxSeconds) maxLen = Math.min(maxLen, maxSeconds * 0.98);
  if (maxBytes && bytesPerSec) maxLen = Math.min(maxLen, (maxBytes * 0.92) / bytesPerSec);
  const files: { path: string; offset: number; duration: number }[] = [];
  if (duration > maxLen) {
    const cuts = planCuts(duration, maxLen, await detectSilences(tools, file));
    const bounds = [0, ...cuts, duration];
    ctx.log.progress({
      type: "step",
      label: `Splitting ${Math.round(duration)}s of audio into ${bounds.length - 1} parts`,
    });
    const outExt = codec === "opus" ? "ogg" : codec;
    for (let i = 0; i < bounds.length - 1; i++) {
      const start = bounds[i]!;
      const len = bounds[i + 1]! - start;
      const out = path.join(
        mediaDir,
        `${path.basename(file, path.extname(file))}-part${String(i + 1).padStart(3, "0")}.${outExt}`,
      );
      if (!(ctx.useCache && (await nonEmptyFile(out))))
        await transcode(tools, file, out, codec, { start, duration: len });
      files.push({ path: out, offset: start, duration: len });
    }
  } else {
    files.push({ path: file, offset: 0, duration });
  }

  const chunks: PreparedChunk[] = [];
  for (const f of files) {
    const st = await fsp.stat(f.path);
    if (maxBytes && st.size > maxBytes) {
      throw new WsError(
        "INPUT_TOO_LARGE",
        `Audio part is ${(st.size / 1e6).toFixed(1)} MB, above this model's ${(maxBytes / 1e6).toFixed(0)} MB limit`,
      );
    }
    chunks.push({
      payload: {
        kind: "file",
        path: f.path,
        filename: path.basename(f.path),
        mime: mimeOf(f.path),
        size: st.size,
        format: extOf(f.path),
        duration: f.duration,
      },
      offset: f.offset,
      identity: await sha1File(f.path),
    });
  }
  return { delivery, chunks };
}
