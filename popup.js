// popup.js — Downlink UI core helpers

const popupUi = globalThis.PopupUI || {};

let currentConfig = {};
let isLoadingSettings = false;
let autoSaveTimer = null;
let saveFeedbackTimer = null;
let toastTimer = null;
let currentState = { tasks: {}, pending: {}, media: {} };
let currentTabId = null;
let lastRenderedMediaKey = '';
let previousMediaCount = 0;
let lastAutoSwitchedMediaCount = 0;
let hiddenTaskGids = new Set();
let autoConnectionCheckTimer = null;
let autoConnectionCheckInFlight = null;
let autoConnectionCheckSettled = null;

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
      showToast(chrome.runtime.lastError.message || '打开预览页失败');
      return;
    }
    const previewTabId = tab?.id;
    if (typeof previewTabId !== 'number') {
      showToast(item.kind === 'audio' ? '已打开音频预览页' : '已打开视频预览页');
      return;
    }
    chrome.runtime.sendMessage({ type: 'PREPARE_MEDIA_PREVIEW', id: item.id, tabId: previewTabId }, (res) => {
      if (!res?.ok) {
        showToast(res?.error || '预览请求补头失败');
        return;
      }
      const applied = Array.isArray(res.headersApplied) && res.headersApplied.length
        ? `，已补头：${res.headersApplied.join(', ')}`
        : '';
      showToast(`${item.kind === 'audio' ? '已打开音频预览页' : '已打开视频预览页'}${applied}`);
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
globalThis.currentTabId = currentTabId;
globalThis.lastRenderedMediaKey = lastRenderedMediaKey;
globalThis.previousMediaCount = previousMediaCount;
globalThis.lastAutoSwitchedMediaCount = lastAutoSwitchedMediaCount;
globalThis.hiddenTaskGids = hiddenTaskGids;
globalThis.autoConnectionCheckTimer = autoConnectionCheckTimer;
globalThis.autoConnectionCheckInFlight = autoConnectionCheckInFlight;
globalThis.autoConnectionCheckSettled = autoConnectionCheckSettled;
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
globalThis.mediaKindLabel = mediaKindLabel;
globalThis.mediaResolutionLabel = mediaResolutionLabel;
globalThis.openPreviewTab = openPreviewTab;
globalThis.shouldAutoSwitchToMediaPanel = shouldAutoSwitchToMediaPanel;
globalThis.showToast = showToast;
globalThis.switchTab = switchTab;
