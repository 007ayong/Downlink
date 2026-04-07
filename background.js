// background.js — Downlink Service Worker
// 拆分为：基础工具 / 下载器适配 / 事件注册

try {
  importScripts(
    'filename-logic.js',
    'lib/background-shared.js',
    'lib/background-downloaders.js',
    'lib/background-media.js'
  );
} catch {}

const DEFAULT_CONFIG = {
  downloaderType: 'aria2',
  aria2Rpc: 'http://localhost:6800/jsonrpc',
  aria2Secret: '',
  useMotrixNext: false,
  externalLauncherName: 'AB DM',
  externalLauncherHost: 'localhost',
  externalLauncherPort: '15151',
  externalLauncherPath: '/start-headless-download',
  autoCapture: true,
  captureExtensions: 'zip,rar,7z,tar,gz,bz2,xz,iso,dmg,exe,msi,deb,pkg,apk,mp4,mkv,avi,mov,webm,mp3,flac,wav,pdf,torrent',
  captureMime: true,
  showConfirm: true,
  saveDir: '',
};

const shared = globalThis.BackgroundShared;
const downloaders = globalThis.BackgroundDownloaders;
const mediaModule = globalThis.BackgroundMedia;

const {
  cleanExpired,
  decodeHttpFilename,
  deriveOrigin,
  dirname,
  fallbackMediaFilename,
  filenameFromCD,
  filenameFromUrl,
  isDirectMediaResource,
  shouldCaptureByExt,
  shouldCaptureByMime,
} = shared;

let config = { ...DEFAULT_CONFIG };
let tasks = {};
let pendingDownloads = {};
let hiddenTaskGids = {};
let uiAlert = null;

const markedUrls = new Map();
const requestHeadersCache = new Map();
const EXTERNAL_LAUNCHER_TIMEOUT_MS = 3000;
function shouldConfirmBeforeSend() {
  return config.downloaderType === 'aria2' && config.showConfirm;
}

function buildConnectionFailureText(label) {
  return `与 ${label} 连接失败，检查 ${label} 是否正在运行`;
}

function getEffectiveConfig(override = {}) {
  const normalized = { ...config, ...(override || {}) };
  normalized.externalLauncherName = 'AB DM';
  if (normalized.downloaderType === 'motrixnext') {
    normalized.downloaderType = 'aria2';
    normalized.useMotrixNext = true;
  }
  return normalized;
}

function setUiAlert(alert) {
  uiAlert = alert;
  broadcastUpdate();
}

function clearUiAlert() {
  if (!uiAlert) return;
  uiAlert = null;
  broadcastUpdate();
}

async function openTaskSurface() {
  try {
    await chrome.action.openPopup();
    return true;
  } catch {
    try {
      await chrome.tabs.create({ url: chrome.runtime.getURL('popup.html') });
      return true;
    } catch {
      return false;
    }
  }
}

const configReady = new Promise((resolve) => {
  chrome.storage.sync.get(DEFAULT_CONFIG, (stored) => {
    const normalized = { ...DEFAULT_CONFIG, ...stored };
    normalized.externalLauncherName = 'AB DM';
    if (normalized.downloaderType === 'motrixnext') {
      normalized.downloaderType = 'aria2';
      normalized.useMotrixNext = true;
    }
    config = normalized;
    resolve(config);
  });
});

chrome.storage.onChanged.addListener((changes) => {
  for (const key in changes) config[key] = changes[key].newValue;
  config.externalLauncherName = 'AB DM';
  if (config.downloaderType === 'motrixnext') {
    config.downloaderType = 'aria2';
    config.useMotrixNext = true;
  }
});

function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title,
    message,
  });
}

function buildMotrixNextDeepLink() {
  return 'motrixnext://';
}

async function openMotrixNextView() {
  try {
    const deepLink = buildMotrixNextDeepLink();
    await chrome.tabs.create({ url: deepLink });
    return { ok: true, url: deepLink };
  } catch (error) {
    notify('MotrixNext 打开失败', error.message);
    return { ok: false, error: error.message };
  }
}

function broadcastUpdate() {
  const mediaState = mediaManager.getState();
  chrome.runtime.sendMessage({
    type: 'TASKS_UPDATE',
    tasks,
    pending: pendingDownloads,
    media: mediaState.media,
    hiddenTaskGids: Object.keys(hiddenTaskGids),
    uiAlert,
  }).catch(() => {});
}

const downloaderClients = downloaders.createClients({
  getConfig: () => config,
  notify,
  onBeforeAria2Send: () => {
    for (const [gid, task] of Object.entries(tasks)) {
      if (task?.gid && task.status !== 'paused') hiddenTaskGids[gid] = true;
    }
    broadcastUpdate();
  },
  onAria2TaskQueued: (gid, taskInfo) => {
    clearUiAlert();
    tasks[gid] = {
      gid,
      url: taskInfo.url,
      filename: taskInfo.filename,
      addedAt: taskInfo.addedAt || Date.now(),
      status: 'active',
      provider: 'aria2',
    };
    delete hiddenTaskGids[gid];
    broadcastUpdate();
  },
});

const {
  aria2Call,
  buildExternalEndpoint,
  getAria2GlobalStat,
  getAria2Status,
  getDownloaderLabel,
  sendTask: sendTaskToDownloader,
  testNeatdmConnection,
} = downloaderClients;

async function sendTask(taskInfo, extraOpts = {}, { openPopupOnFailure = false } = {}) {
  const result = await sendTaskToDownloader(taskInfo, extraOpts);
  if (result?.ok) {
    clearUiAlert();
    return result;
  }

  const message = result?.error || buildConnectionFailureText(getDownloaderLabel(config.downloaderType));
  setUiAlert({ type: 'connection-failure', message });
  if (openPopupOnFailure) await openTaskSurface();
  return { ...result, error: message };
}

function updateActionBadgeForTab(tabId, count) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  chrome.action.setBadgeBackgroundColor({ color: '#e05c2a', tabId });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff', tabId });
  chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '', tabId });
}

function getTabSnapshot(tabId) {
  return new Promise((resolve) => {
    if (typeof tabId !== 'number' || tabId < 0) {
      resolve({ title: '', url: '' });
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        resolve({ title: '', url: '' });
        return;
      }
      resolve({ title: tab.title || '', url: tab.url || '' });
    });
  });
}

const mediaManager = mediaModule.createMediaManager({
  fallbackMediaFilename,
  escapeRegex: shared.escapeRegex,
  hashString: shared.hashString,
  totalSizeFromHeaders: shared.totalSizeFromHeaders,
  mediaKindOf: shared.mediaKindOf,
  deriveOrigin,
  updateActionBadgeForTab,
  broadcastUpdate,
  getRequestHeaders: (url) => requestHeadersCache.get(url)?.headers || {},
  getTabSnapshot,
});

async function pollTasks() {
  await configReady;
  for (const gid of Object.keys(tasks)) {
    if (tasks[gid]?.provider && tasks[gid].provider !== 'aria2') continue;
    try {
      const status = await getAria2Status(gid);
      tasks[gid] = {
        ...tasks[gid],
        status: status.status,
        totalLength: parseInt(status.totalLength, 10) || 0,
        completedLength: parseInt(status.completedLength, 10) || 0,
        downloadSpeed: parseInt(status.downloadSpeed, 10) || 0,
        connections: parseInt(status.connections, 10) || 0,
        filePath: status.files?.[0]?.path || tasks[gid].filePath || '',
        dirPath: dirname(status.files?.[0]?.path || tasks[gid].filePath || ''),
        filename: status.files?.[0]?.path?.split(/[\\/]/).pop() || tasks[gid].filename,
      };
    } catch {}
  }
  broadcastUpdate();
}

setInterval(pollTasks, 1200);

chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!config.autoCapture) return;
    const headers = {};
    for (const header of details.requestHeaders || []) headers[header.name.toLowerCase()] = header.value;
    requestHeadersCache.set(details.url, { headers, expiresAt: Date.now() + 60000 });
    cleanExpired(requestHeadersCache);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!config.autoCapture) return;

    let contentDisposition = '';
    let contentType = '';
    for (const header of details.responseHeaders || []) {
      const name = header.name.toLowerCase();
      if (name === 'content-disposition') contentDisposition = header.value || '';
      if (name === 'content-type') contentType = header.value || '';
    }

    const isAttachment = /attachment/i.test(contentDisposition);
    const filenameFromHeader = filenameFromCD(contentDisposition);
    const urlFilename = filenameFromUrl(details.url);
    const filename = decodeHttpFilename(filenameFromHeader || urlFilename);
    const mime = contentType.split(';')[0].trim().toLowerCase();

    const byMime = shouldCaptureByMime(config, mime);
    const byExt = shouldCaptureByExt(config, details.url, filename);
    const byDisposition = isAttachment;

    if (!byMime && !byExt && !byDisposition) return;

    markedUrls.set(details.url, {
      filename,
      mime,
      contentDisposition,
      tabId: details.tabId,
      expiresAt: Date.now() + 30000,
    });
    cleanExpired(markedUrls);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => mediaManager.handleMediaResponse(details),
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.downloads.onCreated.addListener(async (item) => {
  await configReady;
  if (!config.autoCapture || item.state === 'complete') return;

  const url = item.finalUrl || item.url;
  const browserFilename = item.filename ? decodeHttpFilename(item.filename.split(/[\\/]/).pop()) : '';
  const marked = markedUrls.get(url) || markedUrls.get(item.url);
  const byExt = shouldCaptureByExt(config, url, browserFilename);
  if (!marked && !byExt) return;

  chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));

  const filename = decodeHttpFilename(marked?.filename || browserFilename || filenameFromUrl(url) || '');
  const reqHeaders = requestHeadersCache.get(url)?.headers || requestHeadersCache.get(item.url)?.headers || {};

  if (marked) {
    markedUrls.delete(url);
    markedUrls.delete(item.url);
  }

  const key = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const taskInfo = {
    key,
    url,
    filename,
    size: item.totalBytes,
    mime: marked?.mime || '',
    contentDisposition: marked?.contentDisposition || '',
    headers: reqHeaders,
    origin: reqHeaders.origin || deriveOrigin(url, reqHeaders.referer || ''),
    referrer: reqHeaders.referer || '',
    addedAt: Date.now(),
  };

  if (shouldConfirmBeforeSend()) {
    pendingDownloads[key] = taskInfo;
    broadcastUpdate();
    chrome.action.openPopup().catch(() => {});
    return;
  }

  await sendTask(taskInfo, {}, { openPopupOnFailure: true });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await configReady;

    switch (msg.type) {
      case 'GET_STATE':
        sendResponse({ tasks, pending: pendingDownloads, media: mediaManager.getState().media, config, hiddenTaskGids: Object.keys(hiddenTaskGids), uiAlert });
        break;
      case 'CONFIRM_DOWNLOAD': {
        const info = pendingDownloads[msg.key];
        if (!info) break;
        const result = await sendTask({ ...info, filename: msg.filename || info.filename }, msg.opts || {}, { openPopupOnFailure: true });
        if (result?.ok) delete pendingDownloads[msg.key];
        sendResponse(result);
        broadcastUpdate();
        break;
      }
      case 'REJECT_DOWNLOAD':
        delete pendingDownloads[msg.key];
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      case 'ADD_URL':
        sendResponse(await sendTask({
          url: msg.url,
          filename: msg.filename || '',
          headers: {},
          addedAt: Date.now(),
        }, msg.opts || {}, { openPopupOnFailure: true }));
        break;
      case 'ADD_MEDIA_TASK': {
        const media = mediaManager.findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: '媒体资源不存在或已过期' });
          break;
        }
        sendResponse(await sendTask({
          url: media.resourceUrl,
          filename: msg.filename || media.filename || '',
          headers: media.headers || {},
          mime: media.mime || '',
          contentDisposition: media.contentDisposition || '',
          referrer: media.referrer || '',
          origin: media.origin || '',
          addedAt: Date.now(),
        }, msg.opts || {}, { openPopupOnFailure: false }));
        break;
      }
      case 'GET_MEDIA_ITEM': {
        const media = mediaManager.findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: '媒体资源不存在或已过期' });
          break;
        }
        sendResponse({ ok: true, media });
        break;
      }
      case 'PREPARE_MEDIA_PREVIEW': {
        const media = mediaManager.findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: '媒体资源不存在或已过期' });
          break;
        }
        try {
          const result = await mediaManager.preparePreviewRule(msg.tabId, media);
          sendResponse({ ok: true, ...result });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || '预览请求补头失败' });
        }
        break;
      }
      case 'CLEAR_MEDIA_PREVIEW':
        await mediaManager.clearPreviewRule(msg.tabId);
        sendResponse({ ok: true });
        break;
      case 'UPDATE_MEDIA_METADATA': {
        const updated = mediaManager.updateMediaMetadata(msg.id, {
          duration: typeof msg.duration === 'number' ? msg.duration : undefined,
          width: typeof msg.width === 'number' ? msg.width : undefined,
          height: typeof msg.height === 'number' ? msg.height : undefined,
        });
        if (!updated) {
          sendResponse({ ok: false });
          break;
        }
        sendResponse({ ok: true });
        break;
      }
      case 'CLEAR_MEDIA':
        mediaManager.clearMediaResources(msg.tabId);
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      case 'CLEAR_MEDIA_BADGE':
        if (typeof msg.tabId === 'number' && msg.tabId >= 0) {
          updateActionBadgeForTab(msg.tabId, mediaManager.getState().media[msg.tabId]?.length || 0);
        }
        sendResponse({ ok: true });
        break;
      case 'PAUSE_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) await aria2Call('pause', [msg.gid]).catch(() => {});
        sendResponse({ ok: true });
        break;
      case 'RESUME_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) await aria2Call('unpause', [msg.gid]).catch(() => {});
        sendResponse({ ok: true });
        break;
      case 'REMOVE_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) {
          await aria2Call('remove', [msg.gid]).catch(() => {});
          await aria2Call('removeDownloadResult', [msg.gid]).catch(() => {});
        }
        delete hiddenTaskGids[msg.gid];
        delete tasks[msg.gid];
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      case 'TEST_CONNECTION':
        const testConfig = getEffectiveConfig(msg.config);
        if (testConfig.downloaderType === 'abdownload') {
          try {
            const endpoint = buildExternalEndpoint(testConfig).replace(/\/start-headless-download$|\/add$/, '/queues');
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), EXTERNAL_LAUNCHER_TIMEOUT_MS);
            let res;
            try {
              res = await fetch(endpoint, { signal: controller.signal });
            } finally {
              clearTimeout(timer);
            }
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            clearUiAlert();
            sendResponse({ ok: true, mode: 'abdownload', message: `已连接 ${endpoint}` });
          } catch (error) {
            sendResponse({ ok: false, mode: 'abdownload', error: buildConnectionFailureText('AB DM') });
          }
          break;
        }
        if (testConfig.downloaderType === 'neatdm') {
          const result = await testNeatdmConnection();
          if (result?.ok) clearUiAlert();
          sendResponse(result);
          break;
        }
        try {
          const stat = await getAria2GlobalStat(testConfig);
          clearUiAlert();
          sendResponse({ ok: true, stat, mode: 'aria2' });
        } catch (error) {
          sendResponse({ ok: false, error: buildConnectionFailureText('Aria2'), mode: 'aria2' });
        }
        break;
      case 'SAVE_CONFIG':
        const savedConfig = { ...msg.config };
        if (savedConfig.downloaderType === 'motrixnext') {
          savedConfig.downloaderType = 'aria2';
          savedConfig.useMotrixNext = true;
        }
        await chrome.storage.sync.set(savedConfig);
        config = { ...config, ...savedConfig };
        sendResponse({ ok: true });
        break;
      case 'OPEN_MOTRIXNEXT_VIEW':
        sendResponse(await openMotrixNextView());
        break;
    }
  })();

  return true;
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'send-to-aria2', title: '用当前下载器下载链接', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'send-page-to-aria2', title: '用当前下载器下载当前页面', contexts: ['page'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  await configReady;
  const url = info.linkUrl || tab?.url;
  if (!url) return;
  const reqHeaders = requestHeadersCache.get(url)?.headers || {};
  await sendTask({
    url,
    filename: url.split('?')[0].split('/').pop() || '',
    headers: reqHeaders,
    addedAt: Date.now(),
  }, {}, { openPopupOnFailure: true });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  mediaManager.clearTabState(tabId);
  mediaManager.clearPreviewRule(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateActionBadgeForTab(tabId, mediaManager.getState().media[tabId]?.length || 0);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  mediaManager.clearTabState(tabId);
  updateActionBadgeForTab(tabId, 0);
  mediaManager.clearPreviewRule(tabId);
  broadcastUpdate();
});

chrome.runtime.onStartup.addListener(async () => {
  await configReady;
  if (config.downloaderType !== 'aria2') return;
  try {
    for (const status of await aria2Call('tellActive')) {
      const filePath = status.files?.[0]?.path || '';
      tasks[status.gid] = {
        gid: status.gid,
        url: status.files?.[0]?.uris?.[0]?.uri || '',
        filename: filePath.split(/[\\/]/).pop() || '',
        filePath,
        dirPath: dirname(filePath),
        addedAt: Date.now(),
        status: status.status,
      };
    }
  } catch {}
});

globalThis.isDirectMediaResource = isDirectMediaResource;
globalThis.openMotrixNextView = openMotrixNextView;
globalThis.getBackgroundConfig = () => config;
globalThis.__backgroundTestHooks = {
  setUiAlert,
  clearUiAlert,
  openTaskSurface,
  mediaManager,
};
