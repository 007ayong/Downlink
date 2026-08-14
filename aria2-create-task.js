(function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const embedded = new URLSearchParams(location.search).get('embedded') === '1';
  if (embedded) document.body.classList.add('embedded');
  // null means no initial choice yet; an empty string means the user selected aria2's own default directory.
  const state = { locations: [], selectedPath: null };

  function rpc(method, params = []) { return new Promise((resolve, reject) => chrome.runtime.sendMessage({ type: 'ARIA2_RPC', method, params }, (res) => { if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message)); if (!res?.ok) return reject(new Error(res?.error || 'RPC failed')); resolve(res.result); })); }
  function toast(message) { const el = $('toast'); el.textContent = message; el.style.opacity = '1'; clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.style.opacity = '0'; }, 2800); }
  function parseGroups(text) { return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => line.split(/\s+/).filter(Boolean)); }
  function normalizeLocations(locations) { return (Array.isArray(locations) ? locations : []).map((item) => ({ name: String(item?.name || '').trim(), path: String(item?.path || '').trim(), color: String(item?.color || '#ff9500') })).filter((item) => item.name && item.path); }

  function renderSaveLocations(config = {}) {
    const list = $('saveLocations');
    const menu = $('saveLocationsMenu');
    const trigger = $('saveLocationsTrigger');
    const triggerText = trigger.querySelector('.location-trigger-text');
    const triggerDot = trigger.querySelector('.location-dot');
    const enabled = !!config.aria2CustomSaveEnabled;
    state.locations = enabled ? normalizeLocations(config.aria2SaveLocations) : [];
    if (state.selectedPath !== '' && !state.locations.some((location) => location.path === state.selectedPath)) {
      state.selectedPath = state.locations[0]?.path || '';
    }
    menu.replaceChildren();
    const addOption = (location, label, isDefault = false) => {
      const option = document.createElement('button');
      option.type = 'button'; option.className = `location-option${location?.path === state.selectedPath ? ' active' : ''}`;
      option.setAttribute('role', 'option');
      const dot = document.createElement('span'); dot.className = 'location-dot'; dot.style.setProperty('--location-color', location?.color || '#8e8e93');
      const name = document.createElement('span'); name.className = 'location-option-name'; name.textContent = label;
      option.append(dot, name);
      if (isDefault) { const badge = document.createElement('span'); badge.className = 'location-option-default'; badge.textContent = '默认'; option.appendChild(badge); }
      option.addEventListener('click', () => {
        state.selectedPath = location?.path || '';
        if (!location) {
          triggerText.textContent = '使用 aria2 默认目录';
          triggerDot.style.setProperty('--location-color', '#8e8e93');
          $('saveLocationsPath').textContent = '使用 aria2 默认目录。';
        }
        closeLocationMenu();
        renderSaveLocations({ aria2CustomSaveEnabled: true, aria2SaveLocations: state.locations });
      });
      menu.appendChild(option);
    };
    addOption(null, '使用 aria2 默认目录');
    if (!state.locations.length) {
      triggerText.textContent = '使用 aria2 默认目录';
      triggerDot.style.setProperty('--location-color', '#8e8e93');
      $('saveLocationsHelp').textContent = '在全局设置中管理保存位置列表。';
      $('saveLocationsPath').textContent = '使用 aria2 默认目录。';
      return;
    }
    state.locations.forEach((location, index) => {
      addOption(location, location.name, index === 0);
    });
    const selected = state.selectedPath
      ? state.locations.find((location) => location.path === state.selectedPath)
      : null;
    triggerText.textContent = selected?.name || '使用 aria2 默认目录';
    triggerDot.style.setProperty('--location-color', selected?.color || '#8e8e93');
    $('saveLocationsHelp').textContent = '在全局设置中管理保存位置列表。';
    const pathDisplay = $('saveLocationsPath');
    pathDisplay.textContent = selected?.path || '使用 aria2 默认目录。';
  }

  function closeLocationMenu() {
    $('saveLocationsMenu').classList.remove('open');
    $('saveLocationsTrigger').classList.remove('open');
    $('saveLocationsTrigger').setAttribute('aria-expanded', 'false');
  }

  function loadSaveLocations() { chrome.storage.sync.get({ aria2CustomSaveEnabled: false, aria2SaveLocations: [] }, renderSaveLocations); }
  const uriInput = $('uris');
  function createUriLine(text) {
    const line = document.createElement('div');
    line.className = 'uri-line';
    const no = document.createElement('span');
    no.className = 'uri-no';
    no.contentEditable = 'false';
    no.setAttribute('aria-hidden', 'true');
    const textSpan = document.createElement('span');
    textSpan.className = 'uri-text';
    textSpan.contentEditable = 'true';
    textSpan.textContent = text;
    line.append(no, textSpan);
    return line;
  }
  function getUris() {
    return Array.from(uriInput.querySelectorAll('.uri-text')).map((el) => el.textContent).join('\n');
  }
  function setUris(value) {
    const text = String(value || '');
    uriInput.replaceChildren();
    if (text) text.split('\n').forEach((line) => uriInput.appendChild(createUriLine(line)));
    updateLineNumbers();
  }
  function updateLineNumbers() {
    const lines = uriInput.querySelectorAll('.uri-line');
    lines.forEach((line, index) => {
      const no = line.querySelector('.uri-no');
      const value = String(index + 1);
      if (no.textContent !== value) no.textContent = value;
    });
  }
  function placeCaret(span, offset) {
    const sel = window.getSelection();
    const range = document.createRange();
    const target = span.firstChild || span;
    range.setStart(target, Math.max(0, Math.min(offset, (target.textContent || '').length)));
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }
  uriInput.addEventListener('click', (event) => {
    const textSpans = uriInput.querySelectorAll('.uri-text');
    if (!textSpans.length) {
      const newLine = createUriLine('');
      uriInput.appendChild(newLine);
      updateLineNumbers();
      placeCaret(newLine.querySelector('.uri-text'), 0);
      return;
    }
    if (!event.target.closest('.uri-text')) {
      placeCaret(textSpans[textSpans.length - 1], textSpans[textSpans.length - 1].textContent.length);
    }
  });
  uriInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== 'Backspace') return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const textEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const textSpan = textEl?.closest?.('.uri-text');
    if (event.key === 'Enter') {
      event.preventDefault();
      if (!textSpan) {
        const newLine = createUriLine('');
        uriInput.appendChild(newLine);
        updateLineNumbers();
        placeCaret(newLine.querySelector('.uri-text'), 0);
        return;
      }
      const line = textSpan.closest('.uri-line');
      const before = textSpan.textContent.slice(0, range.startOffset);
      const after = textSpan.textContent.slice(range.startOffset);
      textSpan.textContent = before;
      const newLine = createUriLine(after);
      line.after(newLine);
      updateLineNumbers();
      placeCaret(newLine.querySelector('.uri-text'), 0);
      return;
    }
    if (!textSpan || !range.collapsed || range.startOffset > 0) return;
    event.preventDefault();
    const line = textSpan.closest('.uri-line');
    const prev = line.previousElementSibling;
    if (!prev || !prev.classList.contains('uri-line')) {
      placeCaret(textSpan, 0);
      return;
    }
    const prevText = prev.querySelector('.uri-text');
    const prevLen = prevText.textContent.length;
    prevText.textContent += textSpan.textContent;
    line.remove();
    updateLineNumbers();
    placeCaret(prevText, prevLen);
  });
  uriInput.addEventListener('drop', (event) => event.preventDefault());
  uriInput.addEventListener('paste', (event) => {
    event.preventDefault();
    const text = (event.clipboardData || window.clipboardData).getData('text/plain');
    if (!text) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    const node = range.startContainer;
    const textEl = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const textSpan = textEl?.closest?.('.uri-text');
    if (!textSpan) {
      const fragment = document.createDocumentFragment();
      text.split('\n').forEach((part) => fragment.appendChild(createUriLine(part)));
      uriInput.appendChild(fragment);
      updateLineNumbers();
      return;
    }
    const parts = text.split('\n');
    if (parts.length === 1) {
      const offset = range.startOffset;
      textSpan.textContent = textSpan.textContent.slice(0, offset) + parts[0] + textSpan.textContent.slice(offset);
      placeCaret(textSpan, offset + parts[0].length);
      return;
    }
    const line = textSpan.closest('.uri-line');
    const before = textSpan.textContent.slice(0, range.startOffset);
    const after = textSpan.textContent.slice(range.startOffset);
    const firstLine = createUriLine(before + parts[0]);
    const middle = parts.slice(1, -1).map((part) => createUriLine(part));
    const lastLine = createUriLine(parts[parts.length - 1] + after);
    line.after(firstLine, ...middle, lastLine);
    line.remove();
    updateLineNumbers();
    placeCaret(lastLine.querySelector('.uri-text'), parts[parts.length - 1].length);
  });
  uriInput.addEventListener('input', updateLineNumbers);
  new MutationObserver(updateLineNumbers).observe(uriInput, { childList: true });
  $('back').onclick = () => {
    if (embedded && window.parent !== window) window.parent.postMessage({ type: 'ARIA2_SHOW_TASKS' }, location.origin);
    else location.href = chrome.runtime.getURL('aria2-tasks.html');
  };
  $('saveLocationsTrigger').addEventListener('click', () => {
    const menu = $('saveLocationsMenu'); const opening = !menu.classList.contains('open');
    if (opening) { menu.classList.add('open'); $('saveLocationsTrigger').classList.add('open'); $('saveLocationsTrigger').setAttribute('aria-expanded', 'true'); }
    else closeLocationMenu();
  });
  document.addEventListener('click', (event) => { if (!event.target.closest('#saveLocations')) closeLocationMenu(); });
  $('clear').onclick = () => { setUris(''); state.selectedPath = state.locations[0]?.path || ''; renderSaveLocations({ aria2CustomSaveEnabled: true, aria2SaveLocations: state.locations }); uriInput.focus(); };
  chrome.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && (changes.aria2CustomSaveEnabled || changes.aria2SaveLocations)) loadSaveLocations(); });
  $('form').addEventListener('submit', async (event) => {
    event.preventDefault(); const groups = parseGroups(getUris()); if (!groups.length) return toast('请至少输入一个下载链接');
    const connections = $('connections').value.trim(), options = {}; if (state.selectedPath) options.dir = state.selectedPath; if (connections) options['max-connection-per-server'] = connections;
    const submit = $('submit'); submit.disabled = true;
    try { const results = await Promise.allSettled(groups.map((uris) => rpc('addUri', [uris, options]))); const success = results.filter((result) => result.status === 'fulfilled').length; const failed = results.find((result) => result.status === 'rejected'); if (failed) toast(`${success} 个任务已加入；失败：${failed.reason?.message || failed.reason}`); else { toast(`已加入 ${success} 个下载任务`); if (embedded && window.parent !== window) { window.parent.postMessage({ type: 'ARIA2_SHOW_TASKS' }, location.origin); } else { setUris(''); state.selectedPath = state.locations[0]?.path || ''; renderSaveLocations({ aria2CustomSaveEnabled: true, aria2SaveLocations: state.locations }); setTimeout(() => { location.href = chrome.runtime.getURL('aria2-tasks.html'); }, 800); } } } finally { submit.disabled = false; }
  });
  loadSaveLocations(); setUris(''); uriInput.focus();
})();
