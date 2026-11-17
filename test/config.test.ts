import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { emptyConfig } from "../src/config/config.ts";
import { credentialsFromText, resolveCredentials } from "../src/config/credentials.ts";
import { flattenConfig, getKey, parseValue, type RawConfig, setKey, unsetKey } from "../src/config/edit.ts";
import { loadSecrets, removeSecrets, saveSecrets, secretsFile } from "../src/config/secrets.ts";
import type { WsError } from "../src/core/errors.ts";
import { tempDir } from "./helpers.ts";

const spec = [{ name: "apiKey", env: "WS_TEST_API_KEY" }];

test("saved keys live in a private file and can be removed", async () => {
  await saveSecrets("groq", { apiKey: "gsk_saved" });
  await saveSecrets("deepgram", { apiKey: "dg" });
  assert.deepEqual(await loadSecrets(), { groq: { apiKey: "gsk_saved" }, deepgram: { apiKey: "dg" } });
  // Windows has no POSIX permission bits.
  if (process.platform !== "win32") assert.equal(fs.statSync(secretsFile()).mode & 0o777, 0o600);
  assert.equal(await removeSecrets("groq"), true);
  assert.equal(await removeSecrets("groq"), false);
  assert.deepEqual(Object.keys(await loadSecrets()), ["deepgram"]);
});

test("key lookup order: environment → saved → key file → inline config", async () => {
  const keyFile = `${tempDir()}/key`;
  fs.writeFileSync(keyFile, "from-file\n");
  const cfg = emptyConfig();
  cfg.providers.p = { apiKeyFile: keyFile, apiKey: "inline" };
  const source = async () => {
    const r = await resolveCredentials(cfg, "p", spec);
    return [r.values.apiKey, r.sources.apiKey];
  };
  assert.deepEqual(await source(), ["from-file", "file"]);
  await saveSecrets("p", { apiKey: "saved" });
  assert.deepEqual(await source(), ["saved", "store"]);
  process.env.WS_TEST_API_KEY = "from-env";
  try {
    assert.deepEqual(await source(), ["from-env", "env"]);
  } finally {
    delete process.env.WS_TEST_API_KEY;
  }
  await removeSecrets("p");
  delete cfg.providers.p!.apiKeyFile;
  assert.deepEqual(await source(), ["inline", "config"]);
});

test("piped keys: a bare secret for one credential, NAME=value lines for several", () => {
  assert.deepEqual(credentialsFromText("gsk_x\n", spec), { apiKey: "gsk_x" });
  const two = [
    { name: "appId", env: "VOLC_APP_ID", optional: true },
    { name: "accessToken", env: "VOLC_ACCESS_TOKEN", optional: true },
  ];
  assert.deepEqual(credentialsFromText("VOLC_APP_ID=1\nexport VOLC_ACCESS_TOKEN='t'\n", two), {
    appId: "1",
    accessToken: "t",
  });
  // one unnamed line must not fill every credential of a multi-key provider
  assert.deepEqual(credentialsFromText("VOLC_APP_ID=1\n", two), { appId: "1" });
});

test("config keys: set, get, unset and list", () => {
  const raw: RawConfig = { providers: { groq: { model: "m" } } };
  setKey(raw, "defaults.formats", parseValue("defaults.formats", "srt, txt"));
  setKey(raw, "providers.groq.maxBytes", parseValue("providers.groq.maxBytes", "1000"));
  setKey(raw, "defaults.provider", parseValue("defaults.provider", "123"));
  assert.deepEqual(getKey(raw, "defaults.formats"), ["srt", "txt"]);
  assert.equal(getKey(raw, "providers.groq.maxBytes"), 1000);
  assert.equal(getKey(raw, "defaults.provider"), "123"); // known string keys stay strings
  assert.equal(getKey(raw, "nope.deeper"), undefined);
  assert.deepEqual(flattenConfig(raw), [
    ["providers.groq.model", "m"],
    ["providers.groq.maxBytes", 1000],
    ["defaults.formats", ["srt", "txt"]],
    ["defaults.provider", "123"],
  ]);
  assert.equal(unsetKey(raw, "defaults.formats"), true);
  assert.equal(unsetKey(raw, "defaults.provider"), true);
  assert.equal(raw.defaults, undefined, "empty parents are removed");
  assert.equal(unsetKey(raw, "defaults.provider"), false);
});

test("config refuses secrets and paths through non-objects", () => {
  for (const key of ["providers.groq.apiKey", "bilibili.sessdata", "spotify.spDc", "x.accessToken"]) {
    assert.throws(
      () => setKey({}, key, "v"),
      (e: WsError) => e.code === "BAD_INPUT" && /wavescribe auth/.test(e.hint ?? ""),
      key,
    );
  }
  assert.doesNotThrow(() => setKey({}, "providers.groq.apiKeyFile", "~/.groq"));
  assert.throws(
    () => setKey({ defaults: { language: "zh" } }, "defaults.language.x", "v"),
    (e: WsError) => e.code === "BAD_INPUT",
  );
});
