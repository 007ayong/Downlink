# Downlink

Downlink 是一个浏览器扩展，用来接管浏览器下载，并把任务发送到你选择的外部下载器。

该扩展支持接入多种下载器，拥有高度的灵活性，可根据你使用的下载器，在设置中自行切换保存。只需一个浏览器插件，即可完成下载接管、网页媒体捕获和基础状态查看。

## 当前支持

- [Aria2](https://github.com/aria2/aria2)
- [Motrix](https://github.com/agalwood/motrix)
- [AB DM](https://github.com/amir1376/ab-download-manager)
- [Neat Download Manager](https://www.neatdownloadmanager.com/index.php/en/)

## 主要功能

- 接管浏览器下载请求，并转交给当前配置的下载器
- 支持按扩展名拦截常见文件下载
- 支持根据响应类型捕获音频、视频等媒体资源
- 支持在弹窗中查看任务列表和待确认任务
- 支持预览已捕获的媒体资源，并发送到下载器
- 支持透传关键请求头，改善需要 Cookie、Referer 或鉴权头的下载场景
- 支持通知提醒和基础连接测试

## 安装方式

1. 打开 Chromium 内核浏览器的扩展管理页面
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 选择当前项目目录

## 基本使用

1. 点击扩展图标打开 Downlink
2. 在“设置”中选择目标下载器
3. 根据所选下载器填写连接信息
4. 打开“自动拦截下载”后，浏览器下载会按规则自动转交
5. 如需手动发送，可通过弹窗中的任务区、媒体区或右键菜单操作

## 下载器配置说明

### Aria2 RPC

需要填写：

- RPC 地址
- RPC 密钥，可留空
- 默认保存目录，可留空

适合本地或远程运行 `aria2c` 或 Motrix，并开启 RPC 的场景。
如果你同时安装了 MotrixNext，可勾选“使用 MotrixNext 管理”，在任务面板中快速打开查看。

### AB DM

需要填写：

- 服务地址
- 端口号
- 接口路径

一般情况下，需要核实软件本体和该扩展中的端口号是否一致。

### NeatDM

当前通过默认 WebSocket 地址连接：

- `ws://127.0.0.1:10007/download`

适合本地已运行 NeatDM 接收服务的场景。Neat DM 不开放端口配置。

## 媒体捕获

Downlink 会监听页面中的音频和视频请求，并在媒体面板中展示可发送资源。对于部分依赖请求头、Cookie 或防盗链校验的资源，扩展会尽量补齐请求头以提升可下载性和可预览性。

## 权限说明

扩展当前使用的权限包括：

- `downloads`
- `storage`
- `notifications`
- `tabs`
- `webRequest`
- `contextMenus`
- `declarativeNetRequest`
- `<all_urls>` 主机权限

这些权限主要用于下载接管、请求识别、媒体捕获、状态展示和右键菜单操作。

## 项目结构

- `manifest.json`：扩展清单
- `background.js`：后台逻辑、下载转发、请求捕获
- `popup.html` / `popup.js`：扩展弹窗 UI
- `preview.html` / `preview.js`：媒体预览页面
- `icons/`：扩展图标

## 说明

这个项目目前更偏向本地使用和功能验证，文档会随着下载器适配能力和配置方式继续调整。
