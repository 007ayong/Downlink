const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElementStub() {
  const classes = new Set();
  return {
    style: {},
    dataset: {},
    value: '',
    checked: false,
    textContent: '',
    innerHTML: '',
    disabled: false,
    className: '',
    src: '',
    alt: '',
    children: [],
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
        return classes.has(token);
      },
    },
    addEventListener() {},
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {},
    focus() {},
    select() {},
    click() {},
    querySelector() {
      return createElementStub();
    },
    querySelectorAll() {
      return [];
    },
    _classes: classes,
  };
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
    createElement() {
      return createElementStub();
    },
    execCommand() {
      return true;
    },
  };

  const chrome = {
    _listeners: {},
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message?.type === 'GET_STATE') {
          callback?.({
            tasks: options.state?.tasks || {},
            pending: options.state?.pending || {},
            media: options.state?.media || {},
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
        callback?.({ ok: true });
      },
      getURL(value) {
        return value;
      },
      onMessage: {
        addListener(callback) {
          chrome._listeners.runtimeOnMessage = callback;
        },
      },
    },
    tabs: {
      query(_query, callback) {
        callback?.([{ id: 1 }]);
      },
      create(_opts, callback) {
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
  const getElement = (id) => {
    if (!elements.has(id)) {
      const listeners = {};
      listenersById.set(id, listeners);
      elements.set(id, {
        value: '',
        checked: false,
        style: {},
        textContent: '',
        classList: {
          add() {},
          remove() {},
          toggle() {},
        },
        addEventListener(type, handler) {
          listeners[type] = listeners[type] || [];
          listeners[type].push(handler);
        },
      });
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
    },
    chrome: {
      runtime: {
        sendMessage(_message, callback) {
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
  return { context, listenersById };
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

test('media render key changes when filename changes', () => {
  const popup = loadPopupRuntime();
  const before = popup.buildMediaRenderKey([{ id: '1', resourceUrl: 'u', filename: 'a.mp4', size: 1, kind: 'video', mime: 'video/mp4', width: 0, height: 0 }]);
  const after = popup.buildMediaRenderKey([{ id: '1', resourceUrl: 'u', filename: '中文.mp4', size: 1, kind: 'video', mime: 'video/mp4', width: 0, height: 0 }]);
  assert.notEqual(before, after);
});

test('task icon category prefers media kind and mime', () => {
  const popup = loadPopupRuntime();
  assert.equal(popup.getFileCategory({ name: 'unknown.bin', kind: 'audio', mime: '' }), 'audio');
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
    'assets/file-icons/video.svg'
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
  assert.equal(canViewInMotrix({ downloaderType: 'neatdm', useMotrixNext: true }), false);
});

test('AB DM display name is fixed', () => {
  const popup = loadPopupRuntime();
  assert.equal(popup.getDownloaderName({ downloaderType: 'abdownload', externalLauncherName: 'Custom Name' }), 'AB DM');
  assert.equal(popup.getSendLabel({ downloaderType: 'abdownload', externalLauncherName: 'Custom Name' }), '发送到 AB DM');
});

test('task alert renders connection failure in tasks panel', async () => {
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
