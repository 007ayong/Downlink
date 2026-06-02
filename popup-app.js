// popup-app.js — Downlink popup wiring and rendering

const popupSettings = globalThis.PopupSettings;
const popupAppI18n = globalThis.Localization || {};
const HEADER_STATUS_MIN_CHECKING_MS = 500;
const popupAppT = popupAppI18n.t || ((key, substitutions, fallback = key) => {
  if (fallback && substitutions !== undefined) {
    const values = Array.isArray(substitutions) ? substitutions : [substitutions];
    return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
  }
  return fallback || key;
});
const pendingFilenameDrafts = new Map();
const mediaFilenameDrafts = new Map();
let lastRenderedPendingKey = '';

function getAria2SingleThreadOptions() {
  return {
    split: '1',
    'max-connection-per-server': '1',
    'min-split-size': '1024M',
  };
}

function getGopeedSingleThreadOptions() {
  return {
    gopeedSingleThread: true,
  };
}

function getSingleThreadOptions(cfg = currentConfig) {
  if (cfg.downloaderType === 'gopeed') return getGopeedSingleThreadOptions();
  return getAria2SingleThreadOptions();
}

function getPendingFilenameValue(item) {
  return pendingFilenameDrafts.has(item.key)
    ? pendingFilenameDrafts.get(item.key)
    : decodeDisplayFilename(item.filename || item.url.split('?')[0].split('/').pop() || '');
}

function getMediaFilenameValue(item) {
  return mediaFilenameDrafts.has(item.id)
    ? mediaFilenameDrafts.get(item.id)
    : (item.filename || popupAppT('untitledMedia', undefined, '未命名媒体'));
}

function mediaEditIcon() {
  return '<svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M10.9 2.4a1.6 1.6 0 0 1 2.3 2.3l-7.1 7.1-3 .7.7-3 7.1-7.1Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M9.8 3.5l2.7 2.7" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>';
}

function mediaFactIcon(name) {
  const icons = {
    size: '<svg class="media-fact-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.5" y="3.5" width="11" height="9" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4.75 10.25h6.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="5" cy="6.25" r=".75" fill="currentColor"/></svg>',
    resolution: '<svg class="media-fact-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2.5" y="4" width="11" height="7.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M6.25 13.25h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    duration: '<svg class="media-fact-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><circle cx="8" cy="8" r="5.25" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5.25V8l2 1.25" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };
  return icons[name] || '';
}

function buildPendingConfirmRenderKey(pendingVals) {
  return pendingVals.map((item) => [
    item.key,
    item.url,
    getPendingFilenameValue(item),
  ].join('\u0001')).join('\u0002')
    + `|${popupAppT('pendingDownload', undefined, '待确认下载')}`
    + `|${popupAppT('fileName', undefined, '文件名')}`
    + `|${popupAppT('aria2SingleThread', undefined, '单线程不分片下载')}`
    + `|${popupAppT('ignore', undefined, '忽略')}`
    + `|${getSendLabel(currentConfig)}`
    + `|${currentConfig.downloaderType || ''}`;
}

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
  globalThis.autoConnectionCheckTimer = autoConnectionCheckTimer;
  globalThis.autoConnectionCheckInFlight = autoConnectionCheckInFlight;
  globalThis.autoConnectionCheckSettled = autoConnectionCheckSettled;
  globalThis.headerStatusState = headerStatusState;
  globalThis.headerStatusMinUntil = headerStatusMinUntil;
  globalThis.headerStatusTransitionTimer = headerStatusTransitionTimer;
}

function applyLocaleFromConfig(cfg = currentConfig) {
  popupAppI18n.setLocalePreference?.(cfg?.language || 'auto');
  popupAppI18n.applyTranslations?.(document);
  renderHeaderStatus({ ...headerStatusState, cfg });
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
  if (title) title.textContent = popupAppT('appTitle', undefined, 'Downlink');
  updateHeaderLogo(cfg);
  document.querySelectorAll('.confirm-btn, .media-send-btn').forEach((btn) => {
    if (!btn.disabled) btn.textContent = getSendLabel(cfg);
  });
}

function getSniffingToggleIcon(isPaused) {
  const path = isPaused
    ? 'M5.4 3.5c0-.7.76-1.13 1.36-.76l5.6 3.5c.56.35.56 1.17 0 1.52l-5.6 3.5c-.6.37-1.36-.06-1.36-.76v-7Z'
    : 'M5.25 3.25h1.5c.55 0 1 .45 1 1v7.5c0 .55-.45 1-1 1h-1.5c-.55 0-1-.45-1-1v-7.5c0-.55.45-1 1-1Zm5 0h1.5c.55 0 1 .45 1 1v7.5c0 .55-.45 1-1 1h-1.5c-.55 0-1-.45-1-1v-7.5c0-.55.45-1 1-1Z';
  return `<svg class="control-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="${path}" fill="currentColor"/></svg>`;
}

function renderHeaderStatus({ cfg = currentConfig, state = 'checking', stat = null, message = '' } = {}) {
  const dot = document.getElementById('statusDot');
  const txt = document.getElementById('statusText');
  if (!dot || !txt) return;

  dot.className = `status-dot${state === 'online' ? ' online' : state === 'offline' ? ' offline' : ''}`;

  if (state === 'online') {
    const downloadSpeed = parseInt(stat?.downloadSpeed, 10) || 0;
    txt.textContent = cfg?.downloaderType === 'aria2' && downloadSpeed > 0
      ? popupAppT('connectedWithSpeed', [fmtSpeed(downloadSpeed)], `已连接 · ${fmtSpeed(downloadSpeed)}`)
      : popupAppT('downloaderReady', [getDownloaderName(cfg)], `${getDownloaderName(cfg)} 已就绪`);
    return;
  }

  if (state === 'checking') {
    txt.textContent = popupAppT('statusCheckingConnection', undefined, '检测连接状态中…');
    return;
  }

  txt.textContent = state === 'offline'
    ? popupAppT('downloaderOffline', [getDownloaderName(cfg)], `${getDownloaderName(cfg)} 未连接`)
    : popupAppT('downloaderConnecting', [getDownloaderName(cfg)], `${getDownloaderName(cfg)} 连接中…`);
}

function updateHeaderStatusDisplay({ cfg = currentConfig, state = 'checking', stat = null, message = '' } = {}) {
  headerStatusState = { cfg, state, stat, message };

  if (state === 'checking') {
    headerStatusMinUntil = Date.now() + HEADER_STATUS_MIN_CHECKING_MS;
    clearTimeout(headerStatusTransitionTimer);
    headerStatusTransitionTimer = null;
    syncPopupGlobals();
    renderHeaderStatus(headerStatusState);
    return;
  }

  const delay = Math.max(0, headerStatusMinUntil - Date.now());
  if (delay > 0) {
    clearTimeout(headerStatusTransitionTimer);
    headerStatusTransitionTimer = setTimeout(() => {
      headerStatusTransitionTimer = null;
      headerStatusMinUntil = 0;
      syncPopupGlobals();
      renderHeaderStatus(headerStatusState);
    }, delay);
    syncPopupGlobals();
    return;
  }

  headerStatusMinUntil = 0;
  syncPopupGlobals();
  renderHeaderStatus(headerStatusState);
}

function getConnectionCheckSignature(cfg = currentConfig) {
  if (!cfg?.downloaderType) return '';
  if (cfg.downloaderType === 'aria2') {
    return ['aria2', cfg.aria2Rpc || '', cfg.aria2Secret || ''].join('|');
  }
  if (cfg.downloaderType === 'abdownload') {
    return [
      'abdownload',
      cfg.externalLauncherHost || 'localhost',
      cfg.externalLauncherPort || '15151',
    ].join('|');
  }
  if (cfg.downloaderType === 'motrixnext') {
    return [
      'motrixnext',
      cfg.motrixNextPort || '16801',
      cfg.motrixNextSecret || '',
    ].join('|');
  }
  if (cfg.downloaderType === 'gopeed') {
    return [
      'gopeed',
      cfg.gopeedApi || 'http://127.0.0.1:9999',
      cfg.gopeedToken || '',
    ].join('|');
  }
  if (cfg.downloaderType === 'neatdm') return 'neatdm';
  return '';
}

function requestAutoConnectionCheck(cfg = currentConfig) {
  const signature = getConnectionCheckSignature(cfg);
  if (!signature) return;
  if (signature === autoConnectionCheckSettled || signature === autoConnectionCheckInFlight) return;

  clearTimeout(autoConnectionCheckTimer);
  autoConnectionCheckTimer = setTimeout(() => {
    autoConnectionCheckTimer = null;
    if (getConnectionCheckSignature(cfg) !== signature) return;
    autoConnectionCheckInFlight = signature;
    syncPopupGlobals();
    updateHeaderStatusDisplay({ cfg, state: 'checking' });
    chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: cfg }, (res) => {
      if (autoConnectionCheckInFlight !== signature) return;
      autoConnectionCheckInFlight = null;
      syncPopupGlobals();
      if (getConnectionCheckSignature(currentConfig) !== signature) return;
      if (res?.ok) {
        updateHeaderStatusDisplay({ cfg: currentConfig, state: 'online', stat: res.stat, message: res.message });
      } else {
        updateHeaderStatusDisplay({ cfg: currentConfig, state: 'offline' });
      }
      autoConnectionCheckSettled = signature;
      syncPopupGlobals();
    });
  }, 0);
  syncPopupGlobals();
}

function updateSettingsVisibility(type = currentConfig.downloaderType) {
  const isAria2 = type === 'aria2';
  const isAbDownload = type === 'abdownload';
  const isMotrixNext = type === 'motrixnext';
  const isGopeed = type === 'gopeed';
  const isNeatdm = type === 'neatdm';
  const motrixAutoCloseEnabled = !!currentConfig.motrixBridgeAutoClose;
  document.querySelectorAll('.aria2-only').forEach((el) => el.classList.toggle('settings-hidden', !isAria2));
  document.querySelectorAll('.launcher-only').forEach((el) => el.classList.toggle('settings-hidden', !isAbDownload));
  document.querySelectorAll('.motrixnext-only').forEach((el) => el.classList.toggle('settings-hidden', !isMotrixNext));
  document.querySelectorAll('.gopeed-only').forEach((el) => el.classList.toggle('settings-hidden', !isGopeed));
  document.querySelectorAll('.neatdm-only').forEach((el) => el.classList.toggle('settings-hidden', !isNeatdm));
  document.querySelectorAll('.motrix-autoclose-only').forEach((el) => {
    const toggle = el.querySelector('#cfgMotrixBridgeAutoClose');
    if (toggle) toggle.disabled = !motrixAutoCloseEnabled;
    el.classList.toggle('settings-disabled', !motrixAutoCloseEnabled);
  });
}

function renderInlineAlert(elementId, message = currentState.uiAlert?.message || '', { shake = false } = {}) {
  const alertEl = document.getElementById(elementId);
  if (!alertEl) return;
  alertEl.textContent = message;
  alertEl.classList.toggle('show', !!message);
  alertEl.classList.remove('shake');
  if (!message || !shake) return;
  void alertEl.offsetWidth;
  alertEl.classList.add('shake');
}

function renderTasks(tasks, pending) {
  renderInlineAlert('taskAlert');

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

  const visiblePendingKeys = new Set(pendingVals.map((item) => item.key));
  Array.from(pendingFilenameDrafts.keys()).forEach((key) => {
    if (!visiblePendingKeys.has(key)) pendingFilenameDrafts.delete(key);
  });

  const pendingRenderKey = buildPendingConfirmRenderKey(pendingVals);
  const pendingList = document.getElementById('pendingList');
  if (pendingRenderKey !== lastRenderedPendingKey) {
    pendingList.innerHTML = '';
    pendingVals.forEach((item) => {
      const filename = getPendingFilenameValue(item);
      const canForceSingleThread = ['aria2', 'gopeed'].includes(currentConfig.downloaderType);
      const singleThreadOption = canForceSingleThread ? `
        <label class="pending-option">
          <input type="checkbox" class="force-single-thread aria2-single-thread"/>
          <span>${popupAppT('aria2SingleThread', undefined, '单线程不分片下载')}</span>
        </label>
      ` : '';
      const card = document.createElement('div');
      card.className = 'pending-card';
      card.innerHTML = `
        <div class="pending-label">${popupAppT('pendingDownload', undefined, '待确认下载')}</div>
        <div class="pending-url">${escHtml(item.url)}</div>
        <div class="pending-filename-row">
          <label>${popupAppT('fileName', undefined, '文件名')}</label>
          <input type="text" class="pending-fname" value="${escHtml(filename)}" placeholder="${escHtml(popupAppT('autoDetect', undefined, '自动识别'))}" autocomplete="off" spellcheck="false"/>
        </div>
        ${singleThreadOption}
        <div class="pending-actions">
          <button class="btn btn-primary confirm-btn" data-key="${item.key}">${getSendLabel(currentConfig)}</button>
          <button class="btn btn-ghost reject-btn" data-key="${item.key}">${popupAppT('ignore', undefined, '忽略')}</button>
        </div>
      `;
      pendingList.appendChild(card);
      card.querySelector('.pending-fname').addEventListener('input', (event) => {
        pendingFilenameDrafts.set(item.key, event.currentTarget.value);
        lastRenderedPendingKey = buildPendingConfirmRenderKey(pendingVals);
      });
      card.querySelector('.confirm-btn').addEventListener('click', () => {
        const fname = card.querySelector('.pending-fname').value.trim();
        const opts = canForceSingleThread && card.querySelector('.aria2-single-thread')?.checked
          ? getSingleThreadOptions(currentConfig)
          : {};
        chrome.runtime.sendMessage({ type: 'CONFIRM_DOWNLOAD', key: item.key, filename: fname, opts }, (res) => {
          if (res?.ok) {
            pendingFilenameDrafts.delete(item.key);
            lastRenderedPendingKey = '';
          }
          if (!res?.ok) {
            showToast(popupAppT(
              'sendFailed',
              [res?.error || popupAppT('downloaderConnectionFailed', undefined, '与下载器连接失败，检查下载器是否正在运行')],
              `发送失败：${res?.error || '与下载器连接失败，检查下载器是否正在运行'}`
            ));
          }
        });
      });
      card.querySelector('.reject-btn').addEventListener('click', () => {
        pendingFilenameDrafts.delete(item.key);
        lastRenderedPendingKey = '';
        chrome.runtime.sendMessage({ type: 'REJECT_DOWNLOAD', key: item.key });
      });
    });
    lastRenderedPendingKey = pendingRenderKey;
  }

  const taskList = document.getElementById('taskList');
  taskList.innerHTML = '';
  let activeCount = 0;
  let doneCount = 0;
  let totalSpeed = 0;

  taskVals
    .sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0))
    .forEach((task) => {
      const name = task.filename || task.url?.split('?')[0].split('/').pop() || popupAppT('unknownFile', undefined, '未知文件');
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
      const canViewInGopeed = task.provider === 'gopeed';

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
              ${task.targetName ? `<span>${popupAppT('targetLabel', undefined, '目标')} ${escHtml(task.targetName)}</span>` : ''}
              ${stateKey === 'active' && task.downloadSpeed ? `<span>${popupAppT('speedLabel', undefined, '速度')} ${fmtSpeed(task.downloadSpeed)}</span>` : ''}
              ${stateKey === 'active' && eta ? `<span>${popupAppT('etaLabel', undefined, '剩余')} ${eta}</span>` : ''}
              ${task.connections ? `<span>${popupAppT('connectionsCount', [task.connections], `${task.connections}线`)}</span>` : ''}
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
          ${canViewInMotrix ? `<button class="task-btn" data-action="motrix-view">${popupAppT('motrixView', undefined, 'MotrixNext中查看')}</button>` : ''}
          ${canViewInGopeed ? `<button class="task-btn" data-action="gopeed-view">${popupAppT('gopeedView', undefined, 'Gopeed中查看')}</button>` : ''}
          ${stateKey === 'active' ? `<button class="task-btn" data-action="pause" data-gid="${task.gid}">${popupAppT('pauseTask', undefined, '暂停')}</button>` : ''}
          ${stateKey === 'paused' ? `<button class="task-btn" data-action="resume" data-gid="${task.gid}">${popupAppT('resumeTask', undefined, '继续')}</button>` : ''}
          ${stateKey === 'complete' ? `<button class="task-btn" data-action="remove" data-gid="${task.gid}">${popupAppT('clearTask', undefined, '清除')}</button>` : ''}
          ${['active', 'paused', 'waiting'].includes(stateKey) ? `<button class="task-btn danger" data-action="remove" data-gid="${task.gid}">${popupAppT('cancelTask', undefined, '取消')}</button>` : ''}
          ${stateKey === 'sent' ? `<button class="task-btn" data-action="remove" data-gid="${task.gid}">${popupAppT('clearTask', undefined, '清除')}</button>` : ''}
          ${stateKey === 'error' ? `<button class="task-btn danger" data-action="remove" data-gid="${task.gid}">${popupAppT('clearTask', undefined, '清除')}</button>` : ''}
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
            btn.textContent = popupAppT('opening', undefined, '打开中…');
            chrome.runtime.sendMessage({ type: 'OPEN_MOTRIXNEXT_VIEW' }, (res) => {
              if (!res?.ok) {
                showToast(popupAppT(
                  'openFailed',
                  [res?.error || popupAppT('cannotLaunchMotrix', undefined, '无法唤起 MotrixNext')],
                  `打开失败：${res?.error || '无法唤起 MotrixNext'}`
                ));
              }
              setTimeout(() => {
                btn.disabled = false;
                btn.textContent = originalText;
              }, 500);
            });
            return;
          }
          if (btn.dataset.action === 'gopeed-view') {
            btn.disabled = true;
            const originalText = btn.textContent;
            btn.textContent = popupAppT('opening', undefined, '打开中…');
            chrome.runtime.sendMessage({ type: 'OPEN_GOPEED_VIEW' }, (res) => {
              if (!res?.ok) {
                showToast(popupAppT(
                  'openFailed',
                  [res?.error || popupAppT('cannotLaunchGopeed', undefined, '无法唤起 Gopeed')],
                  `打开失败：${res?.error || '无法唤起 Gopeed'}`
                ));
              }
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

  document.getElementById('fSpeed').textContent = fmtSpeed(totalSpeed);
  const footerStats = document.getElementById('footerStatsLabel');
  if (footerStats) footerStats.textContent = popupAppT('footerStats', [activeCount, doneCount], `活跃 ${activeCount} · 完成 ${doneCount}`);
}

function loadMediaMetadata(item, card) {
  const tagName = item.kind === 'audio' ? 'audio' : 'video';
  const mediaEl = document.createElement(tagName);
  let cleanupTimer = null;
  let cleanedUp = false;
  const clearMetadataRule = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (cleanupTimer) clearTimeout(cleanupTimer);
    chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_METADATA', id: item.id }, () => {});
  };
  const removeMediaEl = () => {
    clearMetadataRule();
    mediaEl.remove();
  };
  mediaEl.preload = 'metadata';
  mediaEl.style.position = 'absolute';
  mediaEl.style.width = '1px';
  mediaEl.style.height = '1px';
  mediaEl.style.opacity = '0';
  mediaEl.muted = true;
  mediaEl.addEventListener('loadedmetadata', () => {
    if (item.kind === 'video' || item.kind === 'media') {
      const width = mediaEl.videoWidth || 0;
      const height = mediaEl.videoHeight || 0;
      const inferredKind = inferMediaKindFromMetadata(item, { loaded: true, width, height });
      const resolutionEl = card.querySelector('.media-resolution');
      if (resolutionEl && width && height) resolutionEl.textContent = `${width}×${height}`;
      chrome.runtime.sendMessage({
        type: 'UPDATE_MEDIA_METADATA',
        id: item.id,
        width,
        height,
        kind: inferredKind,
        duration: Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0,
      });
    }
    removeMediaEl();
  }, { once: true });
  mediaEl.addEventListener('error', removeMediaEl, { once: true });
  card.appendChild(mediaEl);
  chrome.runtime.sendMessage({ type: 'PREPARE_MEDIA_METADATA', id: item.id }, () => {
    mediaEl.src = item.resourceUrl;
    cleanupTimer = setTimeout(removeMediaEl, 15000);
  });
}

function renderMedia(mediaByTab, pausedTabs = []) {
  const listEl = document.getElementById('mediaList');
  const emptyEl = document.getElementById('mediaEmpty');
  const summaryEl = document.getElementById('mediaSummary');
  const mediaBadge = document.getElementById('mediaBadge');
  const toggleSniffingBtn = document.getElementById('toggleSniffingBtn');
  renderInlineAlert('mediaAlert');
  const media = currentTabId == null ? [] : (mediaByTab?.[currentTabId] || []);
  const mediaKey = buildMediaRenderKey(media);
  const mediaCount = media.length;
  const isPaused = currentTabId != null && pausedTabs.includes(currentTabId);

  emptyEl.style.display = media.length ? 'none' : 'flex';
  if (isPaused) {
    summaryEl.textContent = popupAppT('sniffingPaused', undefined, '已暂停嗅探，直播资源不再刷新');
  } else {
    summaryEl.textContent = media.length
      ? popupAppT('currentTabMediaFound', [media.length], `当前标签页已发现 ${media.length} 个直链媒体资源`)
      : popupAppT('waitingMediaRequests', undefined, '等待页面发起音视频请求…');
  }
  if (mediaCount > 0) {
    mediaBadge.textContent = String(mediaCount);
    mediaBadge.style.display = 'inline-block';
  } else {
    mediaBadge.style.display = 'none';
  }

  if (toggleSniffingBtn) {
    const label = isPaused
      ? popupAppT('resumeSniffing', undefined, '恢复嗅探')
      : popupAppT('pauseSniffing', undefined, '暂停嗅探');
    toggleSniffingBtn.innerHTML = getSniffingToggleIcon(isPaused);
    toggleSniffingBtn.title = label;
    if (typeof toggleSniffingBtn.setAttribute === 'function') {
      toggleSniffingBtn.setAttribute('aria-label', label);
    } else {
      toggleSniffingBtn.ariaLabel = label;
    }
    toggleSniffingBtn.classList.toggle('btn-primary', isPaused);
    toggleSniffingBtn.classList.toggle('btn-ghost', !isPaused);
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
    card.className = `media-card media-card-${item.kind || 'media'}`;
    card.dataset.mediaId = item.id;
    const iconSrc = getFileIcon({ name: item.filename, mime: item.mime, kind: item.kind });
    const durationText = mediaDurationLabel(item.duration);
    const resolutionText = item.kind === 'video' || item.kind === 'media' ? mediaResolutionLabel(item) : '';
    const displayFilename = getMediaFilenameValue(item);
    card.innerHTML = `
      <div class="media-top">
        <div class="media-icon"><img src="${escHtml(iconSrc)}" alt="" loading="lazy"></div>
        <div class="media-info">
          <div class="media-title-row">
            <div class="media-name" title="${escHtml(displayFilename)}">${escHtml(displayFilename)}</div>
            <input class="media-name-input" type="text" value="${escHtml(displayFilename)}" autocomplete="off" spellcheck="false" hidden/>
            <button class="media-name-edit" type="button" title="${escHtml(popupAppT('editFileName', undefined, '编辑文件名'))}" aria-label="${escHtml(popupAppT('editFileName', undefined, '编辑文件名'))}">${mediaEditIcon()}</button>
            <span class="media-chip media-kind kind-${escHtml(item.kind || 'video')}">${mediaKindLabel(item.kind)}</span>
          </div>
          <div class="media-url">${escHtml(item.resourceUrl)}</div>
          <div class="media-meta">
            <span class="media-fact">${mediaFactIcon('size')}<span>${item.size ? fmt(item.size) : popupAppT('unknownSize', undefined, '大小未知')}</span></span>
            ${resolutionText ? `<span class="media-fact media-resolution">${mediaFactIcon('resolution')}<span>${escHtml(resolutionText)}</span></span>` : ''}
            ${durationText ? `<span class="media-fact">${mediaFactIcon('duration')}<span>${escHtml(durationText)}</span></span>` : ''}
          </div>
          ${item.mime ? `<div class="media-mime">${escHtml(item.mime)}</div>` : ''}
        </div>
      </div>
      <div class="media-actions">
        <button class="task-btn media-preview-toggle" data-id="${item.id}">${popupAppT('previewMedia', undefined, '预览')}</button>
        <button class="task-btn" data-copy-url="${escHtml(item.resourceUrl)}">${popupAppT('copyLink', undefined, '复制链接')}</button>
        <button class="task-btn media-send-btn" data-send-id="${item.id}">${getSendLabel(currentConfig)}</button>
      </div>
    `;
    listEl.appendChild(card);
    const icon = card.querySelector('.media-icon img');
    if (icon) icon.addEventListener('error', handleTaskIconError);

    if ((item.kind === 'video' || item.kind === 'media') && (!item.width || !item.height)) {
      // Defer metadata loading slightly to allow initial UI paint and avoid
      // triggering many network requests during popup open.
      setTimeout(() => loadMediaMetadata(item, card), 300);
    }

    const nameEl = card.querySelector('.media-name');
    const nameInput = card.querySelector('.media-name-input');
    const editNameBtn = card.querySelector('.media-name-edit');
    let editingOriginalName = displayFilename;
    const commitMediaName = ({ cancel = false } = {}) => {
      if (!nameEl || !nameInput) return getMediaFilenameValue(item);
      const fallbackName = item.filename || popupAppT('untitledMedia', undefined, '未命名媒体');
      const nextName = cancel ? editingOriginalName : (nameInput.value.trim() || fallbackName);
      mediaFilenameDrafts.set(item.id, nextName);
      nameEl.textContent = nextName;
      nameEl.title = nextName;
      nameInput.value = nextName;
      nameInput.hidden = true;
      nameEl.hidden = false;
      return nextName;
    };
    const openMediaNameEditor = () => {
      if (!nameEl || !nameInput) return;
      editingOriginalName = getMediaFilenameValue(item);
      nameInput.value = editingOriginalName;
      nameEl.hidden = true;
      nameInput.hidden = false;
      nameInput.focus();
      nameInput.select();
    };
    if (editNameBtn) {
      editNameBtn.addEventListener('click', () => {
        if (nameInput?.hidden === false) commitMediaName();
        else openMediaNameEditor();
      });
    }
    if (nameInput) {
      nameInput.addEventListener('blur', () => commitMediaName());
      nameInput.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          nameInput.blur();
        } else if (event.key === 'Escape') {
          event.preventDefault();
          commitMediaName({ cancel: true });
        }
      });
    }

    card.querySelector('[data-copy-url]').addEventListener('click', async (event) => {
      const copied = await copyText(event.currentTarget.dataset.copyUrl);
      showToast(copied ? popupAppT('copySuccess', undefined, '已复制媒体链接') : popupAppT('copyFailed', undefined, '复制失败'));
    });

    card.querySelector('[data-send-id]').addEventListener('click', (event) => {
      const btn = event.currentTarget;
      const filename = commitMediaName();
      btn.disabled = true;
      btn.textContent = popupAppT('sending', undefined, '发送中…');
      chrome.runtime.sendMessage({ type: 'ADD_MEDIA_TASK', id: btn.dataset.sendId, filename }, (res) => {
        if (res?.ok) {
          btn.textContent = popupAppT('sent', undefined, '已发送');
          showToast(popupAppT('mediaSentToDownloader', undefined, '媒体已发送到下载器'));
          setTimeout(() => {
            btn.disabled = false;
            btn.textContent = getSendLabel(currentConfig);
          }, 1200);
          if (currentConfig.downloaderType !== 'motrixnext') {
            setTimeout(() => { document.querySelector('[data-tab="tasks"]').click(); }, 300);
          }
        } else {
          btn.disabled = false;
          btn.textContent = getSendLabel(currentConfig);
          const message = res?.error || popupAppT('downloaderConnectionFailed', undefined, '与下载器连接失败，检查下载器是否正在运行');
          currentState.uiAlert = { type: 'connection-failure', message };
          renderInlineAlert('mediaAlert', message, { shake: true });
          syncPopupGlobals();
        }
      });
    });

    card.querySelector('.media-preview-toggle').addEventListener('click', (event) => {
      const btn = event.currentTarget;
      btn.disabled = true;
      const originalText = btn.textContent;
      btn.textContent = popupAppT('opening', undefined, '打开中…');
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
    pausedTabs: state.pausedTabs || [],
    uiAlert: state.uiAlert || null,
  };
  syncPopupGlobals();
  renderTasks(currentState.tasks, currentState.pending);
  renderMedia(currentState.media, currentState.pausedTabs);
}

async function refreshAll() {
  currentTabId = await getCurrentTabId();
  lastRenderedMediaKey = '';
  previousMediaCount = 0;
  lastAutoSwitchedMediaCount = 0;
  syncPopupGlobals();
  chrome.runtime.sendMessage({ type: 'GET_STATE' }, (res) => {
    if (!res) return;
    const config = normalizePopupConfig(res.config);
    applyLocaleFromConfig(config);
    loadSettings(config);
    renderState({ ...res, config });
  });
}

const settingsController = popupSettings.createSettingsController({
  getCurrentConfig: () => currentConfig,
  setCurrentConfig: (next) => { currentConfig = next; },
  getSavedConfig: () => savedConfig,
  setSavedConfig: (next) => { savedConfig = next; },
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
  renderTasks,
  requestAutoConnectionCheck,
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

document.getElementById('cfgLanguage').addEventListener('change', () => {
  const nextCfg = normalizePopupConfig(collectSettingsFromForm());
  currentConfig = { ...currentConfig, ...nextCfg };
  applyLocaleFromConfig(currentConfig);
  updateDynamicLabels(currentConfig);
  renderTasks(currentState.tasks, currentState.pending);
  renderMedia(currentState.media);
  syncPopupGlobals();
});

document.getElementById('cfgDownloaderType').addEventListener('change', (event) => {
  const nextType = event.target.value;
  const nextCfg = normalizePopupConfig({ ...currentConfig, ...collectSettingsFromForm(), downloaderType: nextType });
  updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking', stat: null, message: '' });
});

function getTestConnectionConfig() {
  return normalizePopupConfig(collectSettingsFromForm());
}

document.getElementById('testConnBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResult');
  const testConfig = getTestConnectionConfig();
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('downloaderConnecting', ['Aria2'], 'Aria2 连接中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    if (res?.ok) {
      const stat = res.stat;
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectionSuccessStats', [stat?.numActive || 0, stat?.numWaiting || 0, stat?.numStopped || 0], `连接成功 — 活跃 ${stat?.numActive || 0} · 等待 ${stat?.numWaiting || 0} · 完成 ${stat?.numStopped || 0}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = `${popupAppT('connectionFailedTitle', ['Aria2'], '与 Aria2 连接失败')}：${res?.error || popupAppT('connectionFailedWithLabel', ['Aria2'], '检查 Aria2 是否正在运行')}`;
  });
});

document.getElementById('testLauncherBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultLauncher');
  const testConfig = getTestConnectionConfig();
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('readInProgress', undefined, '读取中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectedEndpoint', [res.message || popupAppT('interfaceConfigured', undefined, '接口已配置')], `${res.message || '接口已配置'}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = `${popupAppT('connectionFailedTitle', ['AB DM'], '与 AB DM 连接失败')}：${res?.error || popupAppT('connectionFailedWithLabel', ['AB DM'], '检查 AB DM 是否正在运行')}`;
  });
});

document.getElementById('testMotrixNextBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultMotrixNext');
  const testConfig = getTestConnectionConfig();
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('downloaderConnecting', ['MotrixNext'], 'MotrixNext 连接中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectedEndpoint', [res.message || popupAppT('motrixNextReady', undefined, 'MotrixNext 已就绪')], `${res.message || 'MotrixNext 已就绪'}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = `${popupAppT('connectionFailedTitle', ['MotrixNext'], '与 MotrixNext 连接失败')}：${res?.error || popupAppT('connectionFailedWithLabel', ['MotrixNext'], '检查 MotrixNext 是否正在运行')}`;
  });
});

document.getElementById('testGopeedBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultGopeed');
  const testConfig = getTestConnectionConfig();
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('downloaderConnecting', ['Gopeed'], 'Gopeed 连接中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectedEndpoint', [res.message || popupAppT('gopeedReady', undefined, 'Gopeed 已就绪')], `${res.message || 'Gopeed 已就绪'}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = `${popupAppT('connectionFailedTitle', ['Gopeed'], '与 Gopeed 连接失败')}：${res?.error || popupAppT('connectionFailedWithLabel', ['Gopeed'], '检查 Gopeed 是否正在运行')}`;
  });
});

document.getElementById('testNeatdmBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultNeatdm');
  const testConfig = getTestConnectionConfig();
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('downloaderConnecting', ['NeatDM'], 'NeatDM 连接中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectedEndpoint', [res.message || popupAppT('neatdmReady', undefined, 'NeatDM 已就绪')], `${res.message || 'NeatDM 已就绪'}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = `${popupAppT('connectionFailedTitle', ['NeatDM'], '与 NeatDM 连接失败')}：${res?.error || popupAppT('connectionFailedWithLabel', ['NeatDM'], '检查 NeatDM 是否正在运行')}`;
  });
});

document.getElementById('clearMediaBtn').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA', tabId: currentTabId }, () => {
    previousMediaCount = 0;
    lastAutoSwitchedMediaCount = 0;
    syncPopupGlobals();
    showToast(popupAppT('clearedCurrentPageMedia', undefined, '已清空当前页面媒体列表'));
  });
});

document.getElementById('toggleSniffingBtn').addEventListener('click', () => {
  const isPaused = currentState.pausedTabs?.includes(currentTabId);
  const msgType = isPaused ? 'RESUME_MEDIA_SNIFFING' : 'PAUSE_MEDIA_SNIFFING';
  chrome.runtime.sendMessage({ type: msgType, tabId: currentTabId }, (res) => {
    if (res?.disabled) {
      showToast(popupAppT('sniffingResumeBlockedByCaptureOff', undefined, '请先开启拦截'));
      return;
    }
    showToast(isPaused && res?.ok !== false
      ? popupAppT('sniffingResumed', undefined, '已恢复嗅探')
      : popupAppT('sniffingPausedToast', undefined, '已暂停嗅探'));
  });
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'TASKS_UPDATE') renderState(msg);
});

applyLocaleFromConfig(currentConfig);
syncPopupGlobals();
// Defer heavy initialization to next animation frame so popup can paint quickly.
// In test (Node) environments `requestAnimationFrame` may be undefined —
// fall back to `setTimeout` to keep behavior consistent.
const _defer = (typeof requestAnimationFrame === 'function')
  ? (cb) => requestAnimationFrame(cb)
  : (cb) => setTimeout(cb, 0);
_defer(() => { setTimeout(() => refreshAll(), 0); });
