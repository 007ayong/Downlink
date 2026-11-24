// popup-app.js — Downlink popup wiring and rendering

// Replaced by packaging / Xcode at build time; source loads remain unlabelled.
const POPUP_BUILD_COMMIT = '__DOWNLINK_BUILD_COMMIT__';

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
const selectedRayburstMediaIds = new Set();
let rayburstMatchAnchorId = null;
let rayburstAutoCompanionId = null;
let currentTabTitle = '';
let currentTabUrl = '';
let rayburstTitleRequest = 0;
let rayburstMergeSubmitting = false;
const menuOriginalParents = new Map();
const MEDIA_HOVER_PREVIEW_DELAY_MS = 280;
const MEDIA_HOVER_PREVIEW_HIDE_DELAY_MS = 360;
const MEDIA_HOVER_PREVIEW_LOAD_TIMEOUT_MS = 30000;
const MEDIA_MESSAGE_TIMEOUT_MS = 2500;
const MEDIA_METADATA_LOAD_DELAY_MS = 100;
const mediaMetadataLoads = new Set();
const mediaMetadataBatchQueue = new Map();
let mediaMetadataBatchTimer = null;
let lastRenderedPendingKey = '';
let mediaHoverPreviewState = {
  itemId: '',
  timer: null,
  hideTimer: null,
  loadTimer: null,
  popover: null,
  mediaEl: null,
};

function closeAllSaveLocationMenus() {
  document.querySelectorAll('.pending-save-location-menu.open').forEach((m) => {
    m.classList.remove('open');
    m.style.removeProperty('--pending-save-location-menu-left');
    m.style.removeProperty('--pending-save-location-menu-top');
    m.style.removeProperty('--pending-save-location-menu-width');
    const originalParent = menuOriginalParents.get(m);
    if (originalParent && m.parentNode !== originalParent) {
      originalParent.appendChild(m);
    }
    menuOriginalParents.delete(m);
  });
}
document.addEventListener?.('click', () => closeAllSaveLocationMenus());

function clearMediaHoverPreviewTimers() {
  if (mediaHoverPreviewState.timer) clearTimeout(mediaHoverPreviewState.timer);
  if (mediaHoverPreviewState.hideTimer) clearTimeout(mediaHoverPreviewState.hideTimer);
  mediaHoverPreviewState.timer = null;
  mediaHoverPreviewState.hideTimer = null;
}

function closeMediaHoverPreview() {
  const { itemId, popover, mediaEl } = mediaHoverPreviewState;
  clearMediaHoverPreviewTimers();
  if (mediaHoverPreviewState.loadTimer) clearTimeout(mediaHoverPreviewState.loadTimer);
  try {
    mediaEl?.pause?.();
  } catch {}
  popover?.remove?.();
  if (itemId) chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_HOVER_PREVIEW', id: itemId }, () => {});
  mediaHoverPreviewState = {
    itemId: '',
    timer: null,
    hideTimer: null,
    loadTimer: null,
    popover: null,
    mediaEl: null,
  };
}

globalThis.addEventListener?.('pagehide', closeMediaHoverPreview);

function scheduleCloseMediaHoverPreview() {
  if (mediaHoverPreviewState.timer) {
    clearTimeout(mediaHoverPreviewState.timer);
    mediaHoverPreviewState.timer = null;
  }
  if (!mediaHoverPreviewState.popover) return;
  if (mediaHoverPreviewState.hideTimer) clearTimeout(mediaHoverPreviewState.hideTimer);
  mediaHoverPreviewState.hideTimer = setTimeout(closeMediaHoverPreview, MEDIA_HOVER_PREVIEW_HIDE_DELAY_MS);
}

function positionMediaHoverPreview(card, popover) {
  const rect = card?.getBoundingClientRect?.();
  if (!rect || !popover?.style) return;
  const viewportWidth = window.innerWidth || document.documentElement?.clientWidth || 420;
  const viewportHeight = window.innerHeight || document.documentElement?.clientHeight || 620;
  const previewWidth = Math.min(320, Math.max(260, viewportWidth - 20));
  const previewHeight = popover.offsetHeight || (card?.dataset?.mediaKind === 'audio' ? 112 : 236);
  const left = Math.max(10, Math.min(rect.left, viewportWidth - previewWidth - 10));
  const belowTop = rect.bottom + 8;
  const top = belowTop + previewHeight <= viewportHeight - 10
    ? belowTop
    : Math.max(10, rect.top - previewHeight - 8);
  popover.style.width = `${Math.round(previewWidth)}px`;
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function openMediaHoverPreview(item, card) {
  if (isSafariPopupRuntime()) return;
  if (!item?.resourceUrl || !item?.id) return;
  if (mediaHoverPreviewState.itemId === item.id && mediaHoverPreviewState.popover) {
    clearMediaHoverPreviewTimers();
    return;
  }
  closeMediaHoverPreview();

  const popover = document.createElement('div');
  popover.className = `media-hover-preview media-hover-preview-${item.kind === 'audio' ? 'audio' : 'video'}`;
  popover.addEventListener('mouseenter', clearMediaHoverPreviewTimers);
  popover.addEventListener('mouseleave', scheduleCloseMediaHoverPreview);

  const header = document.createElement('div');
  header.className = 'media-hover-preview-title';
  header.textContent = getMediaDisplayFilename(item);
  popover.appendChild(header);

  const shell = document.createElement('div');
  shell.className = 'media-hover-preview-shell';
  const tagName = item.kind === 'audio' ? 'audio' : 'video';
  const mediaEl = document.createElement(tagName);
  mediaEl.controls = true;
  mediaEl.autoplay = true;
  mediaEl.preload = 'auto';
  if (tagName === 'video') {
    mediaEl.muted = false;
    mediaEl.playsInline = true;
  }
  const failPreview = () => {
    if (mediaHoverPreviewState.itemId !== item.id || mediaHoverPreviewState.mediaEl !== mediaEl) return;
    popover.classList.add('media-hover-preview-error');
    if (mediaHoverPreviewState.loadTimer) clearTimeout(mediaHoverPreviewState.loadTimer);
    mediaHoverPreviewState.loadTimer = setTimeout(closeMediaHoverPreview, 1200);
  };
  const markPreviewReady = () => {
    if (mediaHoverPreviewState.itemId !== item.id || mediaHoverPreviewState.mediaEl !== mediaEl) return;
    if (mediaHoverPreviewState.loadTimer) clearTimeout(mediaHoverPreviewState.loadTimer);
    mediaHoverPreviewState.loadTimer = null;
  };
  mediaEl.addEventListener('loadeddata', markPreviewReady, { once: true });
  mediaEl.addEventListener('error', failPreview, { once: true });
  shell.appendChild(mediaEl);
  popover.appendChild(shell);

  document.body.appendChild(popover);
  card.dataset.mediaKind = item.kind || 'media';
  positionMediaHoverPreview(card, popover);
  mediaHoverPreviewState = {
    itemId: item.id,
    timer: null,
    hideTimer: null,
    loadTimer: setTimeout(failPreview, MEDIA_HOVER_PREVIEW_LOAD_TIMEOUT_MS),
    popover,
    mediaEl,
  };

  chrome.runtime.sendMessage({ type: 'PREPARE_MEDIA_HOVER_PREVIEW', id: item.id }, (result) => {
    if (mediaHoverPreviewState.itemId !== item.id || mediaHoverPreviewState.mediaEl !== mediaEl) {
      chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_HOVER_PREVIEW', id: item.id }, () => {});
      return;
    }
    if (chrome.runtime.lastError || !result?.ok) {
      failPreview();
      return;
    }
    const startPlayback = (sourceUrl) => {
      if (mediaHoverPreviewState.itemId !== item.id || mediaHoverPreviewState.mediaEl !== mediaEl) {
        return;
      }
      mediaEl.src = sourceUrl;
      const playResult = mediaEl.play?.();
      playResult?.catch?.((error) => {
        if (error?.name !== 'AbortError') failPreview();
      });
    };
    startPlayback(item.resourceUrl);
  });
}

function scheduleMediaHoverPreview(item, card) {
  if (isSafariPopupRuntime()) return;
  clearMediaHoverPreviewTimers();
  mediaHoverPreviewState.timer = setTimeout(() => {
    mediaHoverPreviewState.timer = null;
    openMediaHoverPreview(item, card);
  }, MEDIA_HOVER_PREVIEW_DELAY_MS);
}

function positionSaveLocationMenu(trigger, menu) {
  const triggerRect = trigger?.getBoundingClientRect?.();
  if (!triggerRect || !menu?.style?.setProperty) return;
  menu.style.setProperty('--pending-save-location-menu-left', `${Math.round(triggerRect.left)}px`);
  menu.style.setProperty('--pending-save-location-menu-top', `${Math.round(triggerRect.bottom + 4)}px`);
  menu.style.setProperty('--pending-save-location-menu-width', `${Math.round(triggerRect.width)}px`);
}

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
  if (pendingFilenameDrafts.has(item.key)) return pendingFilenameDrafts.get(item.key);
  if (item.autoDetectFilename) return '';
  return decodeDisplayFilename(item.filename || item.url.split('?')[0].split('/').pop() || '');
}

function getMediaFilenameValue(item) {
  return mediaFilenameDrafts.has(item.id)
    ? mediaFilenameDrafts.get(item.id)
    : (item.filename || popupAppT('untitledMedia', undefined, '未命名媒体'));
}

function getMediaPageFilename(item) {
  const logic = globalThis.FilenameLogic;
  const title = logic?.sanitizeFilenamePart(bilibiliTrackTitle(item) || item.pageTitle || '');
  if (!title || logic.isLowQualityFilename(title)) return '';
  return title;
}

function getMediaDisplayFilename(item) {
  if (mediaFilenameDrafts.has(item.id)) return getMediaFilenameValue(item);
  return getMediaPageFilename(item) || getMediaFilenameValue(item);
}

function getMediaDownloadFilename(item) {
  if (mediaFilenameDrafts.has(item.id)) return getMediaFilenameValue(item);
  const title = getMediaPageFilename(item);
  if (!title) return getMediaFilenameValue(item);
  const logic = globalThis.FilenameLogic;
  const ext = logic.extOf(item.filename || '') || logic.guessMediaExtension(item.resourceUrl, item.mime);
  return ext && !title.toLowerCase().endsWith(`.${ext}`) ? `${title}.${ext}` : title;
}

function createTextElement(tagName, className, text = '') {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function createSvgElement(viewBox, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  if (className) svg.setAttribute('class', className);
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  return svg;
}

function appendSvgPath(svg, d, attrs = {}) {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  Object.entries(attrs).forEach(([key, value]) => path.setAttribute(key, value));
  svg.appendChild(path);
  return path;
}

function createTaskButton(label, action, { gid = '', danger = false } = {}) {
  const button = createTextElement('button', `task-btn${danger ? ' danger' : ''}`, label);
  button.dataset.action = action;
  if (gid) button.dataset.gid = gid;
  return button;
}

function createIconImage(src, className = '') {
  const img = document.createElement('img');
  img.src = src || '';
  img.alt = '';
  img.loading = 'lazy';
  if (className) img.className = className;
  return img;
}

function mediaEditIcon() {
  const svg = createSvgElement('0 0 16 16');
  appendSvgPath(svg, 'M10.9 2.4a1.6 1.6 0 0 1 2.3 2.3l-7.1 7.1-3 .7.7-3 7.1-7.1Z', {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linejoin': 'round',
  });
  appendSvgPath(svg, 'M9.8 3.5l2.7 2.7', {
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.4',
    'stroke-linecap': 'round',
  });
  return svg;
}

function mediaFactIcon(name) {
  const svg = createSvgElement('0 0 16 16', 'media-fact-icon');
  if (name === 'size') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '2.5');
    rect.setAttribute('y', '3.5');
    rect.setAttribute('width', '11');
    rect.setAttribute('height', '9');
    rect.setAttribute('rx', '1.6');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', 'currentColor');
    rect.setAttribute('stroke-width', '1.4');
    svg.appendChild(rect);
    appendSvgPath(svg, 'M4.75 10.25h6.5', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' });
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '5');
    circle.setAttribute('cy', '6.25');
    circle.setAttribute('r', '.75');
    circle.setAttribute('fill', 'currentColor');
    svg.appendChild(circle);
    return svg;
  }
  if (name === 'resolution') {
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('x', '2.5');
    rect.setAttribute('y', '4');
    rect.setAttribute('width', '11');
    rect.setAttribute('height', '7.5');
    rect.setAttribute('rx', '1.5');
    rect.setAttribute('fill', 'none');
    rect.setAttribute('stroke', 'currentColor');
    rect.setAttribute('stroke-width', '1.4');
    svg.appendChild(rect);
    appendSvgPath(svg, 'M6.25 13.25h3.5', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round' });
    return svg;
  }
  if (name === 'duration') {
    const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    circle.setAttribute('cx', '8');
    circle.setAttribute('cy', '8');
    circle.setAttribute('r', '5.25');
    circle.setAttribute('fill', 'none');
    circle.setAttribute('stroke', 'currentColor');
    circle.setAttribute('stroke-width', '1.4');
    svg.appendChild(circle);
    appendSvgPath(svg, 'M8 5.25V8l2 1.25', { fill: 'none', stroke: 'currentColor', 'stroke-width': '1.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
    return svg;
  }
  return document.createDocumentFragment();
}

function buildPendingConfirmRenderKey(pendingVals) {
  const saveLocations = currentConfig.aria2CustomSaveEnabled ? (currentConfig.aria2SaveLocations || []) : [];
  return pendingVals.map((item) => [
    item.key,
    item.url,
  ].join('\u0001')).join('\u0002')
    + `|${popupAppT('pendingDownload', undefined, '待确认下载')}`
    + `|${popupAppT('fileName', undefined, '文件名')}`
    + `|${popupAppT('aria2SingleThreadShort', undefined, '单线程下载')}`
    + `|${popupAppT('ignore', undefined, '忽略')}`
    + `|${getSendLabel(currentConfig)}`
    + `|${currentConfig.downloaderType || ''}`
    + `|${currentConfig.aria2CustomSaveEnabled ? '1' : '0'}`
    + `|${JSON.stringify(saveLocations)}`;
}

function createPendingCard(item, { filename, canForceSingleThread }) {
  const card = document.createElement('div');
  card.className = 'pending-card';

  const header = document.createElement('div');
  header.className = 'pending-head';
  const iconWrap = document.createElement('div');
  iconWrap.className = 'pending-icon';
  iconWrap.appendChild(createIconImage(getFileIcon({ name: filename, mime: item.mime, kind: item.kind })));
  const headerText = document.createElement('div');
  headerText.className = 'pending-heading';
  headerText.appendChild(createTextElement('div', 'pending-label', popupAppT('pendingDownload', undefined, '待确认下载')));
  const urlRow = document.createElement('div');
  urlRow.className = 'pending-url-row';
  const urlText = createTextElement('div', 'pending-url', item.url || '');
  urlText.title = item.url || '';
  urlRow.appendChild(urlText);
  headerText.appendChild(urlRow);
  header.appendChild(iconWrap);
  header.appendChild(headerText);
  card.appendChild(header);

  const filenameRow = document.createElement('div');
  filenameRow.className = 'pending-filename-row';
  const filenameLabel = createTextElement('label', '', popupAppT('fileName', undefined, '文件名'));
  const filenameInput = document.createElement('input');
  filenameInput.type = 'text';
  filenameInput.className = 'pending-fname';
  filenameInput.value = filename || '';
  filenameInput.autocomplete = 'off';
  filenameInput.spellcheck = false;
  filenameRow.appendChild(filenameLabel);
  filenameRow.appendChild(filenameInput);
  card.appendChild(filenameRow);

  const saveLocations = currentConfig.downloaderType === 'aria2' && currentConfig.aria2CustomSaveEnabled
    ? (currentConfig.aria2SaveLocations || []).filter((location) => location?.name && location?.path)
    : [];

  if (saveLocations.length || canForceSingleThread) {
    const optionsRow = document.createElement('div');
    optionsRow.className = 'pending-options-row';

    if (saveLocations.length) {
      const locationGroup = document.createElement('div');
      locationGroup.className = 'pending-options-group';
      const locationLabel = createTextElement('span', 'pending-save-location-label', popupAppT('saveLocation', undefined, '保存位置'));
      locationGroup.appendChild(locationLabel);

      const locationWrapper = document.createElement('div');
      locationWrapper.className = 'pending-save-location';

      const trigger = document.createElement('button');
      trigger.type = 'button';
      trigger.className = 'pending-save-location-trigger';
      const triggerDot = document.createElement('span');
      triggerDot.className = 'pending-save-location-dot';
      triggerDot.style.background = saveLocations[0]?.color || '#ff9500';
      const triggerText = createTextElement('span', 'pending-save-location-text', saveLocations[0]?.name || '');
      trigger.appendChild(triggerDot);
      trigger.appendChild(triggerText);
      const arrow = createTextElement('span', 'pending-save-location-arrow', '');
      trigger.appendChild(arrow);

      const menu = document.createElement('div');
      menu.className = 'pending-save-location-menu';
      menu.dataset.value = saveLocations[0]?.path || '';
      saveLocations.forEach((location, index) => {
        const menuItem = document.createElement('div');
        menuItem.className = 'pending-save-location-item' + (index === 0 ? ' active' : '');
        menuItem.dataset.path = location.path;
        menuItem.dataset.color = location.color || '';
        const itemDot = document.createElement('span');
        itemDot.className = 'pending-save-location-dot';
        itemDot.style.background = location.color || '#ff9500';
        menuItem.appendChild(itemDot);
        menuItem.appendChild(createTextElement('span', 'pending-save-location-name', location.name));
        menu.appendChild(menuItem);
      });

      trigger.addEventListener('click', (e) => {
        e.stopPropagation();
        const isOpen = menu.classList.contains('open');
        closeAllSaveLocationMenus();
        if (!isOpen) {
          menuOriginalParents.set(menu, menu.parentNode);
          document.body.appendChild(menu);
          positionSaveLocationMenu(trigger, menu);
          menu.classList.add('open');
        }
      });

      menu.addEventListener('click', (e) => {
        const item = e.target.closest('.pending-save-location-item');
        if (!item) return;
        menu.querySelectorAll('.pending-save-location-item').forEach((el) => el.classList.remove('active'));
        item.classList.add('active');
        menu.dataset.value = item.dataset.path;
        triggerDot.style.background = item.dataset.color || '#ff9500';
        triggerText.textContent = item.querySelector('.pending-save-location-name')?.textContent || '';
        menu.classList.remove('open');
        const originalParent = menuOriginalParents.get(menu);
        if (originalParent && menu.parentNode !== originalParent) {
          originalParent.appendChild(menu);
        }
        menuOriginalParents.delete(menu);
      });

      locationWrapper.appendChild(trigger);
      locationWrapper.appendChild(menu);
      locationGroup.appendChild(locationWrapper);
      optionsRow.appendChild(locationGroup);
    }

    if (canForceSingleThread) {
      const threadGroup = document.createElement('div');
      threadGroup.className = 'pending-options-group';
      const optionLabel = document.createElement('label');
      optionLabel.className = 'pending-option';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.className = 'force-single-thread aria2-single-thread';
      optionLabel.appendChild(checkbox);
      optionLabel.appendChild(createTextElement('span', '', popupAppT('aria2SingleThreadShort', undefined, '单线程下载')));
      threadGroup.appendChild(optionLabel);
      optionsRow.appendChild(threadGroup);
    }

    card.appendChild(optionsRow);
  }

  const actions = document.createElement('div');
  actions.className = 'pending-actions';
  const confirmBtn = createTextElement('button', 'btn btn-primary confirm-btn', getSendLabel(currentConfig));
  confirmBtn.dataset.key = item.key || '';
  const rejectBtn = createTextElement('button', 'btn btn-ghost reject-btn', popupAppT('ignore', undefined, '忽略'));
  rejectBtn.dataset.key = item.key || '';
  actions.appendChild(rejectBtn);
  actions.appendChild(confirmBtn);
  card.appendChild(actions);

  return card;
}

function appendTaskMeta(meta, text) {
  if (!text) return;
  meta.appendChild(createTextElement('span', '', text));
}

function createTaskCard(task, { name, stateKey, pct, showProgress, eta, canViewInGopeed }) {
  const card = document.createElement('div');
  card.className = `task-card ${stateKey}`;

  const top = document.createElement('div');
  top.className = 'task-top';
  const iconWrap = document.createElement('div');
  iconWrap.className = 'task-icon';
  iconWrap.appendChild(createIconImage(getFileIcon({ name, mime: task.mime, kind: task.kind })));

  const info = document.createElement('div');
  info.className = 'task-info';
  const taskName = createTextElement('div', 'task-name', name);
  taskName.title = name;
  const meta = document.createElement('div');
  meta.className = 'task-meta';
  if (task.totalLength) appendTaskMeta(meta, `${fmt(task.completedLength)} / ${fmt(task.totalLength)}`);
  if (task.targetName) appendTaskMeta(meta, `${popupAppT('targetLabel', undefined, '目标')} ${task.targetName}`);
  if (stateKey === 'active' && task.downloadSpeed) appendTaskMeta(meta, `${popupAppT('speedLabel', undefined, '速度')} ${fmtSpeed(task.downloadSpeed)}`);
  if (stateKey === 'active' && eta) appendTaskMeta(meta, `${popupAppT('etaLabel', undefined, '剩余')} ${eta}`);
  if (task.connections) appendTaskMeta(meta, popupAppT('connectionsCount', [task.connections], `${task.connections}线`));
  info.appendChild(taskName);
  info.appendChild(meta);

  top.appendChild(iconWrap);
  top.appendChild(info);
  top.appendChild(createTextElement('span', `state-pill state-${stateKey}`, getStateLabel(stateKey)));
  card.appendChild(top);

  if (showProgress) {
    const progress = document.createElement('div');
    progress.className = 'task-progress';
    const track = document.createElement('div');
    track.className = 'progress-track';
    const fill = document.createElement('div');
    fill.className = `progress-fill ${stateKey}`;
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    const row = document.createElement('div');
    row.className = 'progress-row';
    row.appendChild(createTextElement('span', '', fmt(task.completedLength)));
    row.appendChild(createTextElement('span', 'progress-pct', `${pct}%`));
    progress.appendChild(track);
    progress.appendChild(row);
    card.appendChild(progress);
  }

  const actions = document.createElement('div');
  actions.className = 'task-actions';
  if (canViewInGopeed) actions.appendChild(createTaskButton(popupAppT('gopeedView', undefined, 'Gopeed中查看'), 'gopeed-view'));
  // 只有 Aria2 任务支持扩展侧暂停/继续，Gopeed 等其他下载器不显示这两个按钮。
  const canPause = !task.provider || task.provider === 'aria2';
  if (stateKey === 'active' && canPause) actions.appendChild(createTaskButton(popupAppT('pauseTask', undefined, '暂停'), 'pause', { gid: task.gid }));
  if (stateKey === 'paused' && canPause) actions.appendChild(createTaskButton(popupAppT('resumeTask', undefined, '继续'), 'resume', { gid: task.gid }));
  if (stateKey === 'complete') actions.appendChild(createTaskButton(popupAppT('clearTask', undefined, '清除'), 'remove', { gid: task.gid }));
  if (['active', 'paused', 'waiting'].includes(stateKey)) actions.appendChild(createTaskButton(popupAppT('cancelTask', undefined, '取消'), 'remove', { gid: task.gid, danger: true }));
  if (stateKey === 'sent') actions.appendChild(createTaskButton(popupAppT('clearTask', undefined, '清除'), 'remove', { gid: task.gid }));
  if (stateKey === 'error') actions.appendChild(createTaskButton(popupAppT('clearTask', undefined, '清除'), 'remove', { gid: task.gid, danger: true }));
  card.appendChild(actions);

  return card;
}

function createMediaFact(iconName, text, className = '') {
  const fact = document.createElement('span');
  fact.className = `media-fact${className ? ` ${className}` : ''}`;
  fact.appendChild(mediaFactIcon(iconName));
  fact.appendChild(createTextElement('span', '', text));
  return fact;
}

function rayburstMergeTrackType(item = {}) {
  if (item.streamProtocol || item.isLive === true) return '';
  if (item.kind === 'audio' || item.kind === 'video') return item.kind;
  const category = getFileCategory({ name: item.filename || item.resourceUrl, mime: item.mime, kind: item.kind });
  return category === 'audio' || category === 'video' ? category : '';
}

function bilibiliTrackUrl(item) {
  const url = rayburstPageUrl(item?.resourceUrl);
  return url && /(?:^|\.)bilivideo\.(?:com|cn)$/.test(url.hostname) ? url : null;
}

function bilibiliTrackCid(item) {
  const url = bilibiliTrackUrl(item);
  if (!url) return '';
  const match = url.pathname.match(/\/(\d+)(?:_da\d+)?-\d+-\d+\.m4s$/i);
  return match?.[1] || '';
}

const bilibiliTitlesByCid = new Map();

function bilibiliTrackTitle(item) {
  return bilibiliTitlesByCid.get(bilibiliTrackCid(item)) || '';
}

function rayburstDurationTolerance(duration) {
  return Math.min(1, Math.max(0.25, duration * 0.01));
}

function rayburstDurationsConflict(anchor, companion) {
  const duration = anchor.duration;
  const other = companion.duration;
  return Number.isFinite(duration) && duration > 0 && Number.isFinite(other) && other > 0
    && Math.abs(duration - other) > rayburstDurationTolerance(Math.min(duration, other));
}

function rayburstDurationConflictMessage() {
  return popupAppT('rayburstMergeDurationMismatch', undefined, '音频和视频时长不一致，请选择时长匹配的轨道。');
}

function findRayburstCompanion(anchor, media) {
  const anchorKind = rayburstMergeTrackType(anchor);
  if (!anchorKind) return null;
  const oppositeKind = anchorKind === 'video' ? 'audio' : 'video';
  const cid = bilibiliTrackCid(anchor);
  // A shared page title and duration cannot identify an opaque Bilibili track.
  if (!cid && bilibiliTrackUrl(anchor)) return null;

  const duration = anchor.duration;
  if (cid) {
    const sameEpisode = media.filter((item) => rayburstMergeTrackType(item) === oppositeKind
      && bilibiliTrackCid(item) === cid
      && !rayburstDurationsConflict(anchor, item));
    if (sameEpisode.length) {
      const anchorHost = bilibiliTrackUrl(anchor).hostname;
      const tracks = new Map();
      for (const item of sameEpisode) {
        const url = bilibiliTrackUrl(item);
        // Bilibili uses the same CID and representation filename on alternate CDNs.
        const key = url.pathname.split('/').pop().toLowerCase();
        const existing = tracks.get(key);
        if (!existing || (url.hostname === anchorHost && bilibiliTrackUrl(existing).hostname !== anchorHost)) {
          tracks.set(key, item);
        }
      }
      media = [...tracks.values()];
      if (media.length === 1) return media[0];
    }
  }
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const anchorPage = rayburstPageUrl(anchor.pageUrl)?.href;
  const candidates = media.filter((item) => {
    const page = rayburstPageUrl(item.pageUrl)?.href;
    const candidateCid = bilibiliTrackCid(item);
    const sameEpisode = Boolean(cid && cid === candidateCid);
    if (cid ? !sameEpisode : bilibiliTrackUrl(item)) return false;
    return rayburstMergeTrackType(item) === oppositeKind
      && Number.isFinite(item.duration) && item.duration > 0
      && !rayburstDurationsConflict(anchor, item)
      && (sameEpisode || ((!anchorPage || !page || page === anchorPage)
        && (!anchor.pageTitle || !item.pageTitle || anchor.pageTitle === item.pageTitle)));
  }).map((item) => ({
    item,
    difference: Math.abs(item.duration - duration),
    samePage: Boolean(anchorPage && rayburstPageUrl(item.pageUrl)?.href === anchorPage),
  })).sort((a, b) => Number(b.samePage) - Number(a.samePage) || a.difference - b.difference);

  const best = candidates[0];
  if (!best) return null;
  // Treat small duration differences as a tie, since audio and video containers can round differently.
  const tied = candidates.filter((candidate) => candidate.samePage === best.samePage
    && candidate.difference - best.difference <= 0.15);
  if (tied.length === 1) return best.item;
  const sameVideo = tied.every(({ item, samePage }) => (
    cid && bilibiliTrackCid(item) === cid
  ) || (anchorPage && anchor.pageTitle && samePage && item.pageTitle === anchor.pageTitle));
  if (oppositeKind === 'audio' && cid && tied.every(({ item }) => (
    bilibiliTrackCid(item) === cid && Number.isFinite(item.size) && item.size > 0
  ))) {
    // For the same episode and near-identical durations, size favors higher-bitrate audio.
    const ranked = tied.map(({ item }) => item).sort((a, b) => b.size - a.size);
    return ranked[0].size > ranked[1].size ? ranked[0] : null;
  }
  if (oppositeKind !== 'video' || !sameVideo) return null;

  // Same-page video variants can share a duration. Prefer a unique highest resolution.
  const ranked = tied.map(({ item }) => ({
    item,
    pixels: (Number(item.width) || 0) * (Number(item.height) || 0),
  })).sort((a, b) => b.pixels - a.pixels);
  return ranked[0].pixels > ranked[1].pixels ? ranked[0].item : null;
}

function rayburstOutputBasename(filename = '') {
  return String(filename || '').trim().replace(/\.(?:mp4|mkv|webm|mov|m4v|m4s|avi|flv|ts)$/i, '');
}

function rayburstPageUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    return url;
  } catch {
    return '';
  }
}

function rayburstDefaultMergeBasename(items = [], media = currentState.media?.[currentTabId] || []) {
  const video = items.find((item) => rayburstMergeTrackType(item) === 'video');
  if (!video) return '';
  if (bilibiliTrackUrl(video)) return rayburstOutputBasename(getMediaDisplayFilename(video));
  const audio = items.find((item) => rayburstMergeTrackType(item) === 'audio');
  const referrer = rayburstPageUrl(video.referrer || video.headers?.referer);
  const capturedUrl = rayburstPageUrl(video.pageUrl);
  const tabUrl = rayburstPageUrl(currentTabUrl);
  const hasPageReferrer = referrer && (referrer.pathname !== '/' || referrer.search);
  const newestPair = audio && ['video', 'audio'].every((kind) => {
    const newest = media.find((item) => rayburstMergeTrackType(item) === kind);
    return newest?.id === (kind === 'video' ? video.id : audio.id);
  });
  const pairOnCurrentPage = newestPair && tabUrl && capturedUrl?.href === tabUrl.href
    && rayburstPageUrl(audio.pageUrl)?.href === tabUrl.href;
  const refersToCurrentPage = hasPageReferrer && referrer.href === tabUrl?.href
    && referrer.href !== capturedUrl?.href;
  const pageTitle = ((pairOnCurrentPage || refersToCurrentPage) && currentTabTitle.trim())
    || video.pageTitle?.trim() || '';
  const cleanTitle = globalThis.FilenameLogic?.sanitizeFilenamePart?.(pageTitle) ?? pageTitle;
  return rayburstOutputBasename(cleanTitle) || rayburstOutputBasename(getMediaFilenameValue(video));
}

function refreshRayburstPageTitle() {
  const tabId = currentTabId;
  const tabUrl = currentTabUrl;
  if (tabId == null) return Promise.resolve();
  const cids = [...new Set((currentState.media?.[tabId] || []).map(bilibiliTrackCid).filter(Boolean))];
  if (currentConfig.downloaderType !== 'motrixnext' && !cids.length) return Promise.resolve();
  const request = ++rayburstTitleRequest;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (request === rayburstTitleRequest) rayburstTitleRequest++;
      resolve();
    }, 600);
    chrome.tabs.sendMessage(tabId, { type: 'GET_MEDIA_PAGE_TITLE', cids }, { frameId: 0 }, (response) => {
      clearTimeout(timeout);
      const liveUrl = rayburstPageUrl(response?.url);
      const snapshot = rayburstPageUrl(tabUrl);
      if (!chrome.runtime.lastError && response && request === rayburstTitleRequest
        && tabId === currentTabId && tabUrl === currentTabUrl
        && liveUrl && liveUrl.origin === snapshot?.origin) {
        for (const entry of Array.isArray(response.titlesByCid) ? response.titlesByCid : []) {
          if (!Array.isArray(entry)) continue;
          const [cid, title] = entry;
          if (cids.includes(cid) && typeof title === 'string' && title.trim()) bilibiliTitlesByCid.set(cid, title);
        }
        if (response.title && liveUrl.pathname === snapshot.pathname) {
          currentTabUrl = liveUrl.href;
          currentTabTitle = response.title;
        }
        const media = currentState.media?.[tabId] || [];
        refreshMediaCardTitles(media);
        updateRayburstMergeControls(media);
      }
      resolve();
    });
  });
}

function setRayburstMergeFormat(value = 'mp4') {
  const format = value === 'mkv' ? 'mkv' : 'mp4';
  const native = document.getElementById('rayburstMergeFormat');
  const label = document.getElementById('rayburstMergeFormatLabel');
  if (native) native.value = format;
  if (label) label.textContent = format.toUpperCase();
  document.querySelectorAll('.rayburst-format-option').forEach((option) => {
    option.setAttribute('aria-selected', String(option.dataset.value === format));
  });
}

function closeRayburstFormatPicker() {
  const picker = document.getElementById('rayburstMergeFormatPicker');
  const button = document.getElementById('rayburstMergeFormatButton');
  picker?.classList.remove('open');
  button?.setAttribute('aria-expanded', 'false');
}

function updateRayburstMergeControls(media = []) {
  const button = document.getElementById('mergeRayburstMediaBtn');
  const bar = document.getElementById('rayburstMergeBar');
  const status = document.getElementById('rayburstMergeStatus');
  const filenameInput = document.getElementById('rayburstMergeFilename');
  const formatSelect = document.getElementById('rayburstMergeFormat');
  if (!button) return;
  const enabled = currentConfig.downloaderType === 'motrixnext';
  const existingIds = new Set(media.map((item) => item.id));
  for (const id of selectedRayburstMediaIds) {
    if (!existingIds.has(id)) selectedRayburstMediaIds.delete(id);
  }
  if (!selectedRayburstMediaIds.has(rayburstAutoCompanionId)) rayburstAutoCompanionId = null;
  if (rayburstAutoCompanionId !== null) {
    const companion = media.find((item) => item.id === rayburstAutoCompanionId);
    const anchor = media.find((item) => item.id !== rayburstAutoCompanionId && selectedRayburstMediaIds.has(item.id));
    if (!anchor || rayburstDurationsConflict(anchor, companion)) {
      selectedRayburstMediaIds.delete(rayburstAutoCompanionId);
      rayburstAutoCompanionId = null;
      rayburstMatchAnchorId = anchor?.id ?? null;
    }
  }
  if (enabled && rayburstMatchAnchorId !== null && selectedRayburstMediaIds.size === 1
      && selectedRayburstMediaIds.has(rayburstMatchAnchorId)) {
    const anchor = media.find((item) => item.id === rayburstMatchAnchorId);
    const companion = findRayburstCompanion(anchor, media);
    if (companion) {
      selectedRayburstMediaIds.add(companion.id);
      rayburstAutoCompanionId = companion.id;
      rayburstMatchAnchorId = null;
    }
  } else {
    rayburstMatchAnchorId = null;
  }
  const selected = media.filter((item) => selectedRayburstMediaIds.has(item.id));
  if (bar) bar.hidden = !enabled || selected.length === 0;
  const types = selected.map(rayburstMergeTrackType).sort();
  const selectedVideo = selected.find((item) => rayburstMergeTrackType(item) === 'video');
  const selectedAudio = selected.find((item) => rayburstMergeTrackType(item) === 'audio');
  const durationConflict = selectedVideo && selectedAudio && rayburstDurationsConflict(selectedVideo, selectedAudio);
  const validPair = !durationConflict && selected.length === 2 && types[0] === 'audio' && types[1] === 'video';
  button.disabled = !validPair || rayburstMergeSubmitting;
  button.textContent = rayburstMergeSubmitting
    ? popupAppT('rayburstMergeSending', undefined, '正在合并发送…')
    : popupAppT('mergeWithRayburst', undefined, '合并下载');
  button.title = durationConflict ? rayburstDurationConflictMessage() : validPair ? '' : popupAppT('rayburstMergeSelectionHint', undefined, '请选择一条视频和一条音频');
  if (status) {
    status.textContent = durationConflict ? rayburstDurationConflictMessage() : validPair
      ? popupAppT('rayburstMergeReady', undefined, '已选中视频与音频')
      : types[0] === 'video'
        ? popupAppT('rayburstMergeNeedAudio', undefined, '已选择视频，还需选择音频')
        : types[0] === 'audio'
          ? popupAppT('rayburstMergeNeedVideo', undefined, '已选择音频，还需选择视频')
          : popupAppT('rayburstMergeSelectionHint', undefined, '请选择一条视频和一条音频');
  }
  if (filenameInput) {
    const videoId = selectedVideo?.id || '';
    const videoChanged = filenameInput.dataset.videoId !== videoId;
    const defaultBasename = selectedVideo ? rayburstDefaultMergeBasename(selected, media) : '';
    if (videoChanged || filenameInput.value === filenameInput.dataset.defaultBasename) {
      filenameInput.value = defaultBasename;
    }
    filenameInput.dataset.videoId = videoId;
    filenameInput.dataset.defaultBasename = defaultBasename;
    if (videoChanged && formatSelect) setRayburstMergeFormat('mp4');
    filenameInput.disabled = !selectedVideo;
  }
  document.getElementById('mediaList')?.querySelectorAll('[data-select-media-id]').forEach((checkbox) => {
    checkbox.checked = selectedRayburstMediaIds.has(checkbox.dataset.selectMediaId);
    checkbox.closest?.('.media-card')?.classList.toggle('media-card-selected', checkbox.checked);
  });
}

function createMediaCard(item, { iconSrc, durationText, resolutionText, displayFilename }) {
  const displayKind = mediaDisplayKind(item);
  const card = document.createElement('div');
  card.className = `media-card media-card-${displayKind}`;
  card.dataset.mediaId = item.id;

  const top = document.createElement('div');
  top.className = 'media-top';
  const iconWrap = document.createElement('div');
  iconWrap.className = 'media-icon';
  iconWrap.appendChild(createIconImage(iconSrc));

  const info = document.createElement('div');
  info.className = 'media-info';
  const titleRow = document.createElement('div');
  titleRow.className = 'media-title-row';
  const nameEl = createTextElement('div', 'media-name', displayFilename);
  nameEl.title = displayFilename;
  const nameInput = document.createElement('input');
  nameInput.className = 'media-name-input';
  nameInput.type = 'text';
  nameInput.value = displayFilename;
  nameInput.autocomplete = 'off';
  nameInput.spellcheck = false;
  nameInput.hidden = true;
  const editBtn = document.createElement('button');
  editBtn.className = 'media-name-edit';
  editBtn.type = 'button';
  editBtn.title = popupAppT('editFileName', undefined, '编辑文件名');
  editBtn.setAttribute('aria-label', popupAppT('editFileName', undefined, '编辑文件名'));
  editBtn.appendChild(mediaEditIcon());
  titleRow.appendChild(nameEl);
  titleRow.appendChild(nameInput);
  titleRow.appendChild(editBtn);
  if (currentConfig.downloaderType === 'motrixnext' && rayburstMergeTrackType(item)) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'media-select-checkbox';
    checkbox.checked = selectedRayburstMediaIds.has(item.id);
    checkbox.dataset.selectMediaId = item.id;
    checkbox.title = popupAppT('mergeWithRayburst', undefined, '合并下载');
    checkbox.setAttribute('aria-label', `${popupAppT('mergeWithRayburst', undefined, '合并下载')}：${displayFilename}`);
    titleRow.appendChild(checkbox);
  }
  titleRow.appendChild(createTextElement('span', `media-chip media-kind kind-${displayKind}`, mediaKindLabel(displayKind)));

  const urlEl = createTextElement('div', 'media-url', item.resourceUrl || '');
  const meta = document.createElement('div');
  meta.className = 'media-meta';
  // Manifest Content-Length is only the playlist text size, not the media
  // payload size, so do not present it as a downloadable file size.
  if (!item.streamProtocol) {
    meta.appendChild(createMediaFact('size', item.size ? fmt(item.size) : popupAppT('unknownSize', undefined, '大小未知')));
  }
  if (resolutionText) meta.appendChild(createMediaFact('resolution', resolutionText, 'media-resolution'));
  if (durationText) meta.appendChild(createMediaFact('duration', durationText));

  info.appendChild(titleRow);
  info.appendChild(urlEl);
  info.appendChild(meta);
  if (item.mime) info.appendChild(createTextElement('div', 'media-mime', item.mime));
  top.appendChild(iconWrap);
  top.appendChild(info);
  card.appendChild(top);

  const actions = document.createElement('div');
  actions.className = 'media-actions';
  const previewBtn = createTextElement('button', 'task-btn media-preview-toggle', popupAppT('previewMedia', undefined, '预览'));
  previewBtn.dataset.id = item.id;
  const copyBtn = createTextElement('button', 'task-btn', popupAppT('copyLink', undefined, '复制链接'));
  copyBtn.dataset.copyUrl = item.resourceUrl || '';
  const sendBtn = createTextElement('button', 'task-btn media-send-btn', getSendLabel(currentConfig));
  sendBtn.dataset.sendId = item.id;
  actions.appendChild(previewBtn);
  actions.appendChild(copyBtn);
  actions.appendChild(sendBtn);
  card.appendChild(actions);

  return card;
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
  globalThis.mediaHoverPreviewState = mediaHoverPreviewState;
}

function applyLocaleFromConfig(cfg = currentConfig) {
  popupAppI18n.setLocalePreference?.(cfg?.language || 'auto');
  popupAppI18n.applyTranslations?.(document);
  renderExtensionVersion();
  renderHeaderStatus({ ...headerStatusState, cfg });
}

function getExtensionVersion() {
  try {
    return chrome.runtime.getManifest?.()?.version || '—';
  } catch {
    return '—';
  }
}

function renderExtensionVersion() {
  const value = document.getElementById('extensionVersionValue');
  if (!value) return;
  value.textContent = getExtensionVersion();
  const build = document.getElementById('extensionBuildValue');
  if (!build) return;
  const match = /^([0-9a-f]{40,64})(\*)?$/.exec(POPUP_BUILD_COMMIT);
  build.hidden = !match;
  if (match) {
    build.textContent = `${match[1].slice(0, 8)}${match[2] || ''}`;
    build.title = `Git: ${match[1]}${match[2] ? ' (uncommitted changes)' : ''}`;
  }
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
  const title = document.querySelector('.header-title-text');
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
  const svg = createSvgElement('0 0 16 16', 'control-icon');
  appendSvgPath(svg, path, { fill: 'currentColor' });
  return svg;
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
      cfg.motrixNextPort || '29110',
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
  const showAria2SaveLocations = isAria2 && !!currentConfig.aria2CustomSaveEnabled;
  document.querySelectorAll('.tasks-toolbar').forEach((el) => el.classList.toggle('settings-hidden', !isAria2));
  document.querySelectorAll('.aria2-only').forEach((el) => el.classList.toggle('settings-hidden', !isAria2));
  document.querySelectorAll('.aria2-custom-save-control').forEach((el) => {
    const toggle = el.querySelector('#cfgAria2CustomSaveEnabled');
    if (toggle) toggle.disabled = !isAria2;
    el.classList.toggle('settings-disabled', false);
  });
  document.querySelectorAll('.aria2-save-locations-config').forEach((el) => el.classList.toggle('settings-hidden', !showAria2SaveLocations));
  document.querySelectorAll('.launcher-only').forEach((el) => el.classList.toggle('settings-hidden', !isAbDownload));
  document.querySelectorAll('.motrixnext-only').forEach((el) => el.classList.toggle('settings-hidden', !isMotrixNext));
  document.querySelectorAll('.gopeed-only').forEach((el) => el.classList.toggle('settings-hidden', !isGopeed));
  document.querySelectorAll('.neatdm-only').forEach((el) => el.classList.toggle('settings-hidden', !isNeatdm));
  // Safari exposes no shortcut-management page or WebExtension API equivalent.
  // Do not offer a control that would otherwise fall back to Chromium's internal URL.
  document.querySelectorAll('.shortcut-settings-row').forEach((el) => {
    el.classList.toggle('settings-hidden', isSafariPopupRuntime());
  });
  document.querySelectorAll('.safari-download-allowlist-row').forEach((el) => {
    el.classList.toggle('settings-hidden', !isSafariPopupRuntime());
  });
  document.querySelectorAll('.downloader-config-group').forEach((el) => {
    el.classList.toggle('settings-hidden', !(isAria2 || isAbDownload || isGopeed));
  });
}

function getConnectionFailureMessage(downloaderLabel) {
  return popupAppT(
    'connectionFailedWithLabel',
    [downloaderLabel],
    `与 ${downloaderLabel} 连接失败，检查 ${downloaderLabel} 是否正在运行`
  );
}

function getUiAlertMessage(alert = currentState.uiAlert) {
  if (!alert) return '';
  if (alert.type === 'connection-failure' && alert.downloaderLabel) {
    return getConnectionFailureMessage(alert.downloaderLabel);
  }
  return alert.message || '';
}

function renderInlineAlert(elementId, message = getUiAlertMessage(), { shake = false } = {}) {
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
    closeAllSaveLocationMenus();
    pendingList.replaceChildren();
    pendingVals.forEach((item) => {
      const filename = getPendingFilenameValue(item);
      const canForceSingleThread = ['aria2', 'gopeed'].includes(currentConfig.downloaderType);
      const card = createPendingCard(item, { filename, canForceSingleThread });
      pendingList.appendChild(card);
      card.querySelector('.pending-fname').addEventListener('input', (event) => {
        pendingFilenameDrafts.set(item.key, event.currentTarget.value);
      });
      card.querySelector('.confirm-btn').addEventListener('click', () => {
        if (card.querySelector('.confirm-btn').disabled) return;
        const fname = card.querySelector('.pending-fname').value.trim();
        const opts = canForceSingleThread && card.querySelector('.aria2-single-thread')?.checked
          ? getSingleThreadOptions(currentConfig)
          : {};
        const saveLocationPath = card.querySelector('.pending-save-location-menu')?.dataset.value || '';
        if (currentConfig.downloaderType === 'aria2' && saveLocationPath) opts.dir = saveLocationPath;
        chrome.runtime.sendMessage({ type: 'CONFIRM_DOWNLOAD', key: item.key, filename: fname, opts }, (res) => {
          if (res?.filenameResolving) return;
          if (res?.ok) {
            pendingFilenameDrafts.delete(item.key);
            lastRenderedPendingKey = '';
          }
          if (!res?.ok) {
            const downloaderLabel = getDownloaderName(currentConfig);
            currentState.uiAlert = {
              type: 'connection-failure',
              downloaderLabel,
              message: res?.error || '',
            };
            renderInlineAlert('taskAlert', getUiAlertMessage(), { shake: true });
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
  pendingVals.forEach((item, index) => {
    const card = pendingList.children[index];
    const input = card.querySelector('.pending-fname');
    const filename = getPendingFilenameValue(item);
    if (input.value !== filename) {
      input.value = filename;
      card.querySelector('.pending-head img').src = getFileIcon({ name: filename, mime: item.mime, kind: item.kind });
    }
    input.placeholder = item.filenameResolving
      ? popupAppT('detectingFilename', undefined, '正在识别文件名…')
      : popupAppT('autoDetect', undefined, '自动识别');
    card.querySelector('.confirm-btn').disabled = !!item.filenameResolving;
  });

  const taskList = document.getElementById('taskList');
  taskList.replaceChildren();
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

      const card = createTaskCard(task, { name, stateKey, pct, showProgress, eta, canViewInGopeed });
      taskList.appendChild(card);
      const icon = card.querySelector('.task-icon img');
      if (icon) icon.addEventListener('error', handleTaskIconError);
      card.querySelectorAll('[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
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

function sendRuntimeMessageWithTimeout(message, timeoutMs = MEDIA_MESSAGE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result || null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      chrome.runtime.sendMessage(message, (result) => {
        if (chrome.runtime.lastError) {
          finish(null);
          return;
        }
        finish(result);
      });
    } catch {
      finish(null);
    }
  });
}

async function flushMediaMetadataBatch() {
  mediaMetadataBatchTimer = null;
  const entries = Array.from(mediaMetadataBatchQueue.values());
  mediaMetadataBatchQueue.clear();
  if (!entries.length) return;

  const startEntries = () => entries.forEach((entry) => entry.start());
  const result = await sendRuntimeMessageWithTimeout({
    type: 'PREPARE_MEDIA_METADATA_BATCH',
    ids: entries.map((entry) => entry.item.id),
  });
  if (result?.ok) {
    startEntries();
    return;
  }
  await Promise.all(entries.map(async (entry) => {
    await sendRuntimeMessageWithTimeout({ type: 'PREPARE_MEDIA_METADATA', id: entry.item.id });
    entry.start();
  }));
}

function queueMediaMetadataProbe(entry) {
  mediaMetadataBatchQueue.set(entry.item.id, entry);
  if (mediaMetadataBatchTimer) return;
  mediaMetadataBatchTimer = setTimeout(flushMediaMetadataBatch, 16);
}

function isSafariPopupRuntime() {
  try {
    return String(chrome.runtime?.getURL?.('') || '').startsWith('safari-web-extension://');
  } catch {
    return false;
  }
}

function probeMediaMetadataInMainWorld(resourceUrl) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { xhr.abort(); } catch {}
      resolve(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, error: 'metadata-timeout' }), 12000);
    const xhr = new XMLHttpRequest();
    try {
      xhr.open('GET', resourceUrl, true);
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', 'bytes=0-2097151');
      xhr.onload = () => {
        if (xhr.status < 200 || xhr.status >= 300 || !(xhr.response instanceof ArrayBuffer)) {
          finish({ ok: false, error: `metadata-http-${xhr.status}` });
          return;
        }
        if (xhr.response.byteLength > 2097152) {
          finish({ ok: false, error: 'metadata-range-oversized' });
          return;
        }
        let manifest = '';
        try {
          manifest = new TextDecoder('utf-8').decode(new Uint8Array(xhr.response));
        } catch {}
        if (/^\s*#EXTM3U\b/i.test(manifest)) {
          const lines = manifest.split(/\r?\n/).map((line) => line.trim());
          const variantUrls = [];
          for (let index = 0; index < lines.length; index += 1) {
            if (!/^#EXT-X-STREAM-INF:/i.test(lines[index])) continue;
            const relativeUrl = lines.slice(index + 1).find((line) => line && !line.startsWith('#'));
            if (!relativeUrl) continue;
            try { variantUrls.push(new URL(relativeUrl, resourceUrl).href); } catch {}
          }
          const resolutions = Array.from(manifest.matchAll(/\bRESOLUTION\s*=\s*(\d+)x(\d+)/gi))
            .map((match) => ({ width: Number(match[1]) || 0, height: Number(match[2]) || 0 }))
            .filter(({ width, height }) => width > 0 && height > 0)
            .sort((a, b) => (b.width * b.height) - (a.width * a.height));
          const bestResolution = resolutions[0] || { width: 0, height: 0 };
          const durations = Array.from(manifest.matchAll(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gmi));
          if (durations.length || bestResolution.width || variantUrls.length) {
            const duration = durations.reduce((total, match) => total + Number(match[1] || 0), 0);
            const liveState = durations.length
              ? { isLive: !/^#EXT-X-ENDLIST\s*$/mi.test(manifest) && !/^#EXT-X-PLAYLIST-TYPE\s*:\s*VOD\s*$/mi.test(manifest) }
              : {};
            finish({ ok: true, ...bestResolution, duration, ...liveState, variantUrls, kind: 'video' });
            return;
          }
        }
        const bytes = new Uint8Array(xhr.response);
        const view = new DataView(xhr.response);
        let width = 0;
        let height = 0;
        let duration = 0;
        let movieTimescale = 0;
        let movieFragmentDuration = 0;
        const readUint64 = (offset) => {
          if (offset + 8 > view.byteLength) return 0;
          return view.getUint32(offset) * 4294967296 + view.getUint32(offset + 4);
        };
        const readBoxDuration = (index) => {
          const version = bytes[index + 4];
          const timescaleOffset = index + (version === 1 ? 28 : 16);
          const durationOffset = index + (version === 1 ? 32 : 20);
          if (durationOffset + (version === 1 ? 8 : 4) > bytes.length) return null;
          const timescale = view.getUint32(timescaleOffset);
          const value = version === 1 ? readUint64(durationOffset) : view.getUint32(durationOffset);
          if (!timescale || !value || value === 0xffffffff) return null;
          return { seconds: value / timescale, timescale };
        };
        for (let index = 0; index + 100 < bytes.length; index += 1) {
          const isMvhd = bytes[index] === 0x6d && bytes[index + 1] === 0x76 &&
            bytes[index + 2] === 0x68 && bytes[index + 3] === 0x64;
          const isMdhd = bytes[index] === 0x6d && bytes[index + 1] === 0x64 &&
            bytes[index + 2] === 0x68 && bytes[index + 3] === 0x64;
          if (isMvhd || isMdhd) {
            if (isMvhd) {
              const timescaleOffset = index + (bytes[index + 4] === 1 ? 28 : 16);
              if (timescaleOffset + 4 <= bytes.length) movieTimescale = view.getUint32(timescaleOffset);
            }
            const parsed = readBoxDuration(index);
            if (parsed) {
              duration = Math.max(duration, parsed.seconds);
            }
          }
          const isMehd = bytes[index] === 0x6d && bytes[index + 1] === 0x65 &&
            bytes[index + 2] === 0x68 && bytes[index + 3] === 0x64;
          if (isMehd && index + 16 <= bytes.length) {
            movieFragmentDuration = bytes[index + 4] === 1
              ? readUint64(index + 8)
              : view.getUint32(index + 8);
          }
          const isSidx = bytes[index] === 0x73 && bytes[index + 1] === 0x69 &&
            bytes[index + 2] === 0x64 && bytes[index + 3] === 0x78;
          if (isSidx && index + 32 <= bytes.length) {
            const version = bytes[index + 4];
            const timescale = view.getUint32(index + 12);
            const referenceCountOffset = index + (version === 1 ? 34 : 26);
            const entriesOffset = referenceCountOffset + 2;
            if (timescale && entriesOffset <= bytes.length) {
              const referenceCount = view.getUint16(referenceCountOffset);
              let totalDuration = 0;
              for (let entry = 0; entry < referenceCount; entry += 1) {
                const entryOffset = entriesOffset + entry * 12;
                if (entryOffset + 12 > bytes.length) break;
                totalDuration += view.getUint32(entryOffset + 4);
              }
              if (totalDuration) duration = Math.max(duration, totalDuration / timescale);
            }
          }
          if (bytes[index] !== 0x74 || bytes[index + 1] !== 0x6b ||
              bytes[index + 2] !== 0x68 || bytes[index + 3] !== 0x64) continue;
          const dimensionOffset = bytes[index + 4] === 1 ? 92 : 80;
          if (index + dimensionOffset + 8 > bytes.length) continue;
          const trackWidth = Math.round(view.getUint32(index + dimensionOffset) / 65536);
          const trackHeight = Math.round(view.getUint32(index + dimensionOffset + 4) / 65536);
          // Audio tracks have zero dimensions; preserve the video track's size.
          if (trackWidth > 0 && trackHeight > 0 && trackWidth * trackHeight > width * height) {
            width = trackWidth;
            height = trackHeight;
          }
        }
        if (!duration && movieTimescale && movieFragmentDuration) {
          duration = movieFragmentDuration / movieTimescale;
        }
        if (!width && !height && !duration) {
          finish({ ok: false, error: 'metadata-not-found' });
          return;
        }
        finish({ ok: true, width, height, duration, kind: width && height ? 'video' : 'audio' });
      };
      xhr.onerror = () => finish({ ok: false, error: 'metadata-load-failed' });
      xhr.send();
    } catch (error) {
      finish({ ok: false, error: error?.message || 'metadata-load-failed' });
    }
  });
}

function probeMediaMetadataInSourceTab(item, timeoutMs = 12500) {
  const tabId = Number.isInteger(item?.tabId) ? item.tabId : currentTabId;
  if (!Number.isInteger(tabId)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result?.ok ? result : null);
    };
    const timeout = setTimeout(() => finish(null), timeoutMs);
    if (chrome.scripting?.executeScript) {
      try {
        chrome.scripting.executeScript({
          target: { tabId },
          world: 'MAIN',
          func: probeMediaMetadataInMainWorld,
          args: [item.resourceUrl],
        }, (results) => {
          if (chrome.runtime.lastError) {
            finish(null);
            return;
          }
          finish(results?.[0]?.result || null);
        });
        return;
      } catch {}
    }
    if (!chrome.tabs?.sendMessage) {
      finish(null);
      return;
    }
    try {
      chrome.tabs.sendMessage(tabId, {
        type: 'PROBE_MEDIA_METADATA_IN_PAGE',
        resourceUrl: item.resourceUrl,
        kind: item.kind,
        streamProtocol: item.streamProtocol,
      }, (result) => {
        if (chrome.runtime.lastError) {
          finish(null);
          return;
        }
        finish(result);
      });
    } catch {
      finish(null);
    }
  });
}

function loadMediaMetadata(item, card) {
  if (!item?.id || mediaMetadataLoads.has(item.id)) return;
  mediaMetadataLoads.add(item.id);
  const tagName = item.kind === 'audio' ? 'audio' : 'video';
  const mediaEl = document.createElement(tagName);
  let batchEntry = null;
  let cleanupTimer = null;
  let cleanedUp = false;
  const clearMetadataRule = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (cleanupTimer) clearTimeout(cleanupTimer);
    chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_METADATA', id: item.id }, () => {});
  };
  const removeMediaEl = () => {
    mediaMetadataLoads.delete(item.id);
    if (mediaMetadataBatchQueue.get(item.id) === batchEntry) {
      mediaMetadataBatchQueue.delete(item.id);
    }
    clearMetadataRule();
    mediaEl.remove();
  };
  const markMetadataFailed = () => {
    const resolutionEl = card.querySelector('.media-resolution');
    if (resolutionEl) resolutionEl.textContent = popupAppT('mediaResolutionUnavailable', undefined, '无法识别分辨率');
    chrome.runtime.sendMessage({
      type: 'UPDATE_MEDIA_METADATA',
      id: item.id,
      metadataFailed: true,
    }, () => {});
    removeMediaEl();
  };
  mediaEl.preload = 'metadata';
  mediaEl.style.position = 'absolute';
  mediaEl.style.width = '1px';
  mediaEl.style.height = '1px';
  mediaEl.style.opacity = '0';
  mediaEl.muted = true;
  mediaEl.addEventListener('loadedmetadata', () => {
    if (rayburstMergeTrackType(item) === 'audio' || item.kind === 'video' || item.kind === 'media') {
      const width = mediaEl.videoWidth || 0;
      const height = mediaEl.videoHeight || 0;
      const inferredKind = inferMediaKindFromMetadata(item, { loaded: true, width, height });
      const duration = mediaEl.duration;
      const liveState = duration === Infinity
        ? { isLive: true }
        : Number.isFinite(duration) && duration > 0 ? { isLive: false } : {};
      const resolutionEl = card.querySelector('.media-resolution');
      if (resolutionEl && width && height) resolutionEl.textContent = `${width}×${height}`;
      chrome.runtime.sendMessage({
        type: 'UPDATE_MEDIA_METADATA',
        id: item.id,
        width,
        height,
        kind: inferredKind,
        duration: Number.isFinite(duration) ? duration : 0,
        ...liveState,
        metadataFailed: false,
      });
    }
    removeMediaEl();
  }, { once: true });
  mediaEl.addEventListener('error', markMetadataFailed, { once: true });
  card.appendChild(mediaEl);
  cleanupTimer = setTimeout(markMetadataFailed, 15000);
  batchEntry = {
    item,
    start() {
      if (!cleanedUp) mediaEl.src = item.resourceUrl;
    },
  };
  const sourcePageProbePreferred = isSafariPopupRuntime() ||
    item.streamProtocol === 'hls' ||
    /\.m3u8(?:[?#\s]|$)/i.test(`${item.resourceUrl || ''} ${item.filename || ''}`);
  if (sourcePageProbePreferred) {
    probeMediaMetadataInSourceTab(item).then((result) => {
      if (cleanedUp) return;
      if (!result) {
        queueMediaMetadataProbe(batchEntry);
        return;
      }
      const width = Number(result.width) || 0;
      const height = Number(result.height) || 0;
      const inferredKind = item.streamProtocol
        ? inferMediaKindFromMetadata(item, { loaded: true, width, height })
        : result.kind || inferMediaKindFromMetadata(item, { loaded: true, width, height });
      const duration = Number(result.duration) || 0;
      const liveState = typeof result.isLive === 'boolean'
        ? { isLive: result.isLive }
        : result.duration === Infinity
          ? { isLive: true }
          : Number.isFinite(result.duration) && result.duration > 0 ? { isLive: false } : {};
      const resolutionEl = card.querySelector('.media-resolution');
      if (resolutionEl && width && height) resolutionEl.textContent = `${width}×${height}`;
      chrome.runtime.sendMessage({
        type: 'UPDATE_MEDIA_METADATA',
        id: item.id,
        width,
        height,
        kind: inferredKind,
        duration,
        ...liveState,
        variantUrls: Array.isArray(result.variantUrls) ? result.variantUrls : undefined,
        metadataFailed: false,
      }, () => {});
      removeMediaEl();
    });
    return;
  }
  queueMediaMetadataProbe(batchEntry);
}

function refreshMediaCardTitles(media) {
  const byId = new Map(media.map((item) => [item.id, item]));
  const list = document.getElementById('mediaList');
  for (const card of list?.children || []) {
    const item = byId.get(card.dataset.mediaId);
    if (!item) continue;
    const filename = getMediaDisplayFilename(item);
    const name = card.querySelector('.media-name');
    if (name) {
      name.textContent = filename;
      name.title = filename;
    }
    const checkbox = card.querySelector('[data-select-media-id]');
    checkbox?.setAttribute('aria-label', `${popupAppT('mergeWithRayburst', undefined, '合并下载')}：${filename}`);
  }
  const hoverItem = byId.get(mediaHoverPreviewState.itemId);
  const hoverTitle = mediaHoverPreviewState.popover?.querySelector?.('.media-hover-preview-title');
  if (hoverItem && hoverTitle) hoverTitle.textContent = getMediaDisplayFilename(hoverItem);
}

function renderMedia(mediaByTab, pausedTabs = [], mediaBlacklistBlockedTabs = []) {
  const listEl = document.getElementById('mediaList');
  const emptyEl = document.getElementById('mediaEmpty');
  const emptyImageEl = document.getElementById('mediaEmptyImage');
  const summaryEl = document.getElementById('mediaSummary');
  const mediaBadge = document.getElementById('mediaBadge');
  const mediaTab = document.getElementById('mediaTab');
  const toggleSniffingBtn = document.getElementById('toggleSniffingBtn');
  const clearMediaBtn = document.getElementById('clearMediaBtn');
  const addSiteToMediaBlacklistBtn = document.getElementById('addSiteToMediaBlacklistBtn');
  renderInlineAlert('mediaAlert');
  const media = currentTabId == null ? [] : (mediaByTab?.[currentTabId] || []);
  const mediaKey = `${currentConfig.downloaderType}:${buildMediaRenderKey(media)}:${JSON.stringify(media.map((item) => item.pageTitle))}`;
  const mediaCount = media.length;
  const isBlacklistBlocked = currentTabId != null && mediaBlacklistBlockedTabs.includes(currentTabId);
  const blacklistBlockedLabel = popupAppT('mediaSniffingBlocked', undefined, '当前网站已在媒体嗅探黑名单中');
  const isPaused = currentTabId != null && pausedTabs.includes(currentTabId);
  const isEffectivelyPaused = isPaused || isBlacklistBlocked;

  emptyEl.style.display = media.length ? 'none' : 'flex';
  if (emptyImageEl) {
    emptyImageEl.src = isBlacklistBlocked
      ? 'assets/empty-media-sniffing-disabled.png'
      : 'assets/empty-media.png';
  }
  if (isBlacklistBlocked) {
    summaryEl.textContent = blacklistBlockedLabel;
  } else if (isPaused) {
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
    const label = isEffectivelyPaused
      ? popupAppT('resumeSniffing', undefined, '恢复嗅探')
      : popupAppT('pauseSniffing', undefined, '暂停嗅探');
    toggleSniffingBtn.replaceChildren(getSniffingToggleIcon(isEffectivelyPaused));
    toggleSniffingBtn.title = isBlacklistBlocked ? blacklistBlockedLabel : label;
    toggleSniffingBtn.disabled = isBlacklistBlocked;
    if (typeof toggleSniffingBtn.setAttribute === 'function') {
      toggleSniffingBtn.setAttribute('aria-label', isBlacklistBlocked ? blacklistBlockedLabel : label);
    } else {
      toggleSniffingBtn.ariaLabel = isBlacklistBlocked ? blacklistBlockedLabel : label;
    }
    toggleSniffingBtn.classList.toggle('btn-primary', isEffectivelyPaused);
    toggleSniffingBtn.classList.toggle('btn-ghost', !isEffectivelyPaused);
  }
  if (clearMediaBtn) clearMediaBtn.disabled = isBlacklistBlocked;
  if (addSiteToMediaBlacklistBtn) {
    addSiteToMediaBlacklistBtn.disabled = currentTabId == null;
    addSiteToMediaBlacklistBtn.textContent = isBlacklistBlocked
      ? popupAppT('removeSiteFromMediaBlacklist', undefined, '从黑名单中删除')
      : popupAppT('addSiteToMediaBlacklist', undefined, '将本站加入黑名单');
  }
  if (mediaTab) {
    mediaTab.classList.toggle('disabled', isBlacklistBlocked);
    mediaTab.title = isBlacklistBlocked ? blacklistBlockedLabel : '';
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
  updateRayburstMergeControls(media);
  syncPopupGlobals();

  if (mediaKey === lastRenderedMediaKey) return;
  lastRenderedMediaKey = mediaKey;
  syncPopupGlobals();

  const activeHoverItem = mediaHoverPreviewState.itemId
    ? media.find((item) => item.id === mediaHoverPreviewState.itemId)
    : null;
  if (!activeHoverItem) {
    closeMediaHoverPreview();
  } else {
    const title = mediaHoverPreviewState.popover?.querySelector?.('.media-hover-preview-title');
    if (title) title.textContent = getMediaDisplayFilename(activeHoverItem);
  }
  listEl.replaceChildren();
  media.forEach((item) => {
    const iconSrc = getFileIcon({ name: item.filename, mime: item.mime, kind: item.kind });
    const durationText = mediaDurationLabel(item.duration);
    const resolutionText = item.kind === 'video' || item.kind === 'media' ? mediaResolutionLabel(item) : '';
    const displayFilename = getMediaDisplayFilename(item);
    const card = createMediaCard(item, { iconSrc, durationText, resolutionText, displayFilename });
    listEl.appendChild(card);
    if (mediaHoverPreviewState.itemId === item.id && mediaHoverPreviewState.popover) {
      positionMediaHoverPreview(card, mediaHoverPreviewState.popover);
    }
    const iconWrap = card.querySelector('.media-icon');
    if (!isSafariPopupRuntime()) {
      if (iconWrap) iconWrap.addEventListener('mouseenter', () => scheduleMediaHoverPreview(item, card));
      if (iconWrap) iconWrap.addEventListener('mouseleave', scheduleCloseMediaHoverPreview);
      card.addEventListener('mouseleave', scheduleCloseMediaHoverPreview);
    }
    const icon = card.querySelector('.media-icon img');
    if (icon) icon.addEventListener('error', handleTaskIconError);
    const selectCheckbox = card.querySelector('[data-select-media-id]');
    if (selectCheckbox) {
      selectCheckbox.addEventListener('change', () => {
        const currentMedia = currentState.media?.[currentTabId] || [];
        if (selectCheckbox.checked) {
          const selectedType = rayburstMergeTrackType(item);
          const currentItem = currentMedia.find((candidate) => candidate.id === item.id) || item;
          const opposite = currentMedia.find((candidate) => selectedRayburstMediaIds.has(candidate.id)
            && rayburstMergeTrackType(candidate) !== selectedType);
          const video = selectedType === 'video' ? currentItem : opposite;
          const audio = selectedType === 'audio' ? currentItem : opposite;
          if (video && audio && rayburstDurationsConflict(video, audio)) {
            selectCheckbox.checked = false;
            showToast(rayburstDurationConflictMessage());
            return;
          }
          rayburstMatchAnchorId = null;
          rayburstAutoCompanionId = null;
          for (const selectedId of selectedRayburstMediaIds) {
            const selectedItem = currentMedia.find((candidate) => candidate.id === selectedId);
            if (rayburstMergeTrackType(selectedItem) === selectedType) selectedRayburstMediaIds.delete(selectedId);
          }
          selectedRayburstMediaIds.add(item.id);
          if (selectedRayburstMediaIds.size === 1) rayburstMatchAnchorId = item.id;
        } else {
          rayburstMatchAnchorId = null;
          selectedRayburstMediaIds.delete(item.id);
          if (rayburstAutoCompanionId && rayburstAutoCompanionId !== item.id) {
            selectedRayburstMediaIds.delete(rayburstAutoCompanionId);
          }
          rayburstAutoCompanionId = null;
        }
        updateRayburstMergeControls(currentMedia);
        refreshRayburstPageTitle();
      });
    }

    const shouldProbeResolution = (item.kind === 'video' || item.kind === 'media') && (!item.width || !item.height);
    const shouldProbeDuration = currentConfig.downloaderType === 'motrixnext'
      && rayburstMergeTrackType(item) && !item.duration;
    if ((shouldProbeResolution || shouldProbeDuration) && !item.metadataFailed && !item.metadataProbed) {
      // Defer metadata loading slightly to allow initial UI paint and avoid
      // triggering many network requests during popup open.
      setTimeout(() => loadMediaMetadata(item, card), MEDIA_METADATA_LOAD_DELAY_MS);
    }

    const nameEl = card.querySelector('.media-name');
    const nameInput = card.querySelector('.media-name-input');
    const editNameBtn = card.querySelector('.media-name-edit');
    let editingOriginalName = displayFilename;
    const commitMediaName = ({ cancel = false } = {}) => {
      if (!nameEl || !nameInput) return getMediaDownloadFilename(item);
      const fallbackName = getMediaDownloadFilename(item);
      const nextName = cancel ? editingOriginalName : (nameInput.value.trim() || fallbackName);
      if (!cancel) mediaFilenameDrafts.set(item.id, nextName);
      nameEl.textContent = getMediaDisplayFilename(item);
      nameEl.title = nameEl.textContent;
      nameInput.value = nextName;
      nameInput.hidden = true;
      nameEl.hidden = false;
      return nextName;
    };
    const openMediaNameEditor = () => {
      if (!nameEl || !nameInput) return;
      editingOriginalName = getMediaDownloadFilename(item);
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
      const filename = nameInput?.hidden === false ? commitMediaName() : getMediaDownloadFilename(item);
      const sendConfig = getTestConnectionConfig();
      const connectionConfig = sendConfig.downloaderType === 'motrixnext'
        ? { motrixNextPort: sendConfig.motrixNextPort, motrixNextSecret: sendConfig.motrixNextSecret }
        : undefined;
      btn.disabled = true;
      btn.textContent = popupAppT('sending', undefined, '发送中…');
      chrome.runtime.sendMessage({ type: 'ADD_MEDIA_TASK', id: btn.dataset.sendId, filename, connectionConfig }, (res) => {
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
          const downloaderLabel = getDownloaderName(currentConfig);
          currentState.uiAlert = {
            type: res?.unsupported ? 'unsupported' : res?.actionable ? 'downloader-error' : 'connection-failure',
            downloaderLabel,
            message: res?.error || '',
          };
          renderInlineAlert('mediaAlert', getUiAlertMessage(), { shake: true });
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
  if (state.config) {
    const nextConfig = normalizePopupConfig(state.config);
    if (JSON.stringify(nextConfig) !== JSON.stringify(savedConfig)) {
      applyLocaleFromConfig(nextConfig);
      loadSettings(nextConfig);
    }
  }
  hiddenTaskGids = new Set(state.hiddenTaskGids || []);
  const media = state.mediaPatch
    ? { ...currentState.media, ...(state.media || {}) }
    : (state.media !== undefined ? state.media : currentState.media);
  currentState = {
    tasks: state.tasks || {},
    pending: state.pending || {},
    media,
    pausedTabs: state.pausedTabs || [],
    mediaBlacklistBlockedTabs: state.mediaBlacklistBlockedTabs || [],
    uiAlert: state.uiAlert || null,
  };
  syncPopupGlobals();
  renderTasks(currentState.tasks, currentState.pending);
  renderMedia(currentState.media, currentState.pausedTabs, currentState.mediaBlacklistBlockedTabs);
}

async function refreshAll() {
  const tab = await getCurrentTab();
  currentTabId = tab?.id ?? null;
  currentTabTitle = tab?.title || '';
  currentTabUrl = tab?.url || '';
  lastRenderedMediaKey = '';
  previousMediaCount = 0;
  lastAutoSwitchedMediaCount = 0;
  syncPopupGlobals();
  chrome.runtime.sendMessage({ type: 'GET_STATE', tabId: currentTabId }, (res) => {
    if (!res) return;
    const config = normalizePopupConfig(res.config);
    renderState({ ...res, config });
    refreshRayburstPageTitle();
  });
}

const settingsController = popupSettings.createSettingsController({
  defaultCaptureExtensions: POPUP_DEFAULT_CAPTURE_EXTENSIONS,
  defaultMediaSniffingBlacklist: POPUP_DEFAULT_MEDIA_SNIFFING_BLACKLIST,
  defaultDownloadInterceptionBlacklist: POPUP_DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST,
  hideSmallDownloadSettings: isSafariPopupRuntime(),
  showSafariDownloadAllowlist: isSafariPopupRuntime(),
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
  globalThis.syncLanguagePicker?.();
  updateDynamicLabels(currentConfig);
  renderTasks(currentState.tasks, currentState.pending);
  renderMedia(currentState.media, currentState.pausedTabs, currentState.mediaBlacklistBlockedTabs);
  syncPopupGlobals();
});

document.getElementById('cfgDownloaderType').addEventListener('change', (event) => {
  const nextType = event.target.value;
  const nextCfg = normalizePopupConfig({ ...currentConfig, ...collectSettingsFromForm(), downloaderType: nextType });
  currentConfig = { ...currentConfig, ...nextCfg };
  lastRenderedMediaKey = '';
  renderMedia(currentState.media, currentState.pausedTabs, currentState.mediaBlacklistBlockedTabs);
  syncPopupGlobals();
  updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking', stat: null, message: '' });
});

async function openShortcutSettings() {
  if (isSafariPopupRuntime()) return;

  try {
    const commandsApi = globalThis.browser?.commands || chrome.commands;
    if (typeof commandsApi?.openShortcutSettings === 'function') {
      await commandsApi.openShortcutSettings();
      showToast(popupAppT('shortcutSettingsOpened', undefined, '已打开浏览器扩展快捷键设置'));
      return;
    }
  } catch {}

  let url = 'chrome://extensions/shortcuts';
  try {
    const info = typeof chrome.runtime.getBrowserInfo === 'function'
      ? await chrome.runtime.getBrowserInfo()
      : null;
    if (/firefox/i.test(info?.name || '')) url = 'about:addons';
  } catch {}

  chrome.tabs.create({ url }, () => {
    if (chrome.runtime.lastError) {
      showToast(chrome.runtime.lastError.message || popupAppT('openFailed', [popupAppT('customizeShortcut', undefined, '自定义')], '打开失败：自定义'));
      return;
    }
    showToast(url === 'about:addons'
      ? popupAppT('shortcutSettingsOpenedFirefoxFallback', undefined, '已打开 Firefox 扩展管理页，可在齿轮菜单中管理扩展快捷键')
      : popupAppT('shortcutSettingsOpened', undefined, '已打开浏览器扩展快捷键设置'));
  });
}

document.getElementById('customizeShortcutBtn').addEventListener('click', async () => {
  await openShortcutSettings();
});

function getTestConnectionConfig() {
  return normalizePopupConfig(collectSettingsFromForm());
}

document.getElementById('testConnBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResult');
  const testConfig = getTestConnectionConfig();
  updateHeaderStatusDisplay({ cfg: testConfig, state: 'checking' });
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('downloaderConnecting', ['Aria2'], 'Aria2 连接中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    updateHeaderStatusDisplay({
      cfg: testConfig,
      state: res?.ok ? 'online' : 'offline',
      stat: res?.stat,
      message: res?.message || '',
    });
    if (res?.ok) {
      const stat = res.stat;
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectionSuccessStats', [stat?.numActive || 0, stat?.numWaiting || 0, stat?.numStopped || 0], `连接成功 — 活跃 ${stat?.numActive || 0} · 等待 ${stat?.numWaiting || 0} · 完成 ${stat?.numStopped || 0}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = getConnectionFailureMessage('Aria2');
  });
});

document.getElementById('testLauncherBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultLauncher');
  const testConfig = getTestConnectionConfig();
  updateHeaderStatusDisplay({ cfg: testConfig, state: 'checking' });
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('readInProgress', undefined, '读取中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    updateHeaderStatusDisplay({
      cfg: testConfig,
      state: res?.ok ? 'online' : 'offline',
      stat: res?.stat,
      message: res?.message || '',
    });
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectedEndpoint', [res.message || popupAppT('interfaceConfigured', undefined, '接口已配置')], `${res.message || '接口已配置'}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = getConnectionFailureMessage('AB DM');
  });
});

document.getElementById('testMotrixNextBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultMotrixNext');
  const testConfig = getTestConnectionConfig();
  updateHeaderStatusDisplay({ cfg: testConfig, state: 'checking' });
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('downloaderConnecting', ['Rayburst'], 'Rayburst 连接中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    updateHeaderStatusDisplay({
      cfg: testConfig,
      state: res?.ok ? 'online' : 'offline',
      stat: res?.stat,
      message: res?.message || '',
    });
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectedEndpoint', [res.message || popupAppT('motrixNextReady', undefined, 'Rayburst 已就绪')], `${res.message || 'Rayburst 已就绪'}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = getConnectionFailureMessage('Rayburst');
  });
});

document.getElementById('testGopeedBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultGopeed');
  const testConfig = getTestConnectionConfig();
  updateHeaderStatusDisplay({ cfg: testConfig, state: 'checking' });
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('downloaderConnecting', ['Gopeed'], 'Gopeed 连接中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    updateHeaderStatusDisplay({
      cfg: testConfig,
      state: res?.ok ? 'online' : 'offline',
      stat: res?.stat,
      message: res?.message || '',
    });
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectedEndpoint', [res.message || popupAppT('gopeedReady', undefined, 'Gopeed 已就绪')], `${res.message || 'Gopeed 已就绪'}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = getConnectionFailureMessage('Gopeed');
  });
});

document.getElementById('testNeatdmBtn').addEventListener('click', () => {
  const resultEl = document.getElementById('connResultNeatdm');
  const testConfig = getTestConnectionConfig();
  updateHeaderStatusDisplay({ cfg: testConfig, state: 'checking' });
  resultEl.className = 'conn-result';
  resultEl.textContent = popupAppT('downloaderConnecting', ['NeatDM'], 'NeatDM 连接中…');
  resultEl.style.display = 'block';
  chrome.runtime.sendMessage({ type: 'TEST_CONNECTION', config: testConfig }, (res) => {
    updateHeaderStatusDisplay({
      cfg: testConfig,
      state: res?.ok ? 'online' : 'offline',
      stat: res?.stat,
      message: res?.message || '',
    });
    if (res?.ok) {
      resultEl.className = 'conn-result ok';
      resultEl.textContent = popupAppT('connectedEndpoint', [res.message || popupAppT('neatdmReady', undefined, 'NeatDM 已就绪')], `${res.message || 'NeatDM 已就绪'}`);
      return;
    }
    resultEl.className = 'conn-result fail';
    resultEl.textContent = getConnectionFailureMessage('NeatDM');
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

document.getElementById('rayburstMergeFormatButton')?.addEventListener('click', (event) => {
  event.stopPropagation();
  const picker = document.getElementById('rayburstMergeFormatPicker');
  const button = event.currentTarget;
  const open = !picker?.classList.contains('open');
  picker?.classList.toggle('open', open);
  button.setAttribute('aria-expanded', String(open));
});

document.getElementById('rayburstMergeFormatMenu')?.addEventListener('click', (event) => {
  const option = event.target.closest('.rayburst-format-option');
  if (!option) return;
  setRayburstMergeFormat(option.dataset.value);
  closeRayburstFormatPicker();
  document.getElementById('rayburstMergeFormatButton')?.focus();
});

document.addEventListener?.('click', closeRayburstFormatPicker);
document.getElementById('rayburstMergeFormatPicker')?.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeRayburstFormatPicker();
    document.getElementById('rayburstMergeFormatButton')?.focus();
  }
});

document.getElementById('mergeRayburstMediaBtn').addEventListener('click', async () => {
  if (rayburstMergeSubmitting) return;
  const tabId = currentTabId;
  const media = currentTabId == null ? [] : (currentState.media?.[currentTabId] || []);
  const selected = media.filter((item) => selectedRayburstMediaIds.has(item.id));
  const video = selected.find((item) => rayburstMergeTrackType(item) === 'video');
  const audio = selected.find((item) => rayburstMergeTrackType(item) === 'audio');
  if (selected.length !== 2 || !video || !audio) {
    showToast(popupAppT('rayburstMergeSelectionHint', undefined, '请选择一条视频和一条音频'));
    return;
  }
  if (rayburstDurationsConflict(video, audio)) {
    showToast(rayburstDurationConflictMessage());
    return;
  }
  const filenameInput = document.getElementById('rayburstMergeFilename');
  const formatSelect = document.getElementById('rayburstMergeFormat');
  rayburstMergeSubmitting = true;
  updateRayburstMergeControls(media);
  if (filenameInput?.value === filenameInput?.dataset.defaultBasename) {
    await refreshRayburstPageTitle();
  }
  if (tabId !== currentTabId || !selected.every((item) => selectedRayburstMediaIds.has(item.id))) {
    rayburstMergeSubmitting = false;
    updateRayburstMergeControls(currentState.media?.[currentTabId] || []);
    return;
  }
  const latestMedia = currentState.media?.[tabId] || [];
  const latestVideo = latestMedia.find((item) => item.id === video.id);
  const latestAudio = latestMedia.find((item) => item.id === audio.id);
  if (latestVideo && latestAudio && rayburstDurationsConflict(latestVideo, latestAudio)) {
    rayburstMergeSubmitting = false;
    updateRayburstMergeControls(latestMedia);
    showToast(rayburstDurationConflictMessage());
    return;
  }
  chrome.runtime.sendMessage({
    type: 'ADD_RAYBURST_MEDIA_COLLECTION',
    ids: selected.map((item) => item.id),
    filename: rayburstOutputBasename(filenameInput?.value) || rayburstDefaultMergeBasename(selected),
    format: formatSelect?.value === 'mkv' ? 'mkv' : 'mp4',
    connectionConfig: {
      motrixNextPort: currentConfig.motrixNextPort,
      motrixNextSecret: currentConfig.motrixNextSecret,
    },
  }, (res) => {
    if (res?.ok) {
      selectedRayburstMediaIds.clear();
      if (filenameInput) filenameInput.dataset.videoId = '';
      document.querySelectorAll('[data-select-media-id]').forEach((checkbox) => { checkbox.checked = false; });
      showToast(popupAppT('rayburstMergeSent', undefined, '已发送到 Rayburst 合并下载'));
    } else {
      showToast(res?.error || popupAppT('sendToDownloaderFailed', undefined, '发送到下载器失败。'));
    }
    rayburstMergeSubmitting = false;
    updateRayburstMergeControls(currentState.media?.[currentTabId] || []);
  });
});

document.getElementById('openAria2TasksBtn').addEventListener('click', () => {
  const url = chrome.runtime.getURL('aria2-tasks.html');
  chrome.tabs.create({ url }, () => {
    if (chrome.runtime.lastError) {
      showToast(chrome.runtime.lastError.message || popupAppT('openFailed', [popupAppT('openAria2Tasks', undefined, '任务管理')], `打开失败：${popupAppT('openAria2Tasks', undefined, '任务管理')}`));
    }
  });
});

document.getElementById('addSiteToMediaBlacklistBtn').addEventListener('click', (event) => {
  const button = event.currentTarget;
  const isBlacklistBlocked = currentState.mediaBlacklistBlockedTabs?.includes(currentTabId);
  button.disabled = true;
  chrome.runtime.sendMessage({
    type: isBlacklistBlocked ? 'REMOVE_SITE_FROM_MEDIA_BLACKLIST' : 'ADD_SITE_TO_MEDIA_BLACKLIST',
    tabId: currentTabId,
  }, (res) => {
    if (!res?.ok) {
      button.disabled = false;
      showToast(res?.error || popupAppT('mediaBlacklistSiteUnavailable', undefined, '当前页面无法加入媒体嗅探黑名单'));
      return;
    }
    showToast(isBlacklistBlocked
      ? popupAppT('siteRemovedFromMediaBlacklist', [res.hostname], `已将 ${res.hostname} 从媒体嗅探黑名单中删除`)
      : popupAppT('siteAddedToMediaBlacklist', [res.hostname], `已将 ${res.hostname} 加入媒体嗅探黑名单`));
  });
});

document.getElementById('toggleSniffingBtn').addEventListener('click', () => {
  if (currentState.mediaBlacklistBlockedTabs?.includes(currentTabId)) {
    showToast(popupAppT('sniffingResumeBlockedByBlacklist', undefined, '当前网站已在媒体嗅探黑名单中'));
    return;
  }
  const isPaused = currentState.pausedTabs?.includes(currentTabId);
  const msgType = isPaused ? 'RESUME_MEDIA_SNIFFING' : 'PAUSE_MEDIA_SNIFFING';
  chrome.runtime.sendMessage({ type: msgType, tabId: currentTabId }, (res) => {
    if (res?.disabled) {
      showToast(res?.blacklisted
        ? popupAppT('sniffingResumeBlockedByBlacklist', undefined, '当前网站已在媒体嗅探黑名单中')
        : popupAppT('sniffingResumeBlockedByCaptureOff', undefined, '请先开启拦截'));
      return;
    }
    showToast(isPaused && res?.ok !== false
      ? popupAppT('sniffingResumed', undefined, '已恢复嗅探')
      : popupAppT('sniffingPausedToast', undefined, '已暂停嗅探'));
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== currentTabId) return;
  const nextUrl = changeInfo.url ?? tab?.url ?? currentTabUrl;
  const urlChanged = nextUrl !== currentTabUrl;
  const titleChanged = typeof changeInfo.title === 'string';
  if (!urlChanged && !titleChanged) return;
  currentTabUrl = nextUrl;
  currentTabTitle = changeInfo.title ?? tab?.title ?? '';
  updateRayburstMergeControls(currentState.media?.[tabId] || []);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'TASKS_UPDATE') return;
  const previousMedia = currentState.media?.[currentTabId];
  renderState(msg);
  const media = currentState.media?.[currentTabId];
  if (media !== previousMedia && media?.some((item) => bilibiliTrackCid(item) && !bilibiliTrackTitle(item))) {
    refreshRayburstPageTitle();
  }
});

// Apply runtime-specific visibility before the deferred state refresh so Safari
// never briefly renders controls it cannot support.
updateSettingsVisibility(currentConfig.downloaderType);
applyLocaleFromConfig(currentConfig);
globalThis.syncLanguagePicker?.();
syncPopupGlobals();
// Defer heavy initialization to next animation frame so popup can paint quickly.
// In test (Node) environments `requestAnimationFrame` may be undefined —
// fall back to `setTimeout` to keep behavior consistent.
const _defer = (typeof requestAnimationFrame === 'function')
  ? (cb) => requestAnimationFrame(cb)
  : (cb) => setTimeout(cb, 0);
_defer(() => { setTimeout(() => refreshAll(), 0); });

// The native health check is read-only; it never launches a stopped host.
function initializeHostServiceStatus() {
  if (!isSafariPopupRuntime()) return;
  document.getElementById('safariSettingsGroup')?.classList.remove('settings-hidden');
  const banner = document.getElementById('hostServiceBanner');
  if (!banner) return;
  const label = document.getElementById('hostServiceLabel');
  const help = document.getElementById('hostServiceHelp');
  const retry = document.getElementById('hostServiceRetry');
  const notice = document.getElementById('hostServiceNotice');
  const english = !String(chrome.i18n?.getUILanguage?.() || navigator.language).startsWith('zh');
  retry.title = english ? 'Check again' : '重新检测';
  retry.setAttribute?.('aria-label', retry.title);
  let pending = false;
  async function check() {
    if (pending) return;
    pending = true;
    retry.disabled = true;
    banner.hidden = false;
    if (!banner.dataset.state) label.textContent = english ? 'Checking Downlink background service…' : '正在检测 Downlink 后台服务…';
    let timer;
    try {
      const status = await Promise.race([
        new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({ type: 'GET_HOST_SERVICE_STATUS' }, response => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message)); else resolve(response);
          });
        }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 3000); }),
      ]);
      render(status?.connected === true);
    } catch (_) { render(false); }
    finally { clearTimeout(timer); pending = false; retry.disabled = false; }
  }
  function render(connected) {
    banner.dataset.state = connected ? 'online' : 'offline';
    label.textContent = connected
      ? (english ? 'Downlink background service connected' : 'Downlink 后台服务已连接')
      : (english ? 'Cannot connect to Downlink background service' : '无法连接 Downlink 后台服务');
    if (notice) {
      notice.hidden = connected;
      notice.textContent = english ? 'Downlink service not running' : 'Downlink 后台服务未启动';
    }
    help.hidden = connected;
    help.textContent = english
      ? 'Open Downlink from Applications and start its background service to restore download capture.'
      : '请从「应用程序」打开 Downlink，启动后台服务以恢复下载接管。';
  }
  notice?.addEventListener('click', () => switchTab('settings'));
  retry.addEventListener('click', check);
  void check();
  const interval = setInterval(() => { if (!document.hidden) void check(); }, 5000);
  window.addEventListener('pagehide', () => clearInterval(interval), { once: true });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initializeHostServiceStatus, { once: true });
else initializeHostServiceStatus();
