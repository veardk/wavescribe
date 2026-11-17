// Terminal logger: the current step on a live status line (spinner, progress bar, part counter),
// finished steps and messages printed above it. Used only when stderr is a terminal.

import { stripVTControlCharacters } from "node:util";
import type { LogLevel } from "../../core/log.ts";
import type { Logger, Progress } from "../../core/types.ts";
import { cyan, dim, green, red, yellow } from "./style.ts";

const FRAMES = ["◐", "◓", "◑", "◒"];
const TICK_MS = 120;
const BAR_WIDTH = 16;

export interface StatusStream {
  write(s: string): unknown;
  columns?: number;
}

const mb = (n: number) => (n / 1e6).toFixed(1);
const WIDE = /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/;

/** Cut plain text to `max` terminal columns (CJK characters take two). */
export function fitColumns(text: string, max: number): string {
  let width = 0;
  let out = "";
  for (const ch of text) {
    const w = WIDE.test(ch) ? 2 : 1;
    if (width + w > max) return `${out.slice(0, -1)}…`;
    width += w;
    out += ch;
  }
  return out;
}

export function progressBar(done: number, total: number, width = BAR_WIDTH): string {
  const filled = Math.round(Math.min(1, done / total) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

/** Text after the step label: `██████░░ 42% 3.1/7.4 MB`, `3.1 MB`, or `part 2/3`. */
export function stepDetail(e: Progress | undefined): string {
  if (e?.type === "bytes") {
    if (!e.total) return `${mb(e.done)} MB`;
    return `${progressBar(e.done, e.total)} ${Math.floor((e.done / e.total) * 100)}%  ${mb(e.done)}/${mb(e.total)} MB`;
  }
  if (e?.type === "parts") return `part ${Math.min(e.done + 1, e.total)}/${e.total}`;
  return "";
}

export function createTerminalLogger(level: LogLevel, stream: StatusStream = process.stderr): Logger {
  let step: { label: string; started: number } | undefined;
  let detail: Progress | undefined;
  let frame = 0;
  let timer: NodeJS.Timeout | undefined;
  let drawn = false;

  const clear = () => {
    if (drawn) stream.write("\r\x1b[2K");
    drawn = false;
  };
  const draw = () => {
    if (!step) return;
    const extra = stepDetail(detail);
    const line = `${cyan(FRAMES[frame % FRAMES.length]!)} ${step.label}${extra ? `  ${dim(extra)}` : ""}`;
    // Keep to one terminal row so `\r` can overwrite it; colours are dropped only when cutting.
    const visible = stripVTControlCharacters(line);
    const fitted = fitColumns(visible, (stream.columns ?? 80) - 1);
    stream.write(`\r\x1b[2K${fitted === visible ? line : fitted}`);
    drawn = true;
  };
  /** Print a permanent line above the status line. */
  const above = (text: string) => {
    clear();
    stream.write(`${text}\n`);
    draw();
  };
  const finish = (ok: boolean) => {
    if (!step) return;
    const secs = (Date.now() - step.started) / 1000;
    const label = `${step.label}${secs >= 1 ? dim(` (${secs.toFixed(1)}s)`) : ""}`;
    step = undefined;
    detail = undefined;
    clearInterval(timer);
    timer = undefined;
    above(`${ok ? green("✔") : red("✖")} ${label}`);
  };

  return {
    info: (msg) => {
      if (level !== "quiet") above(msg);
    },
    warn: (msg) => above(`${yellow("!")} ${msg}`),
    debug: (msg) => {
      if (level === "verbose") above(dim(`· ${msg}`));
    },
    progress: (e) => {
      if (e.type === "end") return finish(e.ok);
      if (e.type === "step") {
        finish(true);
        step = { label: e.label, started: Date.now() };
        timer = setInterval(() => {
          frame++;
          draw();
        }, TICK_MS);
        timer.unref();
        draw();
        return;
      }
      detail = e; // drawn on the next tick, so frequent byte updates stay cheap
    },
  };
}
