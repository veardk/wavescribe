import { COMPAT_PRESETS, openAICompatible } from "../openai-compatible.ts";
import type { ProviderPlugin } from "../plugin.ts";
import aliyun from "./aliyun.ts";
import assemblyai from "./assemblyai.ts";
import cloudflare from "./cloudflare.ts";
import deepgram from "./deepgram.ts";
import elevenlabs from "./elevenlabs.ts";
import gladia from "./gladia.ts";
import soniox from "./soniox.ts";
import speechmatics from "./speechmatics.ts";
import tencent from "./tencent.ts";
import volcengine from "./volcengine.ts";

/** Registration order is also the auto-selection order when no provider is chosen. */
export const BUILTIN_PLUGINS: ProviderPlugin[] = [
  ...COMPAT_PRESETS.map(openAICompatible),
  deepgram,
  assemblyai,
  elevenlabs,
  gladia,
  speechmatics,
  soniox,
  cloudflare,
  aliyun,
  volcengine,
  tencent,
];
