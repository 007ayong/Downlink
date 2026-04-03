// popup-app.js — Downlink popup wiring and rendering

const popupSettings = globalThis.PopupSettings;

function syncPopupGlobals() {
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
  document.querySelectorAll('.confirm-btn, .media-send-btn').forEach((btn) => {
    if (!btn.disabled) btn.textContent = `⚡ ${getSendLabel(cfg)}`;
  });
}

function updateHeaderStatusDisplay({ cfg = currentConfig, state = 'checking', stat = null, message = '' } = {}) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (!dot || !txt) return;

  dot.className = `status-dot${state === 'online' ? ' online' : state === 'offline' ? ' offline' : ''}`;

  if (state === 'online') {
    txt.textContent = cfg?.downloaderType === 'aria2'
      ? `已连接 · ↓${fmtSpeed(parseInt(stat?.downloadSpeed, 10) || 0)}`
      : `${getDownloaderName(cfg)} 已就绪`;
    return;
  }

  txt.textContent = state === 'offline'
    ? `${getDownloaderName(cfg)} 未连接`
    : `${getDownloaderName(cfg)} 连接中…`;
}

function updateSettingsVisibility(type = currentConfig.downloaderType) {
  const isAria2 = type === 'aria2';
  const isAbDownload = type === 'abdownload';
  const isNeatdm = type === 'neatdm';
  document.querySelectorAll('.aria2-only').forEach((el) => el.classList.toggle('settings-hidden', !isAria2));
  document.querySelectorAll('.launcher-only').forEach((el) => el.classList.toggle('settings-hidden', !isAbDownload));
  document.querySelectorAll('.neatdm-only').forEach((el) => el.classList.toggle('settings-hidden', !isNeatdm));
}

function renderTasks(tasks, pending) {
  const taskVals = Object.values(tasks || {}).filter((task) => !hiddenTaskGids.has(task?.gid));
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

  const pendingList = document.getElementById('pendingList');
  pendingList.innerHTML = '';
  pendingVals.forEach((item) => {
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
        <button class="btn btn-primary confirm-btn" data-key="${item.key}">⚡ ${getSendLabel(currentConfig)}</button>
        <button class="btn btn-ghost reject-btn" data-key="${item.key}">✕ 忽略</button>
      </div>
    `;
    pendingList.appendChild(card);
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

  const taskList = document.getElementById('taskList');
  taskList.innerHTML = '';
  let activeCount = 0;
  let doneCount = 0;
  let totalSpeed = 0;

  taskVals
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .forEach((task) => {
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
      const canViewInMotrix = currentConfig.downloaderType === 'aria2' && !!currentConfig.useMotrixNext;

      const showProgress = ['active', 'paused', 'waiting', 'complete'].includes(stateKey);
      const eta = (() => {
        if (!task.downloadSpeed || !task.totalLength) return '';
        const rem = task.totalLength - task.completedLength;
        const sec = rem / task.downloadSpeed;
        if (sec < 60) return `${Math.ceil(sec)}s`;
        if (sec < 3600) return `${Math.ceil(sec / 60)}m`;
        return `${(sec / 3600).toFixed(1)}h`;
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
          ${canViewInMotrix ? `<button class="task-btn" data-action="motrix-view">MotrixNext中查看</button>` : ''}
          ${stateKey === 'active' ? `<button class="task-btn" data-action="pause" data-gid="${task.gid}">⏸ 暂停</button>` : ''}
          ${stateKey === 'paused' ? `<button class="task-btn" data-action="resume" data-gid="${task.gid}">▶ 继续</button>` : ''}
          ${stateKey === 'complete' ? `<button class="task-btn" data-action="remove" data-gid="${task.gid}">✕ 清除</button>` : ''}
          ${['active', 'paused', 'waiting'].includes(stateKey) ? `<button class="task-btn danger" data-action="remove" data-gid="${task.gid}">✕ 取消</button>` : ''}
          ${stateKey === 'sent' ? `<button class="task-btn" data-action="remove" data-gid="${task.gid}">✕ 清除</button>` : ''}
          ${stateKey === 'error' ? `<button class="task-btn danger" data-action="remove" data-gid="${task.gid}">✕ 清除</button>` : ''}
        </div>
      `;
      taskList.appendChild(card);
      const icon = card.querySelector('.task-icon img');
      if (icon) icon.addEventListener('error', handleTaskIconError);
      card.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
          if (btn.dataset.action === 'motrix-view') {
            btn.disabled = true;
            const originalText = btn.textContent;
            btn.textContent = '打开中…';
            chrome.runtime.sendMessage({ type: 'OPEN_MOTRIXNEXT_VIEW' }, (res) => {
              if (!res?.ok) showToast(`打开失败：${res?.error || '无法唤起 MotrixNext'}`);
              setTimeout(() => {
                btn.disabled = false;
                btn.textContent = originalText;
              }, 500);
            });
            return;
          }
          const msgMap = { pause: 'PAUSE_TASK', resume: 'RESUME_TASK', remove: 'REMOVE_TASK' };
          chrome.runtime.sendMessage({ type: msgMap[btn.dataset.action], gid: btn.dataset.gid });
        });
      });
    });

  document.getElementById('fActive').textContent = activeCount;
  document.getElementById('fDone').textContent = doneCount;
  document.getElementById('fSpeed').textContent = fmtSpeed(totalSpeed);
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
  syncPopupGlobals();

  if (mediaKey === lastRenderedMediaKey) return;
  lastRenderedMediaKey = mediaKey;
  syncPopupGlobals();

  listEl.innerHTML = '';
  media.forEach((item) => {
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
        <button class="task-btn media-send-btn" data-send-id="${item.id}">⚡ ${getSendLabel(currentConfig)}</button>
      </div>
    `;
    listEl.appendChild(card);

    if (item.kind === 'video' && (!item.width || !item.height)) loadMediaMetadata(item, card);

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
            btn.textContent = `⚡ ${getSendLabel(currentConfig)}`;
          }, 1200);
          setTimeout(() => { document.querySelector('[data-tab="tasks"]').click(); }, 300);
        } else {
          btn.disabled = false;
          btn.textContent = `⚡ ${getSendLabel(currentConfig)}`;
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

function renderState(state) {
  hiddenTaskGids = new Set(state.hiddenTaskGids || []);
  currentState = {
    tasks: state.tasks || {},
    pending: state.pending || {},
    media: state.media || {},
  };
  syncPopupGlobals();
  renderTasks(currentState.tasks, currentState.pending);
  renderMedia(currentState.media);
}

function checkStatus(cfg = currentConfig) {
  updateHeaderStatusDisplay({ cfg, state: 'checking' });
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    if (res?.ok) {
      updateHeaderStatusDisplay({ cfg, state: 'online', stat: res.stat, message: res.message });
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
  syncPopupGlobals();
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (!res) return;
    loadSettings(res.config);
    renderState(res);
    checkStatus(res.config);
  });
}

const settingsController = popupSettings.createSettingsController({
  getCurrentConfig: () => currentConfig,
  setCurrentConfig: (next) => { currentConfig = next; },
  getCurrentState: () => currentState,
  getLoading: () => isLoadingSettings,
  setLoading: (next) => { isLoadingSettings = next; },
  getAutoSaveTimer: () => autoSaveTimer,
  setAutoSaveTimer: (next) => { autoSaveTimer = next; },
  getSaveFeedbackTimer: () => saveFeedbackTimer,
  setSaveFeedbackTimer: (next) => { saveFeedbackTimer = next; },
  syncGlobals: syncPopupGlobals,
  updateSettingsVisibility,
  updateDynamicLabels,
  updateHeaderStatusDisplay,
  renderTasks,
  checkStatus,
});

const {
  collectSettingsFromForm,
  loadSettings,
  persistSettings,
  scheduleAutoSave,
} = settingsController;

document.getElementById('headerLogo').addEventListener('error', (event) => {
  const logo = event.currentTarget;
  if (!logo || logo.src.endsWith(DEFAULT_HEADER_LOGO)) return;
  logo.dataset.currentSrc = DEFAULT_HEADER_LOGO;
  logo.src = DEFAULT_HEADER_LOGO;
});

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((item) => item.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((panel) => panel.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(`panel-${tab.dataset.tab}`).classList.add('active');
    updateDynamicLabels(currentConfig);
  });
});

settingsController.bindSettingsEvents();

document.getElementById('testConnBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResult');
  resultEl.className = 'conn-result';
  resultEl.textContent = '连接中…';
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    if (res?.ok) {
      const stat = res.stat;
      resultEl.className = 'conn-result ok';
      resultEl.textContent = `✓ 连接成功 — 活跃 ${stat?.numActive || 0} · 等待 ${stat?.numWaiting || 0} · 完成 ${stat?.numStopped || 0}`;
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = `✗ 连接失败 — ${res?.error || '无法连接'}`;
  });
});

document.getElementById('testLauncherBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultLauncher');
  resultEl.className = 'conn-result';
  resultEl.textContent = '读取中…';
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = `✓ ${res.message || '接口已配置'}`;
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = `✗ ${res?.error || res?.message || '接口未配置'}`;
  });
});

document.getElementById('testNeatdmBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultNeatdm');
  resultEl.className = 'conn-result';
  resultEl.textContent = '连接中…';
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION' }, (res) => {
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = `✓ ${res.message || 'NeatDM 已就绪'}`;
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = `✗ ${res?.error || '无法连接到 NeatDM'}`;
  });
});

document.getElementById('refreshBtn').addEventListener('click', () => {
  refreshAll();
});

document.getElementById('clearMediaBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA', tabId: currentTabId }, () => {
    previousMediaCount = 0;
    lastAutoSwitchedMediaCount = 0;
    syncPopupGlobals();
    showToast('已清空当前页面媒体列表');
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TASKS_UPDATE') renderState(msg);
});

syncPopupGlobals();
refreshAll();
