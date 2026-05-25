const i18n = globalThis.Localization || {};
const SEND_CLICK_LOCK_MS = 900;
const t = i18n.t || ((key, substitutions, fallback = key) => {
  if (fallback && substitutions !== undefined) {
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
  }
  return fallback || key;
});

function qs(name) {
  return new URLSearchParams(location.search).get(name) || '';
}

function loadLanguagePreference() {
  return new Promise((resolve) => {
    try {
      if (!chrome?.storage?.sync?.get) {
        resolve('auto');
        return;
      }
      chrome.storage.sync.get({ language: 'auto' }, (stored) => {
        resolve(stored?.language || 'auto');
      });
    } catch {
      resolve('auto');
    }
  });
}

function fmt(bytes) {
  if (!bytes || bytes <= 0) return t('unknownSize', undefined, '大小未知');
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}

function mediaKindText(media) {
  return media.kind === 'audio'
    ? t('mediaKindAudio', undefined, '音频')
    : t('mediaKindVideo', undefined, '视频');
}

function buildSubtitle(media) {
  const parts = [mediaKindText(media), fmt(media.size)];
  if (media.kind === 'video' && media.width && media.height) parts.push(`${media.width}×${media.height}`);
  if (media.mime) parts.push(media.mime);
  return parts.filter(Boolean).join(' · ');
}

function esc(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function setStatus(message, type = '') {
  const el = document.getElementById('status');
  el.textContent = message || '';
  el.className = `status${type ? ` ${type}` : ''}`;
}

function setTopAlert(message, { shake = false } = {}) {
  const el = document.getElementById('topAlert');
  if (!el) return;
  el.textContent = message || '';
  el.classList.toggle('show', !!message);
  el.classList.remove('shake');
  if (!message || !shake) return;
  void el.offsetWidth;
  el.classList.add('shake');
}

let toastTimer = null;
let sendingToDownloader = false;
let currentPreviewFilename = '';
function showToast(message, type = 'ok') {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = type === 'fail' ? '×' : '✓';
  el.setAttribute('aria-label', message || '');
  el.className = `toast ${type} show`;
  toastTimer = setTimeout(() => {
    el.classList.remove('show');
  }, 2200);
}

function copyText(text) {
  return navigator.clipboard.writeText(text);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getMediaItem(id) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'GET_MEDIA_ITEM', id }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || t('cannotReadMediaInfo', undefined, '无法读取媒体信息') });
        return;
      }
      resolve(res || { ok: false, error: t('cannotReadMediaInfo', undefined, '无法读取媒体信息') });
    });
  });
}

function getCurrentTabId() {
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      resolve(tabs?.[0]?.id ?? null);
    });
  });
}

function preparePreview(id, tabId) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'PREPARE_MEDIA_PREVIEW', id, tabId }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || t('previewPatchFailed', undefined, '预览请求补头失败') });
        return;
      }
      resolve(res || { ok: false, error: t('previewPatchFailed', undefined, '预览请求补头失败') });
    });
  });
}

function clearPreview(tabId) {
  if (typeof tabId !== 'number') return;
  chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_PREVIEW', tabId }, () => {});
}

function sendToDownloader(id, filename = '') {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'ADD_MEDIA_TASK', id, filename }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || t('sendToDownloaderFailed', undefined, '发送到下载器失败。') });
        return;
      }
      resolve(res || { ok: false, error: t('sendToDownloaderFailed', undefined, '发送到下载器失败。') });
    });
  });
}

function setPreviewFilename(filename, fallback = '') {
  const nextFilename = String(filename || '').trim() || fallback || t('previewTitle', undefined, '媒体预览');
  currentPreviewFilename = nextFilename;
  const titleEl = document.getElementById('title');
  if (titleEl) titleEl.textContent = nextFilename;
  const audioTitleEl = document.querySelector('.audio-title');
  if (audioTitleEl) audioTitleEl.textContent = nextFilename;
  document.title = t('previewDocumentTitle', [nextFilename], `${nextFilename} - Downlink`);
}

function setSourceTitle(media) {
  const el = document.getElementById('sourceTitle');
  if (!el) return;
  const pageTitle = String(media.pageTitle || '').trim();
  el.textContent = pageTitle;
  el.dataset.label = t('sourceTitleLabel', undefined, '来源：');
  el.title = pageTitle;
  el.hidden = !pageTitle;
}

function setupFilenameEditor(media) {
  const titleEl = document.getElementById('title');
  const inputEl = document.getElementById('titleInput');
  const editBtn = document.getElementById('editFilenameBtn');
  if (!titleEl || !inputEl || !editBtn) return;

  const fallback = media.filename || t('previewTitle', undefined, '媒体预览');
  let cancelEdit = false;

  function openEditor() {
    cancelEdit = false;
    inputEl.value = currentPreviewFilename || fallback;
    titleEl.hidden = true;
    inputEl.hidden = false;
    inputEl.focus();
    inputEl.select();
  }

  function closeEditor() {
    if (!inputEl.hidden) {
      const nextFilename = cancelEdit ? currentPreviewFilename : inputEl.value;
      setPreviewFilename(nextFilename, fallback);
      inputEl.hidden = true;
      titleEl.hidden = false;
    }
    cancelEdit = false;
  }

  editBtn.onclick = () => {
    if (inputEl.hidden) openEditor();
    else closeEditor();
  };
  inputEl.onblur = closeEditor;
  inputEl.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      inputEl.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancelEdit = true;
      inputEl.blur();
    }
  };
}

function renderHeaders(headers = {}) {
  const container = document.getElementById('headerList');
  if (!container) return;
  container.innerHTML = '';
  const entries = Object.entries(headers).filter(([, value]) => value);
  if (!entries.length) {
    container.innerHTML = `<div class="header-item"><div class="header-value">${esc(t('noHeadersCaptured', undefined, '当前没有捕获到可用请求头。'))}</div></div>`;
    return;
  }
  entries.forEach(([key, value]) => {
    const item = document.createElement('div');
    item.className = 'header-item';
    item.innerHTML = `
      <div class="header-key">${esc(key)}</div>
      <div class="header-value">${esc(value)}</div>
    `;
    container.appendChild(item);
  });
}

function mountPlayer(media) {
  const playerWrap = document.getElementById('playerWrap');
  const tagName = media.kind === 'audio' ? 'audio' : 'video';
  playerWrap.innerHTML = '';
  const player = document.createElement(tagName);
  player.controls = true;
  player.preload = 'metadata';
  if (tagName === 'video') player.playsInline = true;
  if (tagName === 'audio') {
    const panel = document.createElement('div');
    panel.className = 'audio-panel';
    panel.innerHTML = `
      <div class="audio-head">
        <div class="audio-icon">
          <svg viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path d="M8 5.7v8.6a1.8 1.8 0 1 1-1.2-1.7V6.9l6.8-1.5v7.3a1.8 1.8 0 1 1-1.2-1.7V4.2L8 5.7Z" fill="currentColor"/>
          </svg>
        </div>
        <div class="audio-copy">
          <div class="audio-title">${esc(currentPreviewFilename || media.filename || t('previewTitle', undefined, '媒体预览'))}</div>
          <div class="audio-sub">${esc(buildSubtitle(media))}</div>
        </div>
      </div>
    `;
    panel.appendChild(player);
    playerWrap.appendChild(panel);
  } else {
    playerWrap.appendChild(player);
  }

  player.addEventListener('loadedmetadata', () => {
    setStatus(t('mediaLoaded', undefined, '媒体已加载，可以开始预览。'), 'ok');
  }, { once: true });
  player.addEventListener('error', () => {
    setStatus(t('previewFailedDetail', undefined, '预览失败。该资源可能依赖额外请求头、Cookie 或防盗链校验。'), 'fail');
  }, { once: true });

  player.src = media.resourceUrl;
}

function setupCommandCopy() {
  document.querySelectorAll('[data-copy-command]').forEach((button) => {
    button.addEventListener('click', async () => {
      const command = button.dataset.copyCommand || '';
      try {
        await copyText(command);
        const message = t('copiedCommand', undefined, '已复制命令。');
        setStatus(message, 'ok');
        showToast(message, 'ok');
      } catch {
        const message = t('copyCommandFailed', undefined, '复制命令失败。');
        setStatus(message, 'fail');
        showToast(message, 'fail');
      }
    });
  });
}

function renderMedia(media) {
  setPreviewFilename(media.filename || t('previewTitle', undefined, '媒体预览'), t('previewTitle', undefined, '媒体预览'));
  setupFilenameEditor(media);
  document.getElementById('subtitle').textContent = buildSubtitle(media);
  setSourceTitle(media);
  const infoFilename = document.getElementById('infoFilename');
  const infoUrl = document.getElementById('infoUrl');
  const infoPageUrl = document.getElementById('infoPageUrl');
  if (infoFilename) infoFilename.textContent = media.filename || '-';
  if (infoUrl) infoUrl.textContent = media.resourceUrl || '-';
  if (infoPageUrl) infoPageUrl.textContent = media.pageUrl || media.referrer || '-';

  const chips = document.getElementById('metaChips');
  chips.innerHTML = `
    <span class="chip kind">${mediaKindText(media)}</span>
    <span class="chip">${esc(fmt(media.size))}</span>
    ${media.kind === 'video' && media.width && media.height ? `<span class="chip">${esc(`${media.width}×${media.height}`)}</span>` : ''}
    ${media.mime ? `<span class="chip">${esc(media.mime)}</span>` : ''}
  `;

  renderHeaders(media.headers || {});

  document.getElementById('copyBtn').onclick = async () => {
    try {
      await copyText(media.resourceUrl || '');
      setTopAlert('');
      const message = t('copiedMediaLink', undefined, '已复制媒体链接。');
      setStatus(message, 'ok');
      showToast(message, 'ok');
    } catch {
      const message = t('copyLinkFailed', undefined, '复制链接失败。');
      setStatus(message, 'fail');
      showToast(message, 'fail');
    }
  };

  document.getElementById('sendBtn').onclick = async () => {
    if (sendingToDownloader) return;
    const sendBtn = document.getElementById('sendBtn');
    sendingToDownloader = true;
    const lockStartedAt = Date.now();
    if (sendBtn) sendBtn.disabled = true;
    setTopAlert('');
    setStatus(t('sendingToDownloader', undefined, '正在发送到下载器…'));
    try {
      const result = await sendToDownloader(media.id, currentPreviewFilename);
      if (result.ok) {
        setTopAlert('');
        const message = t('sentToDownloader', undefined, '已发送到下载器。');
        setStatus(message, 'ok');
        showToast(message, 'ok');
        return;
      }
      const message = result.error || t('sendToDownloaderFailed', undefined, '发送到下载器失败。');
      setTopAlert(message, { shake: true });
      setStatus('', '');
      showToast(message, 'fail');
    } finally {
      const remainingLockMs = Math.max(0, SEND_CLICK_LOCK_MS - (Date.now() - lockStartedAt));
      if (remainingLockMs > 0) await wait(remainingLockMs);
      sendingToDownloader = false;
      if (sendBtn) sendBtn.disabled = false;
    }
  };
}

(async () => {
  i18n.setLocalePreference?.(await loadLanguagePreference());
  i18n.applyTranslations?.(document);
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('aria-label', el.getAttribute('title') || '');
  });
  setupCommandCopy();
  document.getElementById('title').textContent = t('previewTitle', undefined, '媒体预览');
  document.getElementById('subtitle').textContent = t('previewLoading', undefined, '正在加载媒体信息…');
  const id = qs('id');
  if (!id) {
    setStatus(t('missingMediaId', undefined, '缺少媒体标识。'), 'fail');
    return;
  }
  setStatus(t('readingMediaInfo', undefined, '正在读取媒体信息…'));
  const result = await getMediaItem(id);
  if (!result.ok || !result.media) {
    setStatus(result.error || t('mediaExpired', undefined, '媒体资源不存在或已过期。'), 'fail');
    return;
  }
  const tabId = await getCurrentTabId();
  const prepared = await preparePreview(id, tabId);
  const appliedHeadersEl = document.getElementById('appliedHeaders');
  if (!appliedHeadersEl) {
    // Header patching is an implementation detail; the streamlined preview page does not expose it.
  } else if (prepared.ok) {
    appliedHeadersEl.textContent = '';
  } else {
    appliedHeadersEl.textContent = prepared.error || t('previewPatchFailed', undefined, '预览请求补头失败');
  }
  renderMedia(result.media);
  mountPlayer(result.media);
  window.addEventListener('beforeunload', () => clearPreview(tabId), { once: true });
})();
