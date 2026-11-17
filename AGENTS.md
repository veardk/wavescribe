# AGENTS.md

This file is loaded in every session, so it only holds rules that apply to nearly every change. Details live in the matching docs:

- [README.md](README.md): user-facing behavior, including commands, options, config, and supported sources and providers.
- [CONTRIBUTING.md](CONTRIBUTING.md): code style, project structure and dependency direction, commit and release workflow.
- [docs/plugins.md](docs/plugins.md): the speech-to-text provider plugin interface.

When a behavior changes, update the matching doc. Only change this file when a rule that applies to every session changes.

## Commands

```sh
npm run check        # lint + typecheck + test; must pass before pushing
npm run format       # Biome formatting and import sorting
npm run dev -- <args>
npm run build        # tsc → dist/
node --test test/pipeline.test.ts                                   # run one file
node --test --test-name-pattern "prefer asr" test/pipeline.test.ts  # run one test
```

## Conventions

- Node ≥ 22.18, ESM and TypeScript only, `.ts` runs directly. Use only syntax that can be stripped directly (no `enum`, `namespace` or parameter properties). Relative imports use the `.ts` extension.
- Dependency direction: `core → utils → config → parsers/media/exporters → sources/providers → transcribe → pipeline → cli`; never depend in reverse.
- Write tests first when fixing bugs and adding features. Unit tests do not touch the network or call ffmpeg; replace external dependencies with the fakes in `test/helpers.ts`.
- Every change goes through a PR: branch `feat/…` or `fix/…` from the latest `main`, open the PR once `npm run check` passes, and fill in the PR template honestly with what was verified and **what was not**. Squash-merge after CI passes on all three platforms.
- PR titles use Conventional Commits and are written for users: after the squash merge the title is the commit message, and release-please turns it into a CHANGELOG line and uses it to pick the version.
- Do not edit `CHANGELOG.md` or `.release-please-manifest.json` by hand; release-please generates them. Maintainers decide when to release (by merging the release PR).

## Safety and correctness

- Never modify the original text: parsers only handle the format (tags, entities, rolling-caption repeats), and provider results only get structural conversion, never content rewrites. No de-hallucination, Traditional/Simplified Chinese conversion or similar processing.
- Never output secrets anywhere: not in logs, error messages, the `providers` command or test snapshots. Display secrets only through `mask()`. The Bilibili cookie file has mode `0600`.
- stdout is only for data (`-o -`, `--json`); progress and diagnostics go to stderr through `Logger`.
- Always throw `WsError(code, message, { hint })`, never a plain `Error`. The error code sets the exit code: `BAD_INPUT` → 2, everything else → 1.
- `normalize()` must be a pure function, because cached raw responses are replayed through it. Retries, polling, splitting and caching belong to the core; plugins must not implement them.
- Delete an async job file only when the provider reports failure or the job no longer exists (`NOT_FOUND`). Keep the job file on timeouts and transient network errors so the next run can keep waiting.
- Every network request has a timeout: go through `utils/http.ts`; when `fetch` must be used directly, combine the timeout signal with the caller's signal using `AbortSignal.any`. Downloads use `idleWatchdog` so a stalled connection cannot hang.
- Without a login, Bilibili AI subtitles may belong to another video, so they cannot be trusted. When the WBI-signed API is unavailable, fetch subtitles with yt-dlp instead.
- Run external programs with `spawn` and an argument array, never through a shell.
