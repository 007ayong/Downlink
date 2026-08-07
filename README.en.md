<p align="center">
  <img src="./icons/icon300.png" width="96" alt="Downlink Logo"/>
</p>

<h1 align="center">Downlink</h1>

<p align="center">
  <a href="./README.md">简体中文</a> · English
</p>

<p align="center">
  <a href="https://github.com/007ayong/Downlink/stargazers">
    <img src="https://img.shields.io/github/stars/007ayong/Downlink?style=for-the-badge&logo=github&label=Stars" alt="GitHub Stars"/>
  </a>
  <a href="https://github.com/007ayong/Downlink/releases">
    <img src="https://img.shields.io/github/v/release/007ayong/Downlink?style=for-the-badge&label=Release" alt="GitHub Release"/>
  </a>
  <a href="./LICENSE">
    <img src="https://img.shields.io/badge/License-GPL--3.0--only-blue?style=for-the-badge" alt="License"/>
  </a>
</p>


Downlink is a browser extension for working with multi-threaded downloaders. It takes over downloads after the browser confirms the download response and forwards them to the external downloader you choose.

It supports multiple downloaders and lets you switch between them in settings, so a single extension covers download takeover, web media capture, task status viewing, media preview, and right-click quick sending. It works with Chromium-based browsers (Chrome / Edge), Firefox, and Safari.


## Screenshots

![Downlink Screenshot 1](https://cdn.winapps.cc/images/downlink-screenshot1.jpg)

![Downlink Screenshot 2](https://cdn.winapps.cc/images/downlink-screenshot2.jpg)

## Currently Supported

- [Aria2](https://github.com/aria2/aria2)
- [Motrix](https://github.com/agalwood/motrix)
- [MotrixNext](https://github.com/AnInsomniacy/motrix-next)
- [Gopeed](https://github.com/GopeedLab/gopeed)
- [AB DM](https://github.com/amir1376/ab-download-manager)
- [Neat Download Manager](https://www.neatdownloadmanager.com/index.php/en/)

## Main Features

- **Download takeover**: take over tasks after the browser confirms the download response and forward them to the currently configured downloader; manual sending via the popup or right-click menu is also supported
- **Multiple downloaders**: built-in adapters for Aria2, Motrix, MotrixNext, Gopeed, AB DM, and NeatDM, switchable in settings with one click
- **Smart detection**: identify common file downloads by extension and response type; optionally keep files below a size threshold in the browser to reduce downloader task noise
- **Media capture**: listen for audio and video requests on webpages, then preview and send the resources from the media panel
- **Header passthrough**: forward critical request headers such as Cookie, Referer, and authorization headers for downloads that rely on login state or anti-leech checks
- **Task management**: view task lists and pending confirmations in the popup; Aria2 has a dedicated task page with progress, pause/resume, and speed limiting
- **Error notifications and connection tests**: notify on send failures and provide basic connection detection
- **Keyboard shortcut**: `Ctrl+Shift+D` by default (`MacCtrl+Shift+D` on macOS) to toggle automatic capture

## Installation

### Store Installation

[![Chrome Web Store:](./assets/chrome-support.png)](https://chromewebstore.google.com/detail/eepjgbffnmmhpinlmlncdfnhjccpigcg)
[![Edge Web Store:](./assets/edge-support.png)](https://microsoftedge.microsoft.com/addons/detail/klkhmcdcnnhggpiipgedlafhpobojpgl)
[![Firefox Add-ons:](./assets/firefox-support.png)](https://addons.mozilla.org/en-US/firefox/addon/downlink/)

Published versions:

| Store | Version |
| --- | --- |
| [Chrome Web Store](https://chromewebstore.google.com/detail/eepjgbffnmmhpinlmlncdfnhjccpigcg) | ![Chrome Version](https://img.shields.io/chrome-web-store/v/eepjgbffnmmhpinlmlncdfnhjccpigcg?style=for-the-badge&logo=googlechrome&logoColor=white&label=Chrome) |
| [Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/klkhmcdcnnhggpiipgedlafhpobojpgl) | ![Edge Version](https://img.shields.io/badge/dynamic/json?label=Edge&prefix=v&query=%24.version&url=https%3A%2F%2Fmicrosoftedge.microsoft.com%2Faddons%2Fgetproductdetailsbycrxid%2Fklkhmcdcnnhggpiipgedlafhpobojpgl&style=for-the-badge) |
| [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/downlink/) | ![Firefox Version](https://img.shields.io/amo/v/downlink?style=for-the-badge&logo=firefoxbrowser&logoColor=white&label=Firefox) |

### Local Loading (Development Mode)

Chromium-based browsers (Chrome / Edge):

1. Open the extensions page (`chrome://extensions` or `edge://extensions`)
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `dist/chromium` directory (or the repository root)

Firefox:

1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `dist/firefox/manifest.json`

## Building

Building requires Node.js 20+ and the `zip` command-line tool. The project has no third-party npm dependencies, so `npm install` is not required.

### Packaging

```bash
npm run package:chromium   # Output: dist/downlink-vX.Y.Z-chromium.zip
npm run package:firefox    # Output: dist/downlink-vX.Y.Z-firefox.zip
npm run package:all        # Build both Chromium and Firefox
```

For development, use watch mode to rebuild automatically on changes without producing zips:

```bash
npm run dev                # Watch both Chromium and Firefox
npm run dev:chromium       # Chromium only, outputs to dist/chromium
npm run dev:firefox        # Firefox only, outputs to dist/firefox
```

### Firefox Add-on ID

Firefox packaging uses the self-hosted ID `downlink@winapps.cc` by default. To package a listed AMO build, specify a different ID to avoid conflicts:

```bash
FIREFOX_ADDON_ID="downlink-amo@winapps.cc" npm run package:firefox
```

The Firefox build automatically adds the `webRequestBlocking` permission and narrows host permissions to http/https and local loopback addresses (see "Permissions" below).

### Safari / macOS Build

Build the Safari Web Extension host app locally:

```bash
npm run safari:build
```

This command first runs `safari:check` to verify shared resources and version consistency, then builds the Release version with Xcode. A valid Apple signing configuration is required; to only verify that the project compiles, disable code signing:

```bash
CODE_SIGNING_ALLOWED=NO npm run safari:build
```

The Safari project lives in `safari/Downlink/Downlink.xcodeproj`; build artifacts go to `dist/safari/DerivedData`.

## Scripts

### npm Scripts

| Command | Description |
| --- | --- |
| `npm test` | Run tests (`node --test`) |
| `npm run dev` | Watch-build Chromium and Firefox (no zips) |
| `npm run dev:chromium` | Watch-build Chromium only, outputs to `dist/chromium` |
| `npm run dev:firefox` | Watch-build Firefox only, outputs to `dist/firefox` |
| `npm run package:release` / `package:all` | Package both Chromium and Firefox zips |
| `npm run package:chromium` | Package the Chromium zip |
| `npm run package:firefox` | Package the Firefox zip |
| `npm run safari:sync` | Sync shared extension resources into the Safari project and synchronize versions across all targets |
| `npm run safari:check` | Read-only preflight: check Safari resources and version drift |
| `npm run safari:build` | Run Xcode Release build after preflight passes |

### Sync Scripts

- `npm run safari:sync` copies shared resources (scripts, pages, icons, locale files, etc.) from the repository root into `safari/Downlink/Downlink Extension/Resources`, synchronizes versions across `manifest.json`, `package.json`, the Safari manifest, and the Xcode project, and ensures Safari JavaScript files carry a UTF-8 BOM. Safari-only files are never overwritten.
- `npm run safari:check` verifies the above read-only, for CI or pre-release use; if drift is found it tells you to run `npm run safari:sync` to repair it.
- `node scripts/sync-versions.mjs --check` checks that all version numbers match the root `manifest.json`.
- `node scripts/generate-firefox-update-manifest.mjs <xpi-path> <output-path>` generates the `updates.json` update manifest (with SHA-256 hash) for Firefox self-hosting; used by the GitHub Release workflow.

## Automated Publishing

The repository is split into 4 independent workflows:

| Workflow | Trigger | Description |
| --- | --- | --- |
| GitHub Release | Push a `v*` tag | Runs tests, packages and uploads the Chromium zip to a Release, then signs the Firefox self-hosted XPI and uploads it too |
| Publish to Chrome Web Store | Manual (tag or commit) | Packages the given ref and submits it to the Chrome Web Store |
| Publish to Edge Add-ons | Manual (tag) | Packages the given tag and submits it to Edge Add-ons |
| Publish to Firefox Add-ons | Manual (tag or commit, optional approval notes) | Packages the given ref and submits it to AMO as a listed version |

`GitHub Release` also uploads Firefox self-hosted update assets:

- `downlink-vX.Y.Z-firefox.xpi`
- `downlink-firefox-updates.json`

Before publishing, configure these GitHub Secrets:

- `CHROME_PUBLISHER_ID`
- `CHROME_EXTENSION_ID`
- `CHROME_SERVICE_ACCOUNT_JSON`
- `EDGE_PRODUCT_ID`
- `EDGE_CLIENT_ID`
- `EDGE_API_KEY`
- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

The `FIREFOX_LISTED_ADDON_ID` GitHub Variable can override the add-on ID used for the Firefox store build; it defaults to `downlink-amo@winapps.cc`.

The tag version must match the `version` field in `manifest.json`. For example, tag `v1.3.10` corresponds to `1.3.10` in `manifest.json`.

## Basic Usage

1. Click the extension icon to open Downlink
2. Choose your target downloader in Settings
3. Fill in the connection details for the selected downloader
4. Enable automatic download interception; confirmed download responses will be forwarded according to the configured rules
5. For manual sending, use the task panel, media panel, or right-click menu

## Downloader Configuration

### Aria2 RPC

Required fields:

- RPC URL
- RPC secret, optional

This works for local or remote `aria2c` or Motrix setups with RPC enabled.
If you also have MotrixNext installed, you can enable "Manage with MotrixNext" and open it quickly from the task panel.

### MotrixNext

Required fields:

- Port
- Secret, optional. Leaving it empty means MotrixNext `extensionApiSecret` is not configured; in that state the HTTP API disables authentication and connection checks still succeed.

Downlink sends directly to the local MotrixNext HTTP receiver with `POST /add`, using a request body like `{ "url": "...", "filename": "...", "referer": "...", "cookie": "..." }`. `filename` is included when the browser captures it or the media panel detects it, and `referer` and `cookie` are included when the browser captured those request headers. MotrixNext mode does not use extension-side confirmation, pause/resume, or progress controls.

### Gopeed

Required fields:

- API URL, default `http://127.0.0.1:9999`
- Token, optional

Downlink sends tasks through the Gopeed HTTP API with `POST /api/v1/tasks`. Intercepted normal downloads enter the confirmation panel by default; enable "Silent normal downloads" in settings to start them automatically. `opts.extra.connections = 1` is sent only when "Single thread, no splitting" is checked in the confirmation panel; otherwise connection options are omitted. The extension does not pass a save path to Gopeed, so the downloader controls the download location.

### AB DM

Required fields:

- Service host
- Port

In most cases, you should verify that the port configured in the extension matches the actual port used by the application.
Normal tasks use `/add` by default; enable the silent normal download option in settings to start them automatically. Media resources always use `/start-headless-download` so video filenames stay correct. Both browser interception and the right-click menu send directly to AB DM without the extension's confirmation panel.

### NeatDM

The extension currently connects through the default WebSocket endpoint:

- `ws://127.0.0.1:10007/download`

This is intended for local setups where the NeatDM receiver is already running. Neat Download Manager does not expose a configurable port here.
Both browser interception and the right-click menu send directly to NeatDM without the extension's confirmation panel.

## Media Capture

Downlink listens for audio and video requests on webpages and lists sendable resources in the media panel. For resources that depend on request headers, cookies, or anti-leech checks, the extension attempts to fill in the required headers to improve download reliability and preview support.

## Permissions

The Chromium build (Chrome / Edge) uses the following permissions from the root `manifest.json`:

- `downloads`: take over confirmed downloads and handle filenames and download events
- `storage`: persist extension settings (sync/local storage)
- `notifications`: show alerts on download or connection failures
- `tabs`: get the source tab, open downloader management pages, and track task status
- `webRequest`: identify download responses and capture critical request headers such as Cookie, Referer, and authorization headers
- `contextMenus`: the "Download with current downloader" right-click menu
- `declarativeNetRequest`: temporarily add headers for media preview and metadata probing requests (session-level rules, not persisted)
- Host permission `<all_urls>`: match requests on any site for download detection and media capture

The Firefox build is adjusted automatically by the packaging script:

- Adds `webRequestBlocking`, required to block and cancel requests in Firefox
- Narrows host permissions to `http://*/*`, `https://*/*`, `*://127.0.0.1/*`, `*://localhost/*`, and the corresponding `ws://` addresses

The Safari project uses its own manifest at `safari/Downlink/Downlink Extension/Resources/manifest.json`; its permission set differs slightly from the Chromium build (it includes Safari-specific permissions such as `nativeMessaging`, `scripting`, `cookies`, and `webNavigation`) and takes precedence for Safari.

## Project Structure

- `manifest.json`: extension manifest (shared by Chromium/Firefox, adjusted per target at packaging time)
- `background.js`: background logic, download forwarding, request capture
- `content-script.js`: page-injected script
- `popup.html` / `popup.js` / `popup-app.js`: extension popup UI
- `preview.html` / `preview.js`: media preview page
- `aria2-tasks.html` / `aria2-tasks.js`: Aria2 task management page
- `lib/`: shared modules for config defaults, downloader adapters, media capture, i18n, etc.
- `scripts/`: packaging, sync, version checking, and publishing scripts
- `safari/`: Safari Web Extension host project
- `icons/`: extension icons

## License

This project is licensed under [GNU General Public License v3.0 only](./LICENSE).
