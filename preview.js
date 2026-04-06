function qs(name) {
  return new URLSearchParams(location.search).get(name) || '';
}

function fmt(bytes) {
  if (!bytes || bytes <= 0) return '大小未知';
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
        resolve({ ok: false, error: chrome.runtime.lastError.message || '无法读取媒体信息' });
        return;
      }
      resolve(res || { ok: false, error: '无法读取媒体信息' });
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
        resolve({ ok: false, error: chrome.runtime.lastError.message || '预览请求补头失败' });
        return;
      }
      resolve(res || { ok: false, error: '预览请求补头失败' });
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
        resolve({ ok: false, error: chrome.runtime.lastError.message || '发送失败' });
        return;
      }
      resolve(res || { ok: false, error: '发送失败' });
    });
  });
}

function renderHeaders(headers = {}) {
  const container = document.getElementById('headerList');
  container.innerHTML = '';
  const entries = Object.entries(headers).filter(([, value]) => value);
  if (!entries.length) {
    container.innerHTML = '<div class="header-item"><div class="header-value">当前没有捕获到可用请求头。</div></div>';
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

function renderMedia(media) {
  document.title = `${media.filename || '媒体预览'} - Downlink`;
  document.getElementById('title').textContent = media.filename || '媒体预览';
  document.getElementById('subtitle').textContent = media.resourceUrl || '';
  document.getElementById('infoFilename').textContent = media.filename || '-';
  document.getElementById('infoUrl').textContent = media.resourceUrl || '-';
  document.getElementById('infoPageUrl').textContent = media.pageUrl || media.referrer || '-';

  const chips = document.getElementById('metaChips');
  chips.innerHTML = `
    <span class="chip kind">${media.kind === 'audio' ? '音频' : '视频'}</span>
    <span class="chip">${esc(fmt(media.size))}</span>
    ${media.mime ? `<span class="chip">${esc(media.mime)}</span>` : ''}
    ${media.kind === 'video' && media.width && media.height ? `<span class="chip">${esc(`${media.width}×${media.height}`)}</span>` : ''}
  `;

  const playerWrap = document.getElementById('playerWrap');
  const tagName = media.kind === 'audio' ? 'audio' : 'video';
  playerWrap.innerHTML = '';
  const player = document.createElement(tagName);
  player.controls = true;
  player.preload = 'metadata';
  player.src = media.resourceUrl;
  if (tagName === 'video') player.playsInline = true;
  playerWrap.appendChild(player);

  player.addEventListener('loadedmetadata', () => {
    setStatus('媒体已加载，可以开始预览。', 'ok');
  }, { once: true });
  player.addEventListener('error', () => {
    setStatus('预览失败。该资源可能依赖额外请求头、Cookie 或防盗链校验。', 'fail');
  }, { once: true });

  renderHeaders(media.headers || {});

  document.getElementById('copyBtn').onclick = async () => {
    try {
      await copyText(media.resourceUrl || '');
      setTopAlert('');
      setStatus('已复制媒体链接。', 'ok');
    } catch {
      setStatus('复制链接失败。', 'fail');
    }
  };

  document.getElementById('sendBtn').onclick = async () => {
    setTopAlert('');
    setStatus('正在发送到下载器…');
    const result = await sendToDownloader(media.id);
    if (result.ok) {
      setTopAlert('');
      setStatus('已发送到下载器。', 'ok');
      return;
    }
    const message = result.error || '发送到下载器失败。';
    setTopAlert(message, { shake: true });
    setStatus('', '');
  };
}

(async () => {
  const id = qs('id');
  if (!id) {
    setStatus('缺少媒体标识。', 'fail');
    return;
  }
  setStatus('正在读取媒体信息…');
  const result = await getMediaItem(id);
  if (!result.ok || !result.media) {
    setStatus(result.error || '媒体资源不存在或已过期。', 'fail');
    return;
  }
  renderMedia(result.media);
  const tabId = await getCurrentTabId();
  const prepared = await preparePreview(id, tabId);
  const appliedHeadersEl = document.getElementById('appliedHeaders');
  if (prepared.ok) {
    appliedHeadersEl.textContent = Array.isArray(prepared.headersApplied) && prepared.headersApplied.length
      ? prepared.headersApplied.join(', ')
      : '没有可应用的补头';
  } else {
    appliedHeadersEl.textContent = prepared.error || '预览请求补头失败';
  }
  window.addEventListener('beforeunload', () => clearPreview(tabId), { once: true });
})();
