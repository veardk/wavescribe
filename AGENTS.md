# AGENTS.md

每次会话都会加载这个文件，所以只写几乎每次改动都适用的规则。细节去对应的文档里找：

- [README.md](README.md)：面向用户的约定，包括命令、参数、配置、支持的来源和厂商。
- [CONTRIBUTING.md](CONTRIBUTING.md)：代码规范、目录结构和依赖方向、提交与发布流程。
- [docs/plugins.md](docs/plugins.md)：转写厂商插件的接口。

行为约定变了，就去更新对应的文档。只有每次会话都适用的规则变了，才改这个文件。

## 命令

```sh
npm run check        # lint + typecheck + test，推送前必须通过
npm run format       # Biome 格式化并整理 import
npm run dev -- <args>
npm run build        # tsc → dist/
node --test test/pipeline.test.ts                                   # 只跑一个文件
node --test --test-name-pattern "prefer asr" test/pipeline.test.ts  # 只跑一个用例
```

## 约定

- Node ≥ 22.18，只用 ESM 和 TypeScript，直接运行 `.ts`。只用能被直接剥离的语法（不用 `enum`、`namespace` 和参数属性）。相对 import 写 `.ts` 后缀。
- 依赖方向：`core → utils → config → parsers/media/exporters → sources/providers → transcribe → pipeline → cli`，不能反向依赖。
- 修 bug 和加功能时先写测试。单元测试不联网，也不调用 ffmpeg，外部依赖用 `test/helpers.ts` 里的假对象代替。
- 每个改动走 PR：从最新的 `main` 拉 `feat/…`、`fix/…` 分支，`npm run check` 通过后开 PR，按 PR 模板如实写清验证了什么、**没验证什么**。三个平台的 CI 通过后 squash 合并。
- PR 标题用 Conventional Commits，并且写给用户看：squash 合并后它就是提交信息，release-please 把它变成 CHANGELOG 里的一行并决定版本号。
- 不要手动修改 `CHANGELOG.md` 和 `.release-please-manifest.json`，它们由 release-please 生成。发版由维护者决定（合并 release PR）。

## 安全与正确性

- 不修改原文：解析器只处理格式（标签、实体、滚动字幕重复），厂商结果也只做结构转换，不改写内容。不加入去幻觉、繁简转换之类的处理。
- 任何地方都不能输出密钥：日志、错误信息、`providers` 命令和测试快照里都不行。展示密钥只能用 `mask()`。B站 Cookie 文件的权限是 `0600`。
- stdout 只留给数据（`-o -`、`--json`），进度和诊断信息通过 `Logger` 输出到 stderr。
- 抛出的错误一律用 `WsError(code, message, { hint })`，不要抛普通 `Error`。错误码决定退出码：`BAD_INPUT` → 2，其他 → 1。
- `normalize()` 必须是纯函数，因为缓存里的原始响应也会交给它重放。重试、轮询、切分、缓存都由核心负责，插件里不要自己实现。
- 异步任务只有在厂商报告失败，或任务已经不存在（`NOT_FOUND`）时，才删除任务文件。超时和临时网络错误都要保留任务文件，下次运行可以接着等。
- 网络请求一律设置超时：走 `utils/http.ts`；必须直接用 `fetch` 时，用 `AbortSignal.any` 把超时信号和调用方的信号合并。下载要用 `idleWatchdog`，防止连接卡住。
- 没有登录时，B站的 AI 字幕可能属于其他视频，所以不能信任。WBI 签名的接口不可用时，字幕改用 yt-dlp 获取。
- 外部程序用 `spawn` 加参数数组调用，不经过 shell。
