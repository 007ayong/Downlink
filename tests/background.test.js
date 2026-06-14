const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const LEGACY_DEFAULT_CAPTURE_EXTENSIONS = 'zip,rar,7z,tar,gz,bz2,xz,iso,dmg,exe,msi,deb,pkg,apk,mp4,m4s,mkv,avi,mov,webm,mp3,flac,wav,pdf,torrent';

function createChromeStub(storedConfig = {}) {
  const listeners = {
    runtimeOnMessage: null,
    downloadsOnCreated: null,
    downloadsOnDeterminingFilename: null,
    contextMenusOnClicked: null,
    webRequestOnSendHeaders: [],
    webRequestOnHeadersReceived: [],
    webRequestOnSendHeadersSpecs: [],
    webRequestOnHeadersReceivedSpecs: [],
    tabsOnActivated: null,
    tabsOnUpdated: null,
    tabsOnRemoved: null,
    storageOnChanged: null,
    commandsOnCommand: null,
  };
  const actionCalls = {
    openPopup: 0,
    setBadgeBackgroundColor: [],
    setBadgeTextColor: [],
    setBadgeText: [],
  };
  const tabsCalls = {
    create: [],
    update: [],
    remove: [],
  };
  const windowsCalls = {
    create: [],
    update: [],
  };
  const notificationCalls = [];
  const downloadCalls = {
    cancel: [],
    erase: [],
    lastErrorReads: 0,
  };
  const dnrCalls = [];
  const localStorageWrites = [];
  const syncShouldFail = storedConfig.__syncShouldFail;
  const storedValues = { ...storedConfig };
  delete storedValues.__syncShouldFail;
  delete storedValues.__firefoxRuntime;
  delete storedValues.__activeTabs;
  delete storedValues.__tabsById;
  let runtimeApi;

  const chromeStub = {
    _listeners: listeners,
    _actionCalls: actionCalls,
    _tabsCalls: tabsCalls,
    _windowsCalls: windowsCalls,
    _notificationCalls: notificationCalls,
    _downloadCalls: downloadCalls,
    _dnrCalls: dnrCalls,
    _localStorageWrites: localStorageWrites,
    storage: {
      sync: {
        get(defaults, callback) {
          if (syncShouldFail) {
            runtimeApi.lastError = { message: 'sync unavailable' };
            callback?.({ ...defaults });
            runtimeApi.lastError = null;
            return;
          }
          callback?.({ ...defaults, ...storedValues });
        },
        set: async () => {
          if (syncShouldFail) throw new Error('sync unavailable');
        },
      },
      local: {
        get(defaults, callback) {
          callback?.({ ...defaults, ...storedValues });
        },
        set: async (values) => {
          localStorageWrites.push(values);
        },
      },
      onChanged: {
        addListener(callback) {
          listeners.storageOnChanged = callback;
        },
      },
    },
    action: {
      setBadgeBackgroundColor(payload) {
        actionCalls.setBadgeBackgroundColor.push(payload);
      },
      setBadgeTextColor(payload) {
        actionCalls.setBadgeTextColor.push(payload);
      },
      setBadgeText(payload) {
        actionCalls.setBadgeText.push(payload);
      },
      openPopup() {
        actionCalls.openPopup += 1;
        return Promise.resolve();
      },
    },
    webRequest: {
      onSendHeaders: {
        addListener(callback, _filter, extraInfoSpec) {
          listeners.webRequestOnSendHeaders.push(callback);
          listeners.webRequestOnSendHeadersSpecs.push(extraInfoSpec);
        },
      },
      onHeadersReceived: {
        addListener(callback, _filter, extraInfoSpec) {
          listeners.webRequestOnHeadersReceived.push(callback);
          listeners.webRequestOnHeadersReceivedSpecs.push(extraInfoSpec);
        },
      },
    },
    downloads: {
      onCreated: {
        addListener(callback) {
          listeners.downloadsOnCreated = callback;
        },
      },
      onDeterminingFilename: {
        addListener(callback) {
          listeners.downloadsOnDeterminingFilename = callback;
        },
      },
      cancel(_id, callback) {
        downloadCalls.cancel.push(_id);
        callback?.();
      },
      search(query, callback) {
        callback?.([{ id: query.id, state: 'in_progress' }]);
      },
      erase(query, callback) {
        downloadCalls.erase.push(query);
        callback?.();
      },
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
      _lastError: null,
      get lastError() {
        downloadCalls.lastErrorReads += 1;
        return this._lastError;
      },
      set lastError(value) {
        this._lastError = value;
      },
      sendMessage() {
        return Promise.resolve();
      },
      getBrowserInfo: storedConfig.__firefoxRuntime ? (() => Promise.resolve({ name: 'Firefox' })) : undefined,
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
    commands: {
      onCommand: {
        addListener(callback) {
          listeners.commandsOnCommand = callback;
        },
      },
    },
    tabs: {
      query(_query, callback) {
        const tabs = storedConfig.__activeTabs || [{ id: 1, windowId: 3, active: true }];
        callback?.(tabs);
      },
      create: async (opts) => {
        tabsCalls.create.push(opts);
        return { id: 1 };
      },
      get(_tabId, callback) {
        callback?.(storedConfig.__tabsById?.[_tabId] || { id: _tabId, windowId: 3, title: '', url: '' });
      },
      update: async (tabId, opts) => {
        tabsCalls.update.push({ tabId, opts });
        return { id: tabId };
      },
      remove: async (tabId) => {
        tabsCalls.remove.push(tabId);
      },
      onRemoved: {
        addListener(callback) {
          listeners.tabsOnRemoved = callback;
        },
      },
      onActivated: {
        addListener(callback) {
          listeners.tabsOnActivated = callback;
        },
      },
      onUpdated: {
        addListener(callback) {
          listeners.tabsOnUpdated = callback;
        },
      },
    },
    windows: {
      create: async (opts) => {
        windowsCalls.create.push(opts);
        return { id: 2 };
      },
      update: async (windowId, opts) => {
        windowsCalls.update.push({ windowId, opts });
        return { id: windowId };
      },
    },
    declarativeNetRequest: {
      updateSessionRules: async (options) => {
        dnrCalls.push(options);
      },
    },
    notifications: {
      create(payload) {
        notificationCalls.push(payload);
      },
    },
  };
  runtimeApi = chromeStub.runtime;
  return chromeStub;
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
    setTimeout: options.setTimeout || setTimeout,
    clearTimeout: options.clearTimeout || clearTimeout,
    setInterval() {
      return 1;
    },
    clearInterval() {},
    fetch: options.fetch || (async () => {
      throw new Error('unexpected fetch in background test');
    }),
    WebSocket: options.WebSocket,
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

async function invokeBackgroundMessage(background, message, sender = {}) {
  const listener = background.chrome._listeners.runtimeOnMessage;
  assert.equal(typeof listener, 'function');

  return new Promise((resolve) => {
    listener(message, sender, (response) => {
      resolve(response);
    });
  });
}

async function invokeDownloadCreated(background, item) {
  const listener = background.chrome._listeners.downloadsOnCreated;
  assert.equal(typeof listener, 'function');
  await listener(item);
}

async function invokeDeterminingFilename(background, item) {
  const listener = background.chrome._listeners.downloadsOnDeterminingFilename;
  assert.equal(typeof listener, 'function');
  let suggested = false;
  await listener(item, () => {
    suggested = true;
  });
  return suggested;
}

async function invokeSendHeaders(background, details) {
  for (const listener of background.chrome._listeners.webRequestOnSendHeaders || []) {
    await listener(details);
  }
}

async function invokeResponseHeaders(background, details) {
  const results = [];
  for (const listener of background.chrome._listeners.webRequestOnHeadersReceived || []) {
    results.push(await listener(details));
  }
  return results;
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

test('metadata header rule is cleaned up by the background when popup closes early', async () => {
  const timers = [];
  const background = loadBackgroundRuntime({}, {
    setTimeout(callback, delay) {
      const timer = { callback, delay, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) {
      if (timer) timer.cleared = true;
    },
  });
  const url = 'https://cdn.example.com/video.mp4';

  await invokeSendHeaders(background, {
    url,
    tabId: 3,
    method: 'GET',
    requestHeaders: [
      { name: 'Referer', value: 'https://example.com/watch' },
      { name: 'Cookie', value: 'sid=1' },
    ],
  });
  await invokeResponseHeaders(background, {
    url,
    tabId: 3,
    frameId: 0,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-length', value: '1024' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const media = state.media[3][0];
  const result = await invokeBackgroundMessage(background, { type: 'PREPARE_MEDIA_METADATA', id: media.id });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.headersApplied), ['referer', 'cookie']);
  const addCall = background.chrome._dnrCalls.find((call) => call.addRules?.length);
  assert.ok(addCall);
  assert.equal(addCall.addRules[0].condition.tabIds, undefined);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].delay, 15000);

  timers[0].callback();
  await Promise.resolve();

  const removeCall = background.chrome._dnrCalls.find((call) =>
    call.removeRuleIds?.includes(addCall.addRules[0].id) && !call.addRules
  );
  assert.ok(removeCall);
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

test('gopeed view action opens extension bridge page', async () => {
  const background = loadBackgroundRuntime();
  let openedUrl = '';
  background.chrome.tabs.create = async ({ url }) => {
    openedUrl = url;
  };

  const result = await background.openGopeedView();
  assert.equal(result.ok, true);
  assert.equal(openedUrl, 'chrome-extension://test/gopeed-open.html');
  assert.equal(result.target, 'gopeed://');
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

  await invokeSendHeaders(background, {
    url: 'https://example.com/file.zip',
    tabId: 1,
    method: 'GET',
    requestHeaders: [
      { name: 'Cookie', value: 'sid=abc123' },
      { name: 'Referer', value: 'https://example.com/downloads' },
      { name: 'Range', value: 'bytes=0-' },
      { name: 'User-Agent', value: 'Browser UA' },
    ],
  });
  await invokeResponseHeaders(background, {
    url: 'https://example.com/file.zip',
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'Content-Type', value: 'application/zip' },
      { name: 'Content-Disposition', value: 'attachment; filename="server-file.zip"' },
    ],
  });
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
  assert.equal(pending[0].filename, 'server-file.zip');
});

test('browser download cancel reads expected lastError when item is no longer in progress', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });
  background.chrome.downloads.cancel = (_id, callback) => {
    background.chrome._downloadCalls.cancel.push(_id);
    background.chrome.runtime.lastError = { message: 'Download must be in progress' };
    callback?.();
    background.chrome.runtime.lastError = null;
  };
  background.chrome._downloadCalls.lastErrorReads = 0;

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [1]);
  assert.equal(background.chrome._downloadCalls.lastErrorReads > 0, true);
});

test('browser download cancel skips cancel when current download already completed', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });
  background.chrome.downloads.search = (_query, callback) => {
    callback?.([{ id: 1, state: 'complete' }]);
  };

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  assert.equal(JSON.stringify(background.chrome._downloadCalls.erase), JSON.stringify([{ id: 1 }]));
});

test('interrupted browser downloads are ignored by auto capture', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'interrupted',
    totalBytes: 1024,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  assert.deepEqual(background.chrome._downloadCalls.erase, []);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(state.pending || {}).length, 0);
});

test('restored browser downloads from a previous session are not captured on startup', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  await invokeDownloadCreated(background, {
    id: 77,
    url: 'https://example.com/old-file.zip',
    filename: 'old-file.zip',
    state: 'in_progress',
    startTime: new Date(Date.now() - 60000).toISOString(),
    totalBytes: 1024,
  });

  assert.equal(background.chrome._actionCalls.openPopup, 0);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('browser download interception prefers URL filename when Chrome converts plus signs to spaces', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  await invokeDownloadCreated(background, {
    id: 88,
    url: 'https://example.com/files/library++1.0.zip',
    finalUrl: 'https://example.com/files/library++1.0.zip',
    filename: '/Downloads/library  1.0.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].filename, 'library++1.0.zip');
});

test('browser download interception prefers content-disposition filename over Chrome filename', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/download?id=1';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    responseHeaders: [
      { name: 'content-disposition', value: "attachment; filename*=UTF-8''server%2B%2Bfile.zip" },
      { name: 'content-type', value: 'application/zip' },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 90,
    url,
    finalUrl: url,
    filename: '/Downloads/browser-file.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].filename, 'server++file.zip');
  assert.equal(pending[0].contentDisposition, "attachment; filename*=UTF-8''server%2B%2Bfile.zip");
});

test('browser download interception uses content-disposition when URL path has no extension', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/files/release';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    responseHeaders: [
      { name: 'content-disposition', value: "attachment; filename*=UTF-8''server-file.zip" },
      { name: 'content-type', value: 'application/zip' },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 92,
    url,
    finalUrl: url,
    filename: '/Downloads/browser-file.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].filename, 'server-file.zip');
});

test('browser download interception prefers content-disposition filename over specific URL filename', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/files/url-file.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    responseHeaders: [
      { name: 'content-disposition', value: "attachment; filename*=UTF-8''server-file.zip" },
      { name: 'content-type', value: 'application/zip' },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 91,
    url,
    finalUrl: url,
    filename: '/Downloads/browser-file.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].filename, 'server-file.zip');
  assert.equal(pending[0].contentDisposition, "attachment; filename*=UTF-8''server-file.zip");
});

test('response header capture enters pending queue before browser download is created', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  await invokeResponseHeaders(background, {
    url: 'https://example.com/response-only.zip',
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="response-only.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '2048' },
    ],
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, 'https://example.com/response-only.zip');
  assert.equal(pending[0].filename, 'response-only.zip');
  assert.equal(pending[0].size, 2048);
  assert.equal(pending[0].captureSource, 'headers');
});

test('Firefox response header capture blocks the browser download before its panel opens', async () => {
  const background = loadBackgroundRuntime({
    __firefoxRuntime: true,
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._listeners.webRequestOnSendHeadersSpecs[0])), ['requestHeaders']);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._listeners.webRequestOnHeadersReceivedSpecs[0])), ['responseHeaders', 'blocking']);

  const url = 'https://example.com/firefox-response.zip';
  const results = await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="firefox-response.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '2048' },
    ],
  });

  assert.deepEqual(JSON.parse(JSON.stringify(results[0])), { cancel: true });
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, url);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
});

test('Firefox response header capture closes opener-created download tab', async () => {
  const background = loadBackgroundRuntime({
    __firefoxRuntime: true,
    __tabsById: {
      9: { id: 9, windowId: 3, openerTabId: 1, title: '', url: 'https://example.com/firefox-response.zip' },
    },
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/firefox-response.zip';
  const results = await invokeResponseHeaders(background, {
    url,
    tabId: 9,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="firefox-response.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '2048' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(JSON.parse(JSON.stringify(results[0])), { cancel: true });
  assert.deepEqual(background.chrome._tabsCalls.remove, [9]);
});

test('Firefox response header capture keeps tab when opener is unknown', async () => {
  const background = loadBackgroundRuntime({
    __firefoxRuntime: true,
    __tabsById: {
      9: { id: 9, windowId: 3, title: '', url: 'https://example.com/firefox-response.zip' },
    },
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/firefox-response.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 9,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="firefox-response.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '2048' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(background.chrome._tabsCalls.remove, []);
});

test('Firefox response claim prevents duplicate pending task if a download event still arrives', async () => {
  const background = loadBackgroundRuntime({
    __firefoxRuntime: true,
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/firefox-duplicate.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="firefox-duplicate.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 18,
    url,
    finalUrl: url,
    filename: '/Downloads/firefox-duplicate.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [18]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, url);
});

test('browser download created after response capture is cancelled without duplicate pending task', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/response-first.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="response-first.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 18,
    url,
    finalUrl: url,
    filename: '/Downloads/response-first.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [18]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, url);
});

test('Aria2 pending response capture cancels before browser filename prompt', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/prompt.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="prompt.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });

  const suggested = await invokeDeterminingFilename(background, {
    id: 24,
    url,
    finalUrl: url,
    filename: 'prompt.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.equal(suggested, true);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [24]);
  assert.deepEqual(background.chrome._downloadCalls.erase.map(item => ({ ...item })), [{ id: 24 }]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(state.pending || {}).length, 1);
});

test('direct response capture cancels before browser filename prompt after send succeeds', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      autoCapture: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({}) };
      },
    }
  );

  const url = 'https://example.com/direct.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="direct.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });

  const suggested = await invokeDeterminingFilename(background, {
    id: 25,
    url,
    finalUrl: url,
    filename: 'direct.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.equal(suggested, true);
  assert.equal(requestBody.url, url);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [25]);
  assert.deepEqual(background.chrome._downloadCalls.erase.map(item => ({ ...item })), [{ id: 25 }]);
});

test('failed response capture still cancels browser filename prompt', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      autoCapture: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async () => ({ ok: false, status: 500 }),
    }
  );

  const url = 'https://example.com/fallback.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="fallback.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });

  const suggested = await invokeDeterminingFilename(background, {
    id: 26,
    url,
    finalUrl: url,
    filename: 'fallback.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.equal(suggested, true);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [26]);
  assert.deepEqual(background.chrome._downloadCalls.erase.map(item => ({ ...item })), [{ id: 26 }]);
});

test('failed response capture cancels browser download without retrying browser fallback', async () => {
  let fetchCount = 0;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      autoCapture: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async () => {
        fetchCount += 1;
        return { ok: false, status: 500 };
      },
    }
  );

  const url = 'https://example.com/fallback-created.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="fallback-created.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });

  await invokeDownloadCreated(background, {
    id: 27,
    url,
    finalUrl: url,
    filename: 'fallback-created.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.equal(fetchCount, 1);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [27]);
  assert.deepEqual(background.chrome._downloadCalls.erase.map(item => ({ ...item })), [{ id: 27 }]);
});

test('AB DM response capture cancels browser filename prompt before connection result', async () => {
  let resolveFetch;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      autoCapture: true,
      captureExtensions: 'zip',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
    },
    {
      fetch: async () => new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    }
  );

  const url = 'https://example.com/ab-offline.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="ab-offline.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });

  const suggested = await invokeDeterminingFilename(background, {
    id: 28,
    url,
    finalUrl: url,
    filename: 'ab-offline.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.equal(suggested, true);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [28]);
  assert.deepEqual(background.chrome._downloadCalls.erase.map(item => ({ ...item })), [{ id: 28 }]);

  resolveFetch?.({ ok: false, status: 500 });
});

test('POST redirect intent waits for redirected response headers before entering pending queue', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const postUrl = 'https://example.com/export';
  const redirectUrl = 'http://example.com/files/report.zip';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [
      { name: 'referer', value: 'https://example.com/form' },
      { name: 'cookie', value: 'sid=1' },
    ],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'main_frame',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });

  let state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);

  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'main_frame',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="report.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '4096' },
    ],
  });

  state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, redirectUrl);
  assert.equal(pending[0].filename, 'report.zip');
  assert.equal(pending[0].captureSource, 'redirect');
  assert.equal(pending[0].captureReason, 'content-disposition');
  assert.equal(pending[0].headers.cookie, 'sid=1');
});

test('POST redirect intent captures final response without extension from attachment headers', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const postUrl = 'https://files.example.com/file/token';
  const redirectUrl = 'http://download.example.com/file/token';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [
      { name: 'referer', value: postUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="official.iso"' },
      { name: 'content-type', value: 'application/octet-stream' },
      { name: 'content-length', value: '4096' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, redirectUrl);
  assert.equal(pending[0].filename, 'official.iso');
  assert.equal(pending[0].captureSource, 'redirect');
  assert.equal(pending[0].referrer, postUrl);
});

test('POST redirect intent prefers final content-disposition filename over hash URL filename', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'exe',
  });

  const postUrl = 'https://example.com/export';
  const redirectUrl = 'https://exe1.webgetstore.com/2026/06/09/c6e56503b33e4622cd97906bd491ea37.exe?sg=76ef179ee2802963d76a6e2cc388ad5d&e=6a2d76a5&fileName=Bandizip-Professional-7.44-x64-Repack.exe&fi=289780795';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [
      { name: 'referer', value: postUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: "attachment; filename*=UTF-8''Bandizip-Professional-7.44-x64-Repack.exe" },
      { name: 'content-type', value: 'application/octet-stream' },
      { name: 'content-length', value: '4096' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, redirectUrl);
  assert.equal(pending[0].filename, 'Bandizip-Professional-7.44-x64-Repack.exe');
  assert.equal(pending[0].captureSource, 'redirect');
  assert.equal(pending[0].captureReason, 'content-disposition');
});

test('legacy default extensions are upgraded to capture Windows ESD redirects', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: LEGACY_DEFAULT_CAPTURE_EXTENSIONS,
  });

  const postUrl = 'https://files.rg-adguard.net/file/token';
  const redirectUrl = 'http://dl.delivery.mp.microsoft.com/filestreamingservice/files/token/client_zh-cn.esd';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [
      { name: 'referer', value: postUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/octet-stream' },
      { name: 'content-length', value: '4096' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.match(state.config.captureExtensions, /(?:^|,)esd(?:,|$)/);
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, redirectUrl);
  assert.equal(pending[0].filename, 'client_zh-cn.esd');
  assert.equal(pending[0].captureSource, 'redirect');
  assert.equal(pending[0].captureReason, 'extension');
});

test('empty capture extension config stays empty instead of being upgraded', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: '',
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.captureExtensions, '');
});

test('POST redirect intent does not capture final HTML response', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    captureMime: true,
  });

  const postUrl = 'https://example.com/form-submit';
  const redirectUrl = 'https://example.com/success';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'text/html; charset=utf-8' },
      { name: 'content-length', value: '4096' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
});

test('POST redirect intent does not capture final JSON response', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    captureMime: true,
  });

  const postUrl = 'https://example.com/api/export';
  const redirectUrl = 'https://example.com/api/status';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/json' },
      { name: 'content-length', value: '512' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
});

test('POST redirect final response capture cancels browser filename prompt for redirected URL', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const postUrl = 'https://example.com/export';
  const redirectUrl = 'http://example.com/files/report.zip';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'main_frame',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'main_frame',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="report.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });

  const suggested = await invokeDeterminingFilename(background, {
    id: 28,
    url: redirectUrl,
    finalUrl: redirectUrl,
    filename: 'report.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.equal(suggested, true);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [28]);
});

test('POST redirect final response capture cancels browser filename prompt for original URL', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: LEGACY_DEFAULT_CAPTURE_EXTENSIONS,
  });

  const postUrl = 'https://files.rg-adguard.net/file/token';
  const redirectUrl = 'http://dl.delivery.mp.microsoft.com/filestreamingservice/files/token/client_zh-cn.esd';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/octet-stream' },
      { name: 'content-length', value: '6018724448' },
    ],
  });

  const suggested = await invokeDeterminingFilename(background, {
    id: 29,
    url: postUrl,
    filename: 'client_zh-cn.esd',
    mime: 'application/octet-stream',
    state: 'in_progress',
    totalBytes: 6018724448,
  });

  assert.equal(suggested, true);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [29]);
});

test('Aria2 pending response claim cancels browser filename prompt before popup finishes opening', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: LEGACY_DEFAULT_CAPTURE_EXTENSIONS,
  });
  background.chrome.action.openPopup = () => new Promise(() => {});

  const postUrl = 'https://files.rg-adguard.net/file/token';
  const redirectUrl = 'http://dl.delivery.mp.microsoft.com/filestreamingservice/files/token/client_zh-cn.esd';
  await invokeSendHeaders(background, {
    url: postUrl,
    tabId: 1,
    method: 'POST',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: postUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'POST',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: redirectUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: redirectUrl,
    tabId: 1,
    type: 'xmlhttprequest',
    method: 'GET',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/octet-stream' },
      { name: 'content-length', value: '6018724448' },
    ],
  });

  const suggested = await invokeDeterminingFilename(background, {
    id: 30,
    url: postUrl,
    filename: 'client_zh-cn.esd',
    mime: 'application/octet-stream',
    state: 'in_progress',
    totalBytes: 6018724448,
  });

  assert.equal(suggested, true);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [30]);
});

test('GET redirects are not captured from response headers before browser download creation', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  await invokeResponseHeaders(background, {
    url: 'https://example.com/link',
    tabId: 1,
    type: 'main_frame',
    method: 'GET',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: 'https://example.com/file.zip' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
});

test('attachment without extension or download mime is only marked until browser download is created', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    captureMime: true,
  });

  const url = 'https://example.com/export?id=1';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="export"' },
      { name: 'content-type', value: 'application/octet-stream' },
      { name: 'content-length', value: '4096' },
    ],
  });

  let state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);

  await invokeDownloadCreated(background, {
    id: 27,
    url,
    finalUrl: url,
    filename: 'export.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [27]);
  state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, url);
  assert.equal(pending[0].filename, 'export.zip');
});

test('attachment XHR responses are not sent directly to downloader', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    captureMime: true,
  });

  await invokeResponseHeaders(background, {
    url: 'https://example.com/api/report.zip',
    tabId: 1,
    type: 'xmlhttprequest',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="report.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '4096' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
});

test('passive media responses are not sent directly to downloader', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'mp4',
    captureMime: true,
  });

  await invokeResponseHeaders(background, {
    url: 'https://cdn.example.com/video.mp4',
    tabId: 1,
    type: 'media',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-length', value: '5242880' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
});

test('non-attachment archive responses are only marked until browser download is created', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    captureMime: true,
  });

  const url = 'https://cdn.example.com/app-data.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    type: 'xmlhttprequest',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '4096' },
    ],
  });

  let state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);

  await invokeDownloadCreated(background, {
    id: 23,
    url,
    finalUrl: url,
    filename: 'app-data.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [23]);
  state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, url);
});

test('attachment media responses are only marked until browser download is created', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'mp4',
    captureMime: true,
  });

  await invokeResponseHeaders(background, {
    url: 'https://cdn.example.com/download-video',
    tabId: 1,
    type: 'media',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="video.mp4"' },
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-length', value: '5242880' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
});

test('browser download fallback skips document mime even with captured extension', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    captureMime: true,
  });

  await invokeDownloadCreated(background, {
    id: 9,
    url: 'https://example.com/download.zip',
    finalUrl: 'https://example.com/download.zip',
    filename: 'download.zip',
    mime: 'application/xhtml+xml',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('small known downloads can stay in the browser when configured', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    skipSmallDownloads: true,
    smallDownloadThresholdBytes: 1024 * 1024,
  });

  await invokeDownloadCreated(background, {
    id: 19,
    url: 'https://example.com/small.zip',
    finalUrl: 'https://example.com/small.zip',
    filename: 'small.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 512 * 1024,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('small known response downloads can stay in the browser when configured', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    skipSmallDownloads: true,
    smallDownloadThresholdBytes: 1024 * 1024,
  });

  const url = 'https://example.com/small-response.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="small-response.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: String(512 * 1024) },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 22,
    url,
    finalUrl: url,
    filename: 'small-response.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 0,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('small Firefox response downloads still skip when download item reports unknown size', async () => {
  const background = loadBackgroundRuntime({
    __firefoxRuntime: true,
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    skipSmallDownloads: true,
    smallDownloadThresholdBytes: 1024 * 1024,
  });

  const url = 'https://example.com/firefox-small.zip';
  const results = await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="firefox-small.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: String(512 * 1024) },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 23,
    url,
    finalUrl: url,
    filename: 'firefox-small.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: -1,
  });

  assert.equal(results[0], undefined);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('unknown-size downloads are still captured when small-download skipping is enabled', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    skipSmallDownloads: true,
    smallDownloadThresholdBytes: 1024 * 1024,
  });

  await invokeDownloadCreated(background, {
    id: 20,
    url: 'https://example.com/unknown.zip',
    finalUrl: 'https://example.com/unknown.zip',
    filename: 'unknown.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 0,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [20]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, 'https://example.com/unknown.zip');
});

test('downloads at or above small-file threshold are still captured', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
    skipSmallDownloads: true,
    smallDownloadThresholdBytes: 1024 * 1024,
  });

  await invokeDownloadCreated(background, {
    id: 21,
    url: 'https://example.com/large.zip',
    finalUrl: 'https://example.com/large.zip',
    filename: 'large.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 1024 * 1024,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [21]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, 'https://example.com/large.zip');
});

test('Aria2 pending confirmation does not open a fallback window when action popup is blocked', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      autoCapture: true,
      aria2Silent: false,
      captureExtensions: 'zip',
    }
  );
  background.chrome.action.openPopup = async () => {
    background.chrome._actionCalls.openPopup += 1;
    throw new Error('openPopup requires user gesture');
  };

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.equal(background.chrome._actionCalls.openPopup, 1);
  assert.equal(background.chrome._windowsCalls.create.length, 0);
  assert.equal(background.chrome._tabsCalls.create.length, 0);
});

test('new-tab download confirmations focus the original clicked tab before opening popup', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      autoCapture: true,
      aria2Silent: false,
      captureExtensions: 'zip',
      captureMime: true,
    }
  );
  const artifactUrl = 'https://github.com/oceandrift7/YTLocalQueue/actions/runs/26190396891/artifacts/7121736843';
  const downloadUrl = 'https://objects.githubusercontent.com/github-production-release-asset/file.zip';

  const tracked = await invokeBackgroundMessage(
    background,
    {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: artifactUrl,
      filename: 'YTLocalQueue-deb',
    },
    { tab: { id: 12, windowId: 34 } }
  );
  assert.equal(tracked.ok, true);

  await invokeSendHeaders(background, {
    url: artifactUrl,
    tabId: 44,
    method: 'GET',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: artifactUrl,
    tabId: 44,
    type: 'main_frame',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: downloadUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: downloadUrl,
    tabId: 44,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="file.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '1024' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(JSON.stringify(background.chrome._windowsCalls.update), JSON.stringify([{ windowId: 34, opts: { focused: true } }]));
  assert.equal(JSON.stringify(background.chrome._tabsCalls.update), JSON.stringify([{ tabId: 12, opts: { active: true } }]));
  assert.equal(background.chrome._actionCalls.openPopup, 1);
  assert.equal(background.chrome._windowsCalls.create.length, 0);
  assert.equal(background.chrome._tabsCalls.create.length, 0);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(state.pending || {})[0]?.filename, 'YTLocalQueue-deb.zip');
});

test('tracked target-blank downloads opened from source tab focus the source tab popup', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      autoCapture: true,
      aria2Silent: false,
      captureExtensions: 'zip',
      captureMime: true,
    }
  );
  const downloadUrl = 'https://files.example.com/file.zip';

  const tracked = await invokeBackgroundMessage(
    background,
    {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: downloadUrl,
      filename: 'file.zip',
    },
    { tab: { id: 12, windowId: 34 } }
  );
  assert.equal(tracked.ok, true);

  await invokeSendHeaders(background, {
    url: downloadUrl,
    tabId: 12,
    method: 'GET',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: downloadUrl,
    tabId: 12,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="file.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '1024' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(JSON.stringify(background.chrome._windowsCalls.update), JSON.stringify([{ windowId: 34, opts: { focused: true } }]));
  assert.equal(JSON.stringify(background.chrome._tabsCalls.update), JSON.stringify([{ tabId: 12, opts: { active: true } }]));
  assert.equal(background.chrome._actionCalls.openPopup, 1);
});

test('low-quality clicked filenames do not replace generic server filenames', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      autoCapture: true,
      aria2Silent: false,
      captureExtensions: 'zip',
      captureMime: true,
    }
  );
  const artifactUrl = 'https://github.com/example/project/actions/runs/1/artifacts/2';
  const downloadUrl = 'https://objects.githubusercontent.com/github-production-release-asset/file.zip';

  const tracked = await invokeBackgroundMessage(
    background,
    {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: artifactUrl,
      filename: 'Download',
    },
    { tab: { id: 12, windowId: 34 } }
  );
  assert.equal(tracked.ok, true);

  await invokeSendHeaders(background, {
    url: artifactUrl,
    tabId: 44,
    method: 'GET',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: artifactUrl,
    tabId: 44,
    type: 'main_frame',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: downloadUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: downloadUrl,
    tabId: 44,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="file.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '1024' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(state.pending || {})[0]?.filename, 'file.zip');
});

test('download click intent is consumed by the first matching request', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      autoCapture: true,
      aria2Silent: false,
      captureExtensions: 'zip',
      captureMime: true,
    }
  );
  const artifactUrl = 'https://github.com/example/project/actions/runs/1/artifacts/2';
  const downloadUrl = 'https://objects.githubusercontent.com/github-production-release-asset/file.zip';

  const tracked = await invokeBackgroundMessage(
    background,
    {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: artifactUrl,
      filename: 'SourceArtifact',
    },
    { tab: { id: 12, windowId: 34 } }
  );
  assert.equal(tracked.ok, true);

  await invokeSendHeaders(background, {
    url: artifactUrl,
    tabId: 44,
    method: 'GET',
    requestHeaders: [],
  });
  await invokeSendHeaders(background, {
    url: artifactUrl,
    tabId: 45,
    method: 'GET',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: artifactUrl,
    tabId: 45,
    type: 'main_frame',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: downloadUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: downloadUrl,
    tabId: 45,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="file.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '1024' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(state.pending || {})[0]?.filename, 'file.zip');
});

test('automatic send failures do not open fallback task windows', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      autoCapture: true,
      captureExtensions: 'zip',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
    },
    {
      fetch: async () => {
        throw new Error('offline');
      },
    }
  );
  background.chrome.action.openPopup = async () => {
    background.chrome._actionCalls.openPopup += 1;
    throw new Error('openPopup requires user gesture');
  };

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/first.zip',
    filename: 'first.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });
  await invokeDownloadCreated(background, {
    id: 2,
    url: 'https://example.com/second.zip',
    filename: 'second.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.equal(background.chrome._actionCalls.openPopup, 2);
  assert.equal(background.chrome._windowsCalls.create.length, 0);
  assert.equal(background.chrome._tabsCalls.create.length, 0);
  assert.equal(background.chrome._notificationCalls.length, 1);
  assert.equal(background.chrome._notificationCalls[0].title, '与 AB DM 连接失败');
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

test('Aria2 pending confirmation forwards single threaded override options', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      autoCapture: true,
      aria2Silent: false,
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

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);

  const result = await invokeBackgroundMessage(background, {
    type: 'CONFIRM_DOWNLOAD',
    key: pending[0].key,
    filename: 'file.zip',
    opts: {
      split: '1',
      'max-connection-per-server': '1',
      'min-split-size': '1024M',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requestBody.method, 'aria2.addUri');
  assert.deepEqual(requestBody.params[1], {
    out: 'file.zip',
    split: '1',
    'max-connection-per-server': '1',
    'min-split-size': '1024M',
  });
});

test('NeatDM sends immediately after socket opens and ignores post-open socket errors', async () => {
  const sockets = [];
  class MockWebSocket {
    constructor(url, protocol) {
      this.url = url;
      this.protocol = protocol;
      this.sent = [];
      this.closed = false;
      sockets.push(this);
      setTimeout(() => {
        this.onopen?.();
        this.onerror?.(new Error('post-open close noise'));
      }, 0);
    }

    send(message) {
      this.sent.push(message);
    }

    close() {
      this.closed = true;
    }
  }

  const background = loadBackgroundRuntime(
    { downloaderType: 'neatdm' },
    { WebSocket: MockWebSocket }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_URL',
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    headers: {
      'content-type': 'application/zip',
    },
    referrer: 'https://example.com/page',
  });

  assert.equal(result.ok, true);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://127.0.0.1:10007/download');
  assert.equal(sockets[0].protocol, 'neatextension.v1');
  assert.equal(sockets[0].closed, true);
  assert.match(sockets[0].sent[0], /^1:GET\r\n2:https:\/\/example\.com\/file\.zip\r\n6:normal\r\n4:file\.zip\r\n/);
  assert.match(sockets[0].sent[0], /Content-Type: application\/zip\r\n/);
});

test('Gopeed intercepted downloads use pending confirmation and do not pass save path', async () => {
  let requestUrl = '';
  let requestHeaders = null;
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
      gopeedToken: 'secret-token',
      autoCapture: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async (url, options) => {
        requestUrl = url;
        requestHeaders = options.headers;
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { code: 0, data: { id: 'gopeed-task-1' } };
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

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);

  const result = await invokeBackgroundMessage(background, {
    type: 'CONFIRM_DOWNLOAD',
    key: pending[0].key,
    filename: 'file.zip',
    opts: {},
  });

  assert.equal(result.ok, true);
  assert.equal(requestUrl, 'http://127.0.0.1:9999/api/v1/tasks');
  assert.equal(requestHeaders['X-Api-Token'], 'secret-token');
  assert.deepEqual(requestBody, {
    req: {
      url: 'https://example.com/file.zip',
      extra: {
        header: {
          'accept-encoding': 'identity',
        },
      },
    },
    opts: {
      name: 'file.zip',
    },
  });
  assert.equal(Object.hasOwn(requestBody.opts, 'path'), false);
  assert.equal(Object.hasOwn(requestBody.req.extra.header, 'range'), false);

  const nextState = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(nextState.tasks['gopeed-task-1']?.provider, 'gopeed');
  assert.equal(nextState.tasks['gopeed-task-1']?.status, 'sent');
});

test('Gopeed single-thread confirmation passes connections only when requested', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
      autoCapture: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { code: 0, data: 'gopeed-task-1' };
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

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});

  await invokeBackgroundMessage(background, {
    type: 'CONFIRM_DOWNLOAD',
    key: pending[0].key,
    filename: 'file.zip',
    opts: { gopeedSingleThread: true },
  });

  assert.deepEqual(requestBody.opts.extra, { connections: 1 });
});

test('Gopeed task polling updates progress and status', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
      autoCapture: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async (url, options = {}) => {
        if (url === 'http://127.0.0.1:9999/api/v1/tasks' && options.method === 'POST') {
          return {
            ok: true,
            async json() {
              return { code: 0, data: { id: 'gopeed-task-1' } };
            },
          };
        }
        if (url === 'http://127.0.0.1:9999/api/v1/tasks' && options.method === 'GET') {
          return {
            ok: true,
            async json() {
              return {
                code: 0,
                data: [{
                  id: 'gopeed-task-1',
                  status: 'running',
                  size: 2048,
                  progress: {
                    downloaded: 1024,
                    speed: 512,
                  },
                  meta: {
                    req: { url: 'https://example.com/file.zip' },
                    res: {
                      size: 2048,
                      files: [{ name: 'server-file.zip', path: 'folder' }],
                    },
                    opts: {
                      name: 'file.zip',
                      extra: { connections: 1 },
                    },
                  },
                }],
              };
            },
          };
        }
        throw new Error(`unexpected fetch ${url}`);
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
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  await invokeBackgroundMessage(background, {
    type: 'CONFIRM_DOWNLOAD',
    key: pending[0].key,
    filename: 'file.zip',
    opts: { gopeedSingleThread: true },
  });

  await background.__backgroundTestHooks.pollTasks();

  const nextState = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(nextState.tasks['gopeed-task-1']?.status, 'active');
  assert.equal(nextState.tasks['gopeed-task-1']?.totalLength, 2048);
  assert.equal(nextState.tasks['gopeed-task-1']?.completedLength, 1024);
  assert.equal(nextState.tasks['gopeed-task-1']?.downloadSpeed, 512);
  assert.equal(nextState.tasks['gopeed-task-1']?.connections, 1);
  assert.equal(nextState.tasks['gopeed-task-1']?.filename, 'file.zip');
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
    filename: 'custom.zip',
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

test('MotrixNext response claim does not open popup after successful direct send', async () => {
  let requestedUrl = '';
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '16888',
      autoCapture: true,
      captureExtensions: 'zip',
      captureMime: true,
    },
    {
      fetch: async (url) => {
        requestedUrl = url;
        return { ok: true, status: 200 };
      },
    }
  );

  const url = 'https://example.com/file.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="file.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 1,
    url,
    filename: 'file.zip',
    mime: 'application/zip',
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
    filename: 'video-title.mp4',
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
    filename: 'video-title.mp4',
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
    filename: 'video-title.mp4',
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
    filename: 'video-title.mp4',
    referer: 'https://example.com/player',
    cookie: 'sid=abc123',
  });
});

test('Gopeed media send includes edited filename and required media headers', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { code: 0, data: 'gopeed-media-1' };
          },
        };
      },
    }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_1',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    pageUrl: 'https://example.com/watch/123',
    filename: 'video-title.mp4',
    headers: {
      cookie: 'sid=abc123',
      referer: 'https://example.com/player',
      range: 'bytes=0-',
      'user-agent': 'Browser UA',
    },
    mime: 'video/mp4',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_1',
    filename: 'edited-name.mp4',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requestBody, {
    req: {
      url: 'https://cdn.example.com/video.mp4',
      extra: {
        header: {
          cookie: 'sid=abc123',
          referer: 'https://example.com/player',
          'user-agent': 'Browser UA',
          'content-type': 'video/mp4',
          'accept-encoding': 'identity',
        },
      },
    },
    opts: {
      name: 'edited-name.mp4',
    },
  });
  assert.equal(Object.hasOwn(requestBody.req.extra.header, 'range'), false);
});

test('Gopeed media send falls back to page URL as referer', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { code: 0, data: 'gopeed-media-1' };
          },
        };
      },
    }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_1',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    pageUrl: 'https://example.com/watch/123',
    filename: 'video-title.mp4',
    headers: {},
    mime: 'video/mp4',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_1',
  });

  assert.equal(result.ok, true);
  assert.equal(requestBody.req.extra.header.referer, 'https://example.com/watch/123');
});

test('Gopeed manual URL send forwards method body and labels', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { code: 0, data: 'gopeed-manual-1' };
          },
        };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_URL',
    url: 'https://example.com/export',
    filename: 'export.bin',
    method: 'POST',
    body: 'token=abc',
    labels: { source: 'downlink' },
    headers: {
      Referer: 'https://example.com/form',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(requestBody, {
    req: {
      url: 'https://example.com/export',
      extra: {
        header: {
          referer: 'https://example.com/form',
          'content-type': 'application/x-www-form-urlencoded',
          'accept-encoding': 'identity',
        },
        method: 'POST',
        body: 'token=abc',
      },
      labels: { source: 'downlink' },
    },
    opts: {
      name: 'export.bin',
    },
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
  assert.equal(requestBody.folder, undefined);
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

test('user-triggered send failure only exposes task alert', async () => {
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
  assert.equal(background.chrome._actionCalls.openPopup, 0);
  assert.equal(background.chrome._windowsCalls.create.length, 0);
  assert.equal(background.chrome._tabsCalls.create.length, 0);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.uiAlert?.message, '与 AB DM 连接失败，检查 AB DM 是否正在运行');
});

test('pending confirmation send failure does not open a new task surface', async () => {
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

  await invokeContextMenuClick(background, {
    menuItemId: 'send-to-aria2',
    linkUrl: 'https://example.com/file.zip',
  }, {
    id: 1,
    url: 'https://example.com/page',
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);

  background.chrome._actionCalls.openPopup = 0;
  const result = await invokeBackgroundMessage(background, {
    type: 'CONFIRM_DOWNLOAD',
    key: pending[0].key,
    filename: 'file.zip',
  });

  assert.equal(result.ok, false);
  assert.equal(background.chrome._actionCalls.openPopup, 0);
  assert.equal(background.chrome._windowsCalls.create.length, 0);
  assert.equal(background.chrome._tabsCalls.create.length, 0);

  const nextState = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(nextState.pending || {}).length, 1);
  assert.equal(nextState.uiAlert?.message, '与 AB DM 连接失败，检查 AB DM 是否正在运行');
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

test('Gopeed connection test uses incoming API and token', async () => {
  let requestUrl = '';
  let requestHeaders = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
      gopeedToken: 'saved-token',
    },
    {
      fetch: async (url, options = {}) => {
        requestUrl = url;
        requestHeaders = options.headers || {};
        return {
          ok: true,
          async json() {
            return { code: 0, data: { version: '1.6.8' } };
          },
        };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'TEST_CONNECTION',
    config: {
      downloaderType: 'gopeed',
      gopeedApi: 'http://10.0.0.5:9999/',
      gopeedToken: 'live-token',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'gopeed');
  assert.equal(requestUrl, 'http://10.0.0.5:9999/api/v1/info');
  assert.equal(requestHeaders['X-Api-Token'], 'live-token');
});

test('config save falls back to local storage when sync storage is unavailable', async () => {
  const background = loadBackgroundRuntime({ __syncShouldFail: true });

  const result = await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      downloaderType: 'motrixnext',
      motrixNextPort: '16888',
      motrixNextSecret: 'live-secret',
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._localStorageWrites)), [
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '16888',
      motrixNextSecret: 'live-secret',
    },
  ]);
});

test('disabling auto capture pauses active tab sniffing and shows disabled badge', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    __activeTabs: [{ id: 12, windowId: 3, active: true }],
  });

  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_12',
    tabId: 12,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    filename: 'video.mp4',
    mime: 'video/mp4',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      autoCapture: false,
    },
  });

  assert.equal(result.ok, true);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.pausedTabs)), [12]);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '✕', tabId: 12 });
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeBackgroundColor.at(-1))), { color: '#6b7280', tabId: 12 });
});

test('enabling auto capture resumes tabs paused by the auto capture switch', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    __activeTabs: [{ id: 12, windowId: 3, active: true }],
  });

  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_12',
    tabId: 12,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    filename: 'video.mp4',
    mime: 'video/mp4',
  });

  await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      autoCapture: false,
    },
  });
  const disabledState = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.deepEqual(JSON.parse(JSON.stringify(disabledState.pausedTabs)), [12]);

  const result = await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      autoCapture: true,
    },
  });

  assert.equal(result.ok, true);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.pausedTabs)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '1', tabId: 12 });
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeBackgroundColor.at(-1))), { color: '#e05c2a', tabId: 12 });
});

test('storage auto capture changes pause active tab sniffing and update the badge', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    __activeTabs: [{ id: 12, windowId: 3, active: true }],
  });

  assert.equal(typeof background.chrome._listeners.storageOnChanged, 'function');
  background.chrome._listeners.storageOnChanged({
    autoCapture: { oldValue: true, newValue: false },
  }, 'sync');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.pausedTabs)), [12]);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '✕', tabId: 12 });
});

test('command toggles auto capture and keeps sniffing state in sync', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    __activeTabs: [{ id: 12, windowId: 3, active: true }],
  });

  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_12',
    tabId: 12,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    filename: 'video.mp4',
    mime: 'video/mp4',
  });

  assert.equal(typeof background.chrome._listeners.commandsOnCommand, 'function');
  background.chrome._listeners.commandsOnCommand('toggle-auto-capture');
  await background.__backgroundTestHooks.waitForAutoCaptureToggle();

  let state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, false);
  assert.deepEqual(JSON.parse(JSON.stringify(state.pausedTabs)), [12]);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '✕', tabId: 12 });

  background.chrome._listeners.commandsOnCommand('toggle-auto-capture');
  await background.__backgroundTestHooks.waitForAutoCaptureToggle();

  state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.pausedTabs)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '1', tabId: 12 });
});

test('rapid auto capture shortcut presses are applied sequentially', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    __activeTabs: [{ id: 12, windowId: 3, active: true }],
  });

  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_12',
    tabId: 12,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    filename: 'video.mp4',
    mime: 'video/mp4',
  });

  assert.equal(typeof background.chrome._listeners.commandsOnCommand, 'function');
  background.chrome._listeners.commandsOnCommand('toggle-auto-capture');
  background.chrome._listeners.commandsOnCommand('toggle-auto-capture');
  await background.__backgroundTestHooks.waitForAutoCaptureToggle();

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.pausedTabs)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '1', tabId: 12 });
});
