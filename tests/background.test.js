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
  const windowsCalls = {
    create: [],
  };
  const notificationCalls = [];

  return {
    _listeners: listeners,
    _actionCalls: actionCalls,
    _tabsCalls: tabsCalls,
    _windowsCalls: windowsCalls,
    _notificationCalls: notificationCalls,
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
    windows: {
      create: async (opts) => {
        windowsCalls.create.push(opts);
        return { id: 2 };
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async () => {},
    },
    notifications: {
      create(payload) {
        notificationCalls.push(payload);
      },
    },
  };
}

function loadBackgroundRuntime(storedConfig = {}, options = {}) {
  const chrome = createChromeStub(storedConfig);
  const context = {
    console,
    Buffer,
    AbortController,
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

async function invokeDownloadCreated(background, item) {
  const listener = background.chrome._listeners.downloadsOnCreated;
  assert.equal(typeof listener, 'function');
  await listener(item);
}

async function invokeContextMenuClick(background, info, tab = {}) {
  const listener = background.chrome._listeners.contextMenusOnClicked;
  assert.equal(typeof listener, 'function');
  await listener(info, tab);
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

test('motrixnext view action opens extension bridge page', async () => {
  const background = loadBackgroundRuntime();
  let openedUrl = '';
  background.chrome.tabs.create = async ({ url }) => {
    openedUrl = url;
  };

  const result = await background.openMotrixNextView();
  assert.equal(result.ok, true);
  assert.equal(openedUrl, 'chrome-extension://test/motrix-open.html');
  assert.equal(result.target, 'motrixnext://');
});

test('motrixnext view falls back to direct deep link when bridge page fails', async () => {
  const background = loadBackgroundRuntime();
  const openedUrls = [];
  background.chrome.tabs.create = async ({ url }) => {
    openedUrls.push(url);
    if (url.includes('motrix-open.html')) throw new Error('bridge open failed');
  };

  const result = await background.openMotrixNextView();
  assert.equal(result.ok, true);
  assert.equal(result.mode, 'direct-fallback');
  assert.deepEqual(openedUrls, ['chrome-extension://test/motrix-open.html', 'motrixnext://']);
});

test('motrixnext view returns error and notifies when both bridge and direct open fail', async () => {
  const background = loadBackgroundRuntime();
  background.chrome.tabs.create = async () => {
    throw new Error('cannot open');
  };

  const result = await background.openMotrixNextView();
  assert.equal(result.ok, false);
  assert.equal(result.error, 'cannot open');
  assert.equal(background.chrome._notificationCalls.length, 1);
  assert.equal(background.chrome._notificationCalls[0].title, 'MotrixNext 打开失败');
  assert.equal(background.chrome._notificationCalls[0].message, 'cannot open');
});

test('motrixnext config remains an independent downloader type', () => {
  const background = loadBackgroundRuntime({ downloaderType: 'motrixnext' });
  const cfg = background.getBackgroundConfig();
  assert.equal(cfg.downloaderType, 'motrixnext');
});

test('Aria2 intercepted downloads enter pending queue by default', async () => {
  let fetchCalled = false;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      autoCapture: true,
      aria2Silent: false,
      captureExtensions: 'zip',
    },
    {
      fetch: async () => {
        fetchCalled = true;
        throw new Error('should not send immediately');
      },
    }
  );

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.equal(fetchCalled, false);
  assert.equal(background.chrome._actionCalls.openPopup, 1);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, 'https://example.com/file.zip');
  assert.equal(pending[0].filename, 'file.zip');
});

test('Aria2 pending confirmation falls back to popup window when action popup is blocked', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      autoCapture: true,
      aria2Silent: false,
      captureExtensions: 'zip',
    }
  );
  background.chrome.action.openPopup = async () => {
    throw new Error('openPopup requires user gesture');
  };

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.equal(background.chrome._windowsCalls.create.length, 1);
  assert.equal(background.chrome._windowsCalls.create[0].type, 'popup');
  assert.equal(background.chrome._windowsCalls.create[0].url, 'chrome-extension://test/popup.html');
  assert.equal(background.chrome._tabsCalls.create.length, 0);
});

test('Aria2 silent intercepted downloads send immediately', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      autoCapture: true,
      aria2Silent: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { result: 'gid-1' };
          },
        };
      },
    }
  );

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.equal(requestBody.method, 'aria2.addUri');
  assert.deepEqual(requestBody.params[0], ['https://example.com/file.zip']);
  assert.equal(background.chrome._actionCalls.openPopup, 0);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(state.pending || {}).length, 0);
  assert.equal(state.tasks['gid-1']?.filename, 'file.zip');
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

test('AB DM normal sends use add endpoint by default', async () => {
  let requestedUrl = '';
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
      abDownloadSilent: false,
    },
    {
      fetch: async (url, options) => {
        requestedUrl = url;
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200 };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_URL',
    url: 'https://example.com/file.zip',
    filename: 'custom.zip',
  });

  assert.equal(result.ok, true);
  assert.equal(requestedUrl, 'http://localhost:15151/add');
  assert.deepEqual(requestBody, [{ link: 'https://example.com/file.zip' }]);
});

test('MotrixNext sends direct /add request with referer and cookie', async () => {
  let requestedUrl = '';
  let requestHeaders = null;
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '16888',
      motrixNextSecret: 'next-secret',
    },
    {
      fetch: async (url, options) => {
        requestedUrl = url;
        requestHeaders = options.headers;
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200 };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_URL',
    url: 'https://example.com/file.zip',
    filename: 'custom.zip',
    referrer: 'https://example.com/page',
    headers: {
      cookie: 'sid=abc123',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requestedUrl, 'http://localhost:16888/add');
  assert.equal(requestHeaders.Authorization, 'Bearer next-secret');
  assert.deepEqual(requestBody, {
    url: 'https://example.com/file.zip',
    referer: 'https://example.com/page',
    cookie: 'sid=abc123',
  });
});

test('MotrixNext intercepted downloads send immediately without pending confirmation', async () => {
  let requestedUrl = '';
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '16888',
      autoCapture: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async (url) => {
        requestedUrl = url;
        return { ok: true, status: 200 };
      },
    }
  );

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.equal(requestedUrl, 'http://localhost:16888/add');
  assert.equal(background.chrome._actionCalls.openPopup, 0);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(state.pending || {}).length, 0);
});

test('MotrixNext media send falls back to page URL as referer', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '16888',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200 };
      },
    }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_1',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    pageUrl: 'https://example.com/watch/123',
    filename: 'video.mp4',
    headers: {},
    mime: 'video/mp4',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_1',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requestBody, {
    url: 'https://cdn.example.com/video.mp4',
    referer: 'https://example.com/watch/123',
  });
});

test('MotrixNext media send includes captured cookie', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '16888',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200 };
      },
    }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_1',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    pageUrl: 'https://example.com/watch/123',
    filename: 'video.mp4',
    headers: {
      cookie: 'sid=abc123',
      referer: 'https://example.com/player',
    },
    mime: 'video/mp4',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_1',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requestBody, {
    url: 'https://cdn.example.com/video.mp4',
    referer: 'https://example.com/player',
    cookie: 'sid=abc123',
  });
});

test('AB DM silent normal sends use headless endpoint with filename', async () => {
  let requestedUrl = '';
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
      abDownloadSilent: true,
      saveDir: '/downloads',
    },
    {
      fetch: async (url, options) => {
        requestedUrl = url;
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200 };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_URL',
    url: 'https://example.com/file.zip',
    filename: 'custom.zip',
  });

  assert.equal(result.ok, true);
  assert.equal(requestedUrl, 'http://localhost:15151/start-headless-download');
  assert.equal(requestBody.name, 'custom.zip');
  assert.equal(requestBody.folder, '/downloads');
  assert.deepEqual(requestBody.downloadSource, {
    link: 'https://example.com/file.zip',
  });
});

test('AB DM media sends always use headless endpoint with filename', async () => {
  let requestedUrl = '';
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
      abDownloadSilent: false,
    },
    {
      fetch: async (url, options) => {
        requestedUrl = url;
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200 };
      },
    }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_1',
    tabId: 1,
    resourceUrl: 'https://example.com/video.mp4',
    filename: 'video-title.mp4',
    headers: {},
    mime: 'video/mp4',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_1',
  });

  assert.equal(result.ok, true);
  assert.equal(requestedUrl, 'http://localhost:15151/start-headless-download');
  assert.equal(requestBody.name, 'video-title.mp4');
  assert.deepEqual(requestBody.downloadSource, {
    link: 'https://example.com/video.mp4',
  });
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
  assert.equal(state.uiAlert?.message, '与 AB DM 连接失败，检查 AB DM 是否正在运行');
});

test('context menu download enters popup pending queue instead of sending immediately', async () => {
  let fetchCalled = false;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
      externalLauncherPath: '/start-headless-download',
    },
    {
      fetch: async () => {
        fetchCalled = true;
        throw new Error('should not send immediately');
      },
    }
  );

  await invokeContextMenuClick(background, {
    menuItemId: 'send-to-aria2',
    linkUrl: 'https://example.com/file.zip',
  }, {
    id: 1,
    url: 'https://example.com/page',
  });

  assert.equal(fetchCalled, false);
  assert.equal(background.chrome._actionCalls.openPopup, 1);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, 'https://example.com/file.zip');
  assert.equal(pending[0].filename, 'file.zip');
});

test('media send failure keeps current page and only exposes alert state', async () => {
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

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_1',
    tabId: 1,
    resourceUrl: 'https://example.com/video.mp4',
    filename: 'video.mp4',
    headers: {},
    mime: 'video/mp4',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_1',
  });

  assert.equal(result.ok, false);
  assert.equal(background.chrome._actionCalls.openPopup, 0);
  assert.equal(background.chrome._tabsCalls.create.length, 0);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.uiAlert?.message, '与 AB DM 连接失败，检查 AB DM 是否正在运行');
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

test('connection test uses the incoming config override instead of the last saved secret', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      aria2Secret: 'good-secret',
    },
    {
      fetch: async (_url, options) => {
        const payload = JSON.parse(options.body);
        const token = payload.params?.[0];
        if (token !== 'token:good-secret') {
          return {
            ok: true,
            async json() {
              return {
                error: {
                  message: 'Unauthorized',
                },
              };
            },
          };
        }
        return {
          ok: true,
          async json() {
            return {
              result: { numActive: '1', numWaiting: '0', numStopped: '0' },
            };
          },
        };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'TEST_CONNECTION',
    config: {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      aria2Secret: 'bad-secret',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'aria2');
  assert.equal(result.error, '与 Aria2 连接失败，检查 Aria2 是否正在运行');
});

test('AB DM connection test uses the incoming config override instead of the last saved endpoint', async () => {
  let requestedUrl = '';
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      externalLauncherHost: 'saved-host',
      externalLauncherPort: '15151',
      externalLauncherPath: '/start-headless-download',
    },
    {
      fetch: async (url) => {
        requestedUrl = url;
        return {
          ok: false,
          status: 503,
        };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'TEST_CONNECTION',
    config: {
      downloaderType: 'abdownload',
      externalLauncherHost: 'live-host',
      externalLauncherPort: '17000',
      externalLauncherPath: '/add',
    },
  });

  assert.equal(requestedUrl, 'http://live-host:17000/queues');
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'abdownload');
  assert.equal(result.error, '与 AB DM 连接失败，检查 AB DM 是否正在运行');
});

test('MotrixNext connection test validates the incoming secret through stat endpoint', async () => {
  const requests = [];
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '16801',
      motrixNextSecret: 'saved-secret',
    },
    {
      fetch: async (url, options = {}) => {
        requests.push({ url, headers: options.headers || {}, method: options.method || 'GET' });
        if (url === 'http://localhost:17001/add') {
          return { ok: true, status: 204 };
        }
        if (url === 'http://localhost:17001/stat') {
          return options.headers?.Authorization === 'Bearer live-secret'
            ? { ok: true, status: 200 }
            : { ok: false, status: 401 };
        }
        return { ok: false, status: 404 };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'TEST_CONNECTION',
    config: {
      downloaderType: 'motrixnext',
      motrixNextPort: '17001',
      motrixNextSecret: 'live-secret',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    {
      url: 'http://localhost:17001/add',
      method: 'OPTIONS',
      headers: { Authorization: 'Bearer live-secret' },
    },
    {
      url: 'http://localhost:17001/stat',
      method: 'GET',
      headers: { Authorization: 'Bearer live-secret' },
    },
  ]);
});

test('MotrixNext connection test fails when incoming secret is rejected', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '16801',
      motrixNextSecret: 'saved-secret',
    },
    {
      fetch: async (url) => {
        if (url === 'http://localhost:17001/add') return { ok: true, status: 204 };
        if (url === 'http://localhost:17001/stat') return { ok: false, status: 401 };
        return { ok: false, status: 404 };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'TEST_CONNECTION',
    config: {
      downloaderType: 'motrixnext',
      motrixNextPort: '17001',
      motrixNextSecret: 'bad-secret',
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'motrixnext');
  assert.equal(result.error, '与 MotrixNext 连接失败，检查 MotrixNext 是否正在运行');
});
