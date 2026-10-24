# SRT Clip Helper

English | [简体中文](README.md)

A desktop tool for **Bilibili subtitle retrieval and video clipping**. It covers the whole workflow:
**fetch subtitles → search them → pick segments → auto-generate time ranges → batch-clip locally → get video files** —
no browser extension required for the clipping step.

Requirements traceability: [`docs/requirements.md`](docs/requirements.md) (converted from the original `.docx`, in Chinese).

## Screenshots

**Workspace** — resource tree on the left, subtitle reader in the middle, selection & clip tasks on the right.
Ticking cues instantly computes the resulting time range.

![Workspace](docs/images/workspace.png)

**Library-wide search** — search the subtitles of *every* video and part at once; hits can be pushed into
the clip queue in bulk.

![Search](docs/images/search.png)

**Subtitle tools** — batch find & replace (regex supported), timeline shift/scale, export to SRT/VTT/TXT,
copy a timestamped Bilibili link.

![Tools](docs/images/tools.png)

## What it does

- **Get subtitles**
  - Pull from Bilibili: video / season / series / favourites / uploader space / `b23.tv` short links, or a bare BV id.
    Uses WBI signing; reuses your logged-in session via the bundled Tampermonkey userscript (no manual cookie copying).
  - Import local SRT files (auto-detects UTF-8 / UTF-8-BOM / UTF-16 / GBK; tolerant parsing with warnings).
- **Read & search**
  - Four-column reader (index / start / end / text) with virtual scrolling — thousands of cues stay smooth.
  - Per-document search with highlighting and next/prev navigation.
  - **Library-wide search** across every video and part (SQLite FTS5), with jump-to-exact-cue.
  - Multi-part videos are read as one continuous list, with `P2 · title` separators.
- **Select & compute**
  - Checkboxes, Shift-click ranges, select-all / invert / clear.
  - Consecutive cues merge into one range; non-consecutive ones become separate ranges; a configurable gap
    threshold controls merging. Cross-part selections become a single clip assembled from per-part segments.
- **Edit**
  - Inline cue editing (double-click / `F2`).
  - Batch find & replace, regex supported.
  - Timeline shift and scale.
  - Undo (`Ctrl+Z`, last 20 operations).
  - Export SRT / WebVTT / plain text — optionally merging all parts of a video into one file.
- **Clip**
  - **Local slicing**: parses the DASH SIDX index and downloads only the needed byte range, then calls `ffmpeg`
    to cut and mux. Much faster than downloading whole segments.
  - Or export a CSV/XLSX table (column order matches `bilibili-slice-downloader`) and feed it to that extension.
- **Data**
  - SQLite storage (`node:sqlite`, zero native dependencies) with an FTS5 index for search.
  - Old JSON data is migrated automatically on first launch; the original file is renamed and kept, never deleted.

## Requirements

- **Node.js 20 or later** (developed on 22/24)
- **ffmpeg** only if you use local slicing (point the app at `ffmpeg.exe` in Settings; or use the CSV/XLSX export route)

## Install & run

```bash
git clone <repo-url>
cd <repo>
npm install
npm run dev        # development (hot reload)
npm run build      # build into out/
npm run typecheck  # renderer + main + tests
npm test           # core / WBI / slice / smoke / bridge suites
npm start          # run the built app
```

> **npm mirror**: the checked-in `.npmrc` pins China mirrors (registry + Electron binaries).
> **Outside mainland China, delete or comment out `.npmrc` before installing.**
>
> **Test environment**: `test:smoke` and `test:bridge` actually launch Electron and create a window,
> so they need a desktop session (they will fail over plain SSH). The other three suites are pure Node.

### Packaging a Windows build

```bash
npm run dist       # NSIS installer + portable zip, output in dist/
npm run dist:dir   # unpacked only (faster when validating the config)
```

> **Windows prerequisite**: electron-builder downloads the `winCodeSign` toolset, which contains macOS symlinks.
> Without **Developer Mode** (or an elevated shell) extraction fails with
> `Cannot create symbolic link ... libcrypto.dylib`. Either enable
> *Settings → System → For developers → Developer Mode*, or run from an elevated terminal.
> (GitHub Actions' Windows runners already have the privilege, so CI is unaffected.)
>
> Layout: `dist/win-unpacked/` is the portable build — run `SRT Clip Helper.exe` directly.
> The userscript is placed at `resources/userscript/` (outside the asar); that is the file
> the app points you to under *Settings → Browser userscript*.

## Browser userscript (optional)

The userscript is only needed to reuse your logged-in Bilibili session, or to push subtitles straight from a page.

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open the app's *Settings → Browser userscript*, click **Copy script**, then create a new script in
   Tampermonkey and paste it. Alternatively, drag `userscript/SubClip.user.js` into the browser.
3. Open any Bilibili video page; a **剪** button appears in the bottom-left corner. Expand it and click
   **Sync login state**. After that the desktop app can fetch subtitles on its own.

> **Local Network Access (Chrome / Edge 142+)**: browsers block web pages from reaching `127.0.0.1`.
> The first time you click **Allow and connect**, choose **Allow** in the browser prompt. If no prompt
> appears, click the **Permission needed** pill to retry; if you denied it earlier, open the site
> controls from the address bar → **Local network access** and allow it. Permission is per Bilibili
> subdomain, so `www` and `space` may each need one.

The local link is a WebSocket server the desktop app runs on `127.0.0.1:8765` (configurable).

### Local service security model

A WebSocket handshake is **not subject to CORS**, so binding to loopback does *not* keep local web pages out —
any page you visit could otherwise connect to `ws://127.0.0.1:8765`. The server therefore enforces:

| Guard | Purpose |
| --- | --- |
| **Origin allowlist** | Only Bilibili page origins (`https://*.bilibili.com`) may connect — a userscript's WebSocket Origin is the page origin. Anything else is told why and disconnected immediately |
| **Per-type message validation** | Every inbound message is validated (BV id shape, finite timestamps, length and count limits); anything invalid is dropped |
| **`maxPayload` + rate limit** | A single frame is capped at 512 KB (`ws` defaults to 100 MiB, enough to blow up the main process) and per-connection message rate is limited |

There is also an optional **pairing token** (Settings → Browser userscript). It is off by default because the
origin allowlist already stops web pages; the token guards against local processes forging an Origin.

The renderer is not blindly trusted either: the main process only reads/writes paths the user picked in a
native dialog, and the "open" action is restricted to the app's own directories with executable extensions refused.

## Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl + F` | Focus the current document's search box |
| `Ctrl + Shift + F` | Toggle library-wide search |
| `ArrowUp` / `ArrowDown` | Move the cursor |
| `Shift + ArrowUp/Down` | Extend the selection |
| `Enter` | Toggle the current cue |
| `F2` | Edit the current cue |
| `Ctrl + A` | Select all cues |
| `Escape` | Clear selection |
| `Ctrl + Enter` | Add the current range to clip tasks |
| `Ctrl + E` | Export the CSV clip table |
| `Ctrl + Z` | Undo the last subtitle edit |

All of them are rebindable in Settings, with conflict detection.

## Where data lives

| What | Path |
| --- | --- |
| Database | `%APPDATA%\srt-clip-helper\srt-tool-data\srt-tool.db` (SQLite, plus `-wal` / `-shm`) |
| Legacy data (kept after migration) | same folder, `srt-tool.json.migrated-<timestamp>` and `docs\<docId>.json` |
| Settings | `%APPDATA%\srt-clip-helper\settings.json` |

## Tech stack

- Electron 36 + Vue 3 + Vite (`electron-vite`)
- TypeScript with `strict` across main / preload / renderer / tests
- Storage: SQLite through the built-in `node:sqlite` (Electron 36 / Node 22) + FTS5
- Spreadsheet export: CSV (UTF-8 BOM) and XLSX

## Known limitations

- **Bilibili APIs** are undocumented and may change; `src/main/bilibili.ts` and the API/WBI code in
  `userscript/SubClip.user.js` would need updating. Only subtitles your account may access are fetched —
  paywalls, private videos and region locks are not circumvented.
- **Userscript DOM selectors** may break when Bilibili redesigns its pages.
- **Userscript lifecycle**: it only runs on Bilibili pages; refreshing or navigating the page reconnects
  automatically, while other sites do not connect to the desktop app.
- **Categories/tags**: the tree is the automatic `uploader → collection → video → subtitle` hierarchy;
  user-defined tags are not implemented yet.
- **Batch editing** supports find & replace and timeline shift/scale, but not cross-document replace or
  drag-to-adjust timelines.
- **Local slicing** needs ffmpeg; older videos that only expose `durl` cannot be sliced (the app says so clearly).
- **Slicing concurrency**: ffmpeg runs serially (concurrency only applies to downloads).

## License

[MIT](LICENSE). Third-party components and ported code are listed in [`THIRD-PARTY.md`](THIRD-PARTY.md).
