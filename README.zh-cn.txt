# Downlink

GitHub Repository: [Downlink](https://github.com/007ayong/Downlink)

Downlink is a browser extension that takes over download tasks after the browser confirms a download response and sends them to your chosen external downloader.

The extension supports integration with multiple downloaders and offers high flexibility, allowing you to switch the destination in the settings based on the downloader you use. With just one browser plugin, you can achieve download interception, web media capture, and basic status monitoring.

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

- Intercepts tasks after the browser confirms a download response and forwards them to the currently configured downloader.
- Supports identifying common file downloads by extension and response type.
- Option to let small files (below a size threshold) remain as browser downloads to reduce downloader task noise.
- Supports capturing audio, video, and other media resources based on response type.
- Supports viewing the task list and pending confirmation tasks in a popup.
- Supports previewing captured media resources before sending them to the downloader.
- Supports passing through key request headers to improve download scenarios requiring Cookies, Referer, or authentication headers.
- Supports error notifications and basic connection testing.

## Installation

Open the extension management page of your Chromium-based browser, enable "Developer mode", select "Load unpacked", and specify the current project directory.

## Store Links

[![Chrome Web Store:](./assets/chrome-support.png)](https://chromewebstore.google.com/detail/eepjgbffnmmhpinlmlncdfnhjccpigcg)
[![Edge Web Store:](./assets/edge-support.png)](https://microsoftedge.microsoft.com/addons/detail/klkhmcdcnnhggpiipgedlafhpobojpgl)
[![Firefox Add-ons:](./assets/firefox-support.png)](https://addons.mozilla.org/zh-CN/firefox/addon/downlink/)

## Automated Release

The repository is now split into 4 independent workflows:

- `GitHub Release`: Automatically generates a compressed package and uploads it to Releases when a tag in `v*` format is pushed.
- `Publish to Edge Add-ons`: Automatically submits to Edge when a tag in `v*` format is pushed.
- `Publish to Chrome Web Store`: Manually triggered, using your specified tag or commit.
- `Publish to Firefox Add-ons`: Manually triggered, using your specified tag or commit, and submits the public AMO version.

`GitHub Release` additionally uploads Firefox self-hosted update files:

- `downlink-vX.Y.Z-firefox.xpi`
- `downlink-firefox-updates.json`

The Firefox self-hosted version uses the addon ID `downlink@winapps.cc` by default. To manually package the AMO public store version and avoid ID conflicts with self-hosted submissions, you need to specify another ID:

```bash
FIREFOX_ADDON_ID="downlink-amo@winapps.cc" node scripts/package-extension.mjs firefox
```

The `Publish to Firefox Add-ons` workflow uses `downlink-amo@winapps.cc` by default, which can be overridden via the `FIREFOX_LISTED_ADDON_ID` in GitHub Variables.

Before releasing, the following must be configured in GitHub Secrets:

- `CHROME_PUBLISHER_ID`
- `CHROME_EXTENSION_ID`
- `CHROME_SERVICE_ACCOUNT_JSON`
- `EDGE_PRODUCT_ID`
- `EDGE_CLIENT_ID`
- `EDGE_API_KEY`
- `AMO_JWT_ISSUER`
- `AMO_JWT_SECRET`

The tag version must be consistent with the `version` in `manifest.json` (e.g., `v1.0.3` corresponds to `1.0.3` in `manifest.json`).

## Basic Usage

1. Click the extension icon to open Downlink.
2. Select the target downloader in "Settings".
3. Fill in the connection information for the selected downloader.
4. After enabling "Auto-intercept downloads", download responses confirmed by the browser will be automatically forwarded according to the rules.
5. For manual sending, use the task area, media area in the popup, or the right-click menu.

## Downloader Configuration Details

### Aria2 RPC

Required:

- RPC Address
- RPC Secret (can be left empty)

Suitable for scenarios where `aria2c` or Motrix is running locally or remotely with RPC enabled.
If you also have MotrixNext installed, check "Use MotrixNext for management" to quickly open and view tasks in the task panel.

### MotrixNext

Required:

- Port number
- Secret (can be left empty). Leaving it empty indicates that `extensionApiSecret` in MotrixNext is not configured; in this case, the HTTP API will not use authentication, but connection detection will still succeed.

Downlink sends a `POST /add` request directly to the local MotrixNext HTTP receiver service with the body format `{ "url": "...", "filename": "...", "referer": "...", "cookie": "..." }`. The `filename` is attached when the browser captures it or when the media panel identifies a filename. `referer` and `cookie` are attached when the browser captures relevant request headers. MotrixNext mode does not use secondary confirmation, pause/resume, or progress control on the extension side.

### Gopeed

Required:

- API Address (default `http://127.0.0.1:9999`)
- Token (can be left empty)

Downlink sends a `POST /api/v1/tasks` via the Gopeed HTTP API. Ordinary downloads intercepted by the browser will first enter the confirmation panel; `opts.extra.connections = 1` is passed only when "Single-threaded without fragmentation" is checked in the confirmation panel, otherwise no connection count parameter is passed. The extension does not specify a save path to Gopeed; the download location is controlled by Gopeed.

### AB DM

Required:

- Service Address
- Port number

Generally, you need to verify that the port number in the software itself matches the one in this extension.
Ordinary tasks are added via `/add` by default; if you want ordinary tasks to start downloading silently, enable the corresponding option in settings. Media resources will fixedly use `/start-headless-download` to ensure the video filename is correct.

### NeatDM

Currently connects via the default WebSocket address:

- `ws://127.0.0.1:10007/download`

Suitable for scenarios where the NeatDM receiver service is already running locally. Neat DM does not allow port configuration.

## Media Capture

Downlink monitors audio and video requests in the page and displays capturable resources in the media panel. For resources that rely on request headers, Cookies, or anti-leech verification, the extension attempts to complete the request headers to improve downloadability and previewability.

## Permissions

The extension currently uses the following permissions:

- `downloads`
- `storage`
- `notifications`
- `tabs`
- `webRequest`
- `contextMenus`
- `declarativeNetRequest`
- `<all_urls>` host permissions

These permissions are primarily used for download interception, request identification, media capture, status display, and right-click menu operations.

## Project Structure

- `manifest.json`: Extension manifest
- `background.js`: Background logic, download forwarding, request capture
- `popup.html` / `popup.js`: Extension popup UI
- `preview.html` / `preview.js`: Media preview page
- `icons/`: Extension icons

## License

This project is licensed under the [GNU General Public License v3.0 only](./LICENSE).
