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
const MEDIA_HOVER_PREVIEW_DELAY_MS = 280;
const MEDIA_HOVER_PREVIEW_HIDE_DELAY_MS = 120;
let lastRenderedPendingKey = '';
let mediaHoverPreviewState = {
  itemId: '',
  timer: null,
  hideTimer: null,
  popover: null,
  mediaEl: null,
};

function closeAllSaveLocationMenus() {
  document.querySelectorAll('.pending-save-location-menu.open').forEach((m) => {
    m.classList.remove('open');
    m.style.removeProperty('--pending-save-location-menu-left');
    m.style.removeProperty('--pending-save-location-menu-top');
    m.style.removeProperty('--pending-save-location-menu-width');
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
  try {
    mediaEl?.pause?.();
  } catch {}
  popover?.remove?.();
  if (itemId) chrome.runtime.sendMessage({ type: 'CLEAR_MEDIA_HOVER_PREVIEW', id: itemId }, () => {});
  mediaHoverPreviewState = {
    itemId: '',
    timer: null,
    hideTimer: null,
    popover: null,
    mediaEl: null,
  };
}

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
  header.textContent = getMediaFilenameValue(item);
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
  mediaEl.addEventListener('error', () => {
    popover.classList.add('media-hover-preview-error');
  });
  shell.appendChild(mediaEl);
  popover.appendChild(shell);

  document.body.appendChild(popover);
  card.dataset.mediaKind = item.kind || 'media';
  positionMediaHoverPreview(card, popover);
  mediaHoverPreviewState = {
    itemId: item.id,
    timer: null,
    hideTimer: null,
    popover,
    mediaEl,
  };

  chrome.runtime.sendMessage({ type: 'PREPARE_MEDIA_HOVER_PREVIEW', id: item.id }, () => {
    if (mediaHoverPreviewState.itemId !== item.id || mediaHoverPreviewState.mediaEl !== mediaEl) return;
    mediaEl.src = item.resourceUrl;
    const playResult = mediaEl.play?.();
    playResult?.catch?.(() => {});
  });
}

function scheduleMediaHoverPreview(item, card) {
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
  return pendingFilenameDrafts.has(item.key)
    ? pendingFilenameDrafts.get(item.key)
    : decodeDisplayFilename(item.filename || item.url.split('?')[0].split('/').pop() || '');
}

function getMediaFilenameValue(item) {
  return mediaFilenameDrafts.has(item.id)
    ? mediaFilenameDrafts.get(item.id)
    : (item.filename || popupAppT('untitledMedia', undefined, '未命名媒体'));
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
    getPendingFilenameValue(item),
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
  filenameInput.placeholder = popupAppT('autoDetect', undefined, '自动识别');
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

function createTaskCard(task, { name, stateKey, pct, showProgress, eta, canViewInMotrix, canViewInGopeed }) {
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
  if (canViewInMotrix) actions.appendChild(createTaskButton(popupAppT('motrixView', undefined, 'MotrixNext中查看'), 'motrix-view'));
  if (canViewInGopeed) actions.appendChild(createTaskButton(popupAppT('gopeedView', undefined, 'Gopeed中查看'), 'gopeed-view'));
  if (stateKey === 'active') actions.appendChild(createTaskButton(popupAppT('pauseTask', undefined, '暂停'), 'pause', { gid: task.gid }));
  if (stateKey === 'paused') actions.appendChild(createTaskButton(popupAppT('resumeTask', undefined, '继续'), 'resume', { gid: task.gid }));
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

function createMediaCard(item, { iconSrc, durationText, resolutionText, displayFilename }) {
  const card = document.createElement('div');
  card.className = `media-card media-card-${item.kind || 'media'}`;
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
  titleRow.appendChild(createTextElement('span', `media-chip media-kind kind-${item.kind || 'video'}`, mediaKindLabel(item.kind)));

  const urlEl = createTextElement('div', 'media-url', item.resourceUrl || '');
  const meta = document.createElement('div');
  meta.className = 'media-meta';
  meta.appendChild(createMediaFact('size', item.size ? fmt(item.size) : popupAppT('unknownSize', undefined, '大小未知')));
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
  const showAria2SaveLocations = isAria2 && !!currentConfig.aria2CustomSaveEnabled;
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
  document.querySelectorAll('.downloader-config-group').forEach((el) => {
    el.classList.toggle('settings-hidden', !(isAria2 || isAbDownload));
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
    pendingList.replaceChildren();
    pendingVals.forEach((item) => {
      const filename = getPendingFilenameValue(item);
      const canForceSingleThread = ['aria2', 'gopeed'].includes(currentConfig.downloaderType);
      const card = createPendingCard(item, { filename, canForceSingleThread });
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
        const saveLocationPath = card.querySelector('.pending-save-location-menu')?.dataset.value || '';
        if (currentConfig.downloaderType === 'aria2' && saveLocationPath) opts.dir = saveLocationPath;
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

      const card = createTaskCard(task, { name, stateKey, pct, showProgress, eta, canViewInMotrix, canViewInGopeed });
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
  const mediaKey = buildMediaRenderKey(media);
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
  syncPopupGlobals();

  if (mediaKey === lastRenderedMediaKey) return;
  lastRenderedMediaKey = mediaKey;
  syncPopupGlobals();

  closeMediaHoverPreview();
  listEl.replaceChildren();
  media.forEach((item) => {
    const iconSrc = getFileIcon({ name: item.filename, mime: item.mime, kind: item.kind });
    const durationText = mediaDurationLabel(item.duration);
    const resolutionText = item.kind === 'video' || item.kind === 'media' ? mediaResolutionLabel(item) : '';
    const displayFilename = getMediaFilenameValue(item);
    const card = createMediaCard(item, { iconSrc, durationText, resolutionText, displayFilename });
    listEl.appendChild(card);
    const iconWrap = card.querySelector('.media-icon');
    if (iconWrap) iconWrap.addEventListener('mouseenter', () => scheduleMediaHoverPreview(item, card));
    if (iconWrap) iconWrap.addEventListener('mouseleave', scheduleCloseMediaHoverPreview);
    card.addEventListener('mouseleave', scheduleCloseMediaHoverPreview);
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
  if (state.config) {
    const nextConfig = normalizePopupConfig(state.config);
    if (JSON.stringify(nextConfig) !== JSON.stringify(savedConfig)) {
      applyLocaleFromConfig(nextConfig);
      loadSettings(nextConfig);
    }
  }
  hiddenTaskGids = new Set(state.hiddenTaskGids || []);
  currentState = {
    tasks: state.tasks || {},
    pending: state.pending || {},
    media: state.media || {},
    pausedTabs: state.pausedTabs || [],
    mediaBlacklistBlockedTabs: state.mediaBlacklistBlockedTabs || [],
    uiAlert: state.uiAlert || null,
  };
  syncPopupGlobals();
  renderTasks(currentState.tasks, currentState.pending);
  renderMedia(currentState.media, currentState.pausedTabs, currentState.mediaBlacklistBlockedTabs);
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
    renderState({ ...res, config });
  });
}

const settingsController = popupSettings.createSettingsController({
  defaultCaptureExtensions: POPUP_DEFAULT_CAPTURE_EXTENSIONS,
  defaultMediaSniffingBlacklist: POPUP_DEFAULT_MEDIA_SNIFFING_BLACKLIST,
  defaultDownloadInterceptionBlacklist: POPUP_DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST,
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
  renderMedia(currentState.media, currentState.pausedTabs, currentState.mediaBlacklistBlockedTabs);
  syncPopupGlobals();
});

document.getElementById('cfgDownloaderType').addEventListener('change', (event) => {
  const nextType = event.target.value;
  const nextCfg = normalizePopupConfig({ ...currentConfig, ...collectSettingsFromForm(), downloaderType: nextType });
  updateHeaderStatusDisplay({ cfg: nextCfg, state: 'checking', stat: null, message: '' });
});

async function openShortcutSettings() {
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
