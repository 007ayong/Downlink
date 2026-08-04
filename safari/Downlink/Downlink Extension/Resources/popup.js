// popup.js — Downlink UI core helpers

const popupUi = globalThis.PopupUI || {};
const i18n = globalThis.Localization || {};
const t = i18n.t || ((key, substitutions, fallback = key) => {
  if (fallback && substitutions !== undefined) {
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
  }
  return fallback || key;
});

const POPUP_DEFAULT_CAPTURE_EXTENSIONS = globalThis.ConfigDefaults.DEFAULT_CAPTURE_EXTENSIONS;
const POPUP_DEFAULT_MEDIA_SNIFFING_BLACKLIST = 'x.com,youtube.com';
const POPUP_DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST = 'web.telegram.org';

const POPUP_DEFAULT_CONFIG = {
  language: 'auto',
  downloaderType: 'aria2',
  aria2Rpc: 'http://localhost:6800/jsonrpc',
  aria2Secret: '',
  aria2Silent: false,
  aria2CustomSaveEnabled: false,
  aria2SaveLocations: [],
  useMotrixNext: false,
  motrixNextPort: '16801',
  motrixNextSecret: '',
  gopeedApi: 'http://127.0.0.1:9999',
  gopeedToken: '',
  gopeedSilent: false,
  externalLauncherName: 'AB DM',
  externalLauncherHost: 'localhost',
  externalLauncherPort: '15151',
  abDownloadSilent: false,
  autoCapture: true,
  mediaSniffingBlacklist: POPUP_DEFAULT_MEDIA_SNIFFING_BLACKLIST,
  downloadInterceptionBlacklist: POPUP_DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST,
  captureExtensions: POPUP_DEFAULT_CAPTURE_EXTENSIONS,
};

const MACOS_TAG_COLORS = ['#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#007aff', '#af52de', '#8e8e93'];

function normalizePopupConfig(cfg = {}) {
  const next = { ...POPUP_DEFAULT_CONFIG, ...(cfg || {}) };
  next.aria2CustomSaveEnabled = !!next.aria2CustomSaveEnabled;
  next.aria2SaveLocations = normalizeAria2SaveLocations(next.aria2SaveLocations);
  next.externalLauncherHost = 'localhost';
  delete next.skipSmallDownloads;
  delete next.smallDownloadThresholdBytes;
  return next;
}

function normalizeLocationColor(color = '') {
  const value = String(color || '').trim().toLowerCase();
  return MACOS_TAG_COLORS.includes(value) ? value : '#ff9500';
}

function normalizeAria2SaveLocations(locations = []) {
  if (!Array.isArray(locations)) return [];
  return locations
    .map((item) => ({
      name: String(item?.name || '').trim(),
      path: String(item?.path || '').trim(),
      color: normalizeLocationColor(item?.color),
    }))
    .filter((item) => item.name && item.path);
}

let currentConfig = normalizePopupConfig();
let isLoadingSettings = false;
let autoSaveTimer = null;
let saveFeedbackTimer = null;
let toastTimer = null;
let currentState = { tasks: {}, pending: {}, media: {}, pausedTabs: [], mediaBlacklistBlockedTabs: [] };
let savedConfig = normalizePopupConfig();
let currentTabId = null;
let lastRenderedMediaKey = '';
let previousMediaCount = 0;
let lastAutoSwitchedMediaCount = 0;
let hiddenTaskGids = new Set();
let autoConnectionCheckTimer = null;
let autoConnectionCheckInFlight = null;
let autoConnectionCheckSettled = null;
let headerStatusState = { state: 'checking', stat: null, message: '' };
let headerStatusMinUntil = 0;
let headerStatusTransitionTimer = null;

const {
  DEFAULT_HEADER_LOGO,
  buildMediaRenderKey,
  decodeDisplayFilename,
  escHtml,
  fmt,
  fmtSpeed,
  getDownloaderName,
  getFileCategory,
  getFileIcon,
  getHeaderLogoSrc,
  getSendLabel,
  getStateLabel,
  handleTaskIconError,
  inferMediaKindFromMetadata,
  mediaDurationLabel,
  mediaKindLabel,
  mediaResolutionLabel,
  shouldAutoSwitchToMediaPanel,
} = popupUi;

function switchTab(tabName) {
  const target = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (target) target.click();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const input = document.createElement('textarea');
    input.value = text;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.focus();
    input.select();
    const ok = document.execCommand('copy');
    input.remove();
    return ok;
  }
}

function showToast(message) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

function getCurrentTabId() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs?.[0]?.id ?? null);
    });
  });
}

function openPreviewTab(item) {
  const url = chrome.runtime.getURL(`preview.html?id=${encodeURIComponent(item.id)}`);
  chrome.tabs.create({ url }, (tab) => {
    if (chrome.runtime.lastError) {
      showToast(chrome.runtime.lastError.message || t('openPreviewFailed', undefined, '打开预览页失败'));
      return;
    }
    const previewTabId = tab?.id;
    if (typeof previewTabId !== 'number') {
      showToast(item.kind === 'audio'
        ? t('previewOpenedAudio', undefined, '已打开音频预览页')
        : t('previewOpenedVideo', undefined, '已打开视频预览页'));
      return;
    }
    chrome.runtime.sendMessage({ type: 'PREPARE_MEDIA_PREVIEW', id: item.id, tabId: previewTabId }, (res) => {
      if (!res?.ok) {
        showToast(res?.error || t('previewPatchFailed', undefined, '预览请求补头失败'));
        return;
      }
      const applied = Array.isArray(res.headersApplied) && res.headersApplied.length
        ? t('previewHeadersApplied', [res.headersApplied.join(', ')], `，已补头：${res.headersApplied.join(', ')}`)
        : '';
      const openedText = item.kind === 'audio'
        ? t('previewOpenedAudio', undefined, '已打开音频预览页')
        : t('previewOpenedVideo', undefined, '已打开视频预览页');
      showToast(`${openedText}${applied}`);
    });
  });
}

globalThis.DEFAULT_HEADER_LOGO = DEFAULT_HEADER_LOGO;
globalThis.currentConfig = currentConfig;
globalThis.isLoadingSettings = isLoadingSettings;
globalThis.autoSaveTimer = autoSaveTimer;
globalThis.saveFeedbackTimer = saveFeedbackTimer;
globalThis.toastTimer = toastTimer;
globalThis.currentState = currentState;
globalThis.savedConfig = savedConfig;
globalThis.currentTabId = currentTabId;
globalThis.lastRenderedMediaKey = lastRenderedMediaKey;
globalThis.previousMediaCount = previousMediaCount;
globalThis.lastAutoSwitchedMediaCount = lastAutoSwitchedMediaCount;
globalThis.hiddenTaskGids = hiddenTaskGids;
globalThis.autoConnectionCheckTimer = autoConnectionCheckTimer;
globalThis.autoConnectionCheckInFlight = autoConnectionCheckInFlight;
globalThis.autoConnectionCheckSettled = autoConnectionCheckSettled;
globalThis.headerStatusState = headerStatusState;
globalThis.headerStatusMinUntil = headerStatusMinUntil;
globalThis.headerStatusTransitionTimer = headerStatusTransitionTimer;
globalThis.buildMediaRenderKey = buildMediaRenderKey;
globalThis.copyText = copyText;
globalThis.decodeDisplayFilename = decodeDisplayFilename;
globalThis.escHtml = escHtml;
globalThis.fmt = fmt;
globalThis.fmtSpeed = fmtSpeed;
globalThis.getCurrentTabId = getCurrentTabId;
globalThis.getDownloaderName = getDownloaderName;
globalThis.getFileCategory = getFileCategory;
globalThis.getFileIcon = getFileIcon;
globalThis.getHeaderLogoSrc = getHeaderLogoSrc;
globalThis.getSendLabel = getSendLabel;
globalThis.getStateLabel = getStateLabel;
globalThis.handleTaskIconError = handleTaskIconError;
globalThis.inferMediaKindFromMetadata = inferMediaKindFromMetadata;
globalThis.mediaDurationLabel = mediaDurationLabel;
globalThis.mediaKindLabel = mediaKindLabel;
globalThis.mediaResolutionLabel = mediaResolutionLabel;
globalThis.openPreviewTab = openPreviewTab;
globalThis.shouldAutoSwitchToMediaPanel = shouldAutoSwitchToMediaPanel;
globalThis.showToast = showToast;
globalThis.switchTab = switchTab;

// Safari：broadcastUpdate 的 sendMessage 送达不稳定，仅在有待确认下载时轮询同步，
// 避免与 TASKS_UPDATE 叠加导致重复渲染。
(function () {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  let timer = null;
  function stopPolling() { if (timer) { clearInterval(timer); timer = null; } }
  function startPolling() { if (timer) return; timer = setInterval(poll, 1200); poll(); }
  function poll() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
        if (chrome.runtime.lastError || !res) return;
        const render = (typeof globalThis.renderState === 'function') ? globalThis.renderState : null;
        if (!render) return;
        const cfg = (typeof globalThis.normalizePopupConfig === 'function') ? globalThis.normalizePopupConfig(res.config) : res.config;
        render({ ...res, config: cfg });
        const pendingCount = Object.keys(res.pending || {}).length;
        if (pendingCount === 0) stopPolling();
      });
    } catch (e) { /* ignore */ }
  }
  // 监听 TASKS_UPDATE：有 pending 时启动轮询做兜底，无 pending 时停止
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'TASKS_UPDATE') {
      const pendingCount = Object.keys(msg.pending || {}).length;
      if (pendingCount > 0) startPolling(); else stopPolling();
    }
  });
  // 初始拉一次，若有 pending 则启动轮询
  poll();
})();
