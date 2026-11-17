<h1 align="center">wavescribe</h1>
<p align="center">
  <a href="https://github.com/veardk/wavescribe/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/veardk/wavescribe/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/veardk/wavescribe/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/veardk/wavescribe/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://www.npmjs.com/package/wavescribe"><img alt="npm" src="https://img.shields.io/npm/v/wavescribe?style=flat-square" /></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%E2%89%A522.18-blue?style=flat-square" />
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green?style=flat-square" /></a>
</p>

<h3 align="center">音频、视频、播客、字幕 → 带时间戳的文字稿</h3>

把音频、视频、播客和字幕文件转成带时间戳的文字稿（srt / vtt / json / txt / md）。

处理顺序是：**有现成字幕就直接用，没有再调用语音转写 API。** 工具不改动内容，只做格式上必要的处理，比如滚动字幕去重、实体解码。

```
① 来源识别 → ② 获取（现成文字稿，或音频） → ③ 转写（API） → ④ 导出
```

## 安装

需要 Node ≥ 22.18、ffmpeg；YouTube 兜底、Bilibili 和其他视频站还需要 yt-dlp。

```bash
npm install -g wavescribe
wavescribe auth        # 添加转写服务的 API Key（交互式，只在没有现成字幕时才需要）
wavescribe doctor      # 检查 ffmpeg / yt-dlp / 配置 / 密钥
```

从源码运行：

```bash
git clone https://github.com/veardk/wavescribe.git && cd wavescribe
npm install
npm run dev -- <file|url> [options]
```

## 用法

```bash
wavescribe talk.mp3                                  # → ./talk.srt
wavescribe https://youtu.be/UF8uR6Z6KLc -f srt,txt -o out/
wavescribe "https://podcasts.apple.com/cn/podcast/…?i=1000800642062" -l zh
wavescribe https://example.com/feed.xml -e 3         # 第 3 新的一集
wavescribe https://example.com/feed.xml -e "guid:abc" -f json -o -
wavescribe info https://example.com/feed.xml         # 列出单集、可用字幕和音频
wavescribe video.mp4 -p deepgram --speakers -f vtt
wavescribe old.srt -f vtt -o -                       # 字幕格式互转
```

常用参数（完整列表见 `wavescribe -h`）：

| 参数                                           | 说明                                                        |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `-f srt,vtt,json,txt,md`                       | 输出格式，默认 srt                                          |
| `-o <目录\|文件\|->`                           | 输出位置；只输出一种格式时可以直接写文件名；`-` 表示 stdout |
| `-p / -m`                                      | 转写厂商 / 模型                                             |
| `-l zh`                                        | 语种；同时决定优先选哪种语言的字幕                          |
| `-e latest\|3\|guid:…\|2026-11-01\|标题关键词` | 选播客单集                                                  |
| `--prefer asr`                                 | 不用现成字幕，直接转写音频                                  |
| `--speakers`                                   | 说话人分离（需要厂商支持）                                  |
| `--clip 2m`                                    | 只转写前 2 分钟（测试用）                                   |
| `--opt k=v`                                    | 原样传给厂商的额外参数                                      |
| `--no-input`                                   | 不问任何问题（脚本、CI 里用）                               |

**终端里和脚本里的区别**：在终端里手动运行时，会显示进度条和颜色；播客 RSS 没加 `-e` 时弹出单集列表让你选（可以输入文字过滤）。输出被管道接走、在 CI 里、或者加了 `--no-input` 时，不弹任何交互，默认取最新一集，进度按行输出到 stderr。颜色遵守 `NO_COLOR` / `FORCE_COLOR`。

srt / vtt 需要时间戳，所以没有时间戳的文字稿（比如 HTML / 纯文本 transcript）会被跳过，改走下一个来源。只要 txt / md / json 时可以直接使用这类文字稿。

## 支持的来源

| 输入                                  | 获取方式（按顺序尝试）                                                |
| ------------------------------------- | --------------------------------------------------------------------- |
| 本地字幕 `.srt .vtt .ttml .json .txt` | 直接解析                                                              |
| 本地音视频 / 直链                     | ffmpeg 转为单声道 16 kHz 后转写                                       |
| RSS / Atom                            | `podcast:transcript`（json > vtt > srt > html > txt）→ enclosure 音频 |
| Apple Podcasts                        | iTunes Lookup 找到 RSS 并匹配单集，然后按 RSS 处理                    |
| 喜马拉雅                              | 专辑 RSS 匹配单集 → yt-dlp                                            |
| YouTube                               | 人工字幕 → 自动字幕（Innertube）→ yt-dlp 字幕 → 音频转写              |
| Bilibili                              | CC 字幕（AI 字幕需登录）→ yt-dlp 字幕 → 音频转写                      |
| Spotify 单集                          | Spotify 自动生成的文字稿（需登录）；音频有 DRM，不做转写              |
| 其他网页                              | yt-dlp 支持的站点：字幕 → 音频                                        |

小宇宙不在支持范围内。

**Bilibili 登录**：AI 字幕需要登录，运行 `wavescribe login bilibili` 会从本机浏览器同步 Cookie；也可以加 `--qr` 扫码登录。登录信息保存在 `~/.config/wavescribe/`（权限 600）。

**Spotify 登录**：文字稿需要 open.spotify.com 的 `sp_dc` Cookie。第一次运行时会自动从本机浏览器读取（Chrome、Edge、Brave、Arc、Vivaldi、Opera、ego lite、Firefox，需要系统里有 `sqlite3`），之后直接复用。也可以运行 `wavescribe login spotify`：浏览器里找不到登录时会打开 Spotify 网页，登录完成后自动继续。或者用 `--cookie <sp_dc>` 手动传入。也支持 `SPOTIFY_SP_DC` 环境变量和配置文件里的 `spotify.spDc`。

## 转写厂商

`wavescribe providers` 会列出全部厂商、模型、能力，以及密钥是否已配置。

| 类别        | 厂商（id）                                                        | 密钥变量                                                                                 |
| ----------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| OpenAI 兼容 | groq, openai, deepinfra, together, lemonfox, mistral, siliconflow | `<ID>_API_KEY`                                                                           |
| 专用 API    | deepgram, assemblyai, elevenlabs, gladia, speechmatics, soniox    | `<ID>_API_KEY`                                                                           |
|             | cloudflare                                                        | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`                                         |
| 国内        | aliyun（百炼 Paraformer / Fun-ASR）                               | `DASHSCOPE_API_KEY`                                                                      |
|             | volcengine（豆包录音文件识别）                                    | `VOLC_API_KEY`，或 `VOLC_APP_ID` + `VOLC_ACCESS_TOKEN`                                   |
|             | tencent（录音文件识别 / 极速版）                                  | `TENCENTCLOUD_SECRET_ID` + `TENCENTCLOUD_SECRET_KEY`（极速版另需 `TENCENTCLOUD_APP_ID`） |

不指定 `-p` 时，先用配置里的 `defaults.provider`，没有的话就用第一个已配置密钥的厂商。

各家的文件大小 / 时长上限、上传方式（multipart、原始字节、base64、公网 URL、先上传）都由插件声明。核心层据此自动完成：

- 下载、转码、压缩；
- 按静音点切分，并把各段时间戳拼回原时间轴；
- 异步任务轮询（中断后重跑会接着等同一个任务）；
- 按分段缓存厂商的原始响应，重跑不重复计费。

## API Key

没有现成字幕时要调用转写服务，需要对应厂商的 API Key。

```bash
wavescribe auth                                  # 交互式：选厂商 → 粘贴 Key（不回显）→ 当场验证 → 保存
wavescribe auth add groq                         # 直接配置某个厂商
printf %s "$KEY" | wavescribe auth add groq --stdin   # 脚本里用：从管道读入，验证不通过就不保存
wavescribe auth list                             # 已配置的 Key、来源，只显示前 4 位
wavescribe auth test [groq]                      # 用 Key 调一次厂商接口，确认能用（不转写、不计费）
wavescribe auth remove groq
```

Key 保存在 `~/.config/wavescribe/credentials.json`（权限 600），和 config.json 分开，分享配置文件不会带出密钥。多个 Key 的厂商（比如火山引擎）用 `--stdin` 时每行写一个 `变量名=值`。

在终端里直接运行 `wavescribe <链接>` 时，如果需要转写但还没配 Key，会询问要不要现在配置，配好后接着处理。

**读取顺序：环境变量 → `wavescribe auth` 保存的 → `<名称>File`（如 `apiKeyFile`）指向的文件 → 配置里直接写的值。**

## 配置

```bash
wavescribe config                                # 交互式菜单：默认厂商、语言、输出格式、输出目录等
wavescribe config set defaults.provider groq
wavescribe config set defaults.formats srt,txt
wavescribe config get defaults.provider
wavescribe config unset defaults.language
wavescribe config list | path | edit             # 列出 / 显示路径 / 用 $EDITOR 打开
```

`config set` 不接受密钥类的字段（`apiKey`、`token` 等），请用 `wavescribe auth`。

配置文件是 `~/.config/wavescribe/config.json`（也可以用 `WAVESCRIBE_CONFIG` 指定其他路径）：

```json
{
  "defaults": { "provider": "groq", "language": "zh", "formats": ["srt"], "outDir": "~/Transcripts" },
  "providers": {
    "groq": { "apiKeyFile": "~/.groq_key" },
    "speechmatics": { "region": "eu1" },
    "tencent": { "engine": "16k_zh_large" },
    "my-whisper": {
      "type": "openai-compatible",
      "name": "自建 Whisper",
      "baseUrl": "http://localhost:8000/v1",
      "models": ["large-v3"],
      "apiKeyEnv": "MY_WHISPER_KEY",
      "maxBytes": 100000000
    }
  },
  "plugins": ["./my-plugin.js"],
  "paths": { "ffmpeg": "ffmpeg", "ytDlp": "yt-dlp" }
}
```

密钥文件可以只写密钥本身，也可以写成 `GROQ_API_KEY=gsk_…` 这种 dotenv 格式，建议权限设为 600。不推荐把密钥直接写进 config.json。

缓存目录 `~/.cache/wavescribe/work/<来源>-<hash>/` 下有 `source/`、`media/`、`asr/<厂商>/` 和 `transcript.json`。`--no-cache` 会忽略缓存。

## 编写插件

厂商以插件形式接入，接口和示例见 [docs/plugins.md](docs/plugins.md)。只是兼容 OpenAI `/audio/transcriptions` 接口的服务不用写插件，在配置里声明 `"type": "openai-compatible"` 就行（见上面的配置示例）。

## 作为库使用

```ts
import { createLogger, loadConfig, loadRegistry, runInput } from "wavescribe";

const plain = createLogger(); // 文字行输出到 stderr
// 进度是结构化事件（step / bytes / parts / end），界面可以直接拿来画进度条
const log = { ...plain, progress: (e) => (e.type === "bytes" ? updateBar(e.done, e.total) : plain.progress(e)) };
const cfg = await loadConfig();
const env = { cfg, reg: await loadRegistry(cfg, log), log, useCache: true };
const { transcript, files } = await runInput(
  "talk.mp3",
  {
    formats: ["srt"],
    timestamps: false,
    prefer: "captions",
    speakers: false,
    extra: {},
    timeoutSeconds: 1800,
  },
  env,
);
```

## 参与开发

见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
