# Contributing

Thanks for your interest in contributing.

## How to contribute right now

The project is still early and its direction changes quickly:

- **Issues are welcome**: bug reports, and requests for new sources, providers or features.
- **For now, pull requests come only from maintainers and collaborators.** If you want to make a change, open an issue first that describes the problem and your approach, and write code once the direction is agreed, so no work is wasted.
- Passing checks does not guarantee a merge: product direction, security, compatibility and maintainability are also considered.

## Issues

- **Bugs**: use the Bug report template and include the command that reproduces it, `wavescribe --version`, the output of `wavescribe doctor`, and the output with `-v`. **Do not paste API keys, cookies or tokens.**
- **Feature requests**: first describe the problem you want solved and where the current behavior falls short, then the solution you have in mind.
- **Usage questions**: check the [README](README.md) and `wavescribe help <command>` first.

## Environment

- Node ≥ 22.18: runs `.ts` directly (type stripping), so there is no build step during development.
- ffmpeg / ffprobe; testing YouTube, Bilibili and other video sites also needs yt-dlp.

```bash
npm install
npm run dev -- <file|url> [options]   # same as wavescribe …
npm run check                         # lint + typecheck + test; must pass before pushing
npm run format                        # format and organize imports
npm run build                         # output to dist/
```

## Code style

- Formatting and linting use [Biome](https://biomejs.dev), configured in `biome.json`: 2-space indent, 120-character lines, double quotes, semicolons, trailing commas on multi-line constructs.
- TypeScript has `strict` and `noUncheckedIndexedAccess` on. Only syntax that Node can strip directly is allowed (`erasableSyntaxOnly`), so no `enum`, `namespace` or parameter properties.
- Relative imports use the `.ts` extension, which the build rewrites to `.js`. Use `import type` for type-only imports.
- `any` is allowed only when parsing provider or site JSON (`providers/`, `sources/`, `parsers/json.ts`); elsewhere use concrete types or `unknown`.
- Always throw `WsError(code, message, { hint })`, so users know what to do next.
- Progress and diagnostics go through `Logger` to stderr; stdout is only for data. Report progress as structured events, `log.progress({ type: "step" | "bytes" | "parts" | "end" })`, instead of building progress text yourself: the terminal, plain-text logs and a future GUI each decide how to show it.
- Interaction (questions, choices) lives only in `cli/` and appears only when `isInteractive()` is true. When a core module needs the user to choose, it hands the choice to the caller through a callback (for example `Env.chooseEpisode`).
- Do not modify text content: parsers only fix problems of the format itself (tags, entities, rolling-caption repeats) and never rewrite the original text.

## Project structure

```
src/
├── cli/            command line: entry (index), options, help text (help), subcommands (commands/)
│   └── ui/         terminal UI: prompts, progress status line (progress), colors (style); used only by the CLI
├── pipeline.ts     orchestration: source → fetch (transcript / audio → transcribe) → export
├── sources/        turns input into "candidates" (existing transcripts or audio), one module per site
│   ├── bilibili/   api (video IDs, WBI signing, player API) / auth (login) / index (resolve flow)
│   └── spotify/    cookies (read sp_dc from browsers) / auth (TOTP → token, login) / index (transcripts)
├── parsers/        subtitle and transcript parsers: cues (srt/vtt), ttml, json, text
├── transcribe/     calls speech-to-text providers: prepare (transcode/split), stitch (map back onto the timeline), index (call flow)
├── providers/      plugin interface (plugin.ts), registry, provider and model selection, helpers
│   ├── openai-compatible.ts   generic OpenAI-compatible adapter
│   └── builtin/               built-in provider plugins
├── exporters/      srt / vtt / json / txt / md output
├── media/          ffmpeg / ffprobe wrappers
├── config/         config file (config), key-path editing (edit), credential lookup (credentials), saved keys (secrets), paths
├── utils/          http, files, child processes, downloads, XML, async helpers
├── core/           domain types, errors, languages, time (no dependencies on other modules)
├── index.ts        library entry (wavescribe)
└── plugin.ts       plugin SDK entry (wavescribe/plugin)
test/               node:test unit tests
docs/               usage and development docs
```

**Dependency direction** (dependencies only go left to right, never the reverse):

```
core → utils → config → parsers / media / exporters → sources / providers → transcribe → pipeline → cli
```

## Common changes

- **Add a speech-to-text provider**: create a plugin in `src/providers/builtin/` and add it to `builtin/index.ts`. Test `normalize` in `test/providers.test.ts` with a real response. See [docs/plugins.md](docs/plugins.md) for the interface.
- **Add a source site**: create a resolver in `src/sources/` that returns a `ResolvedSource` (metadata + candidates tried in order), then register it in `RESOLVERS` in `sources/index.ts`. The generic web resolver `web` must stay last.
- **Add an output format**: add an `Exporter` in `src/exporters/index.ts`. Formats that need timestamps set `needsTimestamps: true`.

## Tests

- Unit tests do not touch the network or call ffmpeg. External services and plugins are replaced by the fake candidates and fake plugins in `test/helpers.ts`.
- When fixing a bug, first write a test that reproduces it, then fix it.
- For changes involving external services, list the commands you verified by hand and their results in the PR. **Do not paste API keys or cookies.**
- Run one file: `node --test test/pipeline.test.ts`; run one test: `node --test --test-name-pattern "prefer asr" test/pipeline.test.ts`.

## Commits and pull requests

Before submitting, make sure:

- There are tests for the change, or the PR explains why none are needed.
- The README, `wavescribe help` text and docs match the actual behavior.
- No `node_modules`, `dist`, local cache or secrets are committed.
- `npm run check` passes.

Workflow:

1. Branch from the latest `main`, named `feat/…`, `fix/…`, `docs/…`, etc.
2. Make the change and run `npm run check`.
3. Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), in the form `<type>(<scope>): <description>`:

   | type                                           | Used for                                       | In release notes |
   | ---------------------------------------------- | ---------------------------------------------- | ---------------- |
   | `feat`                                         | New features (new sources, providers, options) | Yes              |
   | `fix`                                          | Bug fixes                                      | Yes              |
   | `perf`                                         | Performance improvements                       | Yes              |
   | `docs`                                         | Documentation only                             | No               |
   | `refactor` / `test` / `chore` / `ci` / `build` | Changes that do not affect users               | No               |

   The scope is the affected module, such as `sources`, `bilibili`, `providers`, `groq`, `cli`, `parsers`. Examples:

   ```
   fix(bilibili): use yt-dlp subtitles when the signed player API is rate limited
   feat(providers): add Rev.ai plugin
   ```

   For breaking changes, add `!` after the type (such as `feat(cli)!: …`), or write `BREAKING CHANGE: …` in the body.

4. Open a PR against `main` and fill in the PR template honestly, especially **what was not verified**.
5. **The PR title becomes a line in the release notes**: PRs are only squash-merged, so the title becomes the commit message on `main`, and release-please writes it into the CHANGELOG and uses it to pick the version. Write the title for users, for example `fix(bilibili): skip AI subtitles that belong to another video`, not `fix: update index.ts`.
6. CI runs `npm run check`, the build and a package check on Linux, macOS and Windows; all must pass before merging.

**Do not edit `CHANGELOG.md` or `.release-please-manifest.json` by hand.** release-please generates both files, and CI blocks PRs that edit them by hand.

## Releases

Releases are automated with [release-please](https://github.com/googleapis/release-please):

1. Whenever commits are merged into `main`, release-please updates a "release PR" from the new Conventional Commits, containing the version bump and CHANGELOG changes.
2. When a maintainer merges that release PR, release-please tags it (`vX.Y.Z`) and creates a GitHub Release. A workflow then reruns `npm run check` and publishes through npm Trusted Publisher (with provenance, no token needed).
3. Before 1.0: `feat` and `fix` bump the patch version, breaking changes bump the minor version.
4. To release without any feat / fix (or to release 1.0.0), open a PR with `Release-As: x.y.z` in the **PR description**.

The release PR only changes `package.json`, `CHANGELOG.md` and the manifest and does not trigger CI, so a maintainer merges it as an admin, skipping checks (`gh pr merge <number> --squash --admin`). The second check in the publish workflow keeps this safe.

If the automated publish fails, first publish locally so users can install the release: confirm the local HEAD is the tagged commit, run `npm publish`, then look into the cause.

## License

Contributions are released under the [MIT](LICENSE) license.
