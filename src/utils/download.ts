import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { codeForStatus, WsError } from "../core/errors.ts";
import type { Logger } from "../core/types.ts";
import { sleep } from "./async.ts";
import { ensureDir, extFromContentType, extOf, findCompleteFile } from "./fs.ts";
import { BROWSER_UA } from "./http.ts";

/** Abort a download when no bytes arrive for this long (stalled CDN connections otherwise hang forever). */
const IDLE_TIMEOUT_MS = 60_000;

/** A pass-through stream that aborts `controller` after `ms` without data. */
export function idleWatchdog(controller: AbortController, ms: number): Transform {
  const timer = setTimeout(() => controller.abort(new Error(`no data for ${ms / 1000}s`)), ms);
  return new Transform({
    transform(chunk, _enc, done) {
      timer.refresh();
      done(null, chunk);
    },
    flush(done) {
      clearTimeout(timer);
      done();
    },
    destroy(err, done) {
      clearTimeout(timer);
      done(err);
    },
  });
}

/** A pass-through stream that reports the running byte count. */
function byteCounter(report: (done: number) => void): Transform {
  let done = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      done += chunk.length;
      report(done);
      cb(null, chunk);
    },
  });
}

/**
 * Download a URL to `<dir>/<base>.<ext>` (extension from Content-Type or the URL).
 * Reuses an earlier complete download. Retries network failures with backoff.
 */
export async function downloadFile(
  url: string,
  dir: string,
  base: string,
  opts: {
    log: Logger;
    headers?: Record<string, string>;
    useCache?: boolean;
    signal?: AbortSignal;
    fallbackExt?: string;
  },
): Promise<string> {
  await ensureDir(dir);
  const earlier = opts.useCache === false ? undefined : await findCompleteFile(dir, base);
  if (earlier) {
    opts.log.debug(`reusing download ${path.basename(earlier)}`);
    return earlier;
  }
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const stall = new AbortController();
    const signal = AbortSignal.any([stall.signal, ...(opts.signal ? [opts.signal] : [])]);
    const watchdog = idleWatchdog(stall, IDLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        headers: { "user-agent": BROWSER_UA, ...opts.headers },
        redirect: "follow",
        signal,
      });
      if (!res.ok || !res.body) {
        const err = new WsError(
          codeForStatus(res.status),
          `Download failed: HTTP ${res.status} for ${new URL(url).host}`,
          { status: res.status },
        );
        if (res.status === 429 || res.status >= 500) throw Object.assign(err, { retryable: true });
        throw err;
      }
      const ext =
        extFromContentType(res.headers.get("content-type")) ??
        (extOf(res.url) || extOf(url) || opts.fallbackExt || "bin");
      const dest = path.join(dir, `${base}.${ext}`);
      const total = Number(res.headers.get("content-length") ?? 0);
      opts.log.progress({
        type: "step",
        label: `Downloading ${total ? `${(total / 1e6).toFixed(1)} MB ` : ""}from ${new URL(res.url).host}`,
      });
      await pipeline(
        Readable.fromWeb(res.body as WebReadableStream),
        watchdog,
        byteCounter((done) => opts.log.progress({ type: "bytes", done, total: total || undefined })),
        fs.createWriteStream(`${dest}.part`),
        { signal },
      );
      await fsp.rename(`${dest}.part`, dest);
      return dest;
    } catch (e) {
      watchdog.destroy();
      lastErr = e;
      const retryable = e instanceof WsError ? e.retryable : !opts.signal?.aborted;
      if (!retryable || attempt === 4) break;
      await sleep(1000 * 2 ** attempt, opts.signal);
    }
  }
  if (lastErr instanceof WsError) throw lastErr;
  throw new WsError("NETWORK", `Download failed: ${(lastErr as Error)?.message ?? lastErr}`, { cause: lastErr });
}
