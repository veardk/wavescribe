import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { emptyConfig } from "../src/config/config.ts";
import { loadRegistry } from "../src/providers/registry.ts";
import { silent, tempDir } from "./helpers.ts";

test("config-declared OpenAI-compatible providers and external plugins are registered", async () => {
  const dir = tempDir();
  process.env.XDG_CONFIG_HOME = dir; // keep ~/.config/wavescribe/plugins out of the test
  fs.writeFileSync(
    path.join(dir, "good.mjs"),
    `export default { apiVersion: 1, id: "good", name: "Good", credentials: [], models: [{ id: "m", input: { delivery: ["url"] }, output: { timestamps: "none" } }], transcribe: async () => ({}), normalize: () => ({ segments: [] }) };`,
  );
  fs.writeFileSync(path.join(dir, "bad.mjs"), "export default { apiVersion: 1, id: 'Bad Id' };");
  const warnings: string[] = [];
  const cfg = {
    ...emptyConfig(),
    file: path.join(dir, "config.json"),
    plugins: ["./good.mjs", "./bad.mjs"],
    providers: {
      "my-whisper": { type: "openai-compatible" as const, baseUrl: "http://localhost:8000/v1", models: ["large-v3"] },
    },
  };
  const reg = await loadRegistry(cfg, { ...silent, warn: (m) => warnings.push(m) });
  assert.ok(reg.has("good"));
  assert.equal(reg.get("my-whisper")!.credentials[0]!.env, "MY_WHISPER_API_KEY");
  assert.equal(reg.get("my-whisper")!.models[0]!.id, "large-v3");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /bad\.mjs.*id must be lowercase/);
});
