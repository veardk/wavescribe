# 参与开发

感谢你愿意参与。

## 当前的贡献方式

项目还在早期，方向变化比较快：

- **欢迎开 Issue**：报 bug、提新来源 / 新厂商 / 新功能的需求。
- **Pull Request 暂时只由维护者和协作者提交。** 想动手改的话，请先开 Issue 说明想解决的问题和思路，确认方向后再写代码，避免白做。
- 检查通过不等于一定合并：还会看产品方向、安全、兼容性和可维护性。

## Issues

- **Bug**：用 Bug report 模板，附上复现命令、`wavescribe --version`、`wavescribe doctor` 的输出，以及加 `-v` 后的输出。**不要贴 API Key、Cookie 或 token。**
- **功能建议**：先说想解决什么问题、现在哪里不够用，再说设想的方案。
- **使用问题**：先看 [README](README.md) 和 `wavescribe help <命令>`。

## 环境

- Node ≥ 22.18：直接运行 `.ts`（type stripping），开发时不用构建。
- ffmpeg / ffprobe；测试 YouTube、Bilibili 和其他视频站还需要 yt-dlp。

```bash
npm install
npm run dev -- <file|url> [options]   # 等同于 wavescribe …
npm run check                         # lint + typecheck + test，推送前必须通过
npm run format                        # 自动格式化并整理 import
npm run build                         # 输出到 dist/
```

## 代码规范

- 格式化和 lint 用 [Biome](https://biomejs.dev)，配置在 `biome.json`：2 空格缩进，行宽 120，双引号，带分号，多行时加尾逗号。
- TypeScript 开启 `strict` 和 `noUncheckedIndexedAccess`。只有 Node 能直接剥离的语法可以用（`erasableSyntaxOnly`），所以不用 `enum`、`namespace` 和参数属性。
- 相对 import 写 `.ts` 后缀，构建时会改写成 `.js`。只导入类型时用 `import type`。
- 只有解析厂商或站点的 JSON 时允许用 `any`（`providers/`、`sources/`、`parsers/json.ts`），其他地方用具体类型或 `unknown`。
- 错误统一抛 `WsError(code, message, { hint })`，让用户知道下一步该做什么。
- 进度和诊断信息走 `Logger`，输出到 stderr；stdout 只留给数据。进度用结构化事件 `log.progress({ type: "step" | "bytes" | "parts" | "end" })`，不要自己拼进度文字：终端、纯文本日志和以后的图形界面各自决定怎么显示。
- 交互（提问、选择）只放在 `cli/` 里，并且只在 `isInteractive()` 为真时出现。核心模块需要用户做选择时，通过回调交给调用方（例如 `Env.chooseEpisode`）。
- 不修改文字内容：解析器只处理格式本身的问题（标签、实体、滚动字幕重复），不改写原文。

## 项目结构

```
src/
├── cli/            命令行：入口（index）、参数（options）、帮助文字（help）、各子命令（commands/）
│   └── ui/         终端界面：交互提问（prompts）、进度状态行（progress）、颜色（style），只有 CLI 使用
├── pipeline.ts     编排：来源 → 获取（文字稿 / 音频 → 转写）→ 导出
├── sources/        把输入解析成「候选」（现成文字稿或音频），每个站点一个模块
│   ├── bilibili/   api（视频 ID、WBI 签名、播放器接口）/ auth（登录）/ index（解析流程）
│   └── spotify/    cookies（从浏览器读 sp_dc）/ auth（TOTP 换 token、登录）/ index（文字稿）
├── parsers/        字幕和文字稿解析：cues（srt/vtt）、ttml、json、text
├── transcribe/     调用转写厂商：prepare（转码/切分）、stitch（拼回时间轴）、index（调用流程）
├── providers/      插件接口（plugin.ts）、注册表、厂商和模型选择、辅助函数
│   ├── openai-compatible.ts   通用 OpenAI 兼容适配器
│   └── builtin/               内置厂商插件
├── exporters/      输出 srt / vtt / json / txt / md
├── media/          ffmpeg / ffprobe 封装
├── config/         配置文件（config）、按键读写（edit）、凭证读取（credentials）、保存的 Key（secrets）、路径
├── utils/          http、文件、子进程、下载、XML、异步工具
├── core/           领域类型、错误、语种、时间（不依赖其他模块）
├── index.ts        库入口（wavescribe）
└── plugin.ts       插件 SDK 入口（wavescribe/plugin）
test/               node:test 单元测试
docs/               使用和开发文档
```

**依赖方向**（只能从左往右依赖，不能反过来）：

```
core → utils → config → parsers / media / exporters → sources / providers → transcribe → pipeline → cli
```

## 常见改动

- **新增转写厂商**：在 `src/providers/builtin/` 新建插件，加进 `builtin/index.ts`。在 `test/providers.test.ts` 里用一份真实响应测 `normalize`。接口见 [docs/plugins.md](docs/plugins.md)。
- **新增来源站点**：在 `src/sources/` 新建解析器，返回 `ResolvedSource`（元信息 + 按顺序尝试的候选），然后在 `sources/index.ts` 的 `RESOLVERS` 里注册。通用网页解析器 `web` 必须排在最后。
- **新增输出格式**：在 `src/exporters/index.ts` 里加一个 `Exporter`。需要时间戳的格式设置 `needsTimestamps: true`。

## 测试

- 单元测试不联网，也不调用 ffmpeg。外部服务和插件用 `test/helpers.ts` 里的假候选、假插件代替。
- 修 bug 时先写一个能复现问题的测试，再修。
- 涉及外部服务的改动，请在 PR 里写明手动验证过的命令和结果。**不要贴 API Key 或 Cookie。**
- 只跑一个文件：`node --test test/pipeline.test.ts`；只跑一个用例：`node --test --test-name-pattern "prefer asr" test/pipeline.test.ts`。

## 提交和 Pull Request

提交前确认：

- 有对应的测试，或者在 PR 里说明为什么不需要。
- README、`wavescribe help` 的文字和文档与实际行为一致。
- 没有提交 `node_modules`、`dist`、本地缓存或任何密钥。
- `npm run check` 通过。

流程：

1. 从最新的 `main` 拉分支，命名为 `feat/…`、`fix/…`、`docs/…` 等。
2. 改代码，跑 `npm run check`。
3. 提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/v1.0.0/)，格式为 `<type>(<scope>): <说明>`：

   | type                                           | 用于                             | 是否进入发布说明 |
   | ---------------------------------------------- | -------------------------------- | ---------------- |
   | `feat`                                         | 新功能（新来源、新厂商、新参数） | 是               |
   | `fix`                                          | 修 bug                           | 是               |
   | `perf`                                         | 性能改进                         | 是               |
   | `docs`                                         | 只改文档                         | 否               |
   | `refactor` / `test` / `chore` / `ci` / `build` | 不影响用户的改动                 | 否               |

   scope 写受影响的模块，比如 `sources`、`bilibili`、`providers`、`groq`、`cli`、`parsers`。例子：

   ```
   fix(bilibili): use yt-dlp subtitles when the signed player API is rate limited
   feat(providers): add Rev.ai plugin
   ```

   破坏兼容性的改动在类型后加 `!`（如 `feat(cli)!: …`），或在正文写 `BREAKING CHANGE: …`。

4. 发 PR 到 `main`，按 PR 模板如实填写，特别是**没有验证的部分**。
5. **PR 标题就是发布说明里的一行**：合并方式只有 squash，PR 标题会成为 `main` 上的提交信息，release-please 再把它写进 CHANGELOG 并决定版本号。所以标题要写给用户看，比如 `fix(bilibili): skip AI subtitles that belong to another video`，而不是 `fix: update index.ts`。
6. CI 会在 Linux、macOS、Windows 上跑 `npm run check`、构建和打包检查，全部通过后才能合并。

**不要手动修改 `CHANGELOG.md` 和 `.release-please-manifest.json`。** 这两个文件由 release-please 生成，CI 会拦下手动修改它们的 PR。

## 发布

发布由 [release-please](https://github.com/googleapis/release-please) 自动完成：

1. 每次有提交合并进 `main`，release-please 都会根据新增的 Conventional Commits 更新一个「release PR」，里面包含版本号和 CHANGELOG 的改动。
2. 维护者合并这个 release PR 后，release-please 会打 tag（`vX.Y.Z`）、创建 GitHub Release，然后由 workflow 重新跑一遍 `npm run check`，再通过 npm Trusted Publisher 发布（带 provenance，不需要 token）。
3. 1.0 之前：`feat` 和 `fix` 升最后一位，破坏性改动升中间一位。
4. 没有 feat / fix 也想发版（或者发 1.0.0）时，开一个 PR，在 **PR 描述**里写 `Release-As: x.y.z`。

release PR 只改 `package.json`、`CHANGELOG.md` 和 manifest，不会触发 CI，所以由维护者用管理员身份跳过检查合并（`gh pr merge <编号> --squash --admin`）。安全性由发布流程里的二次检查保证。

自动发布失败时，先在本地补发保证用户能装到：确认本地 HEAD 就是这个 tag 的提交，再 `npm publish`，然后再查原因。

## License

提交的代码按 [MIT](LICENSE) 许可发布。
