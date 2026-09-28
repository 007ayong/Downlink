# 下载器通讯参数整理

本文档整理 Downlink 与各个下载器之间的连接地址、鉴权方式、发送任务接口和请求体字段。参数来源以当前实现为准，主要对应 `background.js` 的默认配置和 `lib/background-downloaders.js` 的适配器逻辑。

## 总览

| 下载器 | 协议 | 默认地址 | 可配置项 | 鉴权 | 任务发送方式 |
| --- | --- | --- | --- | --- | --- |
| Aria2 | HTTP JSON-RPC | `http://localhost:6800/jsonrpc` | RPC 地址、RPC 密钥 | JSON-RPC params 中的 `token:<secret>` | `aria2.addUri` |
| Rayburst（原 MotrixNext） | HTTP | `http://127.0.0.1:29110/add` | 端口、密钥 | `Authorization: Bearer <secret>` | 协议能力检查后 `POST /add` |
| Gopeed | HTTP API | `http://127.0.0.1:9999/api/v1/tasks` | API 地址、Token | `X-Api-Token: <token>` | `POST /api/v1/tasks` |
| AB DM | HTTP | `http://localhost:15151/start-headless-download` 或 `/add` | 主机、端口、静默模式 | 无 | `POST /add` 或 `POST /start-headless-download` |
| NeatDM | WebSocket | `ws://127.0.0.1:10007/download` | 不开放配置 | WebSocket 子协议 `neatextension.v1` | 发送文本协议消息 |

通用连接超时为 3000 ms。发送失败时扩展会提示对应下载器未连接或未运行。

## Aria2

### 配置参数

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `downloaderType` | `aria2` | 选择 Aria2 适配器 |
| `aria2Rpc` | `http://localhost:6800/jsonrpc` | Aria2 JSON-RPC 地址 |
| `aria2Secret` | 空 | RPC 密钥，可不填 |
| `aria2Silent` | `false` | 自动捕获普通下载时是否跳过确认面板直接发送 |
| `aria2CustomSaveEnabled` | `false` | 是否启用自定义保存位置，`aria2Silent` 为 `true` 时强制关闭 |
| `aria2SaveLocations` | `[]` | 自定义保存位置列表，每项含 `name`、`path`、`color`，第一项为默认 |
| `aria2TrackerSubscriptions` | `["https://ngosang.github.io/trackerslist/trackers_best.txt"]` | Tracker 列表订阅链接，保存后会自动抓取并合并到 `aria2Trackers` |
| `aria2Trackers` | `[]` | 已解析的磁力链接 Tracker 缓存（存于本地，避免同步存储配额限制），创建磁力任务时通过 `bt-tracker` 传给 Aria2 |
| `aria2TrackersUpdatedAt` | `0` | Tracker 缓存最近成功更新时间；浏览器启动时超过 24 小时会后台更新 |
| `useMotrixNext` | `false` | 仅用于任务面板中快速跳转 MotrixNext 查看，不改变 Aria2 通讯方式 |

### 请求格式

发送任务使用 JSON-RPC：

```http
POST <aria2Rpc>
Content-Type: application/json
```

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "aria2.addUri",
  "params": [
    ["https://example.com/file.zip"],
    {
      "out": "file.zip",
      "header": [
        "cookie: sid=abc",
        "referer: https://example.com/page"
      ]
    }
  ]
}
```

如果配置了 `aria2Secret`，`params` 首位会插入 `token:<aria2Secret>`：

```json
{
  "params": [
    "token:secret",
    ["https://example.com/file.zip"],
    {}
  ]
}
```

### 任务字段

| 字段 | 来源 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| URL 数组 | `taskInfo.url` | 是 | 传给 `aria2.addUri` 的第一个参数 |
| `out` | `taskInfo.filename` | 否 | 文件名 |
| `header` | 请求头缓存 | 否 | 仅透传 `cookie`、`referer`、`origin`、`authorization`、`user-agent` |
| `split` | 确认面板选项 | 否 | 单线程下载时为 `"1"` |
| `max-connection-per-server` | 确认面板选项 | 否 | 单线程下载时为 `"1"` |
| `min-split-size` | 确认面板选项 | 否 | 单线程下载时为 `"1024M"` |
| `dir` | 确认面板保存位置选择 | 否 | 自定义保存位置，指定下载目录 |
| `bt-tracker` | `aria2Trackers` | 否 | 磁力任务自动附加的 Tracker 列表，逗号分隔 |

### 连接检测

连接检测调用 `aria2.getGlobalStat`。任务进度查询调用 `aria2.tellStatus`。

## Rayburst（原 MotrixNext）

### 配置参数

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `downloaderType` | `motrixnext` | 选择 MotrixNext 适配器 |
| `motrixNextPort` | `29110` | Rayburst 本机 HTTP API 端口 |
| `motrixNextSecret` | 空 | Rayburst 扩展 API 密钥，可不填 |

### 请求格式

发送任务固定访问本机：

```http
GET http://127.0.0.1:<motrixNextPort>/downloads/capabilities
X-Rayburst-Client: rayburst-connect
Authorization: Bearer <motrixNextSecret>
```

能力响应必须声明 `product: "rayburst"`、`protocolVersion: 2` 和 `filenameHints: true`。随后发送任务：

```http
POST http://127.0.0.1:<motrixNextPort>/add
Content-Type: application/json
X-Rayburst-Client: rayburst-connect
Authorization: Bearer <motrixNextSecret>
```

`Authorization` 仅在 `motrixNextSecret` 非空时发送。

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "url": "https://example.com/file.zip",
  "filename": "file.zip",
  "filenameSource": "suggested",
  "referer": "https://example.com/page",
  "cookie": "sid=abc",
  "userAgent": "Mozilla/5.0 ...",
  "requestHeaders": [{ "name": "accept", "value": "*/*" }]
}
```

### 任务字段

| 字段 | 来源 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `id` | 扩展生成 | 是 | 单次提交标识；用于校验服务端回执和避免不确定交付 |
| `url` | `taskInfo.url` | 是 | 下载地址 |
| `finalUrl` | `taskInfo.finalUrl` | 否 | 发生跳转时的最终地址 |
| `filename` | `taskInfo.filename` | 否 | 文件名 |
| `filenameSource` | 固定 `suggested` | 与 `filename` 同时 | 表示由 Downlink 建议的文件名 |
| `referer` | `taskInfo.referrer`、`taskInfo.downloadPage` 或请求头 `referer` | 否 | 防盗链来源页 |
| `cookie` | 请求头 `cookie` | 否 | 站点 Cookie |
| `userAgent` | 请求头 `user-agent` | 否 | 浏览器 User-Agent |
| `requestHeaders` | 过滤后的请求头 | 否 | 不包含 Cookie、Referer、Range、条件请求和逐跳请求头 |

Rayburst 模式不会进入 Downlink 侧二次确认。服务端会返回带有相同 `id` 的回执，`action` 为 `submitted`、`needs-confirmation` 或 `cancelled`；`submitted` 必须同时返回 `gid`。

### HLS/DASH 流媒体任务

Downlink 嗅探到 HLS (`.m3u8` 或对应 MIME) 和 MPEG-DASH (`.mpd` / `application/dash+xml`) 清单后，不会把清单当成普通文件发送到 `/add`，而是使用 Rayburst 的媒体 API：

1. `GET /media/v2/capabilities` 验证 `hls` / `dash`、请求上下文及协议版本。
2. `POST /media/v2/probes` 提交清单 URL、页面标题、来源页和经过过滤的请求头。
3. 轮询 `GET /media/v2/probes/<id>`，等待 Rayburst 完成清单和轨道解析。
4. `POST /media/v2/probes/<id>/submit`，使用 Rayburst 返回的默认轨道与输出格式创建下载任务。

媒体 API 要求 Rayburst 配置非空扩展 API 密钥。当前 Downlink 版本采用 Rayburst 的默认轨道选择；后续可在扩展侧补充视频、音频、字幕、输出格式和直播录制时长选择。

### 连接检测

连接检测依次请求：

```http
GET http://127.0.0.1:<motrixNextPort>/ping
```

再请求：

```http
GET http://127.0.0.1:<motrixNextPort>/stat
```

```http
GET http://127.0.0.1:<motrixNextPort>/downloads/capabilities
```

`/ping` 用于验证产品身份且不带鉴权；其余请求必须带服务端要求的 `X-Rayburst-Client: rayburst-connect`，配置密钥时再带 `Authorization: Bearer <motrixNextSecret>`。

## Gopeed

### 配置参数

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `downloaderType` | `gopeed` | 选择 Gopeed 适配器 |
| `gopeedApi` | `http://127.0.0.1:9999` | Gopeed HTTP API 根地址，末尾斜杠会被移除 |
| `gopeedToken` | 空 | API Token，可不填 |
| `gopeedSilent` | `false` | 自动捕获普通下载时是否跳过确认面板直接发送 |

### 请求格式

发送任务：

```http
POST <gopeedApi>/api/v1/tasks
Content-Type: application/json
X-Api-Token: <gopeedToken>
```

`X-Api-Token` 仅在 `gopeedToken` 非空时发送。

```json
{
  "req": {
    "url": "https://example.com/file.zip",
    "extra": {
      "header": {
        "referer": "https://example.com/page",
        "cookie": "sid=abc",
        "accept-encoding": "identity"
      }
    }
  },
  "opts": {
    "name": "file.zip",
    "extra": {
      "connections": 1
    }
  }
}
```

### 任务字段

| 字段 | 来源 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `req.url` | `taskInfo.url` | 是 | 下载地址 |
| `req.extra.header` | 请求头缓存和任务信息 | 是 | 普通文件任务会补充 `accept-encoding: identity`；HLS 使用下述安全白名单 |
| `req.extra.method` | `taskInfo.method` | 否 | 非 GET 时传递大写方法名 |
| `req.extra.body` | `taskInfo.body` | 否 | 手动任务可传请求体 |
| `req.labels` | `taskInfo.labels` | 否 | 手动任务标签 |
| `opts.name` | `taskInfo.filename` | 否 | 文件名 |
| `opts.extra.connections` | 确认面板选项 | 否 | 勾选单线程不分片下载时传 `1` |

### HLS 流媒体任务

- 仅接受 `streamProtocol: "hls"` 且 URL 路径以 `.m3u8` 结尾的任务；DASH 和无 `.m3u8` 后缀的 HLS 入口会返回不支持，避免 Gopeed 将清单当作普通文件保存。
- 发送前请求 `GET /api/v1/info`，要求 Gopeed 版本不低于 `2.0.0-beta.3`。
- HLS 任务不传 `opts.name`，由 Gopeed 根据实际媒体容器确定合并后的扩展名。
- HLS 请求头会被 Gopeed 继续用于子清单、分片和密钥请求，因此 Downlink 仅保留 `accept`、语言、认证、Cookie、实际捕获的 Origin、Referer、User-Agent、Fetch Metadata 及 `x-*` 请求头；不传 `range`、`content-type`、`content-disposition` 等文件请求元数据。
- 未捕获到 Referer 时仍会使用页面地址补齐，但不会凭空生成 Origin。
- Gopeed 当前原生 HLS 实现只支持点播清单；直播清单会由 Gopeed 拒绝，Downlink 不伪装为普通文件任务。

普通文件任务的 Gopeed 请求头处理规则：

- 删除 `accept-encoding`、`connection`、`content-length`、`host`、`if-range`、`range`。
- 如果没有 `referer`，会从 `taskInfo.referrer` 或 `taskInfo.downloadPage` 补充。
- 如果没有 `content-type`，会从 `taskInfo.mime` 补充。
- 如果没有 `content-disposition`，会从 `taskInfo.contentDisposition` 补充。
- 最终强制设置 `accept-encoding: identity`。

扩展不会向 Gopeed 指定保存路径，不传 `opts.path`。

### 连接检测和任务查询

连接检测：

```http
GET <gopeedApi>/api/v1/info
```

任务列表和进度轮询：

```http
GET <gopeedApi>/api/v1/tasks
```

Gopeed 返回体需要满足 `code === 0`，实际数据读取自 `data`。

## AB DM

### 配置参数

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `downloaderType` | `abdownload` | 选择 AB DM 适配器 |
| `externalLauncherName` | `AB DM` | UI 显示名 |
| `externalLauncherHost` | `localhost` | HTTP 服务主机 |
| `externalLauncherPort` | `15151` | HTTP 服务端口 |
| `externalLauncherPath` | `/start-headless-download` | 后台默认路径；普通任务会按模式覆盖 |
| `abDownloadSilent` | `false` | 普通任务是否静默开始下载 |

### 端点选择

| 场景 | 请求路径 |
| --- | --- |
| 普通任务，`abDownloadSilent === false` | `/add` |
| 普通任务，`abDownloadSilent === true` | `/start-headless-download` |
| 媒体任务 | `/start-headless-download` |
| 显式指定 `abDownloadMode: "add"` | `/add` |
| 显式指定 `abDownloadMode: "headless"` | `/start-headless-download` |

浏览器拦截和右键菜单发送都不会进入扩展的确认面板，普通任务按上述模式选择端点，媒体任务固定使用 headless 端点。

完整地址格式：

```text
http://<externalLauncherHost>:<externalLauncherPort><path>
```

### `/add` 请求格式

```http
POST http://localhost:15151/add
Content-Type: application/json
```

```json
[
  {
    "link": "https://example.com/file.zip",
    "headers": {
      "referer": "https://example.com/page"
    },
    "downloadPage": "https://example.com/page"
  }
]
```

`/add` 使用数组请求体。`headers` 和 `downloadPage` 只有存在时才会传。

### `/start-headless-download` 请求格式

```http
POST http://localhost:15151/start-headless-download
Content-Type: application/json
```

```json
{
  "downloadSource": {
    "link": "https://example.com/file.zip",
    "headers": {
      "referer": "https://example.com/page"
    },
    "downloadPage": "https://example.com/page"
  },
  "folder": "/Downloads",
  "name": "file.zip",
  "queueId": 1
}
```

### 任务字段

| 字段 | 适用路径 | 来源 | 是否必传 | 说明 |
| --- | --- | --- | --- | --- |
| `link` | `/add` | `taskInfo.url` | 是 | 下载地址 |
| `headers` | 两者 | 请求头缓存 | 否 | 透传已捕获请求头 |
| `downloadPage` | 两者 | `taskInfo.downloadPage` 或 `taskInfo.referrer` | 否 | 来源页面 |
| `downloadSource.link` | `/start-headless-download` | `taskInfo.url` | 是 | 下载地址 |
| `folder` | `/start-headless-download` | `extraOpts.dir` | 否 | 目标目录 |
| `name` | `/start-headless-download` | `taskInfo.filename` | 否 | 文件名 |
| `queueId` | `/start-headless-download` | `extraOpts.queueId` | 否 | AB DM 队列 ID |
| `startDownload` | `/start-headless-download` | HLS 任务固定为 `true` | 否 | 让原生 HLS 任务创建后立即开始 |

### HLS 流媒体任务

- HLS 媒体任务固定使用 `/start-headless-download`，在 `downloadSource` 中传递 `type: "hls"`，并设置 `startDownload: true`，使 AB DM 选择原生 HLS 下载器并立即开始。
- 要求 AB DM `1.7.0` 或更高版本；当前仅支持非加密、以 `.ts` 为分片的媒体清单，不支持主清单、fMP4 分片或 DASH。
- AB DM 当前只读取一次媒体清单，直播 HLS 会在发送前明确拒绝，避免把仍在更新的直播误当成完整点播任务。
- 输出文件名统一改为 `.ts`，因为 AB DM 当前执行 TS 分片拼接而非 MP4 重封装。
- 请求头使用流媒体安全白名单，保留认证、Cookie、实际捕获的 Origin、Referer、User-Agent、Fetch Metadata 和 `x-*` 请求头；不传 `range`、`content-type`、`content-disposition`。
- DASH 会在发送前返回不支持。HLS 端点返回错误时不执行旧版 headless 降级请求，避免去掉 `type: "hls"` 后只下载 `.m3u8` 清单。

示例：

```json
{
  "downloadSource": {
    "link": "https://cdn.example.com/720p/index.m3u8",
    "type": "hls",
    "headers": {
      "referer": "https://example.com/watch",
      "cookie": "sid=abc"
    },
    "downloadPage": "https://example.com/watch"
  },
  "name": "video.ts",
  "startDownload": true
}
```

普通文件任务如果 `/start-headless-download` 返回 HTTP 500，扩展会重试一个降级请求体；HLS 不执行此降级：

```json
{
  "downloadSource": {
    "link": "https://example.com/file.zip"
  }
}
```

### 连接检测

连接检测会请求：

```http
GET http://<externalLauncherHost>:<externalLauncherPort>/queues
```

## NeatDM

### 配置参数

| 配置字段 | 默认值 | 说明 |
| --- | --- | --- |
| `downloaderType` | `neatdm` | 选择 NeatDM 适配器 |
| 固定端点 | `ws://127.0.0.1:10007/download` | 当前不开放 UI 配置 |
| WebSocket 子协议 | `neatextension.v1` | 创建 WebSocket 时传入 |

### WebSocket 消息格式

连接：

```text
ws://127.0.0.1:10007/download
Sec-WebSocket-Protocol: neatextension.v1
```

打开后发送 CRLF 分隔的文本消息：

```text
1:GET
2:https://example.com/file.zip
6:normal
4:file.zip
Origin: https://example.com
Referer: https://example.com/page
5:https://example.com/page
Cookie: sid=abc
Content-Type: application/zip
Content-Disposition: attachment; filename="file.zip"
8:application/zip
7:4096
```

消息末尾追加 `\r\n`。

### 字段说明

| 字段 | 来源 | 是否必传 | 说明 |
| --- | --- | --- | --- |
| `1:GET` | 固定值 | 是 | 当前固定 GET |
| `2:<url>` | `taskInfo.url` | 是 | 下载地址 |
| `6:<mode>` | 任务类型推断 | 是 | `normal`、`media` 或 `hls` |
| `4:<filename>` | `taskInfo.filename` | 是 | 文件名；媒体扩展名会被去掉后发送 |
| `Origin` | 捕获到的请求头；普通任务可从 URL 推断 | 否 | HLS 不会在浏览器未发送 Origin 时凭 CDN URL 伪造该字段 |
| `Referer` | `taskInfo.downloadPage` 或 `taskInfo.referrer` | 否 | 来源页 |
| `5:<downloadPage>` | `taskInfo.downloadPage` 或 `taskInfo.referrer` | 否 | 下载页面 |
| `Cookie` | 请求头 `cookie` | 否 | 站点 Cookie |
| `Content-Type` | 请求头或 `taskInfo.mime` | 否 | 媒体扩展名被去掉时不发送 |
| `Content-Disposition` | 任务信息、请求头或生成值 | 否 | 媒体扩展名被去掉时不发送 |
| `8:<mime>` | 请求头或 `taskInfo.mime` | 否 | 默认 `application/octet-stream`，媒体扩展名被去掉时不发送 |
| `7:<size>` | `taskInfo.size` | 否 | 文件大小 |
| 安全请求头 | 请求头缓存 | 否 | 透传 `Accept`、`Accept-Language`、`Authorization`、`User-Agent`、DNT、Client Hints、Fetch Metadata 和 `x-*` 自定义头；不透传 Range、Host、条件请求与逐跳头 |

已知限制：NeatDM 在默认 `normal` 类型下可能不采用 `4:<filename>` 里的自定义文件名，也就是扩展侧传了自定义文件名参数，NeatDM 端仍可能按 URL 或响应头自行命名。

`mode` 推断规则：

- 如果任务显式带 `neatdmMode`，直接使用该值。
- URL 或 MIME 推断扩展名为 `m3u8` 时使用 `hls`。
- 媒体嗅探已明确标记 `streamProtocol: "hls"` 时使用 `hls`；发送文件名时移除 `.m3u8`，避免 NeatDM 把清单扩展名当作最终输出格式。
- 视频、音频或媒体资源使用 `media`。
- 其他任务使用 `normal`。

### 连接检测

连接检测只尝试打开 WebSocket，成功后立即关闭，不发送任务消息。

## 通用任务信息归一化

发送到任意下载器前，任务会先归一化：

| 字段 | 规则 |
| --- | --- |
| `headers` | 请求头统一转为小写键 |
| `referrer` | 优先使用任务 referrer，其次使用请求头 `referer` |
| `origin` | 优先使用任务 origin，其次使用请求头 `origin`，最后从 URL 和 referrer 推断 |
| `filename` | 使用任务文件名，并尝试按 URL 或 MIME 补齐扩展名 |
| `downloadPage` | 优先使用任务 downloadPage，其次使用 referrer |
| `contentDisposition` | 优先使用任务 contentDisposition，其次使用请求头 `content-disposition` |
| `mime` | 无值时为空字符串 |
| `size` | 无值时为 `0` |
| `addedAt` | 无值时填当前时间 |

## 捕获和确认行为差异

| 下载器 | 自动捕获普通下载 | 是否进入确认面板 | 媒体任务行为 |
| --- | --- | --- | --- |
| Aria2 | 支持 | 默认进入；开启 `aria2Silent` 后直接发送 | 发送到 Aria2，可带文件名和请求头 |
| MotrixNext | 支持 | 不进入，直接发送 | 直接 `POST /add` |
| Gopeed | 支持 | 默认进入；开启 `gopeedSilent` 后直接发送 | 直接发送到 Gopeed，补齐媒体请求头 |
| AB DM | 支持 | 不进入扩展确认面板；普通任务按模式选择端点 | 媒体任务固定 `/start-headless-download` |
| NeatDM | 支持 | 不进入扩展确认面板，直接发送 WebSocket 消息 | 根据资源类型推断 `media` 或 `hls` |
