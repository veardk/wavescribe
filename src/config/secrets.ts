// API keys saved by `wavescribe auth`, kept apart from config.json so the config can be shared.
// File: <config dir>/credentials.json, readable only by the user (0600).

import path from "node:path";
import { readJson, writeJson } from "../utils/fs.ts";
import { configDir } from "./paths.ts";

/** provider id → credential name (e.g. `apiKey`) → value. */
export type SavedSecrets = Record<string, Record<string, string>>;

interface SecretsFile {
  version: 1;
  providers: SavedSecrets;
}

export const secretsFile = () => path.join(configDir(), "credentials.json");

export async function loadSecrets(): Promise<SavedSecrets> {
  return (await readJson<SecretsFile>(secretsFile()))?.providers ?? {};
}

async function write(providers: SavedSecrets): Promise<void> {
  const data: SecretsFile = { version: 1, providers };
  await writeJson(secretsFile(), data, { mode: 0o600 });
}

/** Replace what is saved for one provider. */
export async function saveSecrets(providerId: string, values: Record<string, string>): Promise<void> {
  const all = await loadSecrets();
  all[providerId] = values;
  await write(all);
}

/** Forget one provider's saved values. Returns false when nothing was saved. */
export async function removeSecrets(providerId: string): Promise<boolean> {
  const all = await loadSecrets();
  if (!all[providerId]) return false;
  delete all[providerId];
  await write(all);
  return true;
}
