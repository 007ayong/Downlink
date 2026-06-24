const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElementStub(tagName = 'div') {
  const classes = new Set();
  const listeners = {};
  let innerHTML = '';
  const normalizedTagName = String(tagName || 'div').toLowerCase();
  const hasClass = (element, className) => String(element.className || '').split(/\s+/).includes(className)
    || element._classes?.has(className);
  const matchesSelector = (element, selector) => {
    if (!selector) return false;
    if (selector.startsWith('.')) return hasClass(element, selector.slice(1));
    if (selector.startsWith('[') && selector.endsWith(']')) {
      const attr = selector.slice(1, -1);
      if (attr.startsWith('data-')) {
        const key = attr.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
        return Object.prototype.hasOwnProperty.call(element.dataset || {}, key);
      }
      return false;
    }
    return String(element.tagName || '').toLowerCase() === selector.toLowerCase();
  };
  const findFirst = (element, parts) => {
    const [part, ...rest] = parts;
    for (const child of element.children || []) {
      if (matchesSelector(child, part)) {
        if (!rest.length) return child;
        const nested = findFirst(child, rest);
        if (nested) return nested;
      }
      const descendant = findFirst(child, parts);
      if (descendant) return descendant;
    }
    return null;
  };
  const findAll = (element, selector, results = []) => {
    for (const child of element.children || []) {
      if (matchesSelector(child, selector)) results.push(child);
      findAll(child, selector, results);
    }
    return results;
  };
  const element = {
    tagName: normalizedTagName,
    style: {
      setProperty(name, value) {
        this[name] = value;
      },
    },
    dataset: {},
    value: '',
    checked: false,
    textContent: '',
    disabled: false,
    className: '',
    src: '',
    alt: '',
    children: [],
    _queryMap: new Map(),
    classList: {
      add(...tokens) {
        tokens.forEach((token) => classes.add(token));
      },
      remove(...tokens) {
        tokens.forEach((token) => classes.delete(token));
      },
      toggle(token, force) {
        if (force === true) {
          classes.add(token);
          return true;
        }
        if (force === false) {
          classes.delete(token);
          return false;
        }
        if (classes.has(token)) {
          classes.delete(token);
          return false;
        }
        classes.add(token);
        return true;
      },
      contains(token) {
        return hasClass(element, token);
      },
    },
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = [];
      children.forEach((child) => this.appendChild(child));
    },
    remove() {},
    focus() {},
    select() {},
    setAttribute(name, value) {
      if (name === 'class') this.className = String(value);
      else if (name === 'aria-label') this.ariaLabel = String(value);
      else if (name.startsWith('data-')) {
        const key = name.slice(5).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
        this.dataset[key] = String(value);
      } else {
        this[name] = String(value);
      }
    },
    click() {
      (listeners.click || []).forEach((handler) => handler({ currentTarget: this, target: this }));
    },
    querySelector(selector) {
      return this._queryMap.get(selector) || findFirst(this, String(selector).trim().split(/\s+/)) || createElementStub();
    },
    querySelectorAll(selector) {
      return findAll(this, selector);
    },
    closest(selector) {
      let current = this;
      while (current) {
        if (matchesSelector(current, selector)) return current;
        current = current.parentElement;
      }
      return null;
    },
    _classes: classes,
    _listeners: listeners,
  };
  Object.defineProperty(element, 'innerHTML', {
    get() {
      return innerHTML;
    },
    set(value) {
      innerHTML = value;
      this._queryMap.clear();
      if (!String(value).includes('pending-fname')) return;

      const input = createElementStub();
      const valueMatch = String(value).match(/class="pending-fname"[^>]*value="([^"]*)"/);
      input.value = valueMatch ? valueMatch[1] : '';
      this._queryMap.set('.pending-fname', input);
      if (String(value).includes('aria2-single-thread')) {
        this._queryMap.set('.aria2-single-thread', createElementStub());
      }
      this._queryMap.set('.confirm-btn', createElementStub());
      this._queryMap.set('.reject-btn', createElementStub());
    },
  });
  return element;
}

function loadPopupRuntime(options = {}) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createElementStub());
    return elements.get(id);
  };

  const document = {
    body: createElementStub(),
    getElementById(id) {
      return getElement(id);
    },
    querySelector() {
      return createElementStub();
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      return createElementStub(tagName);
    },
    createElementNS(_namespace, tagName) {
      return createElementStub(tagName);
    },
    createDocumentFragment() {
      return createElementStub('fragment');
    },
    execCommand() {
      return true;
    },
  };

  const chrome = {
    _listeners: {},
    _sentMessages: [],
    _createdTabs: [],
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        chrome._sentMessages.push(message);
        if (message?.type === 'GET_STATE') {
          callback?.({
            tasks: options.state?.tasks || {},
            pending: options.state?.pending || {},
            media: options.state?.media || {},
            pausedTabs: options.state?.pausedTabs || [],
            mediaBlacklistBlockedTabs: options.state?.mediaBlacklistBlockedTabs || [],
            config: options.state?.config || {},
            hiddenTaskGids: options.state?.hiddenTaskGids || [],
            uiAlert: options.state?.uiAlert || null,
          });
          return;
        }
        if (message?.type === 'TEST_CONNECTION') {
          callback?.(options.testConnectionResult || { ok: false, error: 'stubbed' });
          return;
        }
        if (options.messageResponses && Object.prototype.hasOwnProperty.call(options.messageResponses, message?.type)) {
          const response = options.messageResponses[message.type];
          callback?.(typeof response === 'function' ? response(message) : response);
          return;
        }
        callback?.({ ok: true });
      },
      getURL(value) {
        return value;
      },
      getManifest() {
        return { version: options.manifestVersion || '1.3.3' };
      },
      getBrowserInfo: options.browserInfo ? (() => Promise.resolve(options.browserInfo)) : undefined,
      onMessage: {
        addListener(callback) {
          chrome._listeners.runtimeOnMessage = callback;
        },
      },
    },
    permissions: options.permissions,
    tabs: {
      query(_query, callback) {
        callback?.([{ id: 1 }]);
      },
      create(_opts, callback) {
        chrome._createdTabs.push(_opts);
        callback?.({ id: 2 });
      },
    },
  };

  const context = {
    console,
    Buffer,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    document,
    chrome,
    navigator: {
      clipboard: {
        writeText: async () => {},
      },
    },
    location: {
      search: '',
    },
    browser: options.browser,
    globalThis: null,
    self: null,
    window: null,
    FilenameLogic: require('../filename-logic.js'),
  };

  context.globalThis = context;
  context.self = context;
  context.window = context;

  const popupUiScript = fs.readFileSync(path.join(__dirname, '..', 'lib', 'popup-ui.js'), 'utf8');
  vm.runInNewContext(popupUiScript, context, { filename: 'lib/popup-ui.js' });
  const script = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  vm.runInNewContext(script, context, { filename: 'popup.js' });
  const popupSettingsScript = fs.readFileSync(path.join(__dirname, '..', 'lib', 'popup-settings.js'), 'utf8');
  vm.runInNewContext(popupSettingsScript, context, { filename: 'lib/popup-settings.js' });
  const popupAppScript = fs.readFileSync(path.join(__dirname, '..', 'popup-app.js'), 'utf8');
  vm.runInNewContext(popupAppScript, context, { filename: 'popup-app.js' });
  return context;
}

function loadPopupSettingsRuntime() {
  const listenersById = new Map();
  const elements = new Map();
  const sentMessages = [];
  const getElement = (id) => {
    if (!elements.has(id)) {
      const listeners = {};
      listenersById.set(id, listeners);
      const element = createElementStub();
      const originalAddEventListener = element.addEventListener;
      element.addEventListener = function addEventListener(type, handler) {
        listeners[type] = listeners[type] || [];
        listeners[type].push(handler);
        originalAddEventListener.call(this, type, handler);
      };
      elements.set(id, element);
    }
    return elements.get(id);
  };

  const context = {
    console,
    setTimeout,
    clearTimeout,
    document: {
      getElementById(id) {
        return getElement(id);
      },
      createElement(tagName) {
        return createElementStub(tagName);
      },
    },
    chrome: {
      runtime: {
        sendMessage(message, callback) {
          sentMessages.push(message);
          callback?.({ ok: true });
        },
      },
    },
    globalThis: null,
    self: null,
    window: null,
  };

  context.globalThis = context;
  context.self = context;
  context.window = context;

  const script = fs.readFileSync(path.join(__dirname, '..', 'lib', 'popup-settings.js'), 'utf8');
  vm.runInNewContext(script, context, { filename: 'lib/popup-settings.js' });
  return { context, listenersById, sentMessages };
}

test('auto-switches when new media is found and there are no pending confirmations', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.shouldAutoSwitchToMediaPanel({
      mediaCount: 1,
      previousMediaCount: 0,
      pendingCount: 0,
      currentTab: 'tasks',
      lastAutoSwitchedMediaCount: 0,
    }),
    true
  );
});

test('still auto-switches even when historical tasks exist elsewhere in popup state', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.shouldAutoSwitchToMediaPanel({
      mediaCount: 3,
      previousMediaCount: 2,
      pendingCount: 0,
      currentTab: 'tasks',
      lastAutoSwitchedMediaCount: 2,
    }),
    true
  );
});

test('does not auto-switch when user is already on the media tab', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.shouldAutoSwitchToMediaPanel({
      mediaCount: 2,
      previousMediaCount: 1,
      pendingCount: 0,
      currentTab: 'media',
      lastAutoSwitchedMediaCount: 1,
    }),
    false
  );
});

test('does not auto-switch when there are pending confirmation cards', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.shouldAutoSwitchToMediaPanel({
      mediaCount: 2,
      previousMediaCount: 1,
      pendingCount: 1,
      currentTab: 'tasks',
      lastAutoSwitchedMediaCount: 1,
    }),
    false
  );
});

test('blacklisted current website greys media tab and disables media controls', async () => {
  const popup = loadPopupRuntime({
    state: {
      config: { mediaSniffingBlacklist: 'youtube.com' },
      mediaBlacklistBlockedTabs: [1],
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  const mediaTab = popup.document.getElementById('mediaTab');
  const toggleSniffingBtn = popup.document.getElementById('toggleSniffingBtn');
  const clearMediaBtn = popup.document.getElementById('clearMediaBtn');
  const addSiteToMediaBlacklistBtn = popup.document.getElementById('addSiteToMediaBlacklistBtn');
  const mediaSummary = popup.document.getElementById('mediaSummary');
  const mediaEmptyImage = popup.document.getElementById('mediaEmptyImage');

  assert.equal(mediaTab.classList.contains('disabled'), true);
  assert.equal(toggleSniffingBtn.disabled, true);
  assert.equal(toggleSniffingBtn.classList.contains('btn-primary'), true);
  assert.equal(toggleSniffingBtn.classList.contains('btn-ghost'), false);
  assert.equal(
    toggleSniffingBtn.children[0].children[0].d,
    'M5.4 3.5c0-.7.76-1.13 1.36-.76l5.6 3.5c.56.35.56 1.17 0 1.52l-5.6 3.5c-.6.37-1.36-.06-1.36-.76v-7Z'
  );
  assert.equal(clearMediaBtn.disabled, true);
  assert.equal(addSiteToMediaBlacklistBtn.disabled, false);
  assert.equal(addSiteToMediaBlacklistBtn.textContent, '从黑名单中删除');
  assert.equal(mediaSummary.textContent, '当前网站已在媒体嗅探黑名单中');
  assert.equal(mediaEmptyImage.src, 'assets/empty-media-sniffing-disabled.png');
});

test('media tab can add the current site to the sniffing blacklist', async () => {
  const popup = loadPopupRuntime({
    messageResponses: {
      ADD_SITE_TO_MEDIA_BLACKLIST: { ok: true, hostname: 'example.com' },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  popup.document.getElementById('addSiteToMediaBlacklistBtn').click();

  const message = popup.chrome._sentMessages.findLast((item) => item?.type === 'ADD_SITE_TO_MEDIA_BLACKLIST');
  assert.deepEqual(JSON.parse(JSON.stringify(message)), {
    type: 'ADD_SITE_TO_MEDIA_BLACKLIST',
    tabId: 1,
  });
});

test('media tab can remove the current site from the sniffing blacklist', async () => {
  const popup = loadPopupRuntime({
    state: {
      mediaBlacklistBlockedTabs: [1],
      config: { mediaSniffingBlacklist: 'example.com' },
    },
    messageResponses: {
      REMOVE_SITE_FROM_MEDIA_BLACKLIST: { ok: true, hostname: 'example.com' },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  popup.document.getElementById('addSiteToMediaBlacklistBtn').click();

  const message = popup.chrome._sentMessages.findLast((item) => item?.type === 'REMOVE_SITE_FROM_MEDIA_BLACKLIST');
  assert.deepEqual(JSON.parse(JSON.stringify(message)), {
    type: 'REMOVE_SITE_FROM_MEDIA_BLACKLIST',
    tabId: 1,
  });
});

test('header shows extension version for debug information', () => {
  const popup = loadPopupRuntime({ manifestVersion: '9.8.7' });

  assert.equal(popup.document.getElementById('extensionVersionValue').textContent, '9.8.7');
});

test('pending confirmation filename edit survives state re-render', () => {
  const popup = loadPopupRuntime();
  const pending = {
    task1: {
      key: 'task1',
      url: 'https://example.com/file.zip',
      filename: 'file.zip',
    },
  };
  const pendingList = popup.document.getElementById('pendingList');

  popup.renderTasks({}, pending);
  assert.equal(pendingList.children.length, 1);

  const card = pendingList.children[0];
  const input = card.querySelector('.pending-fname');
  assert.equal(input.value, 'file.zip');

  input.value = 'renamed.zip';
  input._listeners.input[0]({ currentTarget: input });
  popup.renderTasks({}, pending);

  assert.equal(pendingList.children.length, 1);
  assert.strictEqual(pendingList.children[0], card);
  assert.equal(card.querySelector('.pending-fname').value, 'renamed.zip');
});

test('aria2 pending confirmation can force single threaded download options', () => {
  const popup = loadPopupRuntime();
  Object.assign(popup.currentConfig, { downloaderType: 'aria2' });
  const pending = {
    task1: {
      key: 'task1',
      url: 'https://example.com/file.zip',
      filename: 'file.zip',
      addedAt: 1,
    },
  };

  popup.renderTasks({}, pending);
  const card = popup.document.getElementById('pendingList').children[0];
  card.querySelector('.aria2-single-thread').checked = true;
  card.querySelector('.confirm-btn').click();

  const message = popup.chrome._sentMessages.at(-1);
  assert.equal(message.type, 'CONFIRM_DOWNLOAD');
  assert.equal(message.key, 'task1');
  assert.deepEqual(JSON.parse(JSON.stringify(message.opts)), {
    split: '1',
    'max-connection-per-server': '1',
    'min-split-size': '1024M',
  });
});

test('aria2 pending confirmation sends selected custom save location', () => {
  const popup = loadPopupRuntime();
  Object.assign(popup.currentConfig, {
    downloaderType: 'aria2',
    aria2CustomSaveEnabled: true,
    aria2SaveLocations: [
      { name: '默认', path: '/downloads/default', color: '#ff9500' },
      { name: '视频', path: '/downloads/video', color: '#007aff' },
    ],
  });
  const pending = {
    task1: {
      key: 'task1',
      url: 'https://example.com/file.zip',
      filename: 'file.zip',
      addedAt: 1,
    },
  };

  popup.renderTasks({}, pending);
  const card = popup.document.getElementById('pendingList').children[0];
  const menu = card.querySelector('.pending-save-location-menu');
  assert.equal(menu.dataset.value, '/downloads/default');

  const items = card.querySelectorAll('.pending-save-location-item');
  assert.equal(items.length, 2);
  menu._listeners.click[0]({ target: items[1] });
  assert.equal(menu.dataset.value, '/downloads/video');
  card.querySelector('.confirm-btn').click();

  const message = popup.chrome._sentMessages.at(-1);
  assert.equal(message.type, 'CONFIRM_DOWNLOAD');
  assert.deepEqual(JSON.parse(JSON.stringify(message.opts)), {
    dir: '/downloads/video',
  });
});

test('does not auto-switch again for the same media count', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.shouldAutoSwitchToMediaPanel({
      mediaCount: 2,
      previousMediaCount: 1,
      pendingCount: 0,
      currentTab: 'tasks',
      lastAutoSwitchedMediaCount: 2,
    }),
    false
  );
});

test('popup auto capture switch follows background config updates', () => {
  const popup = loadPopupRuntime();
  const autoCapture = popup.document.getElementById('cfgAutoCapture');
  autoCapture.checked = true;

  popup.chrome._listeners.runtimeOnMessage({
    type: 'TASKS_UPDATE',
    tasks: {},
    pending: {},
    media: {},
    pausedTabs: [],
    hiddenTaskGids: [],
    config: { autoCapture: false },
  });

  assert.equal(autoCapture.checked, false);
});

test('customize shortcut button opens Chromium shortcut settings by default', async () => {
  const popup = loadPopupRuntime();
  popup.document.getElementById('customizeShortcutBtn').click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(popup.chrome._createdTabs.at(-1)?.url, 'chrome://extensions/shortcuts');
});

test('customize shortcut button uses Firefox shortcut settings API when available', async () => {
  let opened = false;
  const popup = loadPopupRuntime({
    browserInfo: { name: 'Firefox' },
    browser: {
      commands: {
        openShortcutSettings: async () => {
          opened = true;
        },
      },
    },
  });
  popup.document.getElementById('customizeShortcutBtn').click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(opened, true);
  assert.equal(popup.chrome._createdTabs.length, 0);
});

test('customize shortcut button falls back to Firefox add-ons manager when API is unavailable', async () => {
  const popup = loadPopupRuntime({ browserInfo: { name: 'Firefox' } });
  popup.document.getElementById('customizeShortcutBtn').click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(popup.chrome._createdTabs.at(-1)?.url, 'about:addons');
});

test('popup display filename decoder handles Chinese encoded words', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.decodeDisplayFilename('=?UTF-8?B?5Lit5paH5rWL6K+VLm1wNA==?='),
    '中文测试.mp4'
  );
});

test('video resolution label shows Chinese placeholder before metadata arrives', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.mediaResolutionLabel({ kind: 'video', width: 0, height: 0 }),
    '分辨率待识别'
  );
});

test('media metadata can refine audio-only mp4 resources', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.inferMediaKindFromMetadata({ kind: 'video', mime: 'video/mp4' }, { loaded: true, width: 0, height: 0 }),
    'audio'
  );
  assert.equal(
    popup.inferMediaKindFromMetadata({ kind: 'media', mime: 'application/octet-stream' }, { loaded: true, width: 0, height: 0 }),
    'audio'
  );
  assert.equal(
    popup.inferMediaKindFromMetadata({ kind: 'video', mime: 'video/mp4' }, { loaded: true, width: 1920, height: 1080 }),
    'video'
  );
  assert.equal(
    popup.inferMediaKindFromMetadata({ kind: 'media', mime: 'application/octet-stream' }, { loaded: true, width: 1920, height: 1080 }),
    'video'
  );
});

test('ambiguous media kind is not mislabeled as video before metadata arrives', () => {
  const popup = loadPopupRuntime();
  assert.equal(popup.mediaKindLabel('media'), '待识别');
});

test('media duration label formats finite positive durations', () => {
  const popup = loadPopupRuntime();
  assert.equal(popup.mediaDurationLabel(65.4), '1:05');
  assert.equal(popup.mediaDurationLabel(3661), '1:01:01');
  assert.equal(popup.mediaDurationLabel(0), '');
  assert.equal(popup.mediaDurationLabel(Infinity), '');
});

test('sniffing resume button shows capture-off message when resume is blocked', async () => {
  const popup = loadPopupRuntime({
    state: {
      pausedTabs: [1],
    },
    messageResponses: {
      RESUME_MEDIA_SNIFFING: { ok: false, disabled: true },
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  popup.document.getElementById('toggleSniffingBtn').click();

  const message = popup.chrome._sentMessages.at(-1);
  assert.deepEqual(JSON.parse(JSON.stringify(message)), {
    type: 'RESUME_MEDIA_SNIFFING',
    tabId: 1,
  });
  assert.equal(popup.document.getElementById('toast').textContent, '请先开启拦截');
});

test('media render key changes when filename changes', () => {
  const popup = loadPopupRuntime();
  const before = popup.buildMediaRenderKey([{ id: '1', resourceUrl: 'u', filename: 'a.mp4', size: 1, kind: 'video', mime: 'video/mp4', width: 0, height: 0 }]);
  const after = popup.buildMediaRenderKey([{ id: '1', resourceUrl: 'u', filename: '中文.mp4', size: 1, kind: 'video', mime: 'video/mp4', width: 0, height: 0 }]);
  assert.notEqual(before, after);
});

test('media render key changes when duration changes', () => {
  const popup = loadPopupRuntime();
  const before = popup.buildMediaRenderKey([{ id: '1', resourceUrl: 'u', filename: 'a.mp4', size: 1, kind: 'audio', mime: 'audio/mp4', width: 0, height: 0, duration: 0 }]);
  const after = popup.buildMediaRenderKey([{ id: '1', resourceUrl: 'u', filename: 'a.mp4', size: 1, kind: 'audio', mime: 'audio/mp4', width: 0, height: 0, duration: 65 }]);
  assert.notEqual(before, after);
});

test('task icon category prefers media kind and mime', () => {
  const popup = loadPopupRuntime();
  assert.equal(popup.getFileCategory({ name: 'unknown.bin', kind: 'audio', mime: '' }), 'audio');
  assert.equal(popup.getFileCategory({ name: 'audio-only.mp4', kind: 'audio', mime: 'video/mp4' }), 'audio');
  assert.equal(popup.getFileCategory({ name: 'unknown.bin', kind: '', mime: 'image/webp' }), 'image');
  assert.equal(popup.getFileCategory({ name: 'installer', kind: '', mime: 'application/x-msdownload' }), 'executable');
});

test('task icon category falls back to file extension', () => {
  const popup = loadPopupRuntime();
  assert.equal(popup.getFileCategory({ name: 'report.xlsx', mime: '' }), 'spreadsheet');
  assert.equal(popup.getFileCategory({ name: 'package.zip', mime: '' }), 'archive');
  assert.equal(popup.getFileCategory({ name: 'plain.unknown', mime: '' }), 'default');
});

test('task icon path resolves to packaged svg asset', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.getFileIcon({ name: 'movie.mp4', mime: 'video/mp4', kind: '' }),
    'assets/file-icons/media-list-video.png'
  );
});

test('task icon error handler falls back to default icon once', () => {
  const popup = loadPopupRuntime();
  const img = {
    src: 'assets/file-icons/missing.svg',
    dataset: {},
  };
  popup.handleTaskIconError({ currentTarget: img });
  assert.equal(img.src, 'assets/file-icons/default.svg');
  assert.equal(img.dataset.fallbackApplied, 'true');

  img.src = 'assets/file-icons/still-missing.svg';
  popup.handleTaskIconError({ currentTarget: img });
  assert.equal(img.src, 'assets/file-icons/still-missing.svg');
});

test('motrix button only shows for aria2 mode with motrix flag enabled', () => {
  const canViewInMotrix = (cfg) => cfg.downloaderType === 'aria2' && !!cfg.useMotrixNext;
  assert.equal(canViewInMotrix({ downloaderType: 'aria2', useMotrixNext: true }), true);
  assert.equal(canViewInMotrix({ downloaderType: 'abdownload', useMotrixNext: true }), false);
  assert.equal(canViewInMotrix({ downloaderType: 'motrixnext', useMotrixNext: true }), false);
  assert.equal(canViewInMotrix({ downloaderType: 'neatdm', useMotrixNext: true }), false);
});

test('AB DM display name is fixed', () => {
  const popup = loadPopupRuntime();
  assert.equal(popup.getDownloaderName({ downloaderType: 'abdownload', externalLauncherName: 'Custom Name' }), 'AB DM');
  assert.equal(popup.getSendLabel({ downloaderType: 'abdownload', externalLauncherName: 'Custom Name' }), '发送到 AB DM');
});

test('MotrixNext header logo uses packaged provider icon', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.getHeaderLogoSrc({ downloaderType: 'motrixnext' }),
    'assets/provider-icons/motrixnext.png'
  );
});

test('Gopeed header logo uses packaged provider icon', () => {
  const popup = loadPopupRuntime();
  assert.equal(
    popup.getHeaderLogoSrc({ downloaderType: 'gopeed' }),
    'assets/provider-icons/gopeed.png'
  );
});

test('aria2 test connection sends the current form config', () => {
  const popup = loadPopupRuntime();

  popup.document.getElementById('cfgDownloaderType').value = 'aria2';
  popup.document.getElementById('cfgRpc').value = 'http://127.0.0.1:6800/jsonrpc';
  popup.document.getElementById('cfgSecret').value = 'bad-secret';

  popup.document.getElementById('testConnBtn').click();

  const testMessage = popup.chrome._sentMessages.findLast((message) => message?.type === 'TEST_CONNECTION');
  assert.deepEqual(JSON.parse(JSON.stringify(testMessage?.config)), {
    downloaderType: 'aria2',
    language: 'auto',
    aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
    aria2Secret: 'bad-secret',
    aria2Silent: false,
    aria2CustomSaveEnabled: false,
    aria2SaveLocations: [],
    useMotrixNext: false,
    motrixBridgeAutoClose: false,
    motrixNextPort: '16801',
    motrixNextSecret: '',
    gopeedApi: 'http://127.0.0.1:9999',
    gopeedToken: '',
    externalLauncherName: 'AB DM',
    externalLauncherHost: 'localhost',
    externalLauncherPort: '15151',
    abDownloadSilent: false,
    autoCapture: false,
    mediaSniffingBlacklist: '',
    captureExtensions: '',
    skipSmallDownloads: false,
    smallDownloadThresholdBytes: 1048576,
  });
});

test('AB DM test connection sends the current form config', () => {
  const popup = loadPopupRuntime();

  popup.document.getElementById('cfgDownloaderType').value = 'abdownload';
  popup.document.getElementById('cfgLauncherPort').value = '17000';
  popup.document.getElementById('cfgAbDownloadSilent').checked = true;

  popup.document.getElementById('testLauncherBtn').click();

  const testMessage = popup.chrome._sentMessages.findLast((message) => message?.type === 'TEST_CONNECTION');
  assert.deepEqual(JSON.parse(JSON.stringify(testMessage?.config)), {
    downloaderType: 'abdownload',
    language: 'auto',
    aria2Rpc: 'http://localhost:6800/jsonrpc',
    aria2Secret: '',
    aria2Silent: false,
    aria2CustomSaveEnabled: false,
    aria2SaveLocations: [],
    useMotrixNext: false,
    motrixBridgeAutoClose: false,
    motrixNextPort: '16801',
    motrixNextSecret: '',
    gopeedApi: 'http://127.0.0.1:9999',
    gopeedToken: '',
    externalLauncherName: 'AB DM',
    externalLauncherHost: 'localhost',
    externalLauncherPort: '17000',
    abDownloadSilent: true,
    autoCapture: false,
    mediaSniffingBlacklist: '',
    captureExtensions: '',
    skipSmallDownloads: false,
    smallDownloadThresholdBytes: 1048576,
  });
});

test('test connection skips runtime permission prompts before messaging background', () => {
  const permissionCalls = [];
  const popup = loadPopupRuntime({
    permissions: {
      contains(payload, callback) {
        permissionCalls.push({ method: 'contains', payload });
        callback(false);
      },
      request(payload, callback) {
        permissionCalls.push({ method: 'request', payload });
        callback(true);
      },
    },
  });

  popup.document.getElementById('cfgDownloaderType').value = 'aria2';
  popup.document.getElementById('cfgRpc').value = 'http://127.0.0.1:6800/jsonrpc';

  popup.document.getElementById('testConnBtn').click();

  assert.deepEqual(permissionCalls, []);
  const testMessage = popup.chrome._sentMessages.findLast((message) => message?.type === 'TEST_CONNECTION');
  assert.equal(testMessage?.config.aria2Rpc, 'http://127.0.0.1:6800/jsonrpc');
});

test('connection failure alert renders in both tasks and media panels', async () => {
  const popup = loadPopupRuntime({
    state: {
      tasks: {},
      pending: {},
      media: {},
      config: {},
      hiddenTaskGids: [],
      uiAlert: null,
    },
  });

  const listener = popup.chrome._listeners.runtimeOnMessage;
  assert.equal(typeof listener, 'function');

  listener({
    type: 'TASKS_UPDATE',
    tasks: {},
    pending: {},
    media: {},
    hiddenTaskGids: [],
    uiAlert: {
      type: 'connection-failure',
      message: '连接失败，检查下载器是否在运行',
    },
  });

  const alertEl = popup.document.getElementById('taskAlert');
  assert.equal(alertEl.textContent, '连接失败，检查下载器是否在运行');
  assert.equal(alertEl.classList.contains('show'), true);

  const mediaAlertEl = popup.document.getElementById('mediaAlert');
  assert.equal(mediaAlertEl.textContent, '连接失败，检查下载器是否在运行');
  assert.equal(mediaAlertEl.classList.contains('show'), true);
});

test('motrix auto-close setting is disabled when not enabled yet', () => {
  const popup = loadPopupRuntime();
  const motrixRow = createElementStub();
  const motrixToggle = createElementStub();
  motrixRow.querySelector = (selector) => (selector === '#cfgMotrixBridgeAutoClose' ? motrixToggle : null);

  const ariaRows = [motrixRow];
  popup.document.querySelectorAll = (selector) => {
    if (selector === '.aria2-only') return ariaRows;
    if (selector === '.launcher-only' || selector === '.neatdm-only') return [];
    if (selector === '.motrix-autoclose-only') return [motrixRow];
    return [];
  };

  Object.assign(popup.currentConfig, { downloaderType: 'aria2', motrixBridgeAutoClose: false });
  popup.updateSettingsVisibility('aria2');

  assert.equal(motrixToggle.disabled, true);
  assert.equal(motrixRow.classList.contains('settings-disabled'), true);
});

test('motrix auto-close setting becomes enabled after bridge option is enabled', () => {
  const popup = loadPopupRuntime();
  const motrixRow = createElementStub();
  const motrixToggle = createElementStub();
  motrixRow.querySelector = (selector) => (selector === '#cfgMotrixBridgeAutoClose' ? motrixToggle : null);

  const ariaRows = [motrixRow];
  popup.document.querySelectorAll = (selector) => {
    if (selector === '.aria2-only') return ariaRows;
    if (selector === '.launcher-only' || selector === '.neatdm-only') return [];
    if (selector === '.motrix-autoclose-only') return [motrixRow];
    return [];
  };

  Object.assign(popup.currentConfig, { downloaderType: 'aria2', motrixBridgeAutoClose: true });
  popup.updateSettingsVisibility('aria2');

  assert.equal(motrixToggle.disabled, false);
  assert.equal(motrixRow.classList.contains('settings-disabled'), false);
});

test('aria2 custom save controls are disabled while silent downloads are enabled', () => {
  const popup = loadPopupRuntime();
  const customSaveRow = createElementStub();
  const customSaveToggle = createElementStub();
  const saveLocationsRow = createElementStub();
  customSaveToggle.checked = true;
  customSaveRow.querySelector = (selector) => (selector === '#cfgAria2CustomSaveEnabled' ? customSaveToggle : null);

  popup.document.querySelectorAll = (selector) => {
    if (selector === '.aria2-only') return [customSaveRow, saveLocationsRow];
    if (selector === '.aria2-custom-save-control') return [customSaveRow];
    if (selector === '.aria2-save-locations-config') return [saveLocationsRow];
    if (selector === '.launcher-only' || selector === '.neatdm-only' || selector === '.motrixnext-only' || selector === '.gopeed-only' || selector === '.motrix-autoclose-only') return [];
    return [];
  };

  Object.assign(popup.currentConfig, {
    downloaderType: 'aria2',
    aria2Silent: true,
    aria2CustomSaveEnabled: true,
  });
  popup.updateSettingsVisibility('aria2');

  assert.equal(customSaveToggle.disabled, true);
  assert.equal(customSaveToggle.checked, false);
  assert.equal(customSaveRow.classList.contains('settings-disabled'), true);
  assert.equal(saveLocationsRow.classList.contains('settings-hidden'), true);
});

test('cfgUseMotrixNext only binds one change listener for autosave', () => {
  const { context, listenersById } = loadPopupSettingsRuntime();
  let scheduleCalls = 0;
  const controller = context.PopupSettings.createSettingsController({
    getCurrentConfig: () => ({}),
    setCurrentConfig() {},
    getCurrentState: () => ({ tasks: {}, pending: {} }),
    getLoading: () => false,
    setLoading() {},
    getAutoSaveTimer: () => null,
    setAutoSaveTimer() {},
    getSaveFeedbackTimer: () => null,
    setSaveFeedbackTimer() {},
    syncGlobals() {},
    updateSettingsVisibility() {},
    updateDynamicLabels() {},
    updateHeaderStatusDisplay() {},
    renderTasks() {},
    checkStatus() {},
  });

  controller.scheduleAutoSave = () => {
    scheduleCalls += 1;
  };
  controller.bindSettingsEvents();

  const changeListeners = listenersById.get('cfgUseMotrixNext')?.change || [];
  assert.equal(changeListeners.length, 1);
});

test('settings controller collects every visible config field from the form', () => {
  const { context } = loadPopupSettingsRuntime();
  const controller = context.PopupSettings.createSettingsController({
    getCurrentConfig: () => ({}),
    setCurrentConfig() {},
    getCurrentState: () => ({ tasks: {}, pending: {} }),
    getLoading: () => false,
    setLoading() {},
    getAutoSaveTimer: () => null,
    setAutoSaveTimer() {},
    getSaveFeedbackTimer: () => null,
    setSaveFeedbackTimer() {},
    syncGlobals() {},
    updateSettingsVisibility() {},
    updateDynamicLabels() {},
    renderTasks() {},
    requestAutoConnectionCheck() {},
  });

  context.document.getElementById('cfgDownloaderType').value = 'abdownload';
  context.document.getElementById('cfgRpc').value = 'http://127.0.0.1:6800/jsonrpc';
  context.document.getElementById('cfgSecret').value = 'secret';
  context.document.getElementById('cfgAria2Silent').checked = true;
  context.document.getElementById('cfgUseMotrixNext').checked = true;
  context.document.getElementById('cfgMotrixBridgeAutoClose').checked = true;
  context.document.getElementById('cfgMotrixNextPort').value = '16888';
  context.document.getElementById('cfgMotrixNextSecret').value = 'motrix-secret';
  context.document.getElementById('cfgLauncherPort').value = '17000';
  context.document.getElementById('cfgAbDownloadSilent').checked = true;
  context.document.getElementById('cfgAutoCapture').checked = true;
  context.document.getElementById('cfgMediaSniffingBlacklist').value = 'x.com,youtube.com';
  context.document.getElementById('cfgExts').value = 'zip,mp4';
  context.document.getElementById('cfgSkipSmallDownloads').checked = true;
  context.document.getElementById('cfgSmallDownloadThresholdMb').value = '2.5';

  assert.deepEqual(JSON.parse(JSON.stringify(controller.collectSettingsFromForm())), {
    downloaderType: 'abdownload',
    language: 'auto',
    aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
    aria2Secret: 'secret',
    aria2Silent: true,
    aria2CustomSaveEnabled: false,
    aria2SaveLocations: [],
    useMotrixNext: true,
    motrixBridgeAutoClose: true,
    motrixNextPort: '16888',
    motrixNextSecret: 'motrix-secret',
    gopeedApi: 'http://127.0.0.1:9999',
    gopeedToken: '',
    externalLauncherName: 'AB DM',
    externalLauncherHost: 'localhost',
    externalLauncherPort: '17000',
    abDownloadSilent: true,
    autoCapture: true,
    mediaSniffingBlacklist: 'x.com,youtube.com',
    captureExtensions: 'zip,mp4',
    skipSmallDownloads: true,
    smallDownloadThresholdBytes: 2.5 * 1024 * 1024,
  });
});

test('settings controller collects custom aria2 save locations in display order', () => {
  const { context } = loadPopupSettingsRuntime();
  const controller = context.PopupSettings.createSettingsController({
    getCurrentConfig: () => ({}),
    setCurrentConfig() {},
    getCurrentState: () => ({ tasks: {}, pending: {} }),
    getLoading: () => false,
    setLoading() {},
    getAutoSaveTimer: () => null,
    setAutoSaveTimer() {},
    getSaveFeedbackTimer: () => null,
    setSaveFeedbackTimer() {},
    syncGlobals() {},
    updateSettingsVisibility() {},
    updateDynamicLabels() {},
    renderTasks() {},
    requestAutoConnectionCheck() {},
  });

  controller.bindSettingsEvents();
  context.document.getElementById('cfgAria2CustomSaveEnabled').checked = true;
  controller.renderSaveLocations([
    { name: '视频', path: '/downloads/video', color: '#007aff' },
    { name: '默认', path: '/downloads/default', color: '#ff9500' },
  ]);

  const config = controller.collectSettingsFromForm();
  assert.equal(config.aria2CustomSaveEnabled, true);
  assert.deepEqual(JSON.parse(JSON.stringify(config.aria2SaveLocations)), [
    { name: '视频', path: '/downloads/video', color: '#007aff' },
    { name: '默认', path: '/downloads/default', color: '#ff9500' },
  ]);
});

test('settings controller updates save location color from built-in palette swatches', () => {
  const { context, listenersById } = loadPopupSettingsRuntime();
  const controller = context.PopupSettings.createSettingsController({
    getCurrentConfig: () => ({}),
    setCurrentConfig() {},
    getCurrentState: () => ({ tasks: {}, pending: {} }),
    getLoading: () => false,
    setLoading() {},
    getAutoSaveTimer: () => null,
    setAutoSaveTimer() {},
    getSaveFeedbackTimer: () => null,
    setSaveFeedbackTimer() {},
    syncGlobals() {},
    updateSettingsVisibility() {},
    updateDynamicLabels() {},
    renderTasks() {},
    requestAutoConnectionCheck() {},
  });

  controller.bindSettingsEvents();
  context.document.getElementById('cfgAria2CustomSaveEnabled').checked = true;
  controller.renderSaveLocations([
    { name: '默认', path: '/downloads/default', color: '#ff9500' },
  ]);

  const list = context.document.getElementById('cfgAria2SaveLocations');
  const blueSwatch = list.querySelectorAll('.save-location-swatch')
    .find((swatch) => swatch.dataset.color === '#007aff');
  assert.ok(blueSwatch);

  for (const handler of listenersById.get('cfgAria2SaveLocations')?.click || []) {
    handler({ target: blueSwatch });
  }

  assert.equal(list.querySelector('.save-location-color').value, '#007aff');
  assert.deepEqual(JSON.parse(JSON.stringify(controller.collectSettingsFromForm().aria2SaveLocations)), [
    { name: '默认', path: '/downloads/default', color: '#007aff' },
  ]);
});

test('settings controller disables custom aria2 save locations when silent downloads are enabled', () => {
  const { context } = loadPopupSettingsRuntime();
  const controller = context.PopupSettings.createSettingsController({
    getCurrentConfig: () => ({}),
    setCurrentConfig() {},
    getCurrentState: () => ({ tasks: {}, pending: {} }),
    getLoading: () => false,
    setLoading() {},
    getAutoSaveTimer: () => null,
    setAutoSaveTimer() {},
    getSaveFeedbackTimer: () => null,
    setSaveFeedbackTimer() {},
    syncGlobals() {},
    updateSettingsVisibility() {},
    updateDynamicLabels() {},
    renderTasks() {},
    requestAutoConnectionCheck() {},
  });

  context.document.getElementById('cfgAria2Silent').checked = true;
  context.document.getElementById('cfgAria2CustomSaveEnabled').checked = true;
  controller.renderSaveLocations([
    { name: '默认', path: '/downloads/default', color: '#ff9500' },
  ]);

  const config = controller.collectSettingsFromForm();
  assert.equal(config.aria2Silent, true);
  assert.equal(config.aria2CustomSaveEnabled, false);
  assert.deepEqual(JSON.parse(JSON.stringify(config.aria2SaveLocations)), [
    { name: '默认', path: '/downloads/default', color: '#ff9500' },
  ]);
});

test('settings load defaults keep MotrixNext port and autosave secret fields', async () => {
  const { context, listenersById, sentMessages } = loadPopupSettingsRuntime();
  let currentConfig = {
    downloaderType: 'aria2',
    language: 'auto',
    aria2Rpc: 'http://localhost:6800/jsonrpc',
    motrixNextPort: '16801',
    motrixNextSecret: '',
    gopeedApi: 'http://127.0.0.1:9999',
    externalLauncherHost: 'legacy-host',
    externalLauncherPort: '15151',
    autoCapture: true,
    mediaSniffingBlacklist: 'x.com,youtube.com',
    smallDownloadThresholdBytes: 1048576,
  };
  const controller = context.PopupSettings.createSettingsController({
    getCurrentConfig: () => currentConfig,
    setCurrentConfig(next) {
      currentConfig = next;
    },
    getSavedConfig: () => currentConfig,
    setSavedConfig(next) {
      currentConfig = next;
    },
    getCurrentState: () => ({ tasks: {}, pending: {} }),
    getLoading: () => false,
    setLoading() {},
    getAutoSaveTimer: () => null,
    setAutoSaveTimer() {},
    getSaveFeedbackTimer: () => null,
    setSaveFeedbackTimer() {},
    syncGlobals() {},
    updateSettingsVisibility() {},
    updateDynamicLabels() {},
    renderTasks() {},
    requestAutoConnectionCheck() {},
  });

  controller.loadSettings({});
  assert.equal(context.document.getElementById('cfgMotrixNextPort').value, '16801');
  assert.equal(context.document.getElementById('cfgGopeedApi').value, 'http://127.0.0.1:9999');
  assert.equal(context.document.getElementById('cfgLauncherPort').value, '15151');
  assert.equal(context.document.getElementById('cfgMediaSniffingBlacklist').value, 'x.com,youtube.com');
  assert.equal(currentConfig.externalLauncherHost, 'localhost');

  controller.bindSettingsEvents();
  context.document.getElementById('cfgDownloaderType').value = 'motrixnext';
  context.document.getElementById('cfgMotrixNextPort').value = '16888';
  context.document.getElementById('cfgMotrixNextSecret').value = 'motrix-secret';
  for (const handler of listenersById.get('cfgMotrixNextSecret')?.change || []) {
    handler({ target: context.document.getElementById('cfgMotrixNextSecret') });
  }
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(sentMessages.at(-1).config.motrixNextPort, '16888');
  assert.equal(sentMessages.at(-1).config.motrixNextSecret, 'motrix-secret');
  assert.equal(sentMessages.at(-1).config.gopeedApi, 'http://127.0.0.1:9999');
  assert.equal(sentMessages.at(-1).config.externalLauncherPort, '15151');
});

test('all editable settings fields trigger autosave on change', async () => {
  const { context, listenersById, sentMessages } = loadPopupSettingsRuntime();
  const controller = context.PopupSettings.createSettingsController({
    getCurrentConfig: () => ({}),
    setCurrentConfig() {},
    getCurrentState: () => ({ tasks: {}, pending: {} }),
    getLoading: () => false,
    setLoading() {},
    getAutoSaveTimer: () => null,
    setAutoSaveTimer() {},
    getSaveFeedbackTimer: () => null,
    setSaveFeedbackTimer() {},
    syncGlobals() {},
    updateSettingsVisibility() {},
    updateDynamicLabels() {},
    renderTasks() {},
    requestAutoConnectionCheck() {},
  });

  controller.bindSettingsEvents();

  const applyChange = async (id, value, type = 'value') => {
    const el = context.document.getElementById(id);
    if (type === 'checked') el.checked = value;
    else el.value = value;
    for (const handler of listenersById.get(id)?.change || []) {
      handler({ target: el, currentTarget: el });
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    return sentMessages.at(-1);
  };

  assert.equal((await applyChange('cfgDownloaderType', 'neatdm')).type, 'SAVE_CONFIG');
  assert.equal((await applyChange('cfgRpc', 'http://127.0.0.1:6800/jsonrpc')).config.aria2Rpc, 'http://127.0.0.1:6800/jsonrpc');
  assert.equal((await applyChange('cfgSecret', 'new-secret')).config.aria2Secret, 'new-secret');
  assert.equal((await applyChange('cfgAria2Silent', true, 'checked')).config.aria2Silent, true);
  assert.equal((await applyChange('cfgAria2CustomSaveEnabled', true, 'checked')).config.aria2CustomSaveEnabled, false);
  assert.equal((await applyChange('cfgMotrixNextPort', '16888')).config.motrixNextPort, '16888');
  assert.equal((await applyChange('cfgMotrixNextSecret', 'motrix-secret')).config.motrixNextSecret, 'motrix-secret');
  assert.equal((await applyChange('cfgLauncherPort', '17000')).config.externalLauncherPort, '17000');
  assert.equal((await applyChange('cfgExts', 'zip,mp4')).config.captureExtensions, 'zip,mp4');
  assert.equal((await applyChange('cfgSmallDownloadThresholdMb', '2')).config.smallDownloadThresholdBytes, 2 * 1024 * 1024);
  assert.equal((await applyChange('cfgAutoCapture', true, 'checked')).config.autoCapture, true);
  assert.equal((await applyChange('cfgMediaSniffingBlacklist', '*')).config.mediaSniffingBlacklist, '*');
  assert.equal((await applyChange('cfgSkipSmallDownloads', true, 'checked')).config.skipSmallDownloads, true);
  assert.equal((await applyChange('cfgUseMotrixNext', true, 'checked')).config.useMotrixNext, true);
  assert.equal((await applyChange('cfgMotrixBridgeAutoClose', true, 'checked')).config.motrixBridgeAutoClose, true);
  assert.equal((await applyChange('cfgAbDownloadSilent', true, 'checked')).config.abDownloadSilent, true);
});
