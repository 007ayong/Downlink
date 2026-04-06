const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createChromeStub(storedConfig = {}) {
  const listeners = {
    runtimeOnMessage: null,
    downloadsOnCreated: null,
    contextMenusOnClicked: null,
  };
  const actionCalls = {
    openPopup: 0,
  };
  const tabsCalls = {
    create: [],
  };

  return {
    _listeners: listeners,
    _actionCalls: actionCalls,
    _tabsCalls: tabsCalls,
    storage: {
      sync: {
        get(defaults, callback) {
          callback?.({ ...defaults, ...storedConfig });
        },
        set: async () => {},
      },
      onChanged: {
        addListener() {},
      },
    },
    action: {
      setBadgeBackgroundColor() {},
      setBadgeTextColor() {},
      setBadgeText() {},
      openPopup() {
        actionCalls.openPopup += 1;
        return Promise.resolve();
      },
    },
    webRequest: {
      onSendHeaders: {
        addListener() {},
      },
      onHeadersReceived: {
        addListener() {},
      },
    },
    downloads: {
      onCreated: {
        addListener(callback) {
          listeners.downloadsOnCreated = callback;
        },
      },
      cancel(_id, callback) {
        callback?.();
      },
      erase() {},
    },
    runtime: {
      onMessage: {
        addListener(callback) {
          listeners.runtimeOnMessage = callback;
        },
      },
      onInstalled: {
        addListener() {},
      },
      onStartup: {
        addListener() {},
      },
      lastError: null,
      sendMessage() {
        return Promise.resolve();
      },
      getURL(pathname) {
        return `chrome-extension://test/${pathname}`;
      },
    },
    contextMenus: {
      removeAll(callback) {
        callback?.();
      },
      create() {},
      onClicked: {
        addListener(callback) {
          listeners.contextMenusOnClicked = callback;
        },
      },
    },
    tabs: {
      create: async (opts) => {
        tabsCalls.create.push(opts);
        return { id: 1 };
      },
      get(_tabId, callback) {
        callback?.({ title: '', url: '' });
      },
      onRemoved: {
        addListener() {},
      },
      onActivated: {
        addListener() {},
      },
      onUpdated: {
        addListener() {},
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async () => {},
    },
    notifications: {
      create() {},
    },
  };
}

function loadBackgroundRuntime(storedConfig = {}, options = {}) {
  const chrome = createChromeStub(storedConfig);
  const context = {
    console,
    Buffer,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    fetch: options.fetch || (async () => {
      throw new Error('unexpected fetch in background test');
    }),
    atob(value) {
      return Buffer.from(value, 'base64').toString('binary');
    },
    chrome,
    importScripts(...files) {
      for (const file of files) {
        const script = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
        vm.runInNewContext(script, context, { filename: file });
      }
    },
    globalThis: null,
    self: null,
    window: null,
    FilenameLogic: require('../filename-logic.js'),
  };

  context.globalThis = context;
  context.self = context;
  context.window = context;

  const script = fs.readFileSync(path.join(__dirname, '..', 'background.js'), 'utf8');
  vm.runInNewContext(script, context, { filename: 'background.js' });
  return context;
}

async function invokeBackgroundMessage(background, message) {
  const listener = background.chrome._listeners.runtimeOnMessage;
  assert.equal(typeof listener, 'function');

  return new Promise((resolve) => {
    listener(message, {}, (response) => {
      resolve(response);
    });
  });
}

test('media sniffing ignores ts segment URLs', () => {
  const background = loadBackgroundRuntime();
  assert.equal(
    background.isDirectMediaResource('https://cdn.example.com/seg-0001.ts?token=1', 'video/mp4', ''),
    false
  );
});

test('media sniffing ignores ts filenames from content-disposition', () => {
  const background = loadBackgroundRuntime();
  assert.equal(
    background.isDirectMediaResource('https://cdn.example.com/download', 'video/mp4', 'seg-0001.ts'),
    false
  );
});

test('media sniffing ignores MPEG-TS mime type even without ts suffix', () => {
  const background = loadBackgroundRuntime();
  assert.equal(
    background.isDirectMediaResource('https://cdn.example.com/live/stream?id=1', 'video/mp2t', ''),
    false
  );
});

test('media sniffing still keeps normal direct media resources', () => {
  const background = loadBackgroundRuntime();
  assert.equal(
    background.isDirectMediaResource('https://cdn.example.com/video.mp4', 'video/mp4', 'video.mp4'),
    true
  );
});

test('motrixnext view action opens the app without a url', async () => {
  const background = loadBackgroundRuntime();
  let openedUrl = '';
  background.chrome.tabs.create = async ({ url }) => {
    openedUrl = url;
  };

  const result = await background.openMotrixNextView();
  assert.equal(result.ok, true);
  assert.equal(openedUrl, 'motrixnext://');
});

test('legacy motrixnext config normalizes to aria2 plus motrix flag', () => {
  const background = loadBackgroundRuntime({ downloaderType: 'motrixnext' });
  const cfg = background.getBackgroundConfig();
  assert.equal(cfg.downloaderType, 'aria2');
  assert.equal(cfg.useMotrixNext, true);
});

test('AB DM downloader label is fixed', () => {
  const background = loadBackgroundRuntime();
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'abdownload' }),
    notify() {},
    onBeforeAria2Send() {},
    onAria2TaskQueued() {},
  });

  assert.equal(clients.getDownloaderLabel('abdownload', { downloaderType: 'abdownload' }), 'AB DM');
});

test('user-triggered send failure opens popup and exposes task alert', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
      externalLauncherPath: '/start-headless-download',
    },
    {
      fetch: async () => {
        throw new Error('offline');
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_URL',
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
  });

  assert.equal(result.ok, false);
  assert.equal(background.chrome._actionCalls.openPopup, 1);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.uiAlert?.message, '连接失败，检查下载器是否在运行');
});

test('successful connection test clears the task alert', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
      externalLauncherPath: '/add',
    }
  );

  background.__backgroundTestHooks.setUiAlert({
    type: 'connection-failure',
    message: '连接失败，检查下载器是否在运行',
  });

  const failedState = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(failedState.uiAlert?.message, '连接失败，检查下载器是否在运行');

  background.__backgroundTestHooks.clearUiAlert();

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.uiAlert, null);
});
