import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { createTerminalLogger, fitColumns, progressBar, stepDetail } from "../src/cli/ui/progress.ts";

/** What stays on screen: each finished line, keeping only what was written after its last `\r`. */
const screen = (out: string) =>
  out
    .split("\n")
    .slice(0, -1)
    .map((l) => stripVTControlCharacters(l.split("\r").at(-1)!));

test("status details: progress bar, byte counts, parts", () => {
  assert.equal(progressBar(1, 4, 8), "██░░░░░░");
  assert.equal(stepDetail({ type: "bytes", done: 3e6, total: 12e6 }), "████░░░░░░░░░░░░ 25%  3.0/12.0 MB");
  assert.equal(stepDetail({ type: "bytes", done: 1.5e6 }), "1.5 MB");
  assert.equal(stepDetail({ type: "parts", done: 1, total: 3 }), "part 2/3");
  assert.equal(stepDetail({ type: "parts", done: 3, total: 3 }), "part 3/3");
});

test("status line fits the terminal width, counting CJK as two columns", () => {
  assert.equal(fitColumns("hello", 10), "hello");
  assert.equal(fitColumns("hello world", 6), "hello…");
  assert.equal(fitColumns("饕客与讨海人", 7), "饕客…");
});

test("terminal logger prints finished steps above the live line", () => {
  let out = "";
  const log = createTerminalLogger("normal", { write: (s: string) => (out += s), columns: 80 });
  log.progress({ type: "step", label: "Downloading" });
  log.progress({ type: "bytes", done: 1, total: 2 });
  log.info("a message");
  log.progress({ type: "step", label: "Transcribing" });
  log.progress({ type: "end", ok: false });
  log.progress({ type: "end", ok: true }); // nothing running: no output
  assert.deepEqual(screen(out), ["a message", "✔ Downloading", "✖ Transcribing"]);
});
