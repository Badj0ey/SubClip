# SubClip Studio

**Find the moment in a subtitle. Turn it into a clip.**

SubClip is a local-first Electron + Vue 3 + TypeScript + SQLite desktop workspace for Bilibili subtitle acquisition, transcript editing, danmaku-assisted navigation, cross-video search, clip organization, FFmpeg exports, and publishing materials. Core editing and search do not require a cloud AI account.

This source tree started from the original **3.16.0** codebase and is currently **3.17.0**. It preserves the existing database schema/migrations, browser userscript protocol, and core workflows. It is **source code**, not a prebuilt installer.

## Get started

Requires **Node.js 22+**, npm, and FFmpeg for local video exports.

```bash
npm ci
npm run dev

# Before shipping:
npm run typecheck
npm test
npm run build
npm run dist       # Windows installer and portable archive
```

On Windows, `SubClip.bat` starts an already-built app with installed dependencies. `.npmrc.example` is an optional mirror configuration; do not commit your local `.npmrc`.

## Main workflow

1. Import `.srt`, `.vtt`, or `.txt` subtitles, or pull Bilibili video/series/favorites subtitles.
2. Browse the library, preview videos, edit transcripts, and select time ranges. For Bilibili videos, expand **Danmaku reference** in the **Clip assistant** sidebar to jump from a comment to the matching subtitle.
3. Search all transcripts with SQLite FTS5 or optional local semantic embeddings.
4. Save clips with names, favorites and tags, then queue FFmpeg exports.
5. Optionally use AI summaries, clip discovery, knowledge graphs, copy templates and publishing kits.

The app opens on a redesigned dashboard. Press **Ctrl+K** for quick navigation and actions. The editor panes are resizable with the pointer or keyboard.

## Structure and documentation

- `src/main/`: Electron IPC, SQLite, Bilibili API, danmaku fetching, streaming and slicing, AI, local bridge.
- `src/preload/`: typed, isolated renderer API.
- `src/renderer/src/`: Vue pages, Pinia stores, layout composables, theme styles.
- `src/shared/`: shared types, pure subtitle/danmaku parsers, validation and utilities.
- `tests/`: regression tests and fixtures; `scripts/`: development helpers.
- `userscript/`: optional browser integration.

See [Feature inventory](docs/FEATURES.md), [Danmaku reference guide](docs/DANMAKU_GUIDE.md), [Architecture](docs/ARCHITECTURE.md), [Development & testing](docs/DEVELOPMENT.md), [Release guide](docs/RELEASE.md), [Refactor report](docs/REFACTOR_REPORT.md), [Quality-optimization merge record](docs/OPTIMIZATION_REVIEW.md), and [Security](SECURITY.md).

## Privacy and limitations

Project data is stored locally in SQLite under Electron `userData`. Bilibili cookies, optional bridge tokens and AI keys are encrypted with Electron `safeStorage` (Windows DPAPI / macOS Keychain / Linux keyring) when available and migrated automatically the next time settings are saved; without OS encryption they fall back to plaintext. Encrypted values are bound to the current OS user, so re-enter them after moving to another machine or account. Back up your data before upgrading, and avoid sharing your settings file. The browser bridge validates origins and supports a pairing token.

Release 3.17.0 was verified on this machine with type checking, the full test suite (7 suites), a production build, a real danmaku-endpoint sample and a GUI smoke test of the source build. Code signing, the NSIS installer flow, real Bilibili login, FFmpeg download and the complete clip-export flow remain unverified; the packaged-app GUI and `safeStorage` checks from 3.16.1 are recorded in the [quality-optimization merge record](docs/OPTIMIZATION_REVIEW.md). Danmaku are fetched from Bilibili on demand and are never written to the database or used in clip selection.

MIT license — see [LICENSE](LICENSE). Third-party notices: [THIRD-PARTY.md](THIRD-PARTY.md).
