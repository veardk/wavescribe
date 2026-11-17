// Time helpers. Everything inside wavescribe is seconds (float); providers convert at the edge.

import { WsError } from "./errors.ts";

export const fromMs = (ms: number | string | undefined | null): number => Number(ms ?? 0) / 1000;

/** "4.87" (AWS-style string seconds) → 4.87 */
export const fromSecString = (s: number | string | undefined | null): number => Number(s ?? 0);

/** protobuf Duration "1.200s" → 1.2 */
export function fromDuration(d: string | number | undefined | null): number {
  if (typeof d === "number") return d;
  if (!d) return 0;
  const m = /^(-?[\d.]+)s$/.exec(d.trim());
  return m ? Number(m[1]) : Number(d);
}

/** 10 ms frames (iFlytek word timings) → seconds */
export const fromFrames10ms = (f: number | string | undefined | null): number => Number(f ?? 0) / 100;

/**
 * Clock or offset time used by subtitle formats:
 * "01:02:03.456", "02:03,456", "123.4", "12.3s", "1500ms", "00:00:01:12" (frames dropped).
 */
export function parseClock(value: string | undefined | null): number | undefined {
  if (value == null) return undefined;
  const v = String(value).trim();
  if (!v) return undefined;
  let m = /^(-?[\d.]+)(h|m|s|ms|f|t)?$/.exec(v);
  if (m) {
    const n = Number(m[1]);
    switch (m[2]) {
      case "h":
        return n * 3600;
      case "m":
        return n * 60;
      case "ms":
        return n / 1000;
      case "f":
        return n / 30;
      case "t":
        return n / 10_000_000;
      default:
        return n;
    }
  }
  m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d+))?(?::\d+)?$/.exec(v);
  if (m) {
    const frac = m[4] ? Number(`0.${m[4]}`) : 0;
    return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
  }
  return undefined;
}

function split(sec: number) {
  const totalMs = Math.max(0, Math.round(sec * 1000));
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const ms = totalMs % 1000;
  return { h, m, s, ms };
}
const p2 = (n: number) => String(n).padStart(2, "0");
const p3 = (n: number) => String(n).padStart(3, "0");

export function formatSrtTime(sec: number): string {
  const { h, m, s, ms } = split(sec);
  return `${p2(h)}:${p2(m)}:${p2(s)},${p3(ms)}`;
}

export function formatVttTime(sec: number): string {
  const { h, m, s, ms } = split(sec);
  return `${p2(h)}:${p2(m)}:${p2(s)}.${p3(ms)}`;
}

/** "1:02:03" or "02:03" for human-readable output. */
export function formatClock(sec: number): string {
  const { h, m, s } = split(sec);
  return h ? `${h}:${p2(m)}:${p2(s)}` : `${p2(m)}:${p2(s)}`;
}

/** "90", "90s", "2m", "1m30s", "01:30" → seconds */
export function parseDurationArg(v: string): number {
  const t = v.trim();
  const clock = /^\d+:\d{1,2}(:\d{1,2})?$/.test(t) ? parseClock(t) : undefined;
  if (clock !== undefined) return clock;
  const re = /(\d+(?:\.\d+)?)\s*(h|m|s)?/g;
  let total = 0;
  let matched = false;
  for (const m of t.matchAll(re)) {
    matched = true;
    const n = Number(m[1]);
    total += m[2] === "h" ? n * 3600 : m[2] === "m" ? n * 60 : n;
  }
  if (!matched || Number.isNaN(total))
    throw new WsError("BAD_INPUT", `Invalid duration: ${v}`, { hint: "Use e.g. 90, 90s, 2m, 1m30s or 01:30" });
  return total;
}
