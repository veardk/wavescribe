import { resolveTools } from "../../config/config.ts";
import { WsError } from "../../core/errors.ts";
import type { Env } from "../../pipeline.ts";
import { cookieFile, qrLogin, syncFromBrowsers } from "../../sources/bilibili/auth.ts";
import { credentialsFile, login as spotifyLogin } from "../../sources/spotify/auth.ts";
import type { Values } from "../options.ts";

const USAGE =
  "Supported: wavescribe login bilibili [--qr] | wavescribe login spotify [--cookie <sp_dc>] [--browser <name>]";

export async function cmdLogin(site: string | undefined, v: Values, env: Env): Promise<number> {
  if (site === "spotify") {
    await spotifyLogin(env.log, { cookie: v.cookie, browser: v.browser });
    env.log.info(`✓ Saved to ${credentialsFile()}`);
    return 0;
  }
  if (site !== "bilibili") throw new WsError("BAD_INPUT", USAGE);
  if (v.qr) {
    await qrLogin(env.log);
  } else if (!(await syncFromBrowsers(resolveTools(env.cfg).ytDlp, env.log))) {
    env.log.warn(
      "No logged-in Bilibili session found in local browsers. Log in at bilibili.com, or run: wavescribe login bilibili --qr",
    );
    return 1;
  }
  env.log.info(`✓ Saved to ${cookieFile()}`);
  return 0;
}
