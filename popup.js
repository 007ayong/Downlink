// popup.js — Downlink UI

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
const DEFAULT_HEADER_LOGO = 'icons/icon48.png';
const DOWNLOADER_LOGOS = {
  aria2: DEFAULT_HEADER_LOGO,
  abdownload: 'assets/provider-icons/abdownload.png',
  neatdm: 'assets/provider-icons/neatdm.png',
};

function getDownloaderName(cfg = currentConfig) {
  if (cfg?.downloaderType === 'abdownload') return cfg.externalLauncherName || 'AB Download';
  if (cfg?.downloaderType === 'neatdm') return 'NeatDM';
  return 'Aria2';
}

function getSendLabel(cfg = currentConfig) {
  return `发送到 ${getDownloaderName(cfg)}`;
}

function getHeaderLogoSrc(cfg = currentConfig) {
  return DOWNLOADER_LOGOS[cfg?.downloaderType] || DEFAULT_HEADER_LOGO;
}

function updateHeaderLogo(cfg = currentConfig) {
  const logo = document.getElementById('headerLogo');
  if (!logo) return;
  const nextSrc = getHeaderLogoSrc(cfg);
  logo.alt = `${getDownloaderName(cfg)} logo`;
  if (logo.dataset.currentSrc === nextSrc) return;
  logo.dataset.currentSrc = nextSrc;
  logo.src = nextSrc;
}

function updateDynamicLabels(cfg = currentConfig) {
  const title = document.querySelector('.header-title');
  if (title) title.textContent = 'Downlink';
  updateHeaderLogo(cfg);
  document.querySelectorAll('.confirm-btn, .media-send-btn').forEach(btn => {
    if (!btn.disabled) btn.textContent = `⚡ ${getSendLabel(cfg)}`;
  });
}

document.getElementById('headerLogo').addEventListener('error', (event) => {
  const logo = event.currentTarget;
  if (!logo || logo.src.endsWith(DEFAULT_HEADER_LOGO)) return;
  logo.dataset.currentSrc = DEFAULT_HEADER_LOGO;
  logo.src = DEFAULT_HEADER_LOGO;
});

function updateHeaderStatusDisplay({
  cfg = currentConfig,
  state = 'checking',
  stat = null,
} = {}) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (!dot || !txt) return;

  dot.className = `status-dot${state === 'online' ? ' online' : state === 'offline' ? ' offline' : ''}`;

  if (state === 'online') {
    if (cfg?.downloaderType === 'aria2') {
      txt.textContent = `已连接 · ↓${fmtSpeed(parseInt(stat?.downloadSpeed, 10) || 0)}`;
    } else {
      txt.textContent = `${getDownloaderName(cfg)} 已就绪`;
    }
    return;
  }

  if (state === 'offline') {
    txt.textContent = `${getDownloaderName(cfg)} 未连接`;
    return;
  }

  txt.textContent = `${getDownloaderName(cfg)} 连接中…`;
}

function updateSettingsVisibility(type = currentConfig.downloaderType) {
  const isAria2 = type === 'aria2';
  const isAbDownload = type === 'abdownload';
  const isNeatdm = type === 'neatdm';
  document.querySelectorAll('.aria2-only').forEach(el => el.classList.toggle('settings-hidden', !isAria2));
  document.querySelectorAll('.launcher-only').forEach(el => el.classList.toggle('settings-hidden', !isAbDownload));
  document.querySelectorAll('.neatdm-only').forEach(el => el.classList.toggle('settings-hidden', !isNeatdm));
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

function fmt(bytes) {
  if (!bytes || bytes <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + u[i];
}

function fmtSpeed(b) {
  if (!b || b <= 0) return '—';
  return fmt(b) + '/s';
}

const FILE_ICON_BASE = 'assets/file-icons';
const FILE_ICON_MAP = {
  default: `${FILE_ICON_BASE}/default.svg`,
  video: `${FILE_ICON_BASE}/video.svg`,
  audio: `${FILE_ICON_BASE}/audio.svg`,
  image: `${FILE_ICON_BASE}/image.svg`,
  archive: `${FILE_ICON_BASE}/archive.svg`,
  document: `${FILE_ICON_BASE}/document.svg`,
  pdf: `${FILE_ICON_BASE}/pdf.svg`,
  spreadsheet: `${FILE_ICON_BASE}/spreadsheet.svg`,
  executable: `${FILE_ICON_BASE}/executable.svg`,
  torrent: `${FILE_ICON_BASE}/torrent.svg`,
};

const EXECUTABLE_MIME_KEYWORDS = [
  'application/x-msdownload',
  'application/vnd.android.package-archive',
  'application/x-apple-diskimage',
  'application/x-deb',
  'application/vnd.debian.binary-package',
  'application/x-msi',
  'application/x-pkg',
  'application/x-executable',
];

function extFromName(name = '') {
  const normalized = String(name || '').trim().toLowerCase();
  if (!normalized.includes('.')) return '';
  return normalized.split('.').pop();
}

function getFileCategory({ name = '', mime = '', kind = '' } = {}) {
  if (kind === 'video' || String(mime).startsWith('video/')) return 'video';
  if (kind === 'audio' || String(mime).startsWith('audio/')) return 'audio';

  const normalizedMime = String(mime).split(';')[0].trim().toLowerCase();
  if (normalizedMime.startsWith('image/')) return 'image';
  if (normalizedMime === 'application/pdf') return 'pdf';
  if (EXECUTABLE_MIME_KEYWORDS.includes(normalizedMime)) return 'executable';
  if (
    normalizedMime.includes('spreadsheet') ||
    normalizedMime === 'text/csv' ||
    normalizedMime === 'application/csv'
  ) return 'spreadsheet';
  if (
    normalizedMime.includes('wordprocessingml') ||
    normalizedMime.includes('msword') ||
    normalizedMime.startsWith('text/')
  ) return 'document';
  if (
    normalizedMime.includes('zip') ||
    normalizedMime.includes('compressed') ||
    normalizedMime.includes('archive') ||
    normalizedMime.includes('7z')
  ) return 'archive';
  if (
    normalizedMime.includes('bittorrent') ||
    normalizedMime === 'application/x-bittorrent'
  ) return 'torrent';

  const ext = extFromName(name);
  const map = {
    mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video', m4v: 'video',
    mp3: 'audio', flac: 'audio', wav: 'audio', aac: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio',
    jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
    zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive',
    pdf: 'pdf',
    doc: 'document', docx: 'document', txt: 'document', md: 'document', rtf: 'document',
    xls: 'spreadsheet', xlsx: 'spreadsheet', csv: 'spreadsheet',
    exe: 'executable', msi: 'executable', dmg: 'executable', deb: 'executable', pkg: 'executable', apk: 'executable',
    torrent: 'torrent', magnet: 'torrent',
  };
  return map[ext] || 'default';
}

function getFileIcon(task = {}) {
  const category = getFileCategory(task);
  return FILE_ICON_MAP[category] || FILE_ICON_MAP.default;
}

function handleTaskIconError(event) {
  const img = event?.currentTarget;
  if (!img) return;
  const fallback = FILE_ICON_MAP.default;
  if (img.dataset.fallbackApplied === 'true' || img.src.endsWith(FILE_ICON_MAP.default)) return;
  img.dataset.fallbackApplied = 'true';
  img.src = fallback;
}

function getStateLabel(s) {
  const map = { active: '下载中', complete: '完成', error: '错误', paused: '已暂停', waiting: '等待中', removed: '已移除', sent: '已唤起' };
  return map[s] || s;
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeDisplayFilename(value = '') {
  if (globalThis.FilenameLogic?.decodeHttpFilename) return globalThis.FilenameLogic.decodeHttpFilename(value);

  const text = String(value || '').trim();
  const decoded = text.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset, encoding, payload) => {
    try {
      let bytes = [];
      if (encoding.toLowerCase() === 'b') {
        const binary = atob(payload.replace(/\s+/g, ''));
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
      return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes));
    } catch {
      return match;
    }
  });
  if (!/%[0-9a-fA-F]{2}/.test(decoded)) return decoded;
  try {
    return decodeURIComponent(decoded.replace(/\+/g, '%20'));
  } catch {
    return decoded;
  }
}

function mediaKindLabel(kind) {
  return kind === 'audio' ? '音频' : '视频';
}

function mediaResolutionLabel(item) {
  if (item.kind !== 'video' || !item.width || !item.height) return '分辨率待识别';
  return `${item.width}×${item.height}`;
}

function switchTab(tabName) {
  const target = document.querySelector(`.tab[data-tab="${tabName}"]`);
  if (target) target.click();
}

function shouldAutoSwitchToMediaPanel(state) {
  return (
    state.mediaCount > state.previousMediaCount &&
    state.pendingCount === 0 &&
    state.currentTab !== 'media' &&
    state.mediaCount !== state.lastAutoSwitchedMediaCount
  );
}

function buildMediaRenderKey(media = []) {
  return media.map(item => [
    item.id,
    item.resourceUrl,
    item.filename,
    item.size,
    item.kind,
    item.mime,
    item.width,
    item.height,
  ].join('|')).join('||');
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
  return new Promise(resolve => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
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
    if (typeof previewTabId === 'number') {
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
      return;
    }
    showToast(item.kind === 'audio' ? '已打开音频预览页' : '已打开视频预览页');
  });
}

function renderTasks(tasks, pending) {
  const taskVals = Object.values(tasks || {}).filter(task => !hiddenTaskGids.has(task?.gid));
  const pendingVals = Object.values(pending || {});

  const badge = document.getElementById('pendingBadge');
  if (pendingVals.length > 0) {
    badge.textContent = pendingVals.length;
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }

  const allEmpty = taskVals.length === 0 && pendingVals.length === 0;
  document.getElementById('tasksEmpty').style.display = allEmpty ? 'flex' : 'none';
  document.getElementById('footerBar').style.display = allEmpty ? 'none' : 'flex';

  const pList = document.getElementById('pendingList');
  pList.innerHTML = '';
  pendingVals.forEach(item => {
    const filename = decodeDisplayFilename(item.filename || item.url.split('?')[0].split('/').pop() || '');
    const card = document.createElement('div');
    card.className = 'pending-card';
    card.innerHTML = `
      <div class="pending-label">待确认下载</div>
      <div class="pending-url">${escHtml(item.url)}</div>
      <div class="pending-filename-row">
        <label>文件名</label>
        <input type="text" class="pending-fname" value="${escHtml(filename)}" placeholder="自动识别"/>
      </div>
      <div class="pending-actions">
        <button class="btn btn-primary confirm-btn" data-key="${item.key}">⚡ ${getSendLabel()}</button>
        <button class="btn btn-ghost reject-btn" data-key="${item.key}">✕ 忽略</button>
      </div>
    `;
    pList.appendChild(card);
    card.querySelector('.confirm-btn').addEventListener('click', () => {
      const fname = card.querySelector('.pending-fname').value.trim();
      chrome.runtime.sendMessage({ type: 'CONFIRM_DOWNLOAD', key: item.key, filename: fname }, (res) => {
        if (!res?.ok) showToast(`发送失败：${res?.error || '无法建立链接'}`);
      });
    });
    card.querySelector('.reject-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'REJECT_DOWNLOAD', key: item.key });
    });
  });

  const tList = document.getElementById('taskList');
  tList.innerHTML = '';
  let activeCount = 0;
  let doneCount = 0;
  let totalSpeed = 0;

  taskVals.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0)).forEach(task => {
    const name = task.filename || task.url?.split('?')[0].split('/').pop() || '未知文件';
    const pct = task.totalLength > 0
      ? Math.min(100, Math.round((task.completedLength / task.totalLength) * 100))
      : (task.status === 'complete' ? 100 : 0);
    const stateKey = task.status || 'waiting';

    if (stateKey === 'active') {
      activeCount++;
      totalSpeed += task.downloadSpeed || 0;
    }
    if (['complete', 'sent'].includes(stateKey)) doneCount++;

    const card = document.createElement('div');
    card.className = `task-card ${stateKey}`;

    const showProgress = ['active', 'paused', 'waiting', 'complete'].includes(stateKey);
    const eta = (() => {
      if (!task.downloadSpeed || !task.totalLength) return '';
      const rem = task.totalLength - task.completedLength;
      const s = rem / task.downloadSpeed;
      if (s < 60) return Math.ceil(s) + 's';
      if (s < 3600) return Math.ceil(s / 60) + 'm';
      return (s / 3600).toFixed(1) + 'h';
    })();

    card.innerHTML = `
      <div class="task-top">
        <div class="task-icon"><img src="${escHtml(getFileIcon({ name, mime: task.mime, kind: task.kind }))}" alt="" loading="lazy"></div>
        <div class="task-info">
          <div class="task-name" title="${escHtml(name)}">${escHtml(name)}</div>
          <div class="task-meta">
            ${task.totalLength ? `<span>${fmt(task.completedLength)} / ${fmt(task.totalLength)}</span>` : ''}
            ${task.targetName ? `<span>⇢ ${escHtml(task.targetName)}</span>` : ''}
            ${stateKey === 'active' && task.downloadSpeed ? `<span>↓ ${fmtSpeed(task.downloadSpeed)}</span>` : ''}
            ${stateKey === 'active' && eta ? `<span>⏱ ${eta}</span>` : ''}
            ${task.connections ? `<span>🔗 ${task.connections}线</span>` : ''}
          </div>
        </div>
        <span class="state-pill state-${stateKey}">${getStateLabel(stateKey)}</span>
      </div>
      ${showProgress ? `
      <div class="task-progress">
        <div class="progress-track">
          <div class="progress-fill ${stateKey}" style="width:${pct}%"></div>
        </div>
        <div class="progress-row">
          <span>${fmt(task.completedLength)}</span>
          <span class="progress-pct">${pct}%</span>
        </div>
      </div>` : ''}
      <div class="task-actions">
        ${stateKey === 'active' ? `<button class="task-btn" data-action="pause" data-gid="${task.gid}">⏸ 暂停</button>` : ''}
        ${stateKey === 'paused' ? `<button class="task-btn" data-action="resume" data-gid="${task.gid}">▶ 继续</button>` : ''}
        ${stateKey === 'complete' ? `<button class="task-btn" data-action="remove" data-gid="${task.gid}">✕ 清除</button>` : ''}
        ${['active', 'paused', 'waiting'].includes(stateKey) ? `<button class="task-btn danger" data-action="remove" data-gid="${task.gid}">✕ 取消</button>` : ''}
        ${stateKey === 'sent' ? `<button class="task-btn" data-action="remove" data-gid="${task.gid}">✕ 清除</button>` : ''}
        ${stateKey === 'error' ? `<button class="task-btn danger" data-action="remove" data-gid="${task.gid}">✕ 清除</button>` : ''}
      </div>
    `;
    tList.appendChild(card);
    const icon = card.querySelector('.task-icon img');
    if (icon) icon.addEventListener('error', handleTaskIconError);
    card.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const action = btn.dataset.action;
        const gid = btn.dataset.gid;
        const msgMap = { pause: 'PAUSE_TASK', resume: 'RESUME_TASK', remove: 'REMOVE_TASK' };
        chrome.runtime.sendMessage({ type: msgMap[action], gid });
      });
    });
  });

  document.getElementById('fActive').textContent = activeCount;
  document.getElementById('fDone').textContent = doneCount;
  document.getElementById('fSpeed').textContent = fmtSpeed(totalSpeed);
}

function renderMedia(mediaByTab) {
  const listEl = document.getElementById('mediaList');
  const emptyEl = document.getElementById('mediaEmpty');
  const summaryEl = document.getElementById('mediaSummary');
  const mediaBadge = document.getElementById('mediaBadge');
  const media = currentTabId == null ? [] : (mediaByTab?.[currentTabId] || []);
  const mediaKey = buildMediaRenderKey(media);
  const mediaCount = media.length;

  emptyEl.style.display = media.length ? 'none' : 'flex';
  summaryEl.textContent = media.length
    ? `当前标签页已发现 ${media.length} 个直链媒体资源`
    : '等待页面发起音视频请求…';
  if (mediaCount > 0) {
    mediaBadge.textContent = String(mediaCount);
    mediaBadge.style.display = 'inline-block';
  } else {
    mediaBadge.style.display = 'none';
  }

  const pendingCount = Object.values(currentState.pending || {}).length;
  const currentTab = document.querySelector('.tab.active')?.dataset.tab;
  if (shouldAutoSwitchToMediaPanel({
    mediaCount,
    previousMediaCount,
    pendingCount,
    currentTab,
    lastAutoSwitchedMediaCount,
  })) {
    lastAutoSwitchedMediaCount = mediaCount;
    switchTab('media');
  }
  previousMediaCount = mediaCount;

  if (mediaKey === lastRenderedMediaKey) return;
  lastRenderedMediaKey = mediaKey;

  listEl.innerHTML = '';

  media.forEach(item => {
    const card = document.createElement('div');
    card.className = 'media-card';
    card.dataset.mediaId = item.id;
    card.innerHTML = `
      <div class="media-top">
        <div class="media-icon">${item.kind === 'audio' ? '🎵' : '🎬'}</div>
        <div class="media-info">
          <div class="media-name" title="${escHtml(item.filename || '未命名媒体')}">${escHtml(item.filename || '未命名媒体')}</div>
          <div class="media-url">${escHtml(item.resourceUrl)}</div>
          <div class="media-meta">
            <span class="media-chip kind-${escHtml(item.kind || 'video')}">${mediaKindLabel(item.kind)}</span>
            <span class="media-chip">${item.size ? fmt(item.size) : '大小未知'}</span>
            ${item.kind === 'video' ? `<span class="media-chip media-resolution">${escHtml(mediaResolutionLabel(item))}</span>` : ''}
            ${item.mime ? `<span class="media-chip">${escHtml(item.mime)}</span>` : ''}
          </div>
        </div>
      </div>
      <div class="media-actions">
        <button class="task-btn media-preview-toggle" data-id="${item.id}">▶ 预览</button>
        <button class="task-btn" data-copy-url="${escHtml(item.resourceUrl)}">⧉ 复制链接</button>
        <button class="task-btn media-send-btn" data-send-id="${item.id}">⚡ ${getSendLabel()}</button>
      </div>
    `;
    listEl.appendChild(card);

    if (item.kind === 'video' && (!item.width || !item.height)) {
      loadMediaMetadata(item, card);
    }

    card.querySelector('[data-copy-url]').addEventListener('click', async (event) => {
      const copied = await copyText(event.currentTarget.dataset.copyUrl);
      showToast(copied ? '已复制媒体链接' : '复制失败');
    });

    card.querySelector('[data-send-id]').addEventListener('click', (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      btn.textContent = '发送中…';
      chrome.runtime.sendMessage({ type: 'ADD_MEDIA_TASK', id: btn.dataset.sendId }, (res) => {
        if (res?.ok) {
          btn.textContent = '✓ 已发送';
          showToast('媒体已发送到下载器');
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = `⚡ ${getSendLabel()}`;
          }, 1200);
          setTimeout(() => { document.querySelector('[data-tab="tasks"]').click(); }, 300);
        } else {
          btn.disabled = false;
          btn.textContent = `⚡ ${getSendLabel()}`;
          showToast(`发送失败：${res?.error || '无法建立链接'}`);
        }
      });
    });

    card.querySelector('.media-preview-toggle').addEventListener('click', (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = '打开中…';
      openPreviewTab(item);
      setTimeout(() => {
        btn.disabled = false;
        btn.textContent = originalText;
      }, 400);
    });
  });
}

function loadMediaMetadata(item, card) {
  const tagName = item.kind === 'audio' ? 'audio' : 'video';
  const mediaEl = document.createElement(tagName);
  mediaEl.preload = 'metadata';
  mediaEl.src = item.resourceUrl;
  mediaEl.style.position = 'absolute';
  mediaEl.style.width = '1px';
  mediaEl.style.height = '1px';
  mediaEl.style.opacity = '0';
  mediaEl.muted = true;
  mediaEl.addEventListener('loadedmetadata', () => {
    if (item.kind === 'video') {
      const width = mediaEl.videoWidth || 0;
      const height = mediaEl.videoHeight || 0;
      const resolutionEl = card.querySelector('.media-resolution');
      if (resolutionEl && width && height) resolutionEl.textContent = `${width}×${height}`;
      chrome.runtime.sendMessage({
        type: 'UPDATE_MEDIA_METADATA',
        id: item.id,
        width,
        height,
        duration: Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0,
      });
    }
    mediaEl.remove();
  }, { once: true });
  mediaEl.addEventListener('error', () => mediaEl.remove(), { once: true });
  card.appendChild(mediaEl);
}

function renderState(state) {
  hiddenTaskGids = new Set(state.hiddenTaskGids || []);
  currentState = {
    tasks: state.tasks || {},
    pending: state.pending || {},
    media: state.media || {},
  };
  renderTasks(currentState.tasks, currentState.pending);
  renderMedia(currentState.media);
}

function collectSettingsFromForm() {
  return {
    downloaderType: document.getElementById('cfgDownloaderType').value,
    aria2Rpc: document.getElementById('cfgRpc').value.trim() || 'http://localhost:6800/jsonrpc',
    aria2Secret: document.getElementById('cfgSecret').value.trim(),
    saveDir: document.getElementById('cfgSaveDir').value.trim(),
    externalLauncherName: document.getElementById('cfgLauncherName').value.trim() || 'AB Download',
    externalLauncherHost: document.getElementById('cfgLauncherHost').value.trim() || 'localhost',
    externalLauncherPort: document.getElementById('cfgLauncherPort').value.trim() || '15151',
    externalLauncherPath: document.getElementById('cfgLauncherPath').value.trim() || '/start-headless-download',
    autoCapture: document.getElementById('cfgAutoCapture').checked,
    showConfirm: document.getElementById('cfgShowConfirm').checked,
    captureExtensions: document.getElementById('cfgExts').value.trim(),
    notification: document.getElementById('cfgNotification').checked,
  };
}

function setSaveButtonState(text, resetDelay = 1500) {
  const btn = document.getElementById('saveSettingsBtn');
  if (!btn) return;
  btn.textContent = text;
  clearTimeout(saveFeedbackTimer);
  if (resetDelay >= 0) {
    saveFeedbackTimer = setTimeout(() => {
      btn.textContent = '保存设置';
    }, resetDelay);
  }
}

function persistSettings(cfg, { showSavedFeedback = true } = {}) {
  clearTimeout(autoSaveTimer);
  setSaveButtonState('保存中…', -1);
  chrome.runtime.sendMessage({ type: 'SAVE_CONFIG', config: cfg }, () => {
    currentConfig = { ...cfg };
    updateSettingsVisibility(cfg.downloaderType);
    updateDynamicLabels(cfg);
    updateHeaderStatusDisplay({ cfg, state: 'checking' });
    checkStatus(cfg);
    setSaveButtonState(showSavedFeedback ? '✓ 已自动保存' : '✓ 已保存');
  });
}

function scheduleAutoSave(delay = 350) {
  if (isLoadingSettings) return;
  clearTimeout(autoSaveTimer);
  const nextCfg = collectSettingsFromForm();
  currentConfig = { ...currentConfig, ...nextCfg };
  updateSettingsVisibility(nextCfg.downloaderType);
  updateDynamicLabels(nextCfg);
  setSaveButtonState('自动保存中…', -1);
  autoSaveTimer = setTimeout(() => {
    persistSettings(collectSettingsFromForm());
  }, delay);
}

function loadSettings(cfg) {
  if (!cfg) return;
  isLoadingSettings = true;
  currentConfig = { ...cfg };
  document.getElementById('cfgDownloaderType').value = cfg.downloaderType || 'aria2';
  document.getElementById('cfgRpc').value = cfg.aria2Rpc || '';
  document.getElementById('cfgSecret').value = cfg.aria2Secret || '';
  document.getElementById('cfgSaveDir').value = cfg.saveDir || '';
  document.getElementById('cfgLauncherName').value = cfg.externalLauncherName || 'AB Download';
  document.getElementById('cfgLauncherHost').value = cfg.externalLauncherHost || 'localhost';
  document.getElementById('cfgLauncherPort').value = cfg.externalLauncherPort || '15151';
  document.getElementById('cfgLauncherPath').value = cfg.externalLauncherPath || '/start-headless-download';
  document.getElementById('cfgAutoCapture').checked = !!cfg.autoCapture;
  document.getElementById('cfgShowConfirm').checked = !!cfg.showConfirm;
  document.getElementById('cfgExts').value = cfg.captureExtensions || '';
  document.getElementById('cfgNotification').checked = !!cfg.notification;
  updateSettingsVisibility(cfg.downloaderType || 'aria2');
  updateDynamicLabels(cfg);
  updateHeaderStatusDisplay({ cfg, state: 'checking' });
  isLoadingSettings = false;
}

document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  persistSettings(collectSettingsFromForm(), { showSavedFeedback: false });
});

document.getElementById('cfgDownloaderType').addEventListener('change', (e) => {
  const nextCfg = {
    ...currentConfig,
    downloaderType: e.target.value,
    externalLauncherName: document.getElementById('cfgLauncherName').value.trim() || currentConfig.externalLauncherName || 'AB Download',
  };
  currentConfig = nextCfg;
  updateSettingsVisibility(nextCfg.downloaderType);
  updateDynamicLabels(nextCfg);
  updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking' });
  scheduleAutoSave(0);
});

[
  'cfgRpc',
  'cfgSecret',
  'cfgSaveDir',
  'cfgLauncherName',
  'cfgLauncherHost',
  'cfgLauncherPort',
  'cfgLauncherPath',
  'cfgExts',
].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener('input', () => {
    if (id === 'cfgLauncherName') {
      const nextCfg = { ...currentConfig, externalLauncherName: el.value.trim() || 'AB Download' };
      currentConfig = nextCfg;
      updateDynamicLabels(nextCfg);
      updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking' });
    }
    scheduleAutoSave();
  });
  el.addEventListener('change', () => {
    if (id === 'cfgLauncherName') {
      const nextCfg = { ...currentConfig, externalLauncherName: el.value.trim() || 'AB Download' };
      currentConfig = nextCfg;
      updateDynamicLabels(nextCfg);
      updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking' });
    }
    scheduleAutoSave(0);
  });
});

[
  'cfgAutoCapture',
  'cfgShowConfirm',
  'cfgNotification',
].forEach(id => {
  document.getElementById(id).addEventListener('change', () => scheduleAutoSave(0));
});

document.getElementById('testConnBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResult');
  resultEl.className = 'conn-result';
  resultEl.textContent = '连接中…';
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    if (res && res.ok) {
      resultEl.className = 'conn-result ok';
      const s = res.stat;
      resultEl.textContent = `✓ 连接成功 — 活跃 ${s?.numActive || 0} · 等待 ${s?.numWaiting || 0} · 完成 ${s?.numStopped || 0}`;
    } else {
      resultEl.className = 'conn-result fail';
      resultEl.textContent = `✗ 连接失败 — ${res?.error || '无法连接'}`;
    }
  });
});

document.getElementById('testLauncherBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultLauncher');
  resultEl.className = 'conn-result';
  resultEl.textContent = '读取中…';
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    if (res && res.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = `✓ ${res.message || '接口已配置'}`;
    } else {
      resultEl.className = 'conn-result fail';
      resultEl.textContent = `✗ ${res?.error || res?.message || '接口未配置'}`;
    }
  });
});

document.getElementById('testNeatdmBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultNeatdm');
  resultEl.className = 'conn-result';
  resultEl.textContent = '连接中…';
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    if (res && res.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = `✓ ${res.message || 'NeatDM 已就绪'}`;
    } else {
      resultEl.className = 'conn-result fail';
      resultEl.textContent = `✗ ${res?.error || '无法连接到 NeatDM'}`;
    }
  });
});

function checkStatus(cfg = currentConfig) {
  updateHeaderStatusDisplay({ cfg, state: 'checking' });
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    if (res && res.ok) {
      updateHeaderStatusDisplay({ cfg, state: 'online', stat: res.stat });
    } else {
      updateHeaderStatusDisplay({ cfg, state: 'offline' });
    }
  });
}

async function refreshAll() {
  currentTabId = await getCurrentTabId();
  lastRenderedMediaKey = '';
  previousMediaCount = 0;
  lastAutoSwitchedMediaCount = 0;
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (res) {
      renderState(res);
      loadSettings(res.config);
      checkStatus(res.config);
    }
  });
}

document.getElementById('refreshBtn').addEventListener('click', () => {
  refreshAll();
});

document.getElementById('clearMediaBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA', tabId: currentTabId }, () => {
    previousMediaCount = 0;
    lastAutoSwitchedMediaCount = 0;
    showToast('已清空当前页面媒体列表');
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TASKS_UPDATE') {
    renderState(msg);
  }
});

(async () => {
  await refreshAll();
})();
