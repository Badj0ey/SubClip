# SubClip Studio

[![CI](https://github.com/Badj0ey/SubClip/actions/workflows/ci.yml/badge.svg)](https://github.com/Badj0ey/SubClip/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-4e5cd3.svg)](LICENSE)

**Find the moment in a subtitle. Turn it into a clip.**

SubClip is a local-first Electron + Vue 3 + TypeScript + SQLite desktop workspace for Bilibili subtitle acquisition, transcript editing, danmaku-assisted navigation, cross-video search, clip organization, FFmpeg exports, and publishing materials. Core editing and search do not require a cloud AI account.

This source tree started from the original **3.16.0** codebase and is currently **3.18.2**. It preserves the existing database schema/migrations and core workflows, and updates the desktop/userscript bridge to protocol v5. It is **source code**; installers, portable archives and SHA-256 checksums are published on [GitHub Releases](https://github.com/Badj0ey/SubClip/releases).

## Get started

Source development requires **Node.js 22+** and npm; FFmpeg is optional in dev mode (the settings panel can point to a local build, otherwise `PATH` is used). The Windows installer already bundles FFmpeg, so end users do not need to install Node.js, npm, or FFmpeg.

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
- `userscript/`: optional browser integration. On a Bilibili video page, use the single **Sync video and subtitles (all parts)** action; the desktop app retries missing subtitle tracks through the connected browser.

See [Changelog](CHANGELOG.md), [Security](SECURITY.md), and [Contributing](CONTRIBUTING.md). The upstream cleanup removed the old `docs/` folder; this source archive does not contain those obsolete links.

## Privacy and limitations

Project data is stored locally in SQLite under Electron `userData`. Bilibili cookies, optional bridge tokens and AI keys are encrypted with Electron `safeStorage` (Windows DPAPI / macOS Keychain / Linux keyring) when available and migrated automatically the next time settings are saved; without OS encryption they fall back to plaintext. Encrypted values are bound to the current OS user, so re-enter them after moving to another machine or account. Back up your data before upgrading, and avoid sharing your settings file. The browser bridge validates origins and supports a pairing token.

Release 3.18.2 is a source-logic fix for browser subtitle acquisition and bridge behavior; it has **not** been runtime-verified with a real Bilibili account or Windows Explorer. The previous 3.18.1 release passed type checking, its test suite, production build, and Windows packaging; those results must not be taken as verification of 3.18.2. Code signing and complete clip export remain unverified. Danmaku are fetched on demand and are never stored in the database.

MIT license — see [LICENSE](LICENSE). Third-party notices: [THIRD-PARTY.md](THIRD-PARTY.md).
