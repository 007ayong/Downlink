# Downlink

GitHub repository: [Downlink](https://github.com/007ayong/Downlink)

Downlink is a browser extension that intercepts browser downloads and forwards them to the external downloader you choose.

It supports multiple downloader backends and is designed to stay flexible. You can switch downloaders in settings and keep using a single extension for download takeover, media capture, and basic task status viewing.

## Screenshots

![Downlink Screenshot 1](https://cdn.winapps.cc/images/downlink-screenshot1.jpg)

![Downlink Screenshot 2](https://cdn.winapps.cc/images/downlink-screenshot2.jpg)

## Currently Supported

- [Aria2](https://github.com/aria2/aria2)
- [Motrix](https://github.com/agalwood/motrix)
- [MotrixNext](https://github.com/AnInsomniacy/motrix-next)
- [AB DM](https://github.com/amir1376/ab-download-manager)
- [Neat Download Manager](https://www.neatdownloadmanager.com/index.php/en/)

## Main Features

- Intercept browser downloads and send them to the currently configured downloader
- Capture common file downloads by extension
- Capture audio and video resources based on response type
- View task lists and pending confirmations in the popup
- Preview captured media and send it to the downloader
- Forward important request headers for downloads that rely on cookies, referer, or authentication headers
- Show error notifications and provide basic connection tests

## Installation

Open the extensions page in a Chromium-based browser, enable Developer mode, then choose Load unpacked and select this project directory.

## Store Links

- Chrome Web Store: [Downlink](https://chromewebstore.google.com/detail/eepjgbffnmmhpinlmlncdfnhjccpigcg)
- Microsoft Edge: [Downlink](https://microsoftedge.microsoft.com/addons/detail/klkhmcdcnnhggpiipgedlafhpobojpgl)

## Automated Publishing

The repository is currently split into 3 separate workflows:

- `GitHub Release`: automatically builds a zip package and uploads it to GitHub Releases when a `v*` tag is pushed
- `Publish to Edge Add-ons`: automatically submits the package to Edge when a `v*` tag is pushed
- `Publish to Chrome Web Store`: manually triggered with a specific tag or commit

Before publishing, configure these GitHub Secrets:

- `CHROME_PUBLISHER_ID`
- `CHROME_EXTENSION_ID`
- `CHROME_SERVICE_ACCOUNT_JSON`
- `EDGE_PRODUCT_ID`
- `EDGE_CLIENT_ID`
- `EDGE_API_KEY`

The tag version must match the `version` field in `manifest.json`. For example, `v1.1.0` should correspond to `1.1.0` in `manifest.json`.

## Basic Usage

1. Click the extension icon to open Downlink.
2. Choose your target downloader in Settings.
3. Fill in the connection details for the selected downloader.
4. Enable automatic download interception to forward browser downloads according to the configured rules.
5. If you want to send manually, use the task panel, media panel, or context menu actions.

## Downloader Configuration

### Aria2 RPC

Required fields:

- RPC URL
- RPC secret, optional
- Default save directory, optional

This works for local or remote `aria2c` or Motrix setups with RPC enabled.
If you also have MotrixNext installed, you can enable "Manage with MotrixNext" and open it quickly from the task panel.

### MotrixNext

Required fields:

- Port
- Secret, optional

Downlink sends directly to the local MotrixNext HTTP receiver with `POST /add`, using a request body like `{ "url": "...", "referer": "...", "cookie": "..." }`. `referer` and `cookie` are included when the browser captured those request headers. MotrixNext mode does not use extension-side confirmation, pause/resume, or progress controls.

### AB DM

Required fields:

- Service host
- Port

In most cases, you should verify that the port configured in the extension matches the actual port used by the application.
Normal tasks use `/add` by default. Enable silent normal downloads in settings to use `/start-headless-download` for normal tasks. Media resources always use `/start-headless-download` so video filenames stay correct.

### NeatDM

The extension currently connects through the default WebSocket endpoint:

- `ws://127.0.0.1:10007/download`

This is intended for local setups where the NeatDM receiver is already running. Neat Download Manager does not expose a configurable port here.

## Media Capture

Downlink listens for audio and video requests from webpages and lists sendable resources in the media panel. For resources that depend on request headers, cookies, or anti-leech checks, the extension attempts to preserve and replay useful headers to improve both download reliability and preview support.

## Permissions

The extension currently uses these permissions:

- `downloads`
- `storage`
- `notifications`
- `tabs`
- `webRequest`
- `contextMenus`
- `declarativeNetRequest`
- `<all_urls>` host permission

These permissions are used for download interception, request inspection, media capture, status display, and context menu actions.

## Project Structure

- `manifest.json`: extension manifest
- `background.js`: background logic, download forwarding, request capture
- `popup.html` / `popup.js`: popup UI
- `preview.html` / `preview.js`: media preview page
- `icons/`: extension icons

## License

This project is licensed under [GNU General Public License v3.0 only](./LICENSE).
