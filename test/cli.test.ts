import assert from "node:assert/strict";
import { test } from "node:test";
import { COMMAND_NAMES, commandHelp, helpText } from "../src/cli/help.ts";
import { parseCommandLine, toRunOptions } from "../src/cli/options.ts";
import type { WsError } from "../src/core/errors.ts";

const opts = (argv: string[], defaults = {}) => toRunOptions(parseCommandLine(argv).values, defaults);

test("formats: comma lists, repeats, config default", () => {
  assert.deepEqual(opts(["-f", "srt,vtt", "-f", "srt"]).formats, ["srt", "vtt"]);
  assert.deepEqual(opts([], { formats: ["md"] }).formats, ["md"]);
  assert.throws(
    () => opts(["-f", "docx"]),
    (e: WsError) => e.code === "BAD_INPUT",
  );
});

test("durations, provider options and language default", () => {
  const o = opts(["--clip", "1m30s", "--timeout", "10m", "--opt", "a=b=c", "--opt", "x="], { language: "zh" });
  assert.equal(o.clipSeconds, 90);
  assert.equal(o.timeoutSeconds, 600);
  assert.deepEqual(o.extra, { a: "b=c", x: "" });
  assert.equal(o.language, "zh");
  assert.equal(opts(["-l", "en"], { language: "zh" }).language, "en");
});

test("bad values are usage errors", () => {
  for (const argv of [
    ["--clip", "soon"],
    ["--opt", "novalue"],
    ["--prefer", "both"],
  ]) {
    assert.throws(
      () => opts(argv),
      (e: WsError) => e.code === "BAD_INPUT",
      argv.join(" "),
    );
  }
});

test("every command has its own help page, and the overview names them all", () => {
  for (const name of ["run", "info", "auth", "config", "providers", "doctor", "login"]) {
    assert.ok(COMMAND_NAMES.includes(name), name);
    assert.match(commandHelp(name)!, /^Usage\n/, name);
  }
  for (const name of COMMAND_NAMES.filter((n) => n !== "run"))
    assert.match(helpText(), new RegExp(`wavescribe ${name}\\b`));
  assert.equal(commandHelp("nope"), undefined);
});
