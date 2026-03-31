// background.js — Downlink Service Worker
// 双层拦截：webRequest 响应头层 + downloads API 层

try { importScripts('filename-logic.js'); } catch {}

const DEFAULT_CONFIG = {
  downloaderType: 'aria2',
  aria2Rpc: 'http://localhost:6800/jsonrpc',
  aria2Secret: '',
  externalLauncherName: 'AB Download',
  externalLauncherHost: 'localhost',
  externalLauncherPort: '15151',
  externalLauncherPath: '/start-headless-download',
  autoCapture: true,
  captureExtensions: 'zip,rar,7z,tar,gz,bz2,xz,iso,dmg,exe,msi,deb,pkg,apk,mp4,mkv,avi,mov,webm,mp3,flac,wav,pdf,torrent',
  captureMime: true,
  showConfirm: true,
  saveDir: '',
  notification: true,
};
const NEATDM_ENDPOINT = 'ws://127.0.0.1:10007/download';
const NEATDM_PROTOCOL = 'neatextension.v1';

// MIME 前缀白名单
const CAPTURE_MIME_PREFIXES = [
  'application/octet-stream','application/zip','application/x-rar',
  'application/x-7z-compressed','application/x-tar','application/gzip',
  'application/x-bzip2','application/x-xz','application/x-iso9660-image',
  'application/x-msdownload','application/vnd.android.package-archive',
  'application/x-apple-diskimage','application/x-deb','application/pdf',
  'application/x-bittorrent','video/','audio/',
];

let config = { ...DEFAULT_CONFIG };
let tasks = {};
let pendingDownloads = {};
let mediaResources = {};
let mediaBadgeCounts = {};
let previewRulesByTab = {};
let hiddenTaskGids = {};

function shouldConfirmBeforeSend() {
  return config.downloaderType === 'aria2' && config.showConfirm;
}

// webRequest 层标记（url -> info）
const markedUrls = new Map();
// 请求头缓存（url -> headers）
const requestHeadersCache = new Map();
const MEDIA_CACHE_LIMIT = 60;
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv']);
const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus']);
const FilenameLogic = globalThis.FilenameLogic || null;

// ── Config ───────────────────────────────────────────────
const configReady = new Promise(resolve => {
  chrome.storage.sync.get(DEFAULT_CONFIG, (stored) => {
    config = { ...DEFAULT_CONFIG, ...stored };
    resolve(config);
  });
});
chrome.storage.onChanged.addListener((changes) => { for (const k in changes) config[k] = changes[k].newValue; });

// ── Aria2 RPC ────────────────────────────────────────────
let rpcId = 1;
async function aria2Call(method, params = []) {
  const secret = config.aria2Secret ? `token:${config.aria2Secret}` : undefined;
  const res = await fetch(config.aria2Rpc, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: String(rpcId++),
      method: `aria2.${method}`,
      params: secret ? [secret, ...params] : params,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}
async function getAria2GlobalStat() { return aria2Call('getGlobalStat'); }
async function getAria2Status(gid) { return aria2Call('tellStatus', [gid]); }

const DOWNLOADERS = {
  aria2: {
    label: (cfg) => cfg.aria2Label || 'Aria2',
  },
  abdownload: {
    label: (cfg) => cfg.externalLauncherName || 'AB Download',
  },
  neatdm: {
    label: () => 'NeatDM',
  },
};

function getDownloaderLabel(type = config.downloaderType, cfg = config) {
  return DOWNLOADERS[type]?.label?.(cfg) || type;
}

function dirname(filePath = '') {
  if (!filePath) return '';
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return filePath;
  const normalized = filePath.replace(/[\\/]+$/, '');
  const idx = normalized.lastIndexOf('/');
  const winIdx = normalized.lastIndexOf('\\');
  const cutIdx = Math.max(idx, winIdx);
  return cutIdx >= 0 ? normalized.slice(0, cutIdx) : normalized;
}

async function addUriToAria2(url, filename, headers = {}, extraOpts = {}) {
  const opts = {};
  if (config.saveDir) opts.dir = config.saveDir;
  if (filename) opts.out = filename;
  // 透传关键请求头给 aria2，让它能访问需要认证/Cookie 的链接
  const headerLines = [];
  ['cookie', 'referer', 'origin', 'authorization', 'user-agent'].forEach(k => {
    if (headers[k]) headerLines.push(`${k}: ${headers[k]}`);
  });
  if (headerLines.length) opts.header = headerLines;
  Object.assign(opts, extraOpts);
  return aria2Call('addUri', [[url], opts]);
}

function buildExternalEndpoint() {
  const host = (config.externalLauncherHost || 'localhost').trim() || 'localhost';
  const port = String(config.externalLauncherPort || '15151').trim() || '15151';
  const path = String(config.externalLauncherPath || '/start-headless-download').trim() || '/start-headless-download';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `http://${host}:${port}${normalizedPath}`;
}

function buildAbDownloadRequest(taskInfo, extraOpts = {}) {
  const path = String(config.externalLauncherPath || '/start-headless-download').trim() || '/start-headless-download';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  const folder = extraOpts.dir || config.saveDir || '';
  const downloadPage = taskInfo.downloadPage || taskInfo.referrer || '';
  const headers = normalizeRequestHeaders(taskInfo.headers || {});

  if (normalizedPath === '/add') {
    const payload = {
      link: taskInfo.url || '',
    };
    if (Object.keys(headers).length) payload.headers = headers;
    if (downloadPage) payload.downloadPage = downloadPage;
    return [payload];
  }

  const payload = {
    downloadSource: {
      link: taskInfo.url || '',
    },
  };
  if (Object.keys(headers).length) payload.downloadSource.headers = headers;
  if (downloadPage) payload.downloadSource.downloadPage = downloadPage;
  if (folder) payload.folder = folder;
  if (taskInfo.filename) payload.name = taskInfo.filename;
  if (typeof extraOpts.queueId === 'number') payload.queueId = extraOpts.queueId;
  return payload;
}

function buildAbDownloadFallbackRequest(taskInfo) {
  return {
    downloadSource: {
      link: taskInfo.url || '',
    },
  };
}

async function sendToExternalLauncher(taskInfo, extraOpts = {}) {
  try {
    const endpoint = buildExternalEndpoint();
    const payload = buildAbDownloadRequest(taskInfo, extraOpts);
    let res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok && res.status === 500 && endpoint.endsWith('/start-headless-download')) {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildAbDownloadFallbackRequest(taskInfo)),
      });
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // 外部下载器只做静默唤起，不在扩展任务列表中生成占位任务。
    return { ok: true };
  } catch (err) {
    if (config.notification) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: `${getDownloaderLabel('abdownload')} 连接失败`,
        message: err.message,
      });
    }
    return { ok: false, error: err.message };
  }
}

function deriveOrigin(url, referrer = '') {
  try {
    return new URL(url).origin;
  } catch {
    try {
      return new URL(referrer).origin;
    } catch {
      return '';
    }
  }
}

function normalizeRequestHeaders(headers = {}) {
  const normalized = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!value) continue;
    normalized[String(key).toLowerCase()] = String(value);
  }
  return normalized;
}

function normalizeTaskInfo(taskInfo = {}, extraOpts = {}) {
  const headers = normalizeRequestHeaders(taskInfo.headers || {});
  const referrer = taskInfo.referrer || headers.referer || '';
  const origin = taskInfo.origin || headers.origin || deriveOrigin(taskInfo.url, referrer);
  const filename = ensureFilenameExtension(taskInfo.filename || '', taskInfo.url, taskInfo.mime || '');
  const downloadPage = taskInfo.downloadPage || referrer || '';
  const contentDisposition = taskInfo.contentDisposition || headers['content-disposition'] || '';

  return {
    ...taskInfo,
    ...extraOpts,
    headers,
    filename,
    referrer,
    origin,
    downloadPage,
    contentDisposition,
    mime: taskInfo.mime || '',
    size: taskInfo.size || 0,
    addedAt: taskInfo.addedAt || Date.now(),
  };
}

function stripHash(url = '') {
  const value = String(url || '').trim();
  if (!value) return '';
  const hashIndex = value.indexOf('#');
  return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
}

function buildContentDisposition(filename = '') {
  const cleanName = sanitizeFilenamePart(filename);
  if (!cleanName) return '';
  const quoted = cleanName.replace(/(["\\])/g, '\\$1');
  return `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`;
}

function getNeatdmMode(taskInfo = {}) {
  if (taskInfo.neatdmMode) return String(taskInfo.neatdmMode);
  const url = taskInfo.url || '';
  const mime = taskInfo.mime || '';
  const kind = taskInfo.kind || mediaKindOf(url, mime);
  const extension = guessMediaExtension(url, mime);
  if (extension === 'm3u8') return 'hls';
  if (kind === 'video' || kind === 'audio') return 'media';
  return 'normal';
}

function buildNeatdmMessage(taskInfo) {
  const headers = normalizeRequestHeaders(taskInfo.headers || {});
  const pageUrl = stripHash(taskInfo.downloadPage || taskInfo.referrer || '');
  const contentType = headers['content-type'] || taskInfo.mime || '';
  const contentDisposition = taskInfo.contentDisposition || headers['content-disposition'] || buildContentDisposition(taskInfo.filename || '');
  const cookies = headers.cookie || '';
  const mode = getNeatdmMode(taskInfo);
  const lines = [
    '1:GET',
    `2:${taskInfo.url || ''}`,
    `6:${mode}`,
    `4:${taskInfo.filename || ''}`,
  ];

  const origin = taskInfo.origin || deriveOrigin(taskInfo.url, pageUrl);
  const referer = pageUrl;
  const downloadPage = pageUrl;
  const mime = contentType || 'application/octet-stream';
  const size = taskInfo.size ? String(taskInfo.size) : '';

  if (origin) lines.push(`Origin: ${origin}`);
  if (referer) lines.push(`Referer: ${referer}`);
  if (downloadPage) lines.push(`5:${downloadPage}`);
  if (cookies) lines.push(`Cookie: ${cookies}`);
  if (contentType) lines.push(`Content-Type: ${contentType}`);
  if (contentDisposition) lines.push(`Content-Disposition: ${contentDisposition}`);
  if (mime) lines.push(`8:${mime}`);
  if (size) lines.push(`7:${size}`);
  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;
    if (!String(key).toLowerCase().startsWith('x-')) continue;
    lines.push(`${key}: ${value}`);
  }

  return `${lines.join('\r\n')}\r\n`;
}

function openNeatdmSocket() {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const finish = (handler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handler(value);
    };
    const timer = setTimeout(() => {
      try { socket?.close(); } catch {}
      finish(reject, new Error('连接超时，NeatDM 可能没有运行'));
    }, 3000);

    try {
      socket = new WebSocket(NEATDM_ENDPOINT, NEATDM_PROTOCOL);
    } catch (err) {
      clearTimeout(timer);
      reject(err);
      return;
    }

    socket.onopen = () => finish(resolve, socket);
    socket.onerror = () => {
      try { socket.close(); } catch {}
      finish(reject, new Error('连接失败，NeatDM 可能没有运行'));
    };
    socket.onclose = () => {
      if (!settled) finish(reject, new Error('连接已关闭'));
    };
  });
}

async function testNeatdmConnection() {
  const socket = await openNeatdmSocket();
  socket.close();
  return { ok: true, mode: 'neatdm', message: `已连接 ${NEATDM_ENDPOINT}` };
}

async function sendToNeatdm(taskInfo) {
  let socket;
  try {
    socket = await openNeatdmSocket();
    socket.send(buildNeatdmMessage(taskInfo));
    socket.close();
    return { ok: true };
  } catch (err) {
    try { socket?.close(); } catch {}
    if (config.notification) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: `${getDownloaderLabel('neatdm')} 连接失败`,
        message: err.message,
      });
    }
    return { ok: false, error: err.message };
  }
}

async function sendTask(taskInfo, extraOpts = {}) {
  const normalizedTask = normalizeTaskInfo(taskInfo, extraOpts);
  if (config.downloaderType === 'abdownload') return sendToExternalLauncher(normalizedTask, extraOpts);
  if (config.downloaderType === 'neatdm') return sendToNeatdm(normalizedTask, extraOpts);
  for (const [gid, task] of Object.entries(tasks)) {
    if (task?.gid && task.status !== 'paused') hiddenTaskGids[gid] = true;
  }
  broadcastUpdate();
  return sendToAria2(normalizedTask, extraOpts);
}

// ── 判断逻辑 ─────────────────────────────────────────────
function captureExts() {
  return config.captureExtensions.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
}
function extOf(str) {
  if (FilenameLogic?.extOf) return FilenameLogic.extOf(str);
  const m = (str || '').match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
  return m ? m[1].toLowerCase() : '';
}
function filenameFromUrl(url = '') {
  if (FilenameLogic?.filenameFromUrl) return FilenameLogic.filenameFromUrl(url);
  try {
    return decodeHttpFilename(new URL(url).pathname.split('/').pop() || '');
  } catch {
    try {
      return decodeHttpFilename(url.split('?')[0].split('/').pop() || '');
    } catch {
      return url.split('?')[0].split('/').pop() || '';
    }
  }
}
function extensionFromMime(mime = '') {
  if (FilenameLogic?.extensionFromMime) return FilenameLogic.extensionFromMime(mime);
  const normalized = String(mime).split(';')[0].trim().toLowerCase();
  const map = {
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/ogg': 'ogv',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/mp4': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'audio/flac': 'flac',
  };
  return map[normalized] || '';
}
function guessMediaExtension(url = '', mime = '') {
  if (FilenameLogic?.guessMediaExtension) return FilenameLogic.guessMediaExtension(url, mime);
  return extOf(url) || extensionFromMime(mime);
}
function sanitizeFilenamePart(value = '') {
  if (FilenameLogic?.sanitizeFilenamePart) return FilenameLogic.sanitizeFilenamePart(value);
  return String(value)
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}
function decodeTextWithCharset(bytes, charset = 'utf-8') {
  if (FilenameLogic?.decodeTextWithCharset) return FilenameLogic.decodeTextWithCharset(bytes, charset);
  const normalized = String(charset || 'utf-8').trim().toLowerCase().replace(/_/g, '-');
  try {
    return new TextDecoder(normalized || 'utf-8').decode(new Uint8Array(bytes));
  } catch {
    try {
      return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
    } catch {
      return bytes.map(byte => String.fromCharCode(byte)).join('');
    }
  }
}
function decodeRfc2047Words(value = '') {
  if (FilenameLogic?.decodeRfc2047Words) return FilenameLogic.decodeRfc2047Words(value);
  const text = String(value || '');
  if (!text.includes('=?')) return text;
  return text.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset, encoding, payload) => {
    try {
      let bytes = [];
      if (encoding.toLowerCase() === 'b') {
        const normalized = payload.replace(/\s+/g, '');
        const binary = atob(normalized);
        bytes = Array.from(binary, ch => ch.charCodeAt(0));
      } else {
        const qp = payload.replace(/_/g, ' ');
        for (let i = 0; i < qp.length; i++) {
          const ch = qp[i];
          if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(qp.slice(i + 1, i + 3))) {
            bytes.push(parseInt(qp.slice(i + 1, i + 3), 16));
            i += 2;
          } else {
            bytes.push(ch.charCodeAt(0));
          }
        }
      }
      return decodeTextWithCharset(bytes, charset);
    } catch {
      return match;
    }
  });
}
function decodePercentEncodedText(value = '', charset = 'utf-8') {
  if (FilenameLogic?.decodePercentEncodedText) return FilenameLogic.decodePercentEncodedText(value, charset);
  const input = String(value || '').replace(/\+/g, '%20');
  if (!/%[0-9a-fA-F]{2}/.test(input)) return input;
  if (/^utf-?8$/i.test(String(charset || 'utf-8'))) {
    try {
      return decodeURIComponent(input);
    } catch {
      // fall through to byte-based decoding
    }
  }
  const bytes = [];
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (ch === '%' && i + 2 < input.length && /^[0-9A-Fa-f]{2}$/.test(input.slice(i + 1, i + 3))) {
      bytes.push(parseInt(input.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(ch.charCodeAt(0) & 0xff);
    }
  }
  return decodeTextWithCharset(bytes, charset);
}
function ensureFilenameExtension(filename = '', url = '', mime = '') {
  if (FilenameLogic?.ensureFilenameExtension) return FilenameLogic.ensureFilenameExtension(filename, url, mime);
  const cleanName = sanitizeFilenamePart(decodeHttpFilename(filename));
  const ext = guessMediaExtension(url, mime);
  if (!cleanName) {
    return ext ? `media.${ext}` : 'media';
  }
  if (/\.[a-z0-9]{2,5}$/i.test(cleanName)) return cleanName;
  return ext ? `${cleanName}.${ext}` : cleanName;
}
function isLowQualityFilename(filename = '') {
  if (FilenameLogic?.isLowQualityFilename) return FilenameLogic.isLowQualityFilename(filename);
  const cleanName = sanitizeFilenamePart(filename).toLowerCase();
  if (!cleanName) return true;
  const basename = cleanName.replace(/\.[a-z0-9]{2,5}$/i, '');
  if (!basename) return true;
  if (/^(media|video|audio|play|stream|download|file)$/.test(basename)) return true;
  if (/^[a-f0-9]{16,}$/i.test(basename)) return true;
  if (/^\d{10,}$/.test(basename)) return true;
  return false;
}
function pickDisplayFilename(item = {}) {
  if (FilenameLogic?.pickDisplayFilename) return FilenameLogic.pickDisplayFilename(item);
  const preferred = sanitizeFilenamePart(item.filename || '');
  if (preferred && !isLowQualityFilename(preferred)) return preferred;
  const urlName = sanitizeFilenamePart(filenameFromUrl(item.resourceUrl || ''));
  if (urlName && !isLowQualityFilename(urlName)) return urlName;
  const pageTitle = sanitizeFilenamePart(item.pageTitle || '');
  if (pageTitle) return `${pageTitle}-${item.kind === 'audio' ? 'audio' : 'video'}`;
  const host = (() => {
    try { return new URL(item.pageUrl || item.referrer || item.resourceUrl || '').hostname.replace(/^www\./, ''); }
    catch { return 'media'; }
  })();
  return `${host || 'media'}-${item.kind === 'audio' ? 'audio' : 'video'}`;
}
function fallbackMediaFilename(item = {}) {
  if (FilenameLogic?.fallbackMediaFilename) return FilenameLogic.fallbackMediaFilename(item);
  return ensureFilenameExtension(pickDisplayFilename(item), item.resourceUrl, item.mime);
}
function shouldCaptureByExt(url, filename) {
  const exts = captureExts();
  if (!exts.length) return false;
  return exts.includes(extOf(url)) || exts.includes(extOf(filename));
}
function shouldCaptureByMime(mime) {
  if (!config.captureMime || !mime) return false;
  const m = mime.split(';')[0].trim().toLowerCase();
  return CAPTURE_MIME_PREFIXES.some(p => m.startsWith(p));
}
function decodeHttpFilename(value = '') {
  if (FilenameLogic?.decodeHttpFilename) return FilenameLogic.decodeHttpFilename(value);
  const text = decodeRfc2047Words(String(value || '').trim().replace(/^["']|["']$/g, ''));
  if (!text) return '';

  // Some servers wrongly use '+' for spaces in filenames.
  const normalized = text.replace(/\+/g, '%20');
  if (!/%[0-9a-fA-F]{2}/.test(normalized)) return text;

  try {
    return decodeURIComponent(normalized);
  } catch {
    return text;
  }
}
function filenameFromCD(cd) {
  if (FilenameLogic?.filenameFromCD) return FilenameLogic.filenameFromCD(cd);
  if (!cd) return '';
  let m = cd.match(/filename\*\s*=\s*([^;]+)/i);
  if (m) {
    const rawValue = m[1].trim().replace(/^["']|["']$/g, '');
    const parts = rawValue.match(/^([^']*)'[^']*'(.*)$/);
    const charset = parts?.[1] || 'utf-8';
    const encodedPart = parts ? parts[2] : rawValue;
    const decoded = decodePercentEncodedText(encodedPart, charset);
    if (decoded) return decoded;
  }
  m = cd.match(/filename\s*=\s*["']?([^"';\r\n]+)["']?/i);
  return m ? decodeHttpFilename(m[1].trim().replace(/["']/g,'')) : '';
}
function cleanExpired(map) {
  const now = Date.now();
  for (const [k, v] of map) if (now > v.expiresAt) map.delete(k);
}
function mediaKindOf(url = '', mime = '') {
  if (FilenameLogic?.mediaKindOf) return FilenameLogic.mediaKindOf(url, mime);
  const normalizedMime = String(mime).split(';')[0].trim().toLowerCase();
  if (normalizedMime.startsWith('video/')) return 'video';
  if (normalizedMime.startsWith('audio/')) return 'audio';
  const ext = extOf(url);
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  return '';
}
function isDirectMediaResource(url = '', mime = '') {
  return Boolean(mediaKindOf(url, mime));
}
function upsertMediaResource(item) {
  if (!item || typeof item.tabId !== 'number' || item.tabId < 0 || !item.resourceUrl) return null;
  const list = mediaResources[item.tabId] || [];
  const idx = list.findIndex(entry => entry.resourceUrl === item.resourceUrl);
  const normalized = {
    ...item,
    detectedAt: item.detectedAt || Date.now(),
    filename: fallbackMediaFilename(item) || '未命名媒体',
  };
  let changed = false;

  if (idx >= 0) {
    const current = list[idx];
    const next = { ...current };
    for (const [key, value] of Object.entries(normalized)) {
      if (value === undefined || value === '') continue;
      if (key === 'size' && current.size && value && value < current.size) continue;
      if (current[key] !== value) {
        next[key] = value;
        changed = true;
      }
    }
    list[idx] = next;
  } else {
    list.unshift(normalized);
    changed = true;
  }

  mediaResources[item.tabId] = list
    .sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0))
    .slice(0, MEDIA_CACHE_LIMIT);
  const resource = mediaResources[item.tabId].find(entry => entry.resourceUrl === item.resourceUrl) || null;
  return resource ? { resource, changed } : null;
}
function findMediaResourceById(id) {
  for (const tabId of Object.keys(mediaResources)) {
    const hit = (mediaResources[tabId] || []).find(item => item.id === id);
    if (hit) return hit;
  }
  return null;
}
function clearMediaResources(tabId) {
  if (typeof tabId === 'number' && tabId >= 0) {
    delete mediaResources[tabId];
    delete mediaBadgeCounts[tabId];
    updateActionBadgeForTab(tabId);
    return;
  }
  mediaResources = {};
  mediaBadgeCounts = {};
  chrome.action.setBadgeText({ text: '' });
}
function hasMediaResource(tabId, resourceUrl) {
  if (typeof tabId !== 'number' || tabId < 0 || !resourceUrl) return false;
  return (mediaResources[tabId] || []).some(item => item.resourceUrl === resourceUrl);
}
function hashString(str = '') {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}
function totalSizeFromHeaders(contentLength = '', contentRange = '') {
  const rangeMatch = String(contentRange || '').match(/\/(\d+)\s*$/);
  if (rangeMatch) return Number.parseInt(rangeMatch[1], 10) || 0;
  return Number.parseInt(contentLength, 10) || 0;
}
function escapeRegex(str = '') {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function getMediaCount(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return 0;
  return (mediaResources[tabId] || []).length;
}
function updateActionBadgeForTab(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  const count = getMediaCount(tabId);
  chrome.action.setBadgeBackgroundColor({ color: '#e05c2a', tabId });
  chrome.action.setBadgeTextColor?.({ color: '#ffffff', tabId });
  chrome.action.setBadgeText({ text: count > 0 ? String(Math.min(count, 99)) : '', tabId });
}
function getPreviewRuleId(tabId) {
  return 100000 + tabId;
}
function getTabSnapshot(tabId) {
  return new Promise(resolve => {
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
async function clearPreviewRule(tabId) {
  if (typeof tabId !== 'number' || tabId < 0) return;
  if (!chrome.declarativeNetRequest?.updateSessionRules) return;
  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [getPreviewRuleId(tabId)],
    });
  } catch {}
  delete previewRulesByTab[tabId];
}
async function preparePreviewRule(tabId, media) {
  if (typeof tabId !== 'number' || tabId < 0) throw new Error('预览标签页无效');
  if (!media?.resourceUrl) throw new Error('媒体地址无效');
  if (!chrome.declarativeNetRequest?.updateSessionRules) {
    throw new Error('当前浏览器不支持预览请求补头');
  }

  const requestHeaders = [];
  const headers = media.headers || {};
  const allowedHeaders = ['referer', 'origin', 'authorization', 'user-agent', 'cookie'];
  for (const key of allowedHeaders) {
    if (headers[key]) {
      requestHeaders.push({ header: key, operation: 'set', value: String(headers[key]) });
    }
  }

  if (requestHeaders.length) {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [getPreviewRuleId(tabId)],
      addRules: [{
        id: getPreviewRuleId(tabId),
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders,
        },
        condition: {
          regexFilter: `^${escapeRegex(media.resourceUrl)}$`,
          resourceTypes: ['media'],
          tabIds: [tabId],
        },
      }],
    });
    previewRulesByTab[tabId] = {
      mediaId: media.id,
      resourceUrl: media.resourceUrl,
    };
  } else {
    await clearPreviewRule(tabId);
  }
  return { ok: true, headersApplied: requestHeaders.map(item => item.header) };
}

// ── 层1a：记录请求头（含 Cookie、Referer）───────────────
chrome.webRequest.onSendHeaders.addListener(
  (details) => {
    if (!config.autoCapture) return;
    const headers = {};
    for (const h of details.requestHeaders || []) headers[h.name.toLowerCase()] = h.value;
    requestHeadersCache.set(details.url, { headers, expiresAt: Date.now() + 60000 });
    cleanExpired(requestHeadersCache);
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders']
);

// ── 层1b：检测响应头，标记应拦截的 URL ──────────────────
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (!config.autoCapture) return;

    const hdrs = {};
    let cd = '', ct = '';
    for (const h of details.responseHeaders || []) {
      hdrs[h.name.toLowerCase()] = h.value;
      if (h.name.toLowerCase() === 'content-disposition') cd = h.value;
      if (h.name.toLowerCase() === 'content-type') ct = h.value;
    }

    const isAttachment = /attachment/i.test(cd);
    const filenameFromHeader = filenameFromCD(cd);
    const urlFilename = filenameFromUrl(details.url);
    const filename = decodeHttpFilename(filenameFromHeader || urlFilename);
    const mime = ct.split(';')[0].trim().toLowerCase();

    const byMime = shouldCaptureByMime(mime);
    const byExt  = shouldCaptureByExt(details.url, filename);
    const byCD   = isAttachment;  // Content-Disposition: attachment 直接拦截

    if (!byMime && !byExt && !byCD) return;

    markedUrls.set(details.url, {
      filename,
      mime,
      contentDisposition: cd,
      tabId: details.tabId,
      expiresAt: Date.now() + 30000,
    });
    cleanExpired(markedUrls);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

chrome.webRequest.onHeadersReceived.addListener(
  async (details) => {
    if (details.tabId < 0) return;

    const hdrs = {};
    let ct = '';
    let cd = '';
    let len = '';
    let contentRange = '';
    for (const h of details.responseHeaders || []) {
      const name = h.name.toLowerCase();
      hdrs[name] = h.value;
      if (name === 'content-type') ct = h.value || '';
      if (name === 'content-disposition') cd = h.value || '';
      if (name === 'content-length') len = h.value || '';
      if (name === 'content-range') contentRange = h.value || '';
    }

    const mime = ct.split(';')[0].trim().toLowerCase();
    if (!isDirectMediaResource(details.url, mime)) return;
    if (details.statusCode === 206 && hasMediaResource(details.tabId, details.url)) return;

    const tabSnapshot = await getTabSnapshot(details.tabId);
    const reqHeaders = requestHeadersCache.get(details.url)?.headers || {};
    const filename = sanitizeFilenamePart(filenameFromCD(cd) || filenameFromUrl(details.url) || '');
    const mediaResult = upsertMediaResource({
      id: `media_${details.tabId}_${hashString(details.url)}`,
      tabId: details.tabId,
      frameId: details.frameId,
      resourceUrl: details.url,
      pageUrl: tabSnapshot.url || details.initiator || reqHeaders.referer || '',
      pageTitle: tabSnapshot.title || '',
      filename,
      mime,
      contentDisposition: cd,
      size: totalSizeFromHeaders(len, contentRange),
      headers: reqHeaders,
      origin: reqHeaders.origin || deriveOrigin(details.url, reqHeaders.referer || ''),
      referrer: reqHeaders.referer || '',
      kind: mediaKindOf(details.url, mime),
      detectedAt: Date.now(),
    });

    if (mediaResult?.changed) {
      mediaBadgeCounts[details.tabId] = getMediaCount(details.tabId);
      updateActionBadgeForTab(details.tabId);
      broadcastUpdate();
    }
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders']
);

// ── 层2：downloads.onCreated（兜底 + 执行取消）──────────
chrome.downloads.onCreated.addListener(async (item) => {
  await configReady;
  if (!config.autoCapture) return;
  if (item.state === 'complete') return;

  const url = item.finalUrl || item.url;
  const browserFilename = item.filename ? decodeHttpFilename(item.filename.split(/[\\/]/).pop()) : '';

  const marked = markedUrls.get(url) || markedUrls.get(item.url);
  const byExt  = shouldCaptureByExt(url, browserFilename);

  if (!marked && !byExt) return;

  // 取消浏览器下载
  chrome.downloads.cancel(item.id, () => chrome.downloads.erase({ id: item.id }));

  const filename = decodeHttpFilename(marked?.filename || browserFilename || filenameFromUrl(url) || '');
  const reqHeaders = requestHeadersCache.get(url)?.headers
                  || requestHeadersCache.get(item.url)?.headers || {};

  if (marked) { markedUrls.delete(url); markedUrls.delete(item.url); }

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
    addedAt: Date.now()
  };

  if (shouldConfirmBeforeSend()) {
    pendingDownloads[key] = taskInfo;
    broadcastUpdate();
    chrome.action.openPopup().catch(() => {});
  } else {
    sendTask(taskInfo);
  }
});

// ── sendToAria2 ───────────────────────────────────────────
async function sendToAria2(taskInfo, extraOpts = {}) {
  try {
    const gid = await addUriToAria2(taskInfo.url, taskInfo.filename, taskInfo.headers || {}, extraOpts);
    tasks[gid] = { gid, url: taskInfo.url, filename: taskInfo.filename, addedAt: taskInfo.addedAt || Date.now(), status: 'active', provider: 'aria2' };
    delete hiddenTaskGids[gid];
    broadcastUpdate();
    if (config.notification) {
      chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: `已发送到 ${getDownloaderLabel()}`, message: taskInfo.filename || taskInfo.url.slice(0, 80) });
    }
    return { ok: true, gid };
  } catch (err) {
    if (config.notification) {
      chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon48.png', title: `${getDownloaderLabel()} 连接失败`, message: err.message });
    }
    return { ok: false, error: err.message };
  }
}

// ── Poll ─────────────────────────────────────────────────
async function pollTasks() {
  await configReady;
  for (const gid of Object.keys(tasks)) {
    if (tasks[gid]?.provider && tasks[gid].provider !== 'aria2') continue;
    try {
      const s = await getAria2Status(gid);
      tasks[gid] = {
        ...tasks[gid], status: s.status,
        totalLength: parseInt(s.totalLength) || 0,
        completedLength: parseInt(s.completedLength) || 0,
        downloadSpeed: parseInt(s.downloadSpeed) || 0,
        connections: parseInt(s.connections) || 0,
        filePath: s.files?.[0]?.path || tasks[gid].filePath || '',
        dirPath: dirname(s.files?.[0]?.path || tasks[gid].filePath || ''),
        filename: s.files?.[0]?.path?.split(/[\\/]/).pop() || tasks[gid].filename,
      };
    } catch {}
  }
  broadcastUpdate();
}
setInterval(pollTasks, 1200);

function broadcastUpdate() {
  chrome.runtime.sendMessage({
    type: 'TASKS_UPDATE',
    tasks,
    pending: pendingDownloads,
    media: mediaResources,
    hiddenTaskGids: Object.keys(hiddenTaskGids),
  }).catch(() => {});
}

// ── Message handler ───────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    await configReady;
    switch (msg.type) {
      case 'GET_STATE': sendResponse({ tasks, pending: pendingDownloads, media: mediaResources, config, hiddenTaskGids: Object.keys(hiddenTaskGids) }); break;
      case 'CONFIRM_DOWNLOAD': {
        const info = pendingDownloads[msg.key];
        if (info) {
          const result = await sendTask({ ...info, filename: msg.filename || info.filename }, msg.opts || {});
          if (result?.ok) delete pendingDownloads[msg.key];
          sendResponse(result);
          broadcastUpdate();
        }
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
        }, msg.opts || {}));
        break;
      case 'ADD_MEDIA_TASK': {
        const media = findMediaResourceById(msg.id);
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
        }, msg.opts || {}));
        break;
      }
      case 'GET_MEDIA_ITEM': {
        const media = findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: '媒体资源不存在或已过期' });
          break;
        }
        sendResponse({ ok: true, media });
        break;
      }
      case 'PREPARE_MEDIA_PREVIEW': {
        const media = findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false, error: '媒体资源不存在或已过期' });
          break;
        }
        try {
          const result = await preparePreviewRule(msg.tabId, media);
          sendResponse({ ok: true, ...result });
        } catch (error) {
          sendResponse({ ok: false, error: error?.message || '预览请求补头失败' });
        }
        break;
      }
      case 'CLEAR_MEDIA_PREVIEW': {
        await clearPreviewRule(msg.tabId);
        sendResponse({ ok: true });
        break;
      }
      case 'UPDATE_MEDIA_METADATA': {
        const media = findMediaResourceById(msg.id);
        if (!media) {
          sendResponse({ ok: false });
          break;
        }
        Object.assign(media, {
          duration: typeof msg.duration === 'number' ? msg.duration : media.duration,
          width: typeof msg.width === 'number' ? msg.width : media.width,
          height: typeof msg.height === 'number' ? msg.height : media.height,
        });
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      }
      case 'CLEAR_MEDIA': {
        clearMediaResources(msg.tabId);
        broadcastUpdate();
        sendResponse({ ok: true });
        break;
      }
      case 'CLEAR_MEDIA_BADGE': {
        if (typeof msg.tabId === 'number' && msg.tabId >= 0) {
          updateActionBadgeForTab(msg.tabId);
        }
        sendResponse({ ok: true });
        break;
      }
      case 'PAUSE_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) await aria2Call('pause', [msg.gid]).catch(()=>{});
        sendResponse({ ok: true }); break;
      case 'RESUME_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) await aria2Call('unpause', [msg.gid]).catch(()=>{});
        sendResponse({ ok: true }); break;
      case 'REMOVE_TASK':
        if (tasks[msg.gid]?.provider === 'aria2' || !tasks[msg.gid]?.provider) {
          await aria2Call('remove', [msg.gid]).catch(()=>{});
          await aria2Call('removeDownloadResult', [msg.gid]).catch(()=>{});
        }
        delete hiddenTaskGids[msg.gid];
        delete tasks[msg.gid]; broadcastUpdate(); sendResponse({ ok: true }); break;
      case 'TEST_CONNECTION':
      if (config.downloaderType === 'abdownload') {
        try {
          const endpoint = buildExternalEndpoint().replace(/\/start-headless-download$|\/add$/, '/queues');
          const res = await fetch(endpoint);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          sendResponse({
            ok: true,
            mode: 'abdownload',
            message: `已连接 ${endpoint}`
          });
        } catch (e) {
          sendResponse({
            ok: false,
            mode: 'abdownload',
            error: e.message
          });
        }
        break;
      }
      if (config.downloaderType === 'neatdm') {
        try {
          sendResponse(await testNeatdmConnection());
        } catch (e) {
          sendResponse({
            ok: false,
            mode: 'neatdm',
            error: e.message
          });
        }
        break;
      }
        try { sendResponse({ ok: true, stat: await getAria2GlobalStat(), mode: 'aria2' }); }
        catch (e) { sendResponse({ ok: false, error: e.message, mode: 'aria2' }); }
        break;
      case 'SAVE_CONFIG':
        await chrome.storage.sync.set(msg.config);
        config = { ...config, ...msg.config };
        sendResponse({ ok: true }); break;
    }
  })();
  return true;
});

// ── Context menu ──────────────────────────────────────────
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
  const reqH = requestHeadersCache.get(url)?.headers || {};
  await sendTask({ url, filename: url.split('?')[0].split('/').pop() || '', headers: reqH, addedAt: Date.now() });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  delete mediaResources[tabId];
  delete mediaBadgeCounts[tabId];
  clearPreviewRule(tabId);
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  updateActionBadgeForTab(tabId);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    delete mediaResources[tabId];
    delete mediaBadgeCounts[tabId];
    updateActionBadgeForTab(tabId);
    clearPreviewRule(tabId);
    broadcastUpdate();
  }
});

// ── Startup ───────────────────────────────────────────────
chrome.runtime.onStartup.addListener(async () => {
  await configReady;
  if (config.downloaderType !== 'aria2') return;
  try {
    for (const s of await aria2Call('tellActive')) {
      const filePath = s.files?.[0]?.path || '';
      tasks[s.gid] = {
        gid: s.gid,
        url: s.files?.[0]?.uris?.[0]?.uri || '',
        filename: filePath.split(/[\\/]/).pop() || '',
        filePath,
        dirPath: dirname(filePath),
        addedAt: Date.now(),
        status: s.status
      };
    }
  } catch {}
});
