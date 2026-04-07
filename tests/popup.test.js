const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElementStub() {
  const classes = new Set();
  const listeners = {};
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
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    remove() {},
    focus() {},
    select() {},
    click() {
      (listeners.click || []).forEach((handler) => handler({ currentTarget: this, target: this }));
    },
    querySelector() {
      return createElementStub();
    },
    querySelectorAll() {
      return [];
    },
    _classes: classes,
    _listeners: listeners,
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
    _sentMessages: [],
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        chrome._sentMessages.push(message);
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
  const sentMessages = [];
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

test('aria2 test connection sends the current form config', () => {
  const popup = loadPopupRuntime();

  popup.document.getElementById('cfgDownloaderType').value = 'aria2';
  popup.document.getElementById('cfgRpc').value = 'http://127.0.0.1:6800/jsonrpc';
  popup.document.getElementById('cfgSecret').value = 'bad-secret';
  popup.document.getElementById('cfgSaveDir').value = '/downloads';

  popup.document.getElementById('testConnBtn').click();

  const testMessage = popup.chrome._sentMessages.findLast((message) => message?.type === 'TEST_CONNECTION');
  assert.deepEqual(JSON.parse(JSON.stringify(testMessage?.config)), {
    downloaderType: 'aria2',
    aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
    aria2Secret: 'bad-secret',
    saveDir: '/downloads',
    useMotrixNext: false,
    externalLauncherName: 'AB DM',
    externalLauncherHost: 'localhost',
    externalLauncherPort: '15151',
    externalLauncherPath: '/start-headless-download',
    autoCapture: false,
    showConfirm: false,
    captureExtensions: '',
  });
});

test('AB DM test connection sends the current form config', () => {
  const popup = loadPopupRuntime();

  popup.document.getElementById('cfgDownloaderType').value = 'abdownload';
  popup.document.getElementById('cfgLauncherHost').value = '10.0.0.8';
  popup.document.getElementById('cfgLauncherPort').value = '17000';
  popup.document.getElementById('cfgLauncherPath').value = '/add';

  popup.document.getElementById('testLauncherBtn').click();

  const testMessage = popup.chrome._sentMessages.findLast((message) => message?.type === 'TEST_CONNECTION');
  assert.deepEqual(JSON.parse(JSON.stringify(testMessage?.config)), {
    downloaderType: 'abdownload',
    aria2Rpc: 'http://localhost:6800/jsonrpc',
    aria2Secret: '',
    saveDir: '',
    useMotrixNext: false,
    externalLauncherName: 'AB DM',
    externalLauncherHost: '10.0.0.8',
    externalLauncherPort: '17000',
    externalLauncherPath: '/add',
    autoCapture: false,
    showConfirm: false,
    captureExtensions: '',
  });
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
  context.document.getElementById('cfgSaveDir').value = '/tmp/downloads';
  context.document.getElementById('cfgUseMotrixNext').checked = true;
  context.document.getElementById('cfgLauncherHost').value = '10.0.0.8';
  context.document.getElementById('cfgLauncherPort').value = '17000';
  context.document.getElementById('cfgLauncherPath').value = '/add';
  context.document.getElementById('cfgAutoCapture').checked = true;
  context.document.getElementById('cfgShowConfirm').checked = true;
  context.document.getElementById('cfgExts').value = 'zip,mp4';

  assert.deepEqual(JSON.parse(JSON.stringify(controller.collectSettingsFromForm())), {
    downloaderType: 'abdownload',
    aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
    aria2Secret: 'secret',
    saveDir: '/tmp/downloads',
    useMotrixNext: true,
    externalLauncherName: 'AB DM',
    externalLauncherHost: '10.0.0.8',
    externalLauncherPort: '17000',
    externalLauncherPath: '/add',
    autoCapture: true,
    showConfirm: true,
    captureExtensions: 'zip,mp4',
  });
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
  assert.equal((await applyChange('cfgSaveDir', '/downloads')).config.saveDir, '/downloads');
  assert.equal((await applyChange('cfgLauncherHost', '10.0.0.8')).config.externalLauncherHost, '10.0.0.8');
  assert.equal((await applyChange('cfgLauncherPort', '17000')).config.externalLauncherPort, '17000');
  assert.equal((await applyChange('cfgLauncherPath', '/add')).config.externalLauncherPath, '/add');
  assert.equal((await applyChange('cfgExts', 'zip,mp4')).config.captureExtensions, 'zip,mp4');
  assert.equal((await applyChange('cfgAutoCapture', true, 'checked')).config.autoCapture, true);
  assert.equal((await applyChange('cfgShowConfirm', true, 'checked')).config.showConfirm, true);
  assert.equal((await applyChange('cfgUseMotrixNext', true, 'checked')).config.useMotrixNext, true);
});
