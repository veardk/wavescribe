// Bilibili web APIs: video ids, WBI request signing, video and player info.

import crypto from "node:crypto";
import { WsError } from "../../core/errors.ts";
import { BROWSER_UA } from "../../utils/http.ts";
import { http } from "../candidates.ts";
import type { SourceContext } from "../types.ts";

const MIXIN = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41,
  13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34,
  44, 52,
];

export const isBilibili = (input: string) => /^https?:\/\/([a-z]+\.)?(bilibili\.com|b23\.tv)\//i.test(input);

function avToBv(aid: string): string {
  const table = "FcwAPNKTMug3GV5Lj7EJnHpWsx4tb8haYeviqBz6rkCy12mUSDQX9RdoZf";
  const out = [..."BV1000000000"];
  let n = ((1n << 51n) | BigInt(aid)) ^ 23442827791579n;
  for (let i = 11; n > 0n; i--, n /= 58n) out[i] = table[Number(n % 58n)]!;
  [out[3], out[9]] = [out[9]!, out[3]!];
  [out[4], out[7]] = [out[7]!, out[4]!];
  return out.join("");
}

export function bvidOf(input: string): string | undefined {
  const t = input.trim();
  const bv = /\/video\/(BV[0-9A-Za-z]+)/.exec(t)?.[1] ?? /[?&]bvid=(BV[0-9A-Za-z]+)/.exec(t)?.[1];
  if (bv) return bv;
  const av = /\/video\/av(\d+)/i.exec(t)?.[1];
  return av ? avToBv(av) : undefined;
}

function signWbi(params: Record<string, string>, mixinKey: string): string {
  const all: Record<string, string> = { ...params, wts: String(Math.floor(Date.now() / 1000)) };
  const query = Object.keys(all)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(all[k]!.replace(/[!'()*]/g, ""))}`)
    .join("&");
  return `${query}&w_rid=${crypto
    .createHash("md5")
    .update(query + mixinKey)
    .digest("hex")}`;
}

export interface Subtitle {
  lan: string;
  lan_doc?: string;
  subtitle_url: string;
}

export interface PlayerInfo {
  headers: Record<string, string>;
  title: string;
  view: any;
  page: number;
  duration?: number;
  player: any;
  /** The WBI-signed endpoint answered. The unsigned fallback can return other videos' subtitles. */
  signed: boolean;
}

async function mixinKey(headers: Record<string, string>, ctx: SourceContext): Promise<string> {
  try {
    const nav = (
      await http(ctx).request("https://api.bilibili.com/x/web-interface/nav", { headers, okStatuses: [412] })
    ).data;
    const key = (u: string) => u.split("/").pop()?.split(".")[0] ?? "";
    const raw = key(nav?.data?.wbi_img?.img_url ?? "") + key(nav?.data?.wbi_img?.sub_url ?? "");
    return raw
      ? MIXIN.map((n) => raw[n])
          .join("")
          .slice(0, 32)
      : "";
  } catch {
    return "";
  }
}

export async function playerInfo(
  bvid: string,
  page: number,
  sessdata: string | undefined,
  ctx: SourceContext,
): Promise<PlayerInfo> {
  const headers: Record<string, string> = {
    "user-agent": BROWSER_UA,
    referer: "https://www.bilibili.com",
    ...(sessdata ? { cookie: `SESSDATA=${sessdata}` } : {}),
  };
  const h = http(ctx);
  const view = (await h.request("https://api.bilibili.com/x/web-interface/view", { query: { bvid }, headers })).data;
  if (view?.code !== 0)
    throw new WsError("NOT_FOUND", `Bilibili video lookup failed: [${view?.code}] ${view?.message ?? ""}`);
  const pages: any[] = view.data.pages ?? [];
  const p = pages[page - 1] ?? pages[0] ?? {};
  const aid = String(view.data.aid);
  const cid = String(p.cid ?? view.data.cid);
  const key = await mixinKey(headers, ctx);
  const endpoints = [
    ...(key
      ? [{ signed: true, url: `https://api.bilibili.com/x/player/wbi/v2?${signWbi({ aid, cid, bvid }, key)}` }]
      : []),
    { signed: false, url: `https://api.bilibili.com/x/player/v2?aid=${aid}&cid=${cid}&bvid=${bvid}` },
  ];
  let player: any;
  let signed = false;
  for (const ep of endpoints) {
    const name = ep.signed ? "signed" : "unsigned";
    try {
      const j = (
        await h.request(ep.url, {
          headers: { ...headers, referer: `https://www.bilibili.com/video/${bvid}` },
          retries: 1,
        })
      ).data;
      if (j?.code === 0) {
        player = j.data;
        signed = ep.signed;
        ctx.log.debug(`bilibili player: ${name} endpoint`);
        break;
      }
      ctx.log.debug(`bilibili player ${name}: code ${j?.code} ${j?.message ?? ""}`);
    } catch (e) {
      ctx.log.debug(`bilibili player ${name} failed: ${(e as Error).message}`);
    }
  }
  return {
    headers,
    title: `${view.data.title}${pages.length > 1 ? ` (P${p.page ?? page} - ${p.part ?? ""})` : ""}`,
    view: view.data,
    page: p.page ?? page,
    duration: p.duration ?? view.data.duration,
    player,
    signed,
  };
}
