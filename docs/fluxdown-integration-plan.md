# FluxDown 适配器接入方案

> 状态：**方案待评审，尚未改动任何代码**
> 调研对象：[zerx-lab/FluxDown](https://github.com/zerx-lab/FluxDown) v0.5.2（2026-10-01 发布）
> 调研方式：读取上游仓库源码与官方文档（`native/api/`、`fluxDown/`、`native/agent/src/nmh.rs`、`website-v2/src/content/docs/`）

---

## 1. 结论摘要

1. FluxDown 是一个 Rust 引擎 + Flutter UI 的多协议下载器（HTTP/FTP/BitTorrent/eD2K/HLS/DASH），另有 headless 服务器形态，本地 HTTP 服务默认监听 `127.0.0.1:17800`。
2. **官方插件并不走 HTTP**——它走浏览器 Native Messaging（`com.fluxdown.nmh` 中继进程）。该通道的 `allowed_origins` 在上游被**硬编码为官方插件 ID**，Downlink 无法复用。
3. **但官方插件同时实现了第二条 HTTP 通道**（`remoteMode`：连接远程 `fluxdown_server`），用的正是 `POST /download`、`POST /download/batch`、`GET /ping` 这套**脚本接管接口**，请求体与 NMH 通道**完全同构**。
4. 因此用户设想的“第三方脚本接管接口”**不是野路子，而是官方一等公民契约**，且有官方插件自身作为参考实现。本方案据此推荐接管接口。
5. 代价：`/download` **不返回 taskId**，Downlink 侧只能做成“发送即完成”（与 AB DM / Rayburst / NeatDM 一致），无法像 aria2 / Gopeed 那样显示进度。

---

## 2. FluxDown 协议地图

单个 axum 服务器、单个端口，按配置分五组路由独立启停。

| 路由组 | 端点 | 桌面默认 | 鉴权 |
| --- | --- | --- | --- |
| 探活 | `GET /ping` | 开 | **无** |
| 脚本接管 | `POST /download`、`POST /download/batch` | **开** | 非空 `X-FluxDown-Client` 头；已配置 token 时还需 token |
| aria2 兼容 | `POST /jsonrpc`、`GET /jsonrpc`（WS） | **开** | 已配置 token 时逐调用校验（`X-FluxDown-Token` 或 `params[0]="token:xxx"`） |
| 管理 API | `/api/v1/*` | **关** | **强制** token |
| MCP | `POST /mcp` | **关** | **强制** token |

其他事实：

- 桌面默认只绑回环（`127.0.0.1`）；设置里开“局域网访问”后变 `0.0.0.0`，**下次启动生效**。headless 由 `FLUXDOWN_BIND` 决定，默认 `0.0.0.0:17800`。
- 桌面开启 LAN 或 CORS 时，agent 会**自动生成并持久化**一个访问密钥；headless 不自动补，未设密钥前 `/download*` 与 `/jsonrpc` 返回 `403 setup required: set the access key first`。
- 来源门禁：`/download*` 与 `/jsonrpc` 对**带 `Origin`** 的请求只放行 `chrome-extension://` / `moz-extension://` / `safari-web-extension://` 与同源请求，其余 403。扩展来源**在白名单内**；不带 `Origin` 的非浏览器客户端（curl、油猴）不受限。
- 回环监听时核心 API 额外校验 `Host` ∈ {`127.0.0.1`, `localhost`, `[::1]`}（防 DNS rebinding）；LAN/headless 模式不校验。
- `GET /ping` 返回 `{"success":true,"app":"FluxDown","version":"0.5.2","message":"pong"}`——`app` 字段可用来确认对面确实是 FluxDown 而非占用了 17800 的其他服务。

参考：`website-v2/src/content/docs/zh/api/overview.md`、`native/api/src/auth.rs`、`native/api/src/server.rs`。

---

## 3. 官方插件用的是什么接口（重点回答）

官方插件源码在 `fluxDown/`（WXT + TypeScript）。它有**两条投递通道**，由设置项 `remoteMode`（`off` / `always` / `fallback`）在 `utils/download-dispatch.ts` 里做路由：

### 3.1 通道一：Native Messaging（默认）

```
Browser Extension
  <-> browser.runtime.connectNative("com.fluxdown.nmh")    (stdin/stdout，4 字节 LE 长度前缀 + JSON)
fluxdown_nmh（中继二进制）
  <-> 命名管道 \\.\pipe\fluxdown-<账户名> / Unix socket     (同样的帧格式)
FluxDown App
```

- 请求/响应按自增 `msg_id` 配对，单请求超时 12s，端口持久复用。
- App 未运行时**由 NMH 中继自动拉起**（`NO_LAUNCH_ACTIONS` = ping/tasks/task_op/open/reveal 不触发拉起）。
- 需要 `nativeMessaging` 权限。

**Downlink 无法使用**：NMH 宿主的 `allowed_origins` / `allowed_extensions` 在上游被写死为官方插件：

```rust
// native/agent/src/nmh.rs:577,580,745,756
const CHROME_EXTENSION_ID: &str = "chrome-extension://meleenglfggcmcajknpeeeiobnpfmahc/";
const FIREFOX_EXTENSION_ID: &str = "fluxdown@fluxdown.app";
// Chromium 清单 allowed_origins = [CHROME_EXTENSION_ID, EDGE_EXTENSION_ID]
// Firefox  清单 allowed_extensions = [FIREFOX_EXTENSION_ID]
```

Downlink 的扩展 ID 不在名单里，`connectNative()` 会被浏览器直接拒绝。且上游没有任何“允许第三方插件接入”的入口。**这条路直接排除。**

### 3.2 通道二：远程 HTTP（本方案要用的）

`fluxDown/utils/remote-server.ts`——官方插件连接远程 `fluxdown_server` 用的客户端：

```ts
// 请求头
{ "Content-Type": "application/json",
  "X-FluxDown-Client": "extension",
  "X-FluxDown-Token": cfg.remoteToken }

// 端点
POST {remoteUrl}/download          body = DownloadRequest
POST {remoteUrl}/download/batch    body = { items: [...BatchDownloadItem] }
GET  {remoteUrl}/ping                                    // 无鉴权，探活 + 取 app/version
GET  {remoteUrl}/api/v1/info                             // 带 token，校验鉴权
```

`remote-server.ts` 的注释明确指出：payload **直接复用** `native-messaging.ts` 的 `DownloadRequest` / `BatchDownloadItem` 类型，**“服务端按同一套字段解析，本文件不重新定义、不做字段转换”**。

这就是接管接口本身。**官方插件自己就在用 `POST /download` + `X-FluxDown-Client`。**

### 3.3 三条候选路径横向对比

| | 接管接口 `/download` | aria2 兼容 `/jsonrpc` | 管理 API `/api/v1/tasks` |
| --- | --- | --- | --- |
| 官方插件是否在用 | ✅ 远程通道 | ✖（面向 aria2 客户端/油猴） | ✖ |
| 桌面默认开关 | 开 | 开 | **关**（需用户手动开） |
| 返回 taskId | ✖ 无 | ✅ gid，可 `tellStatus` | ✅ taskId |
| 原生确认框 | ✅ 有（可开免打扰静默） | ✖ 直接建任务 | ✖ 直接建任务 |
| Cookie / 自定义头 | ✅ 一等字段 | ✅ `header` 数组 | ✅ |
| `method` / `body`（表单 POST） | ✅ | ✖ | ✖ |
| 离散音视频轨合并 `audioUrl` | ✅ | ✖ | ✖ |
| Downlink 改造成本 | 中 | 低（复用 aria2 客户端） | 中高 |
| 与 Downlink 既有形态 | 发送即完成 | 可跟踪进度 | 可跟踪进度 |

**推荐：接管接口。** 理由：官方一等契约 + 官方插件参考实现 + 桌面默认开启 + 字段最全（cookie/headers/method/body/audioUrl），且与 Downlink 现有 AB DM / Rayburst / NeatDM 的“发送即完成”形态一致。

> 备选（不建议作为首版）：aria2 兼容 RPC 能白嫖 Downlink 现有的进度轮询与任务管理页，但会丢掉 `method`/`body`/`audioUrl`，且 `bt-tracker` 在上游被静默忽略，语义上更像“假装成 aria2”，后续两边能力一旦分叉会持续踩坑。

---

## 4. `/download` 契约详解

### 4.1 请求体：`DownloadRequest`（camelCase，全部可选除 `url`）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | ✅ | `http` / `https` / `ftp` 直链或 `magnet:` |
| `filename` | string | | 建议文件名，会预填给用户 |
| `saveDir` | string | | 目标目录；空 = 由 FluxDown 按分类/默认目录决定 |
| `referrer` | string | | 防盗链来源页 |
| `cookies` | string | | 原始 Cookie 头值 |
| `headers` | object | | 额外请求头，`string → string`（如 `Authorization`） |
| `fileSize` | number | | `>0` 已知大小跳过探测；`-1` 确认是下载资源但大小未知；`0`/缺省 正常探测 |
| `mimeType` | string | | |
| `method` | string | | 浏览器原始方法，缺省 `GET`。**表单 POST 触发的下载必须传**，否则 FluxDown 会用 GET 重发拿到错误内容 |
| `body` | object | | `{kind:"formData",fields:{k:[v]}}` 或 `{kind:"raw",bytesB64,contentType?}` |
| `audioUrl` | string | | 离散音视频轨对的音频轨 URL；非空 = 分别下载后 ffmpeg mux 合并 |

### 4.2 响应

```json
{ "success": true, "message": "download accepted" }
```

**没有 taskId。** 语义是“已受理进入外部下载流程”，不是“已建任务”。

### 4.3 批量

`POST /download/batch` 接受两种形态，最终**合并成一次确认**（URL 用 `\n` 连接）：

```json
{ "items": [ { /* DownloadRequest */ } ] }
{ "urls": ["u1","u2"], "saveDir": "", "referrer": "", "cookies": "", "headers": {} }
```

Downlink 当前没有批量投递入口，首版可不做。

### 4.4 鉴权与错误码

服务端顺序：**先校验 `X-FluxDown-Client` → 再校验 token → 再解析 body**（`native/api/src/server.rs::takeover_download`）。

| 状态 | 响应 message | 含义 |
| --- | --- | --- |
| 200 | `download accepted` | 受理成功 |
| 400 | `url is required` / `invalid download payload: ...` | 载荷非法（**已通过鉴权**） |
| 401 | `invalid or missing token` | token 错误 |
| 403 | `missing X-FluxDown-Client header` | 缺客户端标识头 |
| 403 | `setup required: set the access key first` | headless 未设访问密钥 |

> **可用的无副作用 token 探针**：`POST /download` 传 body `{}`。`url` 无 serde 默认值，必然解析失败 → 鉴权通过时返回 `400 invalid download payload`，token 错时返回 `401`，且因为 body 解析失败**永远不会走到 `submit_external`**，不会建任务、不弹确认框。适合做“连接测试”里的鉴权校验。

---

## 5. 与 Downlink 现状的差距分析

### 5.1 能得到什么

- `cookies` / `headers` / `referrer` / `filename` / `saveDir` / `fileSize` / `mimeType` 都是一等字段，`normalizeTaskInfo` 的产出可近乎一一对应映射。
- 新增 `method` / `body` 映射能力——Downlink 的 aria2 / Gopeed 路径目前都没有，这是**净增益**。
- `audioUrl` 可对接 Downlink 现有的“视频直链 + 音频直链智能合并”（目前仅 Rayburst 支持，走 `kind: "collection"`）。
- HLS/DASH：FluxDown 有专属引擎，直接投递清单 URL 即可，由 FluxDown 选择轨道。

### 5.2 需要接受的损失 / 风险

| # | 问题 | 影响 | 处置 |
| --- | --- | --- | --- |
| R1 | **不返回 taskId** | 无法跟踪进度，任务列表无记录 | 按“发送即完成”实现：`trackable: false`、`status: 'sent'`，与 AB DM / Rayburst / NeatDM 一致。可选 Phase 2：用 `aria2.tellActive/tellWaiting/tellStopped`（或管理 API）按 URL 反查关联——**不推荐首版做**，脆且易误配 |
| R2 | **双重确认框** | Downlink 确认面板 + FluxDown 桌面确认框 = 两次点击 | 文档提示用户可在 FluxDown 侧开“免打扰下载”，只留 Downlink 一次确认 |
| R3 | **无法冷启动 FluxDown** | HTTP 通道没有拉起能力（只有 NMH 通道有）。App 没开就发送失败 | 明确的失败文案（“FluxDown 未运行”）+ 连接测试区分“没开”与“密钥错”。可选降级：`fluxdown://download?url=..&filename=..` 能唤起 App，但**不带 cookie/headers**，只适合无鉴权直链 |
| R4 | 管理 API 桌面默认关 | `GET /api/v1/info` 在桌面返回 404，**无法在桌面校验 token** | 连接测试：`/ping` 验身份 + `POST /download` 空体验 token（见 4.4），把 404 当“管理 API 未开，跳过”而非失败（对齐官方 `remoteVerify` 的处理） |
| R5 | 上游版本年轻（v0.5.x，迭代快） | 字段/默认开关可能变 | 只依赖 `/ping` 与 `/download` 两个最稳定的契约面；`app`/`version` 字段做产品识别；对未知响应走“坏响应”分支 |
| R6 | 图标许可 | FluxDown 为 AGPL-3.0，其 logo 直接搬运到 GPL-3.0 的 Downlink 需留意 | 优先考虑**自绘中性图标**，或按 AGPL 要求做署名并在 `assets/provider-icons/README.md` 记录来源。**待决策** |

### 5.3 不需要改的

- `manifest.json`：`host_permissions: ["<all_urls>"]` 已覆盖 `http://127.0.0.1:17800`；**不需要** `nativeMessaging`（且加了也没用，见 3.1）。
- 扩展上下文的 CORS：MV3 扩展在 `host_permissions` 覆盖范围内发起的 `fetch` 不受 CORS 预检限制；即便发送 `Origin`，扩展 scheme 也在 FluxDown 白名单内。与官方插件处境完全相同。
- `chrome.storage` 配额、同步逻辑：新增三个标量字段无影响。

---

## 6. 实施计划

### Phase 0 — 契约验证（先做，不写产品代码）

用 curl 跑通，确认实际行为与源码一致：

```bash
BASE=http://127.0.0.1:17800

# 1) 身份与版本
curl -s $BASE/ping
# 期望 {"success":true,"app":"FluxDown","version":"0.5.2","message":"pong"}

# 2) 接管接口建单（无 token 的桌面场景要带客户端头）
curl -si -X POST $BASE/download \
  -H 'Content-Type: application/json' \
  -H 'X-FluxDown-Client: downlink' \
  -d '{"url":"https://example.com/file.zip","filename":"file.zip","referrer":"https://example.com/"}'
# 期望 200 {"success":true,"message":"download accepted"}，且桌面弹出确认框

# 3) token 探针（无副作用）
curl -si -X POST $BASE/download -H 'Content-Type: application/json' \
  -H 'X-FluxDown-Client: downlink' -H 'X-FluxDown-Token: WRONG' -d '{}'
# token 正确 -> 400 invalid download payload ; token 错误 -> 401 invalid or missing token

# 4) 缺客户端头
curl -si -X POST $BASE/download -H 'Content-Type: application/json' -d '{}'
# 期望 403 missing X-FluxDown-Client header
```

需要确认的点：hls 清单（`.m3u8` / `.mpd`）投递 `/download` 后 FluxDown 是否按流媒体处理；`saveDir` 在无确认框（免打扰）时是否生效；`audioUrl` 的实际行为。

### Phase 1 — 纯适配层（`lib/background-downloaders.js`）

1. `DOWNLOADERS` 增补：`fluxdown: { label: () => 'FluxDown' }`。
2. 端点构造（与 `buildGopeedEndpoint` 同风格，接受用户可配 base）：
   - `buildFluxdownEndpoint(cfg, '/download' | '/download/batch' | '/ping')`
   - 规范化：去尾斜杠；base 不含路径时补 `/download`；默认 `http://127.0.0.1:17800`。
3. `buildFluxdownRequest(taskInfo)` → `DownloadRequest`：

   | Downlink 字段 | → FluxDown | 备注 |
   | --- | --- | --- |
   | `url` | `url` | |
   | `filename` | `filename` | 只传清洗后的文件名，不传路径 |
   | `referrer` / `downloadPage` | `referrer` | 优先 `referrer` |
   | `headers.cookie` | `cookies` | 走一等字段 |
   | 其余安全请求头 | `headers` | 参考 NeatDM / Gopeed 的安全白名单，剔除 `range`/`host`/`content-length`/逐跳头 |
   | `size` | `fileSize` | `>0` 才传 |
   | `mime` | `mimeType` | |
   | `extraOpts.dir` | `saveDir` | 来自确认面板的保存位置 |
   | `method` / `body` | `method` / `body` | 非 GET 才传；`body` 需转 `{kind:'formData'|'raw'}` |
   | 音频轨 URL | `audioUrl` | Phase 2，对接合并场景 |

4. `sendToFluxdown(taskInfo, extraOpts)`：
   - `POST {base}/download`，头 `Content-Type: application/json`、`X-FluxDown-Client: downlink`、token 非空时 `X-FluxDown-Token`。
   - 响应判定**对齐官方 `remote-server.ts::postJson`**：`resp.redirected` → 坏响应；`401/403` → 鉴权/设置失败；非 2xx → 取服务端 `message`；2xx 但 `success !== true` → 坏响应。
   - 无 gid，成功返回 `{ ok: true }`。
5. `testFluxdownConnection(cfg)`：
   - `GET {base}/ping` → 校验 `json.app === 'FluxDown'`，取 `version` 展示（如 `已连接 FluxDown 0.5.2`）。
   - token 非空时追加 `POST {base}/download` 空体验证（4.4）；`400` = 鉴权通过，`401` = 密钥错误，`404`/网络错误按各自语义处理。
6. `sendTask()` 分发加一支：`else if (provider === 'fluxdown') result = await sendToFluxdown(normalizedTask, extraOpts);`
7. `onTaskAccepted` 的 `trackable` / `status`：`fluxdown` 归入“发送即完成”分支（当前表达式 `provider === 'aria2' || provider === 'gopeed'`）。
8. 导出 `testFluxdownConnection`。

### Phase 2 — 配置与 UI

| 文件 | 改动 |
| --- | --- |
| `popup.js` | `POPUP_DEFAULT_CONFIG` 增 `fluxdownUrl: 'http://127.0.0.1:17800'`、`fluxdownToken: ''`、`fluxdownSilent: false` |
| `background.js` | `DEFAULT_CONFIG` 增同样三项；`shouldConfirmBeforeSend()` 增 `fluxdown && !fluxdownSilent`；`TEST_CONNECTION` 增 `fluxdown` 分支 |
| `popup.html` | `#cfgDownloaderType` 增 `<option value="fluxdown">FluxDown</option>`；新增 `.fluxdown-only settings-hidden` 区块：API 地址 `#cfgFluxdownUrl`、访问密钥 `#cfgFluxdownToken`（password）、连接测试行 `#connResultFluxdown` + `#testFluxdownBtn`；`.downloader-config-group` 内增“普通任务静默下载”开关 `#cfgFluxdownSilent` |
| `lib/popup-settings.js` | `collectSettingsFromForm` / `loadSettings` / `persistSettings` 的 `shouldRetestConnection` / `bindSettingsEvents` 输入列表各增三项 |
| `popup-app.js` | `getConnectionCheckSignature()` 增 `fluxdown` 分支；`updateSettingsVisibility()` 增 `isFluxdown` → `.fluxdown-only`，并把 `fluxdown` 纳入 `.downloader-config-group` 的显示条件 |
| `lib/popup-ui.js` | `DOWNLOADER_LOGOS` 增 `fluxdown`；`getDownloaderName()` 增 `fluxdown → 'FluxDown'` |
| `lib/downloader-picker.js` | `DOWNLOADER_ICONS` 增 `fluxdown: 'assets/provider-icons/fluxdown.png'` |
| `lib/i18n.js` | zh-CN + en 各增：`settingsFluxdownUrl`、`settingsFluxdownUrlSub`、`settingsFluxdownToken`、`settingsFluxdownTokenSub`、`settingsFluxdownSilent`、`settingsFluxdownSilentSub`、`fluxdownConnected` |
| `assets/provider-icons/fluxdown.png` | 新增图标（≥64×64，头部显示 26×26）；同步更新 `assets/provider-icons/README.md` |

**确认面板默认行为（待确认）**：建议 `fluxdown` 默认**进入** Downlink 确认面板（同 aria2 / Gopeed），因为 `/download` 支持 `saveDir`/`filename`，而确认面板正是用户选这两个的地方；`fluxdownSilent` 开启后跳过。代价是 R2 的双重确认框，用文档提示 FluxDown 侧“免打扰”化解。备选方案：默认不进入面板（同 AB DM），完全交给 FluxDown 的确认框。

### Phase 3 — 测试

现有 `node --test` 套件：

- `tests/background.test.js`（229 KB，主要回归面）：
  - `DEFAULT_CONFIG` 含新字段且 `downloaderType` 切到 `fluxdown` 后行为正确；
  - `TEST_CONNECTION` → `/ping` 成功 / `app` 不匹配（防误判其他服务）/ 网络失败；
  - `sendToFluxdown` 的请求体断言：`url`、`filename`、`referrer`、`cookies`、`headers` 白名单过滤、`fileSize` 仅在 `>0` 时出现、`method`/`body`；
  - 请求头断言：`X-FluxDown-Client` 恒在；`X-FluxDown-Token` 仅在 token 非空时出现；
  - 错误映射：400 / 401 / 403 / 5xx / `redirected` / 2xx-but-`success:false`；
  - token 探针：`400` 判为鉴权通过、`401` 判为密钥错误。
- `tests/popup.test.js`：picker 出现 FluxDown 选项；`updateSettingsVisibility('fluxdown')` 的显隐；collect/populate 往返。
- `tests/safari-resource-sync.test.js`：确认新增图标是否触发资源清单断言（`sync-safari-resources.mjs` 递归拷贝 `assets/`，预期自动覆盖，但需跑一遍确认）。

### Phase 4 — 文档与产物

1. `docs/downloader-communication-params.md`：总览表加一行；新增 `## FluxDown` 章节（配置字段、请求格式、任务字段表、连接检测、与 aria2 路径的取舍说明）；末尾“捕获和确认行为差异”表加一行。
2. `README.md` / `README.en.md`：下载器列表与切换说明；补一段“使用 FluxDown 需在其设置中开启 API 服务，建议开启免打扰避免二次确认”。
3. `npm test`。
4. `npm run package:all` 重新生成 `dist/chromium`、`dist/firefox`。
5. `npm run safari:sync` 同步 `safari/.../Resources/`（图标 + 改动文件）。
6. `npm run safari:check` 校验同步一致性。

---

## 7. 工作量与顺序建议

| 阶段 | 内容 | 相对工作量 |
| --- | --- | --- |
| Phase 0 | curl 契约验证 | 小（但必须先做，尤其 HLS 与 `saveDir` 行为） |
| Phase 1 | `lib/background-downloaders.js` 适配层 | 中 |
| Phase 2 | 配置 + UI + i18n + 图标 | 中（改动点分散在 8 个文件） |
| Phase 3 | 测试 | 中（`background.test.js` 体量大，需找对插入点） |
| Phase 4 | 文档 + dist + safari | 小 |

建议按 Phase 0 → 1 → 2 → 3 → 4 顺序推进，Phase 0 若发现 HLS/`saveDir` 行为与预期不符，回到本方案调整 Phase 1 的字段映射。

---

## 8. 待决策项

1. **确认面板默认行为**：`fluxdown` 默认进入 Downlink 确认面板（推荐，同 aria2/Gopeed），还是直接发送（同 AB DM）？
2. **访问密钥是否必填**：桌面无 LAN/CORS 时 token 可以为空；UI 是否把 token 标为“可选，仅在 FluxDown 开启局域网/CORS 时必填”？
3. **图标来源**：自绘中性图标，还是采用 FluxDown logo 并按 AGPL-3.0 做署名记录（R6）？
4. **是否首版就做** `method`/`body` 与 `audioUrl` 映射，还是留到 Phase 2？
5. **是否需要 Phase 2 的进度反查**（按 URL 关联 `aria2.tellActive` / 管理 API）？默认建议不做。

---

## 9. 附：关键上游坐标

| 内容 | 位置 |
| --- | --- |
| 协议总览（中文） | `website-v2/src/content/docs/zh/api/overview.md` |
| `/download` 请求体解析 | `native/api/src/takeover.rs` |
| `/download` 路由与响应 | `native/api/src/server.rs`（`takeover_download` / `submit_external` / `ping`） |
| `DownloadRequest` 定义 | `native/protocol/src/daemon.rs` |
| 鉴权与来源门禁 | `native/api/src/auth.rs` |
| 路由与默认开关 | `.omp/knowledge/hosts-and-api.md` |
| aria2 兼容方法与选项映射 | `native/api/src/aria2.rs` |
| 官方插件 NMH 通道 | `fluxDown/utils/native-messaging.ts` |
| 官方插件 HTTP 通道 | `fluxDown/utils/remote-server.ts` |
| 官方插件通道路由 | `fluxDown/utils/download-dispatch.ts` |
| NMH `allowed_origins` 硬编码 | `native/agent/src/nmh.rs:577,580,745,756` |
