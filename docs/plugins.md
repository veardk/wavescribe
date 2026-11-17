# 编写转写厂商插件

wavescribe 的每个转写厂商都是一个插件：插件只**描述**厂商接受什么、怎么调用、返回结果怎么翻译。下面这些由核心统一处理，插件不用管：

- 下载、转码、压缩，超限时按静音切分；
- 重试（遵守 Retry-After）；
- 异步任务轮询，中断后可续等；
- 按分段缓存原始响应；
- 凭证读取；
- 说话人改名为 S1/S2，时间戳拼回原时间轴。

内置的 17 个厂商（`src/providers/builtin/`）用的也是这套接口，可以直接拿来当参考。

## 加载方式

插件是一个 ES 模块（`.js` / `.mjs`，Node ≥ 22.18 也可以直接用 `.ts`），默认导出一个插件对象（也可以导出数组）。有两种加载方式：

- 放进 `~/.config/wavescribe/plugins/`；
- 写进配置的 `plugins` 列表（相对路径以配置文件所在目录为基准，也可以写 npm 包名）。

插件 id 和内置厂商重名时会覆盖内置的。插件加载失败只会打印警告，不影响其他厂商。

## 最小示例（同步接口）

```ts
import { definePlugin, PLUGIN_API_VERSION, groupWords, num, str } from "wavescribe/plugin";

export default definePlugin({
  apiVersion: PLUGIN_API_VERSION,
  id: "acme",
  name: "Acme ASR",
  credentials: [{ name: "apiKey", env: "ACME_API_KEY" }],
  settings: [{ name: "baseUrl", env: "ACME_BASE_URL", default: "https://api.acme.example" }],
  models: [
    {
      id: "v1",
      default: true,
      input: { delivery: ["multipart", "url"], maxBytes: 50e6, formats: ["mp3", "wav"] },
      output: { timestamps: "word", speakers: true },
    },
  ],

  // 返回厂商的原始响应；核心会缓存它，重跑时直接交给 normalize，不再请求。
  async transcribe(audio, opts, ctx) {
    const form = new FormData();
    if (audio.kind === "file") form.append("file", await ctx.blob(audio.path, audio.mime), audio.filename);
    else if (audio.kind === "url") form.append("url", audio.url);
    if (opts.providerLanguage) form.append("language", opts.providerLanguage);
    const res = await ctx.http.request(`${ctx.settings.baseUrl}/v1/stt`, {
      method: "POST",
      headers: { authorization: `Bearer ${ctx.credentials.apiKey}` },
      body: form,
    });
    return res.data;
  },

  // 纯函数：原始响应 → 以秒为单位的分段。不能做任何 I/O。
  normalize: (raw: any) => ({
    segments: groupWords(
      (raw.words ?? []).map((w: any) => ({
        start: num(w.start),
        end: num(w.end),
        text: str(w.text),
        speaker: w.speaker,
      })),
    ),
    language: raw.language,
  }),
});
```

`definePlugin` 只用来提供类型检查。插件不想依赖 wavescribe 包时，可以直接导出对象，写 `apiVersion: 1`。

## 接口要点

| 字段                                             | 说明                                                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `credentials`                                    | 需要的密钥：`name` 是插件读取时用的名字，`env` 是环境变量名，`optional` 表示可选。用户用 `wavescribe auth` 保存，也可以用环境变量或 `<name>File`。                                   |
| `settings`                                       | 非机密设置（区域、Base URL 等），读取顺序：配置 → 环境变量 → `default`。                                                                                                             |
| `models[].input.delivery`                        | 按偏好排列：`multipart`、`raw`、`base64`、`url`（厂商自己拉公网 URL）、`upload`（先调插件的 `upload()`）。                                                                           |
| `models[].input.maxBytes / maxSeconds / formats` | 单次请求的上限和可接受的格式。超出时核心会转码、压缩、切分。                                                                                                                         |
| `models[].output.timestamps`                     | `none` / `segment` / `word`。`none` 的模型不能输出 srt/vtt。                                                                                                                         |
| `models[].mode`                                  | 插件同时实现了同步和异步接口时，指定这个模型用哪种。                                                                                                                                 |
| `mapLanguage(lang, model)`                       | 把 BCP-47（`zh`、`en-US`）转成厂商的写法；返回 `undefined` 表示交给厂商自动识别。                                                                                                    |
| `checkCredentials(values)`                       | 密钥有多种组合时（例如 API Key 或 AppId + Token），返回问题描述，没问题返回 `undefined`。                                                                                            |
| `verify(ctx)`                                    | 可选。发一个免费的请求（比如列出模型）证明密钥能用，供 `wavescribe auth` 当场验证。直接用 `ctx.http`，401/403 会被当作密钥被拒。没有这个方法的厂商会在第一次转写时才知道密钥对不对。 |

## 异步厂商

实现 `submit` → `poll` →（可选）`fetchResult`，不用实现 `transcribe`：

```ts
async submit(audio, opts, ctx) {
  const res = await ctx.http.request(`${base}/jobs`, { json: { url: audio.kind === "url" ? audio.url : undefined } });
  return { id: res.data.id };               // 会写入缓存目录，中断后重跑会接着等这个任务
},
async poll(task, ctx) {
  const s = (await ctx.http.request(`${base}/jobs/${task.id}`)).data;
  if (s.status === "done") return { state: "done", raw: s };   // 带 raw 时不再调用 fetchResult
  if (s.status === "error") return { state: "failed", message: s.error };
  return { state: "pending", detail: s.status };
},
pollIntervalMs: { initial: 3000, max: 20000 },
```

轮询间隔从 `initial` 开始按 1.5 倍递增，最多到 `max`。总等待时间由 `--timeout` 控制。

## 错误

`ctx.http.request` 遇到非 2xx 会抛出 `WsError`，按状态码映射成 `AUTH`、`RATE_LIMIT`、`INPUT_TOO_LARGE` 等。插件自己判断出错时，也抛 `WsError`（从 `wavescribe/plugin` 导入），并尽量给出 `hint`。

## 可用的辅助函数（`wavescribe/plugin`）

- `groupWords(words, { maxGap, maxChars, join })`：把词流组成句子级分段。中日韩文字之间不加空格；`join: "raw"` 保留 token 原有的空格。
- `attachWords(segments, words)`：把扁平的词列表挂到对应的分段上。
- `joinWords`、`paragraphs`、`num`、`str`、`spk`：拼词、按段落切纯文本，以及数字、字符串和说话人标签的安全转换。
- `fromMs`、`fromDuration("1.2s")`、`fromSecString`、`fromFrames10ms`：把各种时间写法转成秒。

## 不用写插件的情况

服务兼容 OpenAI 的 `/audio/transcriptions` 接口时，在配置里声明就行：

```json
{
  "providers": {
    "my-whisper": {
      "type": "openai-compatible",
      "baseUrl": "http://localhost:8000/v1",
      "models": ["large-v3"],
      "apiKeyEnv": "MY_WHISPER_KEY",
      "maxBytes": 100000000
    }
  }
}
```

## 测试

`normalize` 是纯函数，用一份真实响应做快照测试最省事，参考 `test/providers.test.ts`。
