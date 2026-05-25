const i18n = globalThis.Localization || {};
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

function copyText(text) {
  return navigator.clipboard.writeText(text);
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

function sendToDownloader(id) {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: 'ADD_MEDIA_TASK', id }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message || t('sendToDownloaderFailed', undefined, '发送到下载器失败。') });
        return;
      }
      resolve(res || { ok: false, error: t('sendToDownloaderFailed', undefined, '发送到下载器失败。') });
    });
  });
}

function renderHeaders(headers = {}) {
  const container = document.getElementById('headerList');
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
  playerWrap.appendChild(player);

  player.addEventListener('loadedmetadata', () => {
    setStatus(t('mediaLoaded', undefined, '媒体已加载，可以开始预览。'), 'ok');
  }, { once: true });
  player.addEventListener('error', () => {
    setStatus(t('previewFailedDetail', undefined, '预览失败。该资源可能依赖额外请求头、Cookie 或防盗链校验。'), 'fail');
  }, { once: true });

  player.src = media.resourceUrl;
}

function renderMedia(media) {
  document.title = t('previewDocumentTitle', [media.filename || t('previewTitle', undefined, '媒体预览')], `${media.filename || '媒体预览'} - Downlink`);
  document.getElementById('title').textContent = media.filename || t('previewTitle', undefined, '媒体预览');
  document.getElementById('subtitle').textContent = media.resourceUrl || '';
  document.getElementById('infoFilename').textContent = media.filename || '-';
  document.getElementById('infoUrl').textContent = media.resourceUrl || '-';
  document.getElementById('infoPageUrl').textContent = media.pageUrl || media.referrer || '-';

  const chips = document.getElementById('metaChips');
  chips.innerHTML = `
    <span class="chip kind">${media.kind === 'audio' ? t('mediaKindAudio', undefined, '音频') : t('mediaKindVideo', undefined, '视频')}</span>
    <span class="chip">${esc(fmt(media.size))}</span>
    ${media.mime ? `<span class="chip">${esc(media.mime)}</span>` : ''}
    ${media.kind === 'video' && media.width && media.height ? `<span class="chip">${esc(`${media.width}×${media.height}`)}</span>` : ''}
  `;

  renderHeaders(media.headers || {});

  document.getElementById('copyBtn').onclick = async () => {
    try {
      await copyText(media.resourceUrl || '');
      setTopAlert('');
      setStatus(t('copiedMediaLink', undefined, '已复制媒体链接。'), 'ok');
    } catch {
      setStatus(t('copyLinkFailed', undefined, '复制链接失败。'), 'fail');
    }
  };

  document.getElementById('sendBtn').onclick = async () => {
    setTopAlert('');
    setStatus(t('sendingToDownloader', undefined, '正在发送到下载器…'));
    const result = await sendToDownloader(media.id);
    if (result.ok) {
      setTopAlert('');
      setStatus(t('sentToDownloader', undefined, '已发送到下载器。'), 'ok');
      return;
    }
    const message = result.error || t('sendToDownloaderFailed', undefined, '发送到下载器失败。');
    setTopAlert(message, { shake: true });
    setStatus('', '');
  };
}

(async () => {
  i18n.setLocalePreference?.(await loadLanguagePreference());
  i18n.applyTranslations?.(document);
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
  if (prepared.ok) {
    appliedHeadersEl.textContent = Array.isArray(prepared.headersApplied) && prepared.headersApplied.length
      ? prepared.headersApplied.join(', ')
      : t('noPatchedHeaders', undefined, '没有可应用的补头');
  } else {
    appliedHeadersEl.textContent = prepared.error || t('previewPatchFailed', undefined, '预览请求补头失败');
  }
  renderMedia(result.media);
  mountPlayer(result.media);
  window.addEventListener('beforeunload', () => clearPreview(tabId), { once: true });
})();
