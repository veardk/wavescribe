import { mask, resolveCredentials } from "../../config/credentials.ts";
import type { Env } from "../../pipeline.ts";
import { isConfigured, modelMode } from "../../providers/select.ts";
import type { Values } from "../options.ts";
import { print, printJson } from "../output.ts";

export async function cmdProviders(v: Values, env: Env): Promise<number> {
  const rows = [];
  for (const p of env.reg.values()) {
    const creds = await resolveCredentials(env.cfg, p.id, p.credentials);
    rows.push({
      id: p.id,
      name: p.name,
      configured: await isConfigured(p, env.cfg),
      credentials: p.credentials.map((c) => {
        const value = creds.values[c.name];
        return {
          env: c.env,
          optional: !!c.optional,
          set: !!value,
          source: creds.sources[c.name],
          preview: value ? mask(value) : undefined,
        };
      }),
      models: p.models.map((m) => ({
        id: m.id,
        default: !!m.default,
        mode: modelMode(p, m),
        timestamps: m.output.timestamps,
        speakers: !!m.output.speakers,
        delivery: m.input.delivery,
        maxMB: m.input.maxBytes ? Math.round(m.input.maxBytes / 1e6) : undefined,
      })),
      homepage: p.homepage,
    });
  }
  if (v.json) {
    printJson(rows);
    return 0;
  }
  const out: string[] = [];
  for (const r of rows) {
    out.push(`${r.configured ? "✓" : "·"} ${r.id.padEnd(13)} ${r.name}`);
    out.push(
      `    keys    ${r.credentials.map((c) => `${c.env}${c.optional ? "?" : ""}${c.set ? ` (${c.source})` : ""}`).join(", ")}`,
    );
    for (const m of r.models) {
      const speakers = m.speakers ? " speakers" : "         ";
      const limit = m.maxMB ? ` ≤${m.maxMB}MB` : "";
      out.push(
        `    ${m.default ? "*" : " "} ${m.id.padEnd(30)} ${m.mode.padEnd(5)} ts:${m.timestamps.padEnd(7)}${speakers}  ${m.delivery.join("/")}${limit}`,
      );
    }
  }
  out.push(
    "",
    "✓ = keys found.  * = default model.",
    "Add a key with `wavescribe auth`, or set the environment variable shown after `keys`.",
  );
  print(out.join("\n"));
  return 0;
}
