import { codeForStatus, WsError } from "../core/errors.ts";
import type { Logger } from "../core/types.ts";
import { VERSION } from "../version.ts";
import { sleep } from "./async.ts";

export const USER_AGENT = `wavescribe/${VERSION}`;
export const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  /** Must be re-sendable (string, Buffer, Blob, FormData) because requests are retried. */
  body?: string | Uint8Array | Blob | FormData | URLSearchParams;
  /** Shorthand: JSON-encode and set Content-Type. */
  json?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  timeoutMs?: number;
  retries?: number;
  expect?: "json" | "text" | "bytes" | "none";
  /** Statuses treated as success besides 2xx. */
  okStatuses?: number[];
  signal?: AbortSignal;
}

export interface HttpResponse<T = any> {
  status: number;
  headers: Headers;
  data: T;
  url: string;
}

export interface Http {
  request<T = any>(url: string, req?: HttpRequest): Promise<HttpResponse<T>>;
}

function retryAfterMs(h: Headers): number | undefined {
  const v = h.get("retry-after") ?? h.get("x-ratelimit-reset-requests");
  if (!v) return undefined;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.min(n * 1000, 120_000);
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, Math.min(d - Date.now(), 120_000)) : undefined;
}

const retryableStatus = (s: number) => s === 429 || s === 408 || (s >= 500 && s !== 501);

export function createHttp(log?: Logger, defaults: { signal?: AbortSignal } = {}): Http {
  return {
    async request<T = any>(url: string, req: HttpRequest = {}): Promise<HttpResponse<T>> {
      const u = new URL(url);
      for (const [k, v] of Object.entries(req.query ?? {})) if (v !== undefined) u.searchParams.set(k, String(v));
      const headers: Record<string, string> = { "user-agent": USER_AGENT, ...req.headers };
      let body = req.body;
      if (req.json !== undefined) {
        body = JSON.stringify(req.json);
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type"))
          headers["content-type"] = "application/json";
      }
      const retries = req.retries ?? 3;
      const signal = req.signal ?? defaults.signal;
      let attempt = 0;
      for (;;) {
        attempt++;
        let res: Response;
        try {
          res = await fetch(u, {
            method: req.method ?? (body ? "POST" : "GET"),
            headers,
            body: body as RequestInit["body"],
            signal: AbortSignal.any([AbortSignal.timeout(req.timeoutMs ?? 600_000), ...(signal ? [signal] : [])]),
            redirect: "follow",
          });
        } catch (e) {
          if (signal?.aborted) throw e;
          const err = e as Error;
          const isTimeout = err.name === "TimeoutError";
          if (attempt <= retries) {
            const wait = 1000 * 2 ** (attempt - 1);
            log?.debug(`network error on ${u.host} (${err.message}); retry ${attempt}/${retries} in ${wait}ms`);
            await sleep(wait, signal);
            continue;
          }
          throw new WsError(
            isTimeout ? "TIMEOUT" : "NETWORK",
            `${isTimeout ? "Timed out" : "Network error"} calling ${u.host}: ${err.message}`,
            { cause: e },
          );
        }

        const ok = res.ok || (req.okStatuses ?? []).includes(res.status);
        if (!ok && retryableStatus(res.status) && attempt <= retries) {
          const wait = retryAfterMs(res.headers) ?? Math.min(1000 * 2 ** attempt, 60_000);
          log?.debug(`HTTP ${res.status} from ${u.host}; retry ${attempt}/${retries} in ${Math.round(wait)}ms`);
          await res.body?.cancel().catch(() => {});
          await sleep(wait, signal);
          continue;
        }
        if (!ok) {
          const text = await res.text().catch(() => "");
          throw new WsError(codeForStatus(res.status), `HTTP ${res.status} from ${u.host}: ${summarize(text)}`, {
            status: res.status,
          });
        }
        const expect = req.expect ?? "json";
        let data: unknown;
        if (expect === "none") {
          await res.body?.cancel().catch(() => {});
          data = undefined;
        } else if (expect === "bytes") data = new Uint8Array(await res.arrayBuffer());
        else {
          const text = await res.text();
          if (expect === "text") data = text;
          else if (!text.trim()) data = undefined;
          else {
            try {
              data = JSON.parse(text);
            } catch {
              throw new WsError("PROVIDER_ERROR", `Expected JSON from ${u.host}, got: ${summarize(text)}`, {
                status: res.status,
              });
            }
          }
        }
        return { status: res.status, headers: res.headers, data: data as T, url: res.url };
      }
    },
  };
}

/** Short, single-line error body for messages. */
export function summarize(text: string, n = 300): string {
  const t = text.replace(/\s+/g, " ").trim();
  try {
    const j = JSON.parse(t);
    const msg = j?.error?.message ?? j?.message ?? j?.error ?? j?.detail ?? j?.err_msg ?? j?.Response?.Error?.Message;
    if (typeof msg === "string") return msg.slice(0, n);
    if (msg) return JSON.stringify(msg).slice(0, n);
  } catch {
    /* not json */
  }
  return t.slice(0, n) || "(empty body)";
}
