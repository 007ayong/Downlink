const i18n = globalThis.Localization || {};
const SEND_CLICK_LOCK_MS = 900;
const SAFARI_PREVIEW_CHUNK_SIZE = 2 * 1024 * 1024;
const SAFARI_PREVIEW_BUFFER_AHEAD_SECONDS = 45;
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

function getSendFailureMessage(result = {}) {
  if (result.downloaderLabel) {
    return t(
      'connectionFailedWithLabel',
      [result.downloaderLabel],
      `与 ${result.downloaderLabel} 连接失败，检查 ${result.downloaderLabel} 是否正在运行`
    );
  }
  return result.error || t('sendToDownloaderFailed', undefined, '发送到下载器失败。');
}

let toastTimer = null;
let sendingToDownloader = false;
let currentPreviewFilename = '';
let activeSafariPreviewSession = null;
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

function createTextElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text || '';
  return element;
}

function createAudioIcon() {
  const svgNs = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNs, 'svg');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS(svgNs, 'path');
  path.setAttribute('d', 'M8 5.7v8.6a1.8 1.8 0 1 1-1.2-1.7V6.9l6.8-1.5v7.3a1.8 1.8 0 1 1-1.2-1.7V4.2L8 5.7Z');
  path.setAttribute('fill', 'currentColor');
  svg.appendChild(path);

  return svg;
}

function renderHeaders(headers = {}) {
  const container = document.getElementById('headerList');
  if (!container) return;
  container.replaceChildren();
  const entries = Object.entries(headers).filter(([, value]) => value);
  if (!entries.length) {
    const item = createTextElement('div', 'header-item', '');
    item.appendChild(createTextElement('div', 'header-value', t('noHeadersCaptured', undefined, '当前没有捕获到可用请求头。')));
    container.appendChild(item);
    return;
  }
  entries.forEach(([key, value]) => {
    const item = document.createElement('div');
    item.className = 'header-item';
    item.appendChild(createTextElement('div', 'header-key', key));
    item.appendChild(createTextElement('div', 'header-value', value));
    container.appendChild(item);
  });
}

function isSafariPreviewRuntime() {
  try {
    return String(chrome.runtime?.getURL?.('') || '').startsWith('safari-web-extension://');
  } catch {
    return false;
  }
}

function loadPreviewChunkInMainWorld(resourceUrl, start, end) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { xhr.abort(); } catch {}
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, error: 'preview-timeout' }), 15000);
    const xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', resourceUrl, true);
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', `bytes=${start}-${end}`);
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300 || !(xhr.response instanceof ArrayBuffer)) {
          finish({ ok: false, error: `preview-http-${xhr.status}` });
          return;
        }
        const bytes = new Uint8Array(xhr.response);
        const requestedLength = end - start + 1;
        if (bytes.length > requestedLength) {
          finish({ ok: false, error: 'preview-range-oversized' });
          return;
        }
        if (xhr.status !== 206 && start > 0) {
          finish({ ok: false, error: 'preview-range-unsupported' });
          return;
        }
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        const contentRange = xhr.getResponseHeader('Content-Range') || '';
        const totalMatch = contentRange.match(/\/(\d+)$/);
        finish({
          ok: true,
          base64: btoa(binary),
          byteLength: bytes.length,
          totalSize: totalMatch ? Number(totalMatch[1]) : bytes.length,
          ranged: xhr.status === 206,
        });
      };
      xhr.onerror = () => finish({ ok: false, error: 'preview-load-failed' });
      xhr.send();
    } catch (error) {
      finish({ ok: false, error: error?.message || 'preview-load-failed' });
    }
  });
}

function loadPreviewChunkFromSourceTab(media, start, end) {
  if (!Number.isInteger(media?.tabId) || !chrome.scripting?.executeScript) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.scripting.executeScript({
        target: { tabId: media.tabId },
        world: 'MAIN',
        func: loadPreviewChunkInMainWorld,
        args: [media.resourceUrl, start, end],
      }, (results) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(results?.[0]?.result || null);
      });
    } catch {
      resolve(null);
    }
  });
}

function decodePreviewChunk(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function findMp4Marker(bytes, marker) {
  const codes = Array.from(marker, (char) => char.charCodeAt(0));
  for (let index = 0; index + codes.length <= bytes.length; index += 1) {
    if (codes.every((code, offset) => bytes[index + offset] === code)) return index;
  }
  return -1;
}

function getMediaSourceMime(media, firstChunk) {
  const declaredMime = String(media.mime || '').toLowerCase();
  if (/^(audio|video)\/[^;]+;\s*codecs=/.test(declaredMime)) return declaredMime;
  if (media.kind === 'audio') return 'audio/mp4; codecs="mp4a.40.2"';
  const avcCIndex = findMp4Marker(firstChunk, 'avcC');
  if (avcCIndex >= 0 && avcCIndex + 8 <= firstChunk.length) {
    const values = firstChunk.subarray(avcCIndex + 5, avcCIndex + 8);
    const codec = Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
    return `video/mp4; codecs="avc1.${codec}"`;
  }
  if (findMp4Marker(firstChunk, 'av01') >= 0) return 'video/mp4; codecs="av01.0.08M.08"';
  if (findMp4Marker(firstChunk, 'hvc1') >= 0) return 'video/mp4; codecs="hvc1"';
  if (findMp4Marker(firstChunk, 'hev1') >= 0) return 'video/mp4; codecs="hev1"';
  return 'video/mp4; codecs="avc1.640028"';
}

function waitForPreviewBufferRoom(player, sourceBuffer, session) {
  if (session.cancelled || !sourceBuffer.buffered?.length) return Promise.resolve();
  const bufferedEnd = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
  if (bufferedEnd - (player.currentTime || 0) < SAFARI_PREVIEW_BUFFER_AHEAD_SECONDS) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (session.cancelled || !sourceBuffer.buffered?.length) {
        resolve();
        return;
      }
      const end = sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
      if (end - (player.currentTime || 0) < SAFARI_PREVIEW_BUFFER_AHEAD_SECONDS) {
        resolve();
        return;
      }
      session.bufferTimer = setTimeout(check, 500);
    };
    check();
  });
}

async function mountSafariAuthenticatedSource(media, player) {
  if (!Number.isInteger(media?.tabId) || !chrome.scripting?.executeScript || typeof MediaSource !== 'function') {
    return false;
  }
  const session = { cancelled: false, bufferTimer: null, sourceOpenTimer: null, objectUrl: '' };
  activeSafariPreviewSession = session;
  const mediaSource = new MediaSource();
  session.objectUrl = URL.createObjectURL(mediaSource);
  player.src = session.objectUrl;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const fail = () => {
      if (session.cancelled) return;
      if (session.sourceOpenTimer) clearTimeout(session.sourceOpenTimer);
      setStatus(t('previewFailedDetail', undefined, '预览失败。该资源可能依赖额外请求头、Cookie 或防盗链校验。'), 'fail');
      finish(false);
    };
    session.sourceOpenTimer = setTimeout(fail, 15000);
    mediaSource.addEventListener('sourceopen', async () => {
      if (session.sourceOpenTimer) {
        clearTimeout(session.sourceOpenTimer);
        session.sourceOpenTimer = null;
      }
      try {
        const firstResult = await loadPreviewChunkFromSourceTab(media, 0, SAFARI_PREVIEW_CHUNK_SIZE - 1);
        if (session.cancelled || !firstResult?.ok || !firstResult.base64 || !firstResult.byteLength) {
          fail();
          return;
        }
        const firstChunk = decodePreviewChunk(firstResult.base64);
        const mime = getMediaSourceMime(media, firstChunk);
        if (MediaSource.isTypeSupported && !MediaSource.isTypeSupported(mime)) {
          fail();
          return;
        }
        const sourceBuffer = mediaSource.addSourceBuffer(mime);
        let offset = firstResult.byteLength;
        let totalSize = Number(firstResult.totalSize) || Number(media.size) || 0;
        let nextChunk = firstChunk;
        let loading = false;
        const pump = async () => {
          if (session.cancelled || loading || sourceBuffer.updating || mediaSource.readyState !== 'open') return;
          if (player.currentTime > 60 && sourceBuffer.buffered?.length &&
              sourceBuffer.buffered.start(0) < player.currentTime - 30) {
            sourceBuffer.remove(0, player.currentTime - 30);
            return;
          }
          if (nextChunk) {
            const chunk = nextChunk;
            nextChunk = null;
            sourceBuffer.appendBuffer(chunk);
            finish(true);
            return;
          }
          if (totalSize && offset >= totalSize) {
            mediaSource.endOfStream();
            return;
          }
          loading = true;
          await waitForPreviewBufferRoom(player, sourceBuffer, session);
          const result = session.cancelled ? null : await loadPreviewChunkFromSourceTab(
            media,
            offset,
            offset + SAFARI_PREVIEW_CHUNK_SIZE - 1
          );
          loading = false;
          if (session.cancelled) return;
          if (!result?.ok || !result.base64 || !result.byteLength) {
            fail();
            return;
          }
          totalSize = Number(result.totalSize) || totalSize;
          offset += result.byteLength;
          nextChunk = decodePreviewChunk(result.base64);
          pump();
        };
        sourceBuffer.addEventListener('updateend', pump);
        sourceBuffer.addEventListener('error', fail, { once: true });
        pump();
      } catch {
        fail();
      }
    }, { once: true });
    mediaSource.addEventListener('error', fail, { once: true });
  });
}

function cleanupSafariPreviewSession() {
  const session = activeSafariPreviewSession;
  if (!session) return;
  session.cancelled = true;
  if (session.bufferTimer) clearTimeout(session.bufferTimer);
  if (session.sourceOpenTimer) clearTimeout(session.sourceOpenTimer);
  if (session.objectUrl) URL.revokeObjectURL?.(session.objectUrl);
  activeSafariPreviewSession = null;
}

async function mountPlayer(media) {
  const playerWrap = document.getElementById('playerWrap');
  const tagName = media.kind === 'audio' ? 'audio' : 'video';
  playerWrap.replaceChildren();
  const player = document.createElement(tagName);
  player.controls = true;
  player.preload = 'metadata';
  if (tagName === 'video') player.playsInline = true;
  if (tagName === 'audio') {
    const panel = document.createElement('div');
    panel.className = 'audio-panel';
    const audioHead = document.createElement('div');
    audioHead.className = 'audio-head';
    const audioIcon = document.createElement('div');
    audioIcon.className = 'audio-icon';
    audioIcon.appendChild(createAudioIcon());
    const audioCopy = document.createElement('div');
    audioCopy.className = 'audio-copy';
    audioCopy.appendChild(createTextElement('div', 'audio-title', currentPreviewFilename || media.filename || t('previewTitle', undefined, '媒体预览')));
    audioCopy.appendChild(createTextElement('div', 'audio-sub', buildSubtitle(media)));
    audioHead.appendChild(audioIcon);
    audioHead.appendChild(audioCopy);
    panel.appendChild(audioHead);
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

  if (isSafariPreviewRuntime()) {
    setStatus(t('previewLoading', undefined, '正在加载媒体信息…'));
    const authenticated = await mountSafariAuthenticatedSource(media, player);
    if (authenticated) return;
    cleanupSafariPreviewSession();
  }
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
  const chipNodes = [
    createTextElement('span', 'chip kind', mediaKindText(media)),
    createTextElement('span', 'chip', fmt(media.size)),
  ];
  if (media.kind === 'video' && media.width && media.height) {
    chipNodes.push(createTextElement('span', 'chip', `${media.width}×${media.height}`));
  }
  if (media.mime) chipNodes.push(createTextElement('span', 'chip', media.mime));
  chips.replaceChildren(...chipNodes);

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
      const message = getSendFailureMessage(result);
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
  window.addEventListener('beforeunload', () => {
    cleanupSafariPreviewSession();
    clearPreview(tabId);
  }, { once: true });
  await mountPlayer(result.media);
})();
