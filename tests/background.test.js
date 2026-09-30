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
  const runtimeMessages = [];
  const localStorageWrites = [];
  const syncShouldFail = storedConfig.__syncShouldFail;
  const badgeError = storedConfig.__badgeError;
  const throwOnDeterminingFilenameAccess = storedConfig.__throwOnDeterminingFilenameAccess;
  const storedValues = { ...storedConfig };
  delete storedValues.__syncShouldFail;
  delete storedValues.__firefoxRuntime;
  delete storedValues.__throwOnDeterminingFilenameAccess;
  delete storedValues.__activeTabs;
  delete storedValues.__tabsById;
  delete storedValues.__badgeError;
  let runtimeApi;

  const downloadsApi = {
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
  };

  if (throwOnDeterminingFilenameAccess) {
    Object.defineProperty(downloadsApi, 'onDeterminingFilename', {
      configurable: true,
      get() {
        throw new Error('onDeterminingFilename should not be read');
      },
    });
  }

  const chromeStub = {
    _listeners: listeners,
    _actionCalls: actionCalls,
    _tabsCalls: tabsCalls,
    _windowsCalls: windowsCalls,
    _notificationCalls: notificationCalls,
    _downloadCalls: downloadCalls,
    _dnrCalls: dnrCalls,
    _runtimeMessages: runtimeMessages,
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
        if (badgeError) return Promise.reject(new Error(badgeError));
      },
      setBadgeTextColor(payload) {
        actionCalls.setBadgeTextColor.push(payload);
        if (badgeError) return Promise.reject(new Error(badgeError));
      },
      setBadgeText(payload) {
        actionCalls.setBadgeText.push(payload);
        if (badgeError) return Promise.reject(new Error(badgeError));
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
    downloads: downloadsApi,
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
      sendMessage(message) {
        runtimeMessages.push(message);
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
      ...(storedConfig.__tabMessageResponse ? {
        sendMessage(tabId, message, callback) {
          const response = storedConfig.__tabMessageResponse(tabId, message);
          Promise.resolve(response).then((value) => callback?.(value));
        },
      } : {}),
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
  if (options.storage) Object.assign(chrome.storage, options.storage);
  const context = {
    console: options.console || console,
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
  assert.equal(background.isDirectMediaResource('https://cdn.example.com/live.flv', 'video/x-flv', ''), true);
});

test('media sniffing recognizes HLS and DASH manifests by extension or MIME', () => {
  const background = loadBackgroundRuntime();
  assert.equal(background.isDirectMediaResource('https://cdn.example.com/master.m3u8?token=1', '', ''), true);
  assert.equal(background.isDirectMediaResource('https://cdn.example.com/manifest', 'application/dash+xml', ''), true);
  assert.equal(background.BackgroundShared.streamProtocolOf('https://cdn.example.com/master.m3u8', '', ''), 'hls');
  assert.equal(background.BackgroundShared.streamProtocolOf('https://cdn.example.com/manifest', 'application/dash+xml', ''), 'dash');
});

test('media sniffing ignores remote HLS requests made by extension pages in every browser', async () => {
  const background = loadBackgroundRuntime({
    __tabsById: {
      10: { id: 10, url: 'chrome-extension://extension-id/preview.html' },
      11: { id: 11, url: 'moz-extension://extension-id/preview.html' },
      12: { id: 12, url: 'safari-web-extension://extension-id/preview.html' },
    },
  });
  const manager = background.__backgroundTestHooks.mediaManager;
  const responseHeaders = [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }];

  for (const [tabId, initiator] of [
    [10, 'chrome-extension://extension-id'],
    [11, 'moz-extension://extension-id'],
    [12, 'safari-web-extension://extension-id'],
  ]) {
    await manager.handleMediaResponse({
      url: `https://cdn.example.com/live/${tabId}/master.m3u8`,
      tabId,
      frameId: 0,
      statusCode: 200,
      initiator,
      responseHeaders,
    });
    assert.deepEqual(manager.getState().media[tabId] || [], []);
    assert.equal(manager.getState().badgeCounts[tabId] || 0, 0);
  }
});

test('extension-tab URL prevents recursive sniffing when webRequest omits the initiator', async () => {
  const background = loadBackgroundRuntime({
    __tabsById: {
      13: { id: 13, url: 'safari-web-extension://extension-id/preview.html' },
    },
  });
  const manager = background.__backgroundTestHooks.mediaManager;

  await manager.handleMediaResponse({
    url: 'https://cdn.example.com/live/master.m3u8',
    tabId: 13,
    frameId: 0,
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });

  assert.deepEqual(manager.getState().media[13] || [], []);
  assert.equal(manager.getState().badgeCounts[13] || 0, 0);
});

test('media sniffing normalizes a misreported HLS document MIME', async () => {
  const background = loadBackgroundRuntime();
  const manager = background.__backgroundTestHooks.mediaManager;

  await manager.handleMediaResponse({
    url: 'https://cdn.example.com/episode/index.m3u8?token=1',
    tabId: 3,
    frameId: 0,
    statusCode: 200,
    initiator: 'https://example.com',
    responseHeaders: [
      { name: 'content-type', value: 'text/html; charset=utf-8' },
      { name: 'content-length', value: '512' },
    ],
  });

  const media = manager.getState().media[3];
  assert.equal(media.length, 1);
  assert.equal(media[0].streamProtocol, 'hls');
  assert.equal(media[0].mime, 'application/vnd.apple.mpegurl');
});

test('media sniffing unwraps an HTML resolver URL that contains an absolute HLS manifest', async () => {
  const background = loadBackgroundRuntime();
  const manager = background.__backgroundTestHooks.mediaManager;
  const manifestUrl = 'https://v14.example.com/video/index.m3u8';

  await manager.handleMediaResponse({
    url: `https://resolver.example.com/m3u8/?url=${encodeURIComponent(manifestUrl)}`,
    tabId: 4,
    frameId: 0,
    statusCode: 200,
    initiator: 'https://example.com',
    responseHeaders: [{ name: 'content-type', value: 'text/html' }],
  });

  const media = manager.getState().media[4];
  assert.equal(media.length, 1);
  assert.equal(media[0].resourceUrl, manifestUrl);
  assert.equal(media[0].filename, 'example.com-index.m3u8');
  assert.equal(media[0].streamProtocol, 'hls');
  assert.equal(media[0].mime, 'application/vnd.apple.mpegurl');
});

test('cross-origin manifest unwrapping does not forward resolver credentials', async () => {
  const background = loadBackgroundRuntime();
  const manager = background.__backgroundTestHooks.mediaManager;
  const wrapperUrl = 'https://resolver.example.com/m3u8/?url=https%3A%2F%2Fcdn.example.net%2Findex.m3u8';

  await invokeSendHeaders(background, {
    url: wrapperUrl,
    tabId: 3,
    method: 'GET',
    requestHeaders: [
      { name: 'Cookie', value: 'resolver_session=secret' },
      { name: 'Authorization', value: 'Bearer resolver-secret' },
      { name: 'X-Resolver-Token', value: 'resolver-token' },
      { name: 'Referer', value: 'https://example.com/watch' },
      { name: 'User-Agent', value: 'Browser UA' },
    ],
  });
  await manager.handleMediaResponse({
    url: wrapperUrl,
    tabId: 3,
    frameId: 0,
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'text/html' }],
  });

  const [media] = manager.getState().media[3];
  assert.equal(media.resourceUrl, 'https://cdn.example.net/index.m3u8');
  assert.deepEqual(JSON.parse(JSON.stringify(media.headers)), {
    referer: 'https://example.com/watch',
    'user-agent': 'Browser UA',
  });
});

test('media list adds a stable suffix when distinct resources resolve to the same filename', () => {
  const background = loadBackgroundRuntime();
  const manager = background.__backgroundTestHooks.mediaManager;
  for (const resourceUrl of [
    'https://one.example.com/video/index.m3u8',
    'https://two.example.com/video/index.m3u8',
  ]) {
    manager.upsertMediaResource({
      id: `media_${resourceUrl}`,
      tabId: 3,
      resourceUrl,
      filename: 'index.m3u8',
      pageTitle: '同一页面',
      kind: 'video',
    });
  }

  const filenames = manager.getState().media[3].map((item) => item.filename);
  assert.equal(new Set(filenames).size, 2);
  assert.ok(filenames.includes('同一页面-index.m3u8'));
  assert.ok(filenames.some((name) => /^同一页面-index-[a-z0-9]{6}\.m3u8$/.test(name)));
});

test('HLS master metadata merges a captured variant and removes its duplicate card', () => {
  const background = loadBackgroundRuntime();
  const manager = background.__backgroundTestHooks.mediaManager;
  const masterUrl = 'https://cdn.example.com/video/master.m3u8';
  const variantUrl = 'https://cdn.example.com/video/index-r4ndhb.m3u8';
  manager.upsertMediaResource({
    id: 'media_variant', tabId: 3, resourceUrl: variantUrl,
    filename: 'index-r4ndhb.m3u8', pageTitle: '播放器', kind: 'video', streamProtocol: 'hls',
  });
  manager.upsertMediaResource({
    id: 'media_master', tabId: 3, resourceUrl: masterUrl,
    filename: 'master.m3u8', pageTitle: '播放器', kind: 'video', streamProtocol: 'hls',
  });

  manager.updateMediaMetadata('media_master', {
    width: 1920,
    height: 960,
    variantUrls: [variantUrl],
    metadataFailed: false,
  });
  assert.equal(manager.getState().media[3].length, 2);

  manager.updateMediaMetadata('media_variant', {
    duration: 3589,
    isLive: false,
    width: 0,
    height: 0,
    metadataFailed: false,
  });

  const media = manager.getState().media[3];
  assert.equal(media.length, 1);
  assert.equal(media[0].id, 'media_master');
  assert.equal(media[0].width, 1920);
  assert.equal(media[0].height, 960);
  assert.equal(media[0].duration, 3589);
  assert.equal(media[0].isLive, false);
  assert.equal(manager.getState().badgeCounts[3], 1);
});

test('known HLS variants allow the first capture and suppress refreshes after metadata merges', async () => {
  const background = loadBackgroundRuntime();
  const manager = background.__backgroundTestHooks.mediaManager;
  const masterUrl = 'https://cdn.example.com/live/master.m3u8';
  const variantUrl = 'https://cdn.example.com/live/index.m3u8';
  manager.upsertMediaResource({
    id: 'media_live_master', tabId: 3, resourceUrl: masterUrl,
    filename: 'master.m3u8', kind: 'video', streamProtocol: 'hls',
  });
  manager.updateMediaMetadata('media_live_master', {
    width: 1280,
    height: 720,
    variantUrls: [variantUrl],
    metadataFailed: false,
  });

  const response = {
    url: variantUrl,
    tabId: 3,
    frameId: 0,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/vnd.apple.mpegurl' },
      { name: 'content-length', value: '4096' },
    ],
  };
  await manager.handleMediaResponse(response);
  assert.equal(manager.getState().media[3].length, 2);

  const variant = manager.getState().media[3].find((item) => item.resourceUrl === variantUrl);
  manager.updateMediaMetadata(variant.id, {
    duration: 30,
    isLive: true,
    width: 0,
    height: 0,
    metadataFailed: false,
  });
  assert.equal(manager.getState().media[3].length, 1);

  await manager.handleMediaResponse(response);

  const media = manager.getState().media[3];
  assert.equal(media.length, 1);
  assert.equal(media[0].id, 'media_live_master');
  assert.equal(media[0].duration, 30);
  assert.equal(media[0].isLive, true);
});

test('background HLS probing publishes only the merged master item', async () => {
  const masterUrl = 'https://cdn.example.com/show/master.m3u8';
  const variantUrl = 'https://cdn.example.com/show/video.m3u8';
  const background = loadBackgroundRuntime({
    __tabMessageResponse(_tabId, message) {
      if (message.resourceUrl === masterUrl) {
        return {
          ok: true, width: 1920, height: 1080, duration: 0,
          kind: 'video', variantUrls: [variantUrl],
        };
      }
      return { ok: true, width: 0, height: 0, duration: 120, isLive: false, kind: 'video', variantUrls: [] };
    },
  });
  const manager = background.__backgroundTestHooks.mediaManager;
  const responseHeaders = [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }];

  await manager.handleMediaResponse({ url: masterUrl, tabId: 3, frameId: 0, statusCode: 200, responseHeaders });
  await manager.handleMediaResponse({ url: variantUrl, tabId: 3, frameId: 0, statusCode: 200, responseHeaders });
  assert.equal(manager.getState().media[3].length, 0);

  await new Promise((resolve) => setTimeout(resolve, 250));
  const media = manager.getState().media[3];
  assert.equal(media.length, 1);
  assert.equal(media[0].resourceUrl, masterUrl);
  assert.equal(media[0].width, 1920);
  assert.equal(media[0].height, 1080);
  assert.equal(media[0].duration, 120);
  assert.equal(media[0].metadataProbed, true);
  assert.equal(manager.getState().badgeCounts[3], 1);
});

test('a slow HLS variant does not keep a resolved master hidden', async () => {
  const masterUrl = 'https://cdn.example.com/show/master.m3u8';
  const variantUrl = 'https://cdn.example.com/show/video.m3u8';
  let resolveVariant;
  const background = loadBackgroundRuntime({
    __tabMessageResponse(_tabId, message) {
      if (message.resourceUrl === masterUrl) {
        return {
          ok: true, width: 1920, height: 1080, duration: 0,
          kind: 'video', variantUrls: [variantUrl],
        };
      }
      return new Promise((resolve) => { resolveVariant = resolve; });
    },
  });
  const manager = background.__backgroundTestHooks.mediaManager;
  const responseHeaders = [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }];

  await manager.handleMediaResponse({ url: masterUrl, tabId: 3, frameId: 0, statusCode: 200, responseHeaders });
  await manager.handleMediaResponse({ url: variantUrl, tabId: 3, frameId: 0, statusCode: 200, responseHeaders });
  await new Promise((resolve) => setTimeout(resolve, 250));

  let media = manager.getState().media[3];
  assert.equal(media.length, 1);
  assert.equal(media[0].resourceUrl, masterUrl);
  assert.equal(media[0].width, 1920);
  assert.equal(manager.getState().badgeCounts[3], 1);

  resolveVariant({
    ok: true, width: 0, height: 0, duration: 120,
    isLive: false, kind: 'video', variantUrls: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  media = manager.getState().media[3];
  assert.equal(media.length, 1);
  assert.equal(media[0].resourceUrl, masterUrl);
  assert.equal(media[0].duration, 120);
});

test('a resolved HLS child stays hidden while an unclassified master is probing', async () => {
  const masterUrl = 'https://cdn.example.com/show/master.m3u8';
  const variantUrl = 'https://cdn.example.com/show/video.m3u8';
  let resolveMaster;
  const background = loadBackgroundRuntime({
    __tabMessageResponse(_tabId, message) {
      if (message.resourceUrl === masterUrl) {
        return new Promise((resolve) => { resolveMaster = resolve; });
      }
      return {
        ok: true, width: 0, height: 0, duration: 120,
        isLive: false, kind: 'video', variantUrls: [],
      };
    },
  });
  const manager = background.__backgroundTestHooks.mediaManager;
  const responseHeaders = [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }];

  await manager.handleMediaResponse({ url: variantUrl, tabId: 3, frameId: 0, statusCode: 200, responseHeaders });
  await manager.handleMediaResponse({ url: masterUrl, tabId: 3, frameId: 0, statusCode: 200, responseHeaders });
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.equal(manager.getState().media[3].length, 0);

  resolveMaster({
    ok: true, width: 1920, height: 1080, duration: 0,
    kind: 'video', variantUrls: [variantUrl],
  });
  await new Promise((resolve) => setTimeout(resolve, 250));

  const media = manager.getState().media[3];
  assert.equal(media.length, 1);
  assert.equal(media[0].resourceUrl, masterUrl);
  assert.equal(media[0].duration, 120);
  assert.equal(media[0].width, 1920);
  assert.equal(manager.getState().badgeCounts[3], 1);
});

test('a stalled HLS probe falls back to a visible sniffed resource promptly', async () => {
  const background = loadBackgroundRuntime({
    __tabMessageResponse() {
      return new Promise(() => {});
    },
  });
  const manager = background.__backgroundTestHooks.mediaManager;
  const resourceUrl = 'https://cdn.example.com/show/master.m3u8';

  await manager.handleMediaResponse({
    url: resourceUrl,
    tabId: 3,
    frameId: 0,
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'application/vnd.apple.mpegurl' }],
  });
  assert.equal(manager.getState().media[3].length, 0);

  await new Promise((resolve) => setTimeout(resolve, 1050));
  const media = manager.getState().media[3];
  assert.equal(media.length, 1);
  assert.equal(media[0].resourceUrl, resourceUrl);
  assert.equal(media[0].metadataPending, true);
  assert.equal(manager.getState().badgeCounts[3], 1);
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
  assert.deepEqual(Array.from(addCall.addRules[0].condition.resourceTypes), ['media', 'xmlhttprequest', 'other']);
  const cleanupTimer = timers.find((timer) => timer.delay === 15000);
  assert.ok(cleanupTimer);

  cleanupTimer.callback();
  await Promise.resolve();

  const removeCall = background.chrome._dnrCalls.find((call) =>
    call.removeRuleIds?.includes(addCall.addRules[0].id) && !call.addRules
  );
  assert.ok(removeCall);
});

test('HLS preview header rule covers same-origin playlists and segments only in the preview tab', async () => {
  const background = loadBackgroundRuntime();
  const manager = background.__backgroundTestHooks.mediaManager;
  const resourceUrl = 'https://cdn.example.com/live/master.m3u8?token=1';
  manager.upsertMediaResource({
    id: 'media_hls_preview',
    tabId: 3,
    resourceUrl,
    filename: 'master.m3u8',
    kind: 'video',
    streamProtocol: 'hls',
    headers: {
      referer: 'https://example.com/watch',
      cookie: 'sid=1',
    },
  });

  const media = manager.findMediaResourceById('media_hls_preview');
  const result = await manager.preparePreviewRule(99, media);

  assert.equal(result.ok, true);
  const addCall = background.chrome._dnrCalls.find((call) => call.addRules?.length);
  assert.ok(addCall);
  assert.equal(addCall.addRules[0].condition.regexFilter, '^https://cdn\\.example\\.com/');
  assert.deepEqual(Array.from(addCall.addRules[0].condition.tabIds), [99]);
  assert.deepEqual(Array.from(addCall.addRules[0].condition.resourceTypes), ['media', 'xmlhttprequest', 'other']);
});

test('hover preview header rule stays active until explicitly cleared', async () => {
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
  const result = await invokeBackgroundMessage(background, { type: 'PREPARE_MEDIA_HOVER_PREVIEW', id: media.id });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.headersApplied), ['referer', 'cookie']);
  const addCall = background.chrome._dnrCalls.find((call) => call.addRules?.length);
  assert.ok(addCall);
  assert.equal(addCall.addRules[0].condition.tabIds, undefined);
  assert.equal(addCall.addRules[0].priority, 2);
  assert.deepEqual(Array.from(addCall.addRules[0].condition.resourceTypes), ['media', 'xmlhttprequest', 'other']);
  assert.equal(timers.filter((timer) => timer.delay === 15000).length, 0);

  const clearResult = await invokeBackgroundMessage(background, { type: 'CLEAR_MEDIA_HOVER_PREVIEW', id: media.id });
  assert.equal(clearResult.ok, true);
  const removeCall = background.chrome._dnrCalls.find((call) =>
    call.removeRuleIds?.includes(addCall.addRules[0].id) && !call.addRules
  );
  assert.ok(removeCall);
});

test('preview header rule falls back to the source page referer', async () => {
  const background = loadBackgroundRuntime();
  const media = {
    id: 'media_fallback',
    tabId: 3,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    pageUrl: 'https://example.com/watch/123',
    filename: 'video.mp4',
    kind: 'video',
    headers: {},
  };
  background.__backgroundTestHooks.mediaManager.upsertMediaResource(media);

  const result = await invokeBackgroundMessage(background, {
    type: 'PREPARE_MEDIA_HOVER_PREVIEW',
    id: media.id,
  });

  assert.deepEqual(Array.from(result.headersApplied), ['referer']);
  const rule = background.chrome._dnrCalls.find((call) => call.addRules?.length)?.addRules[0];
  assert.equal(rule.action.requestHeaders[0].value, media.pageUrl);
  const active = background.__backgroundTestHooks.mediaManager.getActivePreviewRequestInfo(media.resourceUrl);
  assert.deepEqual(Array.from(active.modes), ['hover']);
  assert.deepEqual(Array.from(active.expectedHeaders), ['referer']);
  await invokeBackgroundMessage(background, { type: 'CLEAR_MEDIA_HOVER_PREVIEW', id: media.id });
});

test('media metadata header rules are installed in one batch', async () => {
  const background = loadBackgroundRuntime();
  const media = [
    {
      id: 'media_1',
      tabId: 3,
      resourceUrl: 'https://cdn.example.com/video.mp4',
      filename: 'video.mp4',
      kind: 'video',
      headers: { referer: 'https://example.com/watch' },
    },
    {
      id: 'media_2',
      tabId: 3,
      resourceUrl: 'https://cdn.example.com/audio.m4a',
      filename: 'audio.m4a',
      kind: 'audio',
      headers: { referer: 'https://example.com/watch' },
    },
  ];
  media.forEach((item) => background.__backgroundTestHooks.mediaManager.upsertMediaResource(item));

  const result = await invokeBackgroundMessage(background, {
    type: 'PREPARE_MEDIA_METADATA_BATCH',
    ids: media.map((item) => item.id),
  });

  assert.equal(result.ok, true);
  assert.deepEqual(Array.from(result.items, (item) => item.id), ['media_1', 'media_2']);
  const addCalls = background.chrome._dnrCalls.filter((call) => call.addRules?.length);
  assert.equal(addCalls.length, 1);
  assert.equal(addCalls[0].addRules.length, 2);
  for (const item of media) {
    await invokeBackgroundMessage(background, { type: 'CLEAR_MEDIA_METADATA', id: item.id });
  }
});

test('media metadata batch allocates unique rule IDs when hashes collide', async () => {
  const background = loadBackgroundRuntime();
  const manager = background.BackgroundMedia.createMediaManager({
    fallbackMediaFilename: (media) => media.filename,
    escapeRegex: background.BackgroundShared.escapeRegex,
    hashString: () => '1',
    totalSizeFromHeaders: () => 0,
    mediaKindOf: () => 'video',
    deriveOrigin: () => '',
    updateActionBadgeForTab() {},
    broadcastUpdate() {},
    getRequestHeaders: () => ({}),
    getTabSnapshot: async () => ({}),
  });
  const media = ['one', 'two'].map((suffix) => ({
    id: `media_${suffix}`,
    tabId: 3,
    resourceUrl: `https://cdn.example.com/${suffix}.mp4`,
    filename: `${suffix}.mp4`,
    headers: { referer: 'https://example.com/watch' },
  }));

  await manager.prepareMetadataRules(media);

  const ruleIds = background.chrome._dnrCalls.at(-1).addRules.map((rule) => rule.id);
  assert.equal(new Set(ruleIds).size, media.length);
});

test('popup state only serializes media for the requested tab', async () => {
  const background = loadBackgroundRuntime();
  const mediaManager = background.__backgroundTestHooks.mediaManager;
  mediaManager.upsertMediaResource({
    id: 'media_3',
    tabId: 3,
    resourceUrl: 'https://cdn.example.com/three.mp4',
    filename: 'three.mp4',
    kind: 'video',
  });
  mediaManager.upsertMediaResource({
    id: 'media_4',
    tabId: 4,
    resourceUrl: 'https://cdn.example.com/four.mp4',
    filename: 'four.mp4',
    kind: 'video',
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE', tabId: 3 });

  assert.deepEqual(Object.keys(state.media), ['3']);
  assert.equal(state.media[3][0].id, 'media_3');
});

test('rapid media discoveries are coalesced into one tab-scoped update', async () => {
  const background = loadBackgroundRuntime();
  for (const suffix of ['one', 'two']) {
    await invokeResponseHeaders(background, {
      url: `https://cdn.example.com/${suffix}.mp4`,
      tabId: 3,
      frameId: 0,
      statusCode: 200,
      responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
    });
  }

  await new Promise((resolve) => setTimeout(resolve, 80));

  const updates = background.chrome._runtimeMessages.filter((message) => message?.type === 'TASKS_UPDATE');
  assert.equal(updates.length, 1);
  assert.equal(updates[0].mediaPatch, true);
  assert.deepEqual(Object.keys(updates[0].media), ['3']);
  assert.equal(updates[0].media[3].length, 2);
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

test('browser download capture does not erase an id missing during the pre-cancel search', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });
  background.chrome.downloads.search = (_query, callback) => callback?.([]);

  await invokeDownloadCreated(background, {
    id: 404,
    url: 'https://example.com/missing.zip',
    filename: 'missing.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  assert.deepEqual(background.chrome._downloadCalls.erase, []);
});

test('browser download capture does not erase after cancel reports Invalid downloadId', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });
  background.chrome.downloads.cancel = (_id, callback) => {
    background.chrome._downloadCalls.cancel.push(_id);
    background.chrome.runtime.lastError = { message: 'Invalid downloadId' };
    callback?.();
    background.chrome.runtime.lastError = null;
  };

  await invokeDownloadCreated(background, {
    id: 405,
    url: 'https://example.com/vanished.zip',
    filename: 'vanished.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [405]);
  assert.deepEqual(background.chrome._downloadCalls.erase, []);
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

test('browser download interception decodes tiktok content-disposition filename', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/download/tiktok';
  const contentDisposition = 'attachment; filename="TikTok_ASD+Vibe_@tkdashen.zip"; filename*=UTF-8\'\'TikTok_ASD%2BVibe_%40tkdashen.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    responseHeaders: [
      { name: 'content-disposition', value: contentDisposition },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '2038816' },
    ],
  });
  await invokeDownloadCreated(background, {
    id: 93,
    url,
    finalUrl: url,
    filename: '/Downloads/download.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 2038816,
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].filename, 'TikTok_ASD+Vibe_@tkdashen.zip');
  assert.equal(pending[0].contentDisposition, contentDisposition);
});

test('browser download interception waits for determined filename when created item is empty', async () => {
  const order = [];
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });
  const originalCancel = background.chrome.downloads.cancel;
  const originalOpenPopup = background.chrome.action.openPopup;
  background.chrome.downloads.cancel = (id, callback) => {
    order.push('cancel');
    originalCancel(id, () => {
      order.push('cancel-callback');
      callback?.();
    });
  };
  background.chrome.action.openPopup = () => {
    order.push('open-popup');
    return originalOpenPopup();
  };

  const url = 'https://files.example.com/k/d/1715544219';
  await invokeDownloadCreated(background, {
    id: 1847,
    url,
    finalUrl: url,
    filename: '',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 2038816,
    danger: 'safe',
    exists: true,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  let state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);

  const suggested = await invokeDeterminingFilename(background, {
    id: 1847,
    url,
    finalUrl: url,
    filename: '/Downloads/TikTok_ASD+Vibe_@tkdashen.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 2038816,
    danger: 'safe',
    exists: true,
  });

  assert.equal(suggested, false);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [1847]);
  state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].filename, 'TikTok_ASD+Vibe_@tkdashen.zip');
  assert.deepEqual(order, ['cancel', 'cancel-callback', 'open-popup']);
});

test('browser download interception leaves blob downloads in the browser', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'mp4',
  });

  const url = 'blob:https://ffmpeg.bmmmd.com/52158164-af08-4b5e-b4d2-05589db9f298';
  await invokeDownloadCreated(background, {
    id: 1911,
    url,
    finalUrl: url,
    filename: '',
    mime: 'video/mp4',
    state: 'in_progress',
    totalBytes: 2038816,
    danger: 'safe',
    exists: true,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  let state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);

  const suggested = await invokeDeterminingFilename(background, {
    id: 1911,
    url,
    finalUrl: url,
    filename: '/Downloads/KQRLg1xrXcSBvNH_.mp4',
    mime: 'video/mp4',
    state: 'in_progress',
    totalBytes: 2038816,
    danger: 'safe',
    exists: true,
  });

  assert.equal(suggested, true);
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  assert.deepEqual(background.chrome._downloadCalls.erase, []);
  assert.equal(background.chrome._actionCalls.openPopup, 0);
  state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('browser download interception leaves data URL downloads in the browser', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'mp4',
  });

  const url = 'data:video/mp4;base64,AAAA';
  await invokeDownloadCreated(background, {
    id: 1912,
    url,
    finalUrl: url,
    filename: '/Downloads/generated.mp4',
    mime: 'video/mp4',
    state: 'in_progress',
    totalBytes: 4,
    danger: 'safe',
    exists: true,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  assert.deepEqual(background.chrome._downloadCalls.erase, []);
  assert.equal(background.chrome._actionCalls.openPopup, 0);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('browser download interception skips Downlink task when cancel fails unexpectedly', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });
  background.chrome.downloads.cancel = (_id, callback) => {
    background.chrome._downloadCalls.cancel.push(_id);
    background.chrome.runtime.lastError = { message: 'Permission denied' };
    callback?.();
    background.chrome.runtime.lastError = null;
  };

  await invokeDownloadCreated(background, {
    id: 1848,
    url: 'https://example.com/file.zip',
    finalUrl: 'https://example.com/file.zip',
    filename: 'file.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [1848]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.equal(background.chrome._actionCalls.openPopup, 0);
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

test('Chromium response header capture requests extra headers', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
  });

  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._listeners.webRequestOnHeadersReceivedSpecs[0])), ['responseHeaders', 'extraHeaders']);
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

test('Firefox blocks extensionless binary responses using the clicked download filename', async () => {
  const background = loadBackgroundRuntime({
    __firefoxRuntime: true,
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });
  const signedUrl = 'https://files.example.com/download?signature=abc';

  const tracked = await invokeBackgroundMessage(
    background,
    { type: 'TRACK_DOWNLOAD_CLICK', url: signedUrl, filename: 'release.zip' },
    { tab: { id: 7, windowId: 9, url: 'https://example.com/releases' } },
  );
  assert.equal(tracked.ok, true);
  await invokeSendHeaders(background, {
    url: signedUrl,
    tabId: 7,
    method: 'GET',
    requestHeaders: [{ name: 'Referer', value: 'https://example.com/releases' }],
  });
  const results = await invokeResponseHeaders(background, {
    url: signedUrl,
    tabId: 7,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'application/octet-stream' },
      { name: 'content-length', value: '2048' },
    ],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(JSON.parse(JSON.stringify(results[0])), { cancel: true });
  assert.equal(background.chrome._actionCalls.openPopup, 1);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].filename, 'release.zip');
});

test('Firefox runtime does not read unsupported onDeterminingFilename API', async () => {
  const background = loadBackgroundRuntime({
    __firefoxRuntime: true,
    __throwOnDeterminingFilenameAccess: true,
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  assert.equal(background.chrome._listeners.downloadsOnDeterminingFilename, null);
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

  assert.equal(suggested, false);
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
      fetch: async (requestUrl, options = {}) => {
        if (requestUrl.endsWith('/downloads/capabilities')) return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
        requestBody = JSON.parse(options.body);
        return { ok: true, json: async () => ({ id: requestBody.id, action: 'submitted', gid: 'gid-1' }) };
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

  assert.equal(suggested, false);
  for (let attempt = 0; attempt < 5 && !requestBody; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
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

  assert.equal(suggested, false);
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

  assert.equal(suggested, false);
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

test('empty capture extension config captures downloads with any extension', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: '',
  });

  const url = 'https://example.com/releases/package.custom';
  await invokeDownloadCreated(background, {
    id: 41,
    url,
    finalUrl: url,
    filename: 'package.custom',
    mime: 'application/octet-stream',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [41]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, url);
  assert.equal(pending[0].filename, 'package.custom');
  assert.equal(pending[0].captureReason, 'extension');
});

test('wildcard capture extension config captures downloads with any extension', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: '*',
  });

  const url = 'https://example.com/releases/package.custom';
  await invokeDownloadCreated(background, {
    id: 43,
    url,
    finalUrl: url,
    filename: 'package.custom',
    mime: 'application/octet-stream',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [43]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].captureReason, 'extension');
});

test('wildcard capture extension config captures extensionless binary downloads', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: '*',
  });

  const url = 'https://example.com/download';
  await invokeDownloadCreated(background, {
    id: 44,
    url,
    finalUrl: url,
    filename: 'download',
    mime: 'application/octet-stream',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [44]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].captureReason, 'mime');
});

test('wildcard capture extension config captures application binary downloads', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: '*',
  });

  const url = 'https://example.com/download';
  await invokeDownloadCreated(background, {
    id: 45,
    url,
    finalUrl: url,
    filename: 'download',
    mime: 'application/binary',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [45]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].captureReason, 'mime');
});

test('captures iTunes IPA mime downloads without filename extension', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: 'zip',
  });

  const url = 'https://example.com/download';
  await invokeDownloadCreated(background, {
    id: 46,
    url,
    finalUrl: url,
    filename: 'download',
    mime: 'application/x-itunes-ipa',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.deepEqual(background.chrome._downloadCalls.cancel, [46]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].captureReason, 'mime');
  assert.equal(pending[0].mime, 'application/x-itunes-ipa');
});

test('capture extension config still checks filename when URL extension differs', async () => {
  const background = loadBackgroundRuntime({
    captureExtensions: 'zip',
  });

  const classification = background.BackgroundShared.classifyDownloadCandidate({
    captureExtensions: 'zip',
  }, {
    url: 'https://example.com/download.bin',
    filename: 'release.zip',
    source: 'test',
  });

  assert.equal(classification.shouldCapture, true);
  assert.equal(classification.byExt, true);
  assert.equal(classification.reason, 'extension');
});

test('empty capture extension config cancels redirected downloads before browser filename prompt', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: '',
  });

  const sourceUrl = 'https://example.com/download?id=package';
  const redirectUrl = 'https://cdn.example.com/releases/package.custom';
  await invokeResponseHeaders(background, {
    url: sourceUrl,
    tabId: 1,
    type: 'main_frame',
    method: 'GET',
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
      { name: 'content-type', value: 'application/octet-stream' },
      { name: 'content-length', value: '4096' },
    ],
  });

  const suggested = await invokeDeterminingFilename(background, {
    id: 42,
    url: sourceUrl,
    finalUrl: redirectUrl,
    filename: 'package.custom',
    mime: 'application/octet-stream',
    state: 'in_progress',
    totalBytes: 4096,
  });

  assert.equal(suggested, false);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [42]);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, redirectUrl);
  assert.equal(pending[0].filename, 'package.custom');
  assert.equal(pending[0].captureSource, 'redirect');
  assert.equal(pending[0].captureReason, 'extension');
});

test('empty capture extension config does not capture extensionless JSON responses', async () => {
  const background = loadBackgroundRuntime({
    downloaderType: 'aria2',
    autoCapture: true,
    aria2Silent: false,
    captureExtensions: '',
    captureMime: true,
  });

  await invokeResponseHeaders(background, {
    url: 'https://example.com/api/status',
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

  assert.equal(suggested, false);
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

  assert.equal(suggested, false);
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

  assert.equal(suggested, false);
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
      aria2CustomSaveEnabled: true,
      aria2SaveLocations: [
        { name: '默认', path: '/downloads/default', color: '#ff9500' },
        { name: '视频', path: '/downloads/video', color: '#007aff' },
      ],
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
  assert.equal(requestBody.params[1].dir, '/downloads/default');
  assert.equal(background.chrome._actionCalls.openPopup, 0);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.values(state.pending || {}).length, 0);
  assert.equal(state.tasks['gid-1']?.filename, 'file.zip');
});

test('Aria2 automatic interception persists creation time for manager results', async () => {
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
        if (requestBody.method === 'aria2.addUri') {
          return { ok: true, async json() { return { result: 'auto-capture-gid' }; } };
        }
        if (requestBody.method === 'aria2.tellActive') {
          return {
            ok: true,
            async json() {
              return {
                result: [{ gid: 'auto-capture-gid', status: 'active', files: [] }],
              };
            },
          };
        }
        throw new Error(`unexpected rpc method ${requestBody.method}`);
      },
    },
  );

  await invokeDownloadCreated(background, {
    id: 1,
    url: 'https://example.com/auto-captured.zip',
    filename: 'auto-captured.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });

  const metadataWrite = background.chrome._localStorageWrites
    .map((values) => values.aria2TaskMeta)
    .find((value) => value?.['auto-capture-gid']?.addedAt);
  assert.ok(metadataWrite?.['auto-capture-gid']?.addedAt > 0);

  const active = await invokeBackgroundMessage(background, {
    type: 'ARIA2_RPC',
    method: 'tellActive',
  });
  assert.equal(requestBody.method, 'aria2.tellActive');
  assert.ok(Number(active.result[0].addedTime) > 0);
});

test('Aria2 silent downloads omit dir when custom save locations are disabled', async () => {
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      autoCapture: true,
      aria2Silent: true,
      aria2CustomSaveEnabled: false,
      aria2SaveLocations: [
        { name: '旧位置', path: '/downloads/old-custom', color: '#ff9500' },
      ],
      captureExtensions: 'zip',
    },
    {
      fetch: async (_url, options) => {
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { result: 'gid-default-dir' };
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
  assert.equal(Object.hasOwn(requestBody.params[1], 'dir'), false);
});

test('Aria2 pending confirmation isolates single threaded overrides from the next download', async () => {
  let requestBody = null;
  const requests = [];
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
        requests.push(requestBody);
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

  const configAfterSingle = (await invokeBackgroundMessage(background, { type: 'GET_STATE' })).config;
  await invokeDownloadCreated(background, {
    id: 2,
    url: 'https://example.com/next.zip',
    filename: 'next.zip',
    state: 'in_progress',
    totalBytes: 1024,
  });
  const nextState = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const nextPending = Object.values(nextState.pending || {});
  assert.equal(nextPending.length, 1);
  const nextResult = await invokeBackgroundMessage(background, {
    type: 'CONFIRM_DOWNLOAD',
    key: nextPending[0].key,
    filename: 'next.zip',
    opts: {},
  });
  assert.equal(nextResult.ok, true);
  assert.deepEqual(requestBody.params[1], { out: 'next.zip' });
  assert.equal(requests.length, 2);
  assert.ok(requests.every(request => request.method === 'aria2.addUri'));
  assert.deepEqual((await invokeBackgroundMessage(background, { type: 'GET_STATE' })).config, configAfterSingle);
  for (const values of background.chrome._localStorageWrites) {
    const serialized = JSON.stringify(values);
    assert.equal(/max-connection-per-server|min-split-size|"split"/.test(serialized), false);
  }

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

test('NeatDM sends sniffed HLS manifests in hls mode with request context', async () => {
  const sockets = [];
  class MockWebSocket {
    constructor(url, protocol) {
      this.url = url;
      this.protocol = protocol;
      this.sent = [];
      sockets.push(this);
      setTimeout(() => this.onopen?.(), 0);
    }
    send(message) { this.sent.push(message); }
    close() {}
  }
  const background = loadBackgroundRuntime(
    { downloaderType: 'neatdm' },
    { WebSocket: MockWebSocket }
  );
  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_hls_neatdm',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/live/master?token=1',
    pageUrl: 'https://example.com/watch/live#player',
    pageTitle: 'Live event',
    filename: 'Live event.m3u8',
    headers: {
      cookie: 'sid=abc123',
      referer: 'https://example.com/watch/live#player',
      'user-agent': 'Browser UA',
      authorization: 'Bearer stream-token',
      accept: 'application/vnd.apple.mpegurl',
      range: 'bytes=0-',
    },
    mime: 'application/vnd.apple.mpegurl',
    streamProtocol: 'hls',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_hls_neatdm',
  });

  assert.equal(result.ok, true);
  assert.equal(sockets.length, 1);
  const message = sockets[0].sent[0];
  assert.match(message, /^1:GET\r\n2:https:\/\/cdn\.example\.com\/live\/master\?token=1\r\n6:hls\r\n4:Live event\r\n/);
  assert.doesNotMatch(message, /Origin:/);
  assert.match(message, /Referer: https:\/\/example\.com\/watch\/live\r\n/);
  assert.match(message, /5:https:\/\/example\.com\/watch\/live\r\n/);
  assert.match(message, /Cookie: sid=abc123\r\n/);
  assert.match(message, /User-Agent: Browser UA\r\n/);
  assert.match(message, /Authorization: Bearer stream-token\r\n/);
  assert.match(message, /Accept: application\/vnd\.apple\.mpegurl\r\n/);
  assert.doesNotMatch(message, /Range:/);
  assert.doesNotMatch(message, /Content-Type:/);
  assert.doesNotMatch(message, /Content-Disposition:/);
  assert.doesNotMatch(message, /8:application\/vnd\.apple\.mpegurl/);
});

test('NeatDM response capture waits for browser download cancel before sending', async () => {
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
    {
      downloaderType: 'neatdm',
      autoCapture: true,
      captureExtensions: 'zip',
    },
    { WebSocket: MockWebSocket }
  );
  const order = [];
  background.chrome.downloads.cancel = (_id, callback) => {
    order.push('cancel');
    background.chrome._downloadCalls.cancel.push(_id);
    setTimeout(() => {
      order.push('cancel-callback');
      callback?.();
    }, 0);
  };

  const url = 'https://example.com/response-neatdm.zip';
  await invokeResponseHeaders(background, {
    url,
    tabId: 1,
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="response-neatdm.zip"' },
      { name: 'content-type', value: 'application/zip' },
      { name: 'content-length', value: '4096' },
    ],
  });

  assert.equal(sockets.length, 0);

  const listener = background.chrome._listeners.downloadsOnDeterminingFilename;
  let suggested = false;
  await listener({
    id: 31,
    url,
    finalUrl: url,
    filename: 'response-neatdm.zip',
    mime: 'application/zip',
    state: 'in_progress',
    totalBytes: 4096,
  }, () => {
    order.push('suggest');
    suggested = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(suggested, false);
  assert.deepEqual(order, ['cancel', 'cancel-callback']);
  assert.deepEqual(background.chrome._downloadCalls.cancel, [31]);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://127.0.0.1:10007/download');
  assert.match(sockets[0].sent[0], /^1:GET\r\n2:https:\/\/example\.com\/response-neatdm\.zip\r\n6:normal\r\n4:response-neatdm\.zip\r\n/);
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

test('Gopeed silent mode sends intercepted downloads without confirmation', async () => {
  let requestUrl = '';
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
      gopeedSilent: true,
      autoCapture: true,
      captureExtensions: 'zip',
    },
    {
      fetch: async (url, options) => {
        requestUrl = url;
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
  assert.equal(Object.keys(state.pending || {}).length, 0);

  assert.equal(requestUrl, 'http://127.0.0.1:9999/api/v1/tasks');
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
  assert.equal(state.tasks['gopeed-task-1']?.provider, 'gopeed');
  assert.equal(state.tasks['gopeed-task-1']?.status, 'sent');
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
    onTaskAccepted() {},
  });

  assert.equal(clients.getDownloaderLabel('abdownload', { downloaderType: 'abdownload' }), 'AB DM');
});

test('Aria2 sends wait for the queued-task persistence callback', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      aria2Secret: '',
      aria2Silent: false,
      aria2CustomSaveEnabled: false,
      aria2SaveLocations: [],
    },
    {
      fetch: async (_url, options) => ({
        ok: true,
        async json() {
          const request = JSON.parse(options.body);
          assert.equal(request.method, 'aria2.addUri');
          return { result: 'queued-gid-1' };
        },
      }),
    },
  );
  let release;
  const queued = new Promise((resolve) => {
    release = resolve;
  });
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      aria2Secret: '',
      aria2Silent: false,
      aria2CustomSaveEnabled: false,
      aria2SaveLocations: [],
    }),
    notify() {},
    onTaskAccepted() {
      return queued;
    },
  });

  let settled = false;
  const outcome = clients.sendTask({ url: 'https://example.com/file.zip', filename: 'file.zip' })
    .then((result) => {
      settled = true;
      return result;
    }, (error) => {
      settled = true;
      throw error;
    });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settled, false);

  release();
  const result = await outcome;
  assert.equal(result.ok, true);
  assert.equal(result.gid, 'queued-gid-1');
});

test('successful cross-downloader sends and untracked launchers hide old floating-panel tasks', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      aria2Secret: '',
      aria2Silent: true,
      gopeedApi: 'http://127.0.0.1:9999',
      gopeedToken: '',
      gopeedSilent: true,
    },
    {
      fetch: async (url, options = {}) => {
        if (String(url).includes('/jsonrpc')) {
          return { ok: true, async json() { return { result: 'aria2-old' }; } };
        }
        if (String(url).includes('/api/v1/tasks')) {
          return { ok: true, async json() { return { code: 0, data: 'gopeed-new' }; } };
        }
        if (String(url).includes(':15151/add')) return { ok: true };
        throw new Error(`unexpected fetch ${url} ${options.method || 'GET'}`);
      },
    },
  );

  const first = await invokeBackgroundMessage(background, {
    type: 'ADD_URL', url: 'https://example.com/old.zip', filename: 'old.zip',
  });
  assert.equal(first.ok, true);
  await invokeBackgroundMessage(background, { type: 'SAVE_CONFIG', config: { downloaderType: 'gopeed' } });
  const second = await invokeBackgroundMessage(background, {
    type: 'ADD_URL', url: 'https://example.com/new.zip', filename: 'new.zip',
  });
  assert.equal(second.ok, true);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.tasks['aria2-old'], undefined);
  assert.ok(!state.hiddenTaskGids.includes('aria2-old'));
  assert.ok(!state.hiddenTaskGids.includes('gopeed-new'));
  assert.equal(state.tasks['gopeed-new'].provider, 'gopeed');

  await invokeBackgroundMessage(background, { type: 'SAVE_CONFIG', config: { downloaderType: 'abdownload' } });
  const third = await invokeBackgroundMessage(background, {
    type: 'ADD_URL', url: 'https://example.com/external.zip', filename: 'external.zip',
  });
  assert.equal(third.ok, true);
  const finalState = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(finalState.tasks['gopeed-new'], undefined);
  assert.ok(!finalState.hiddenTaskGids.includes('gopeed-new'));
});

test('failed sends keep existing floating-panel tasks visible', async () => {
  let failGopeed = false;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      aria2Secret: '',
      aria2Silent: true,
      gopeedApi: 'http://127.0.0.1:9999',
      gopeedToken: '',
      gopeedSilent: true,
    },
    {
      fetch: async (url) => {
        if (String(url).includes('/jsonrpc')) {
          return { ok: true, async json() { return { result: 'aria2-visible' }; } };
        }
        if (failGopeed) throw new Error('offline');
        throw new Error(`unexpected fetch ${url}`);
      },
    },
  );

  await invokeBackgroundMessage(background, {
    type: 'ADD_URL', url: 'https://example.com/old.zip', filename: 'old.zip',
  });
  await invokeBackgroundMessage(background, { type: 'SAVE_CONFIG', config: { downloaderType: 'gopeed' } });
  failGopeed = true;
  const failed = await invokeBackgroundMessage(background, {
    type: 'ADD_URL', url: 'https://example.com/new.zip', filename: 'new.zip',
  });
  assert.equal(failed.ok, false);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.ok(!state.hiddenTaskGids.includes('aria2-visible'));
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
      fetch: async (url, options = {}) => {
        if (url.endsWith('/downloads/capabilities')) return { ok: true, status: 200, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
        requestedUrl = url;
        requestHeaders = options.headers;
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ id: requestBody.id, action: 'submitted', gid: 'gid-1' }) };
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
  assert.equal(requestedUrl, 'http://127.0.0.1:16888/add');
  assert.equal(requestHeaders.Authorization, 'Bearer next-secret');
  assert.equal(requestHeaders['X-Rayburst-Client'], 'rayburst-connect');
  assert.ok(requestBody.id);
  delete requestBody.id;
  assert.deepEqual(requestBody, {
    url: 'https://example.com/file.zip',
    filename: 'custom.zip',
    filenameSource: 'suggested',
    referer: 'https://example.com/page',
    cookie: 'sid=abc123',
  });
});

test('Rayburst retries an unresolved request with the same id', async () => {
  const pending = new Map();
  const postedIds = [];
  let postAttempt = 0;
  const background = loadBackgroundRuntime({}, {
    fetch: async (url, options = {}) => {
      if (url.endsWith('/downloads/capabilities')) {
        return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
      }
      const body = JSON.parse(options.body);
      postedIds.push(body.id);
      postAttempt += 1;
      if (postAttempt === 1) throw new Error('response lost');
      return { ok: true, json: async () => ({ id: body.id, action: 'submitted', gid: 'gid-replayed' }) };
    },
  });
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'motrixnext', motrixNextPort: '29110' }),
    notify() {},
    async getPendingRayburstRequest(key) { return pending.get(key); },
    async savePendingRayburstRequest(key, request) { pending.set(key, request); },
    async removePendingRayburstRequest(key) { pending.delete(key); },
  });

  const task = { url: 'https://example.com/file.zip', filename: 'file.zip' };
  assert.equal((await clients.sendTask(task)).ok, false);
  assert.equal(pending.size, 1);
  const replayed = await clients.sendTask(task);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.gid, 'gid-replayed');
  assert.deepEqual(postedIds, [postedIds[0], postedIds[0]]);
  assert.equal(pending.size, 0);
});

test('Rayburst forwards only sanitized allowlisted headers and marks browser filenames', async () => {
  let requestBody;
  const background = loadBackgroundRuntime({}, {
    fetch: async (url, options = {}) => {
      if (url.endsWith('/downloads/capabilities')) {
        return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
      }
      requestBody = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: requestBody.id, action: 'submitted', gid: 'gid-headers' }) };
    },
  });
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'motrixnext', motrixNextPort: '29110' }),
    notify() {},
  });

  const result = await clients.sendTask({
    url: 'https://example.com/file.zip',
    filename: 'browser-file.zip',
    captureSource: 'browser-download',
    headers: {
      accept: 'application/zip\r\nInjected: true',
      'accept-encoding': 'br',
      'sec-fetch-site': 'same-origin',
      'x-private-header': 'secret',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requestBody.filenameSource, 'browser');
  assert.deepEqual(requestBody.requestHeaders, [
    { name: 'accept', value: 'application/zip  Injected: true' },
    { name: 'sec-fetch-site', value: 'same-origin' },
  ]);
});

test('Rayburst cancelled receipt is not reported as a successful submission', async () => {
  const background = loadBackgroundRuntime({}, {
    fetch: async (url, options = {}) => {
      if (url.endsWith('/downloads/capabilities')) {
        return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
      }
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: body.id, action: 'cancelled' }) };
    },
  });
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'motrixnext', motrixNextPort: '29110' }),
    notify() {},
  });

  const result = await clients.sendTask({ url: 'https://example.com/file.zip' });
  assert.equal(result.ok, false);
  assert.equal(result.cancelled, true);
});

test('Rayburst confirmation receipts do not rotate floating-panel tasks before submission', async () => {
  let accepted = 0;
  const background = loadBackgroundRuntime({}, {
    fetch: async (url, options = {}) => {
      if (url.endsWith('/downloads/capabilities')) {
        return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
      }
      const body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ id: body.id, action: 'needs-confirmation' }) };
    },
  });
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'motrixnext', motrixNextPort: '29110' }),
    notify() {},
    onTaskAccepted() { accepted += 1; },
  });

  const result = await clients.sendTask({ url: 'https://example.com/file.zip' });
  assert.equal(result.ok, true);
  assert.equal(result.pending, true);
  assert.equal(accepted, 0);
});

test('Rayburst permits an explicit custom port matching the legacy default', async () => {
  const background = loadBackgroundRuntime({ motrixNextPort: '16801' });
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.motrixNextPort, '16801');
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
      fetch: async (url, options = {}) => {
        if (url.endsWith('/downloads/capabilities')) return { ok: true, status: 200, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
        requestedUrl = url;
        const body = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ id: body.id, action: 'submitted', gid: 'gid-1' }) };
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

  assert.equal(requestedUrl, 'http://127.0.0.1:16888/add');
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
      fetch: async (url, options = {}) => {
        if (url.endsWith('/downloads/capabilities')) return { ok: true, status: 200, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
        requestedUrl = url;
        const body = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ id: body.id, action: 'submitted', gid: 'gid-1' }) };
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

  assert.equal(requestedUrl, 'http://127.0.0.1:16888/add');
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
      fetch: async (url, options = {}) => {
        if (url.endsWith('/downloads/capabilities')) return { ok: true, status: 200, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ id: requestBody.id, action: 'submitted', gid: 'gid-1' }) };
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
  assert.ok(requestBody.id);
  delete requestBody.id;
  assert.deepEqual(requestBody, {
    url: 'https://cdn.example.com/video.mp4',
    filename: 'video-title.mp4',
    filenameSource: 'suggested',
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
      fetch: async (url, options = {}) => {
        if (url.endsWith('/downloads/capabilities')) return { ok: true, status: 200, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
        requestBody = JSON.parse(options.body);
        return { ok: true, status: 200, json: async () => ({ id: requestBody.id, action: 'submitted', gid: 'gid-1' }) };
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
  assert.ok(requestBody.id);
  delete requestBody.id;
  assert.deepEqual(requestBody, {
    url: 'https://cdn.example.com/video.mp4',
    filename: 'video-title.mp4',
    filenameSource: 'suggested',
    referer: 'https://example.com/player',
    cookie: 'sid=abc123',
  });
});

test('Rayburst media send probes and submits HLS with the default selection', async () => {
  const requests = [];
  let probeId = '';
  const defaultSelection = {
    videoId: 'video-main',
    audioId: 'audio-main',
    subtitleId: null,
    format: 'mp4',
    recordTimeSeconds: 0,
    startTimeSeconds: 0,
    endTimeSeconds: 0,
  };
  const background = loadBackgroundRuntime(
    { downloaderType: 'motrixnext', motrixNextPort: '29110', motrixNextSecret: 'media-secret' },
    {
      fetch: async (url, options = {}) => {
        requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
        if (url.endsWith('/media/v2/capabilities')) {
          return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, sourceKinds: ['hls', 'dash'], requestContexts: true }) };
        }
        if (url.endsWith('/media/v2/probes')) {
          probeId = requests.at(-1).body.id;
          return { ok: true, json: async () => ({ id: probeId, state: 'ready', presentation: { defaults: defaultSelection } }) };
        }
        const submissionId = requests.at(-1).body.submissionId;
        return { ok: true, json: async () => ({ id: probeId, submissionId, gid: 'media-gid-1' }) };
      },
    }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_hls_1',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/live/master.m3u8?token=1',
    pageUrl: 'https://example.com/watch/live',
    pageTitle: 'Live event',
    filename: 'master.m3u8',
    headers: { cookie: 'sid=abc123', referer: 'https://example.com/watch/live', 'user-agent': 'Browser UA' },
    mime: 'application/vnd.apple.mpegurl',
    streamProtocol: 'hls',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_hls_1',
    connectionConfig: { motrixNextPort: '29110', motrixNextSecret: 'current-popup-secret' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.gid, 'media-gid-1');
  assert.equal(result.media, true);
  assert.equal(requests.length, 3);
  assert.equal(requests[0].options.headers.Authorization, 'Bearer current-popup-secret');
  assert.deepEqual(requests[1].body.source, {
    url: 'https://cdn.example.com/live/master.m3u8?token=1',
    kind: 'hls',
    pageUrl: 'https://example.com/watch/live',
    title: '',
    filename: 'Live event-master.m3u8',
    mime: 'application/vnd.apple.mpegurl',
    requestContexts: [{
      url: 'https://cdn.example.com/live/master.m3u8?token=1',
      headers: [
        { name: 'cookie', value: 'sid=abc123' },
        { name: 'referer', value: 'https://example.com/watch/live' },
        { name: 'user-agent', value: 'Browser UA' },
      ],
    }],
    input: { manifests: [], tracks: [], keys: [] },
  });
  assert.deepEqual(requests[2].body.selection, defaultSelection);
});

test('Rayburst collection combines one recognized video and audio with scoped request contexts', async () => {
  const requests = [];
  let probeId = '';
  const defaults = {
    videoId: 'native-video-track', audioId: 'native-audio-track', subtitleId: null, format: 'mp4',
    recordTimeSeconds: 0, startTimeSeconds: 0, endTimeSeconds: 0,
  };
  const background = loadBackgroundRuntime({}, {
    fetch: async (url, options = {}) => {
      const body = options.body ? JSON.parse(options.body) : null;
      requests.push({ url, options, body });
      if (url.endsWith('/media/v2/capabilities')) {
        return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, sourceKinds: ['collection'], requestContexts: true }) };
      }
      if (url.endsWith('/media/v2/probes')) {
        probeId = body.id;
        return { ok: true, json: async () => ({
          id: probeId,
          state: 'ready',
          presentation: {
            defaults,
            formats: ['mp4', 'mkv'],
            tracks: [
              { id: 'native-video-track', type: 'video' },
              { id: 'native-audio-track', type: 'audio' },
            ],
          },
        }) };
      }
      return { ok: true, json: async () => ({ id: probeId, submissionId: body.submissionId, gid: 'merged-gid' }) };
    },
  });
  const accepted = [];
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'motrixnext', motrixNextPort: '29110', motrixNextSecret: 'secret' }),
    notify() {},
    onTaskAccepted(task) { accepted.push(task); },
  });
  const result = await clients.sendRayburstCollection([
    {
      url: 'https://cdn.example/video/main.m4s', rayburstTrackType: 'video', filename: 'movie.mp4',
      headers: { cookie: 'video=1', referer: 'https://watch.example/player' }, downloadPage: 'https://watch.example/player',
    },
    {
      url: 'https://cdn.example/audio/main.m4s', rayburstTrackType: 'audio', filename: 'audio.m4a',
      headers: { authorization: 'Bearer audio', referer: 'https://watch.example/player' }, downloadPage: 'https://watch.example/player',
    },
  ], 'movie', 'mkv');

  assert.equal(result.ok, true);
  assert.equal(result.gid, 'merged-gid');
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].provider, 'motrixnext');
  assert.equal(accepted[0].trackable, false);
  assert.equal(requests[1].body.source.kind, 'collection');
  assert.deepEqual(requests[1].body.source.input.tracks, [
    { id: 'downlink-video-1', type: 'video', urls: ['https://cdn.example/video/main.m4s'] },
    { id: 'downlink-audio-2', type: 'audio', urls: ['https://cdn.example/audio/main.m4s'] },
  ]);
  assert.deepEqual(requests[1].body.source.requestContexts, [
    {
      url: 'https://cdn.example/video/main.m4s',
      headers: [
        { name: 'authorization', value: 'Bearer audio' },
        { name: 'referer', value: 'https://watch.example/player' },
        { name: 'cookie', value: 'video=1' },
      ],
    },
  ]);
  assert.equal(requests[1].body.source.filename, 'movie');
  assert.deepEqual(requests[2].body.selection, {
    ...defaults,
    format: 'mkv',
  });
});

test('Rayburst collection rejects selections that are not exactly one video and one audio', async () => {
  const background = loadBackgroundRuntime();
  const clients = background.BackgroundDownloaders.createClients({ getConfig: () => ({}), notify() {} });
  const result = await clients.sendRayburstCollection([
    { url: 'https://cdn.example/one.mp4', rayburstTrackType: 'video' },
    { url: 'https://cdn.example/two.mp4', rayburstTrackType: 'video' },
  ], 'movie.mp4');
  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
});

test('Rayburst collection rejects non-HTTP media before creating a probe', async () => {
  const requests = [];
  const background = loadBackgroundRuntime({}, {
    fetch: async (url) => {
      requests.push(url);
      return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, sourceKinds: ['collection'], requestContexts: true }) };
    },
  });
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'motrixnext', motrixNextPort: '29110', motrixNextSecret: 'secret' }),
    notify() {},
  });
  const result = await clients.sendRayburstCollection([
    { url: 'blob:https://watch.example/video', rayburstTrackType: 'video' },
    { url: 'https://cdn.example/audio.m4a', rayburstTrackType: 'audio' },
  ], 'movie', 'mp4');

  assert.equal(result.ok, false);
  assert.equal(result.unsupported, true);
  assert.match(result.error, /HTTP\(S\)/);
  assert.equal(requests.length, 0);
});

test('Rayburst media retry reuses probe and submission identities after a lost receipt', async () => {
  const pending = new Map();
  const probeIds = [];
  const submissionIds = [];
  let submitAttempt = 0;
  let savedSubmissionId = '';
  const defaultSelection = {
    videoId: 'video-main', audioId: null, subtitleId: null, format: 'mp4',
    recordTimeSeconds: 0, startTimeSeconds: 0, endTimeSeconds: 0,
  };
  const background = loadBackgroundRuntime({}, {
    fetch: async (url, options = {}) => {
      if (url.endsWith('/media/v2/capabilities')) {
        return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, sourceKinds: ['hls'], requestContexts: true }) };
      }
      const body = options.body ? JSON.parse(options.body) : null;
      if (url.endsWith('/media/v2/probes')) {
        probeIds.push(body.id);
        if (submitAttempt > 0) {
          return { ok: true, json: async () => ({ id: body.id, state: 'submitted', submissionId: savedSubmissionId, gid: 'media-replayed' }) };
        }
        return { ok: true, json: async () => ({ id: body.id, state: 'ready', presentation: { defaults: defaultSelection } }) };
      }
      submissionIds.push(body.submissionId);
      submitAttempt += 1;
      throw new Error('response lost');
    },
  });
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'motrixnext', motrixNextPort: '29110', motrixNextSecret: 'secret' }),
    notify() {},
    async getPendingRayburstRequest(key) { return pending.get(key); },
    async savePendingRayburstRequest(key, request) {
      pending.set(key, request);
      savedSubmissionId = request.submissionId;
    },
    async removePendingRayburstRequest(key) { pending.delete(key); },
  });
  const task = {
    url: 'https://cdn.example.com/master.m3u8',
    filename: 'master.m3u8',
    mime: 'application/vnd.apple.mpegurl',
    streamProtocol: 'hls',
    downloadPage: 'https://example.com/watch',
  };

  assert.equal((await clients.sendTask(task)).ok, false);
  assert.equal(pending.size, 1);
  const replayed = await clients.sendTask(task);
  assert.equal(replayed.ok, true);
  assert.equal(replayed.gid, 'media-replayed');
  assert.deepEqual(probeIds, [probeIds[0], probeIds[0]]);
  assert.deepEqual(submissionIds, [savedSubmissionId]);
  assert.equal(pending.size, 0);
});

test('Rayburst media send continues when Safari retry storage exceeds its quota', async () => {
  let probeId = '';
  let submitted = false;
  const defaults = {
    videoId: 'video-main', audioId: null, subtitleId: null, format: 'mp4',
    recordTimeSeconds: 0, startTimeSeconds: 0, endTimeSeconds: 0,
  };
  const background = loadBackgroundRuntime({}, {
    fetch: async (url, options = {}) => {
      if (url.endsWith('/media/v2/capabilities')) {
        return { ok: true, json: async () => ({ product: 'rayburst', protocolVersion: 2, sourceKinds: ['hls'], requestContexts: true }) };
      }
      const body = JSON.parse(options.body);
      if (url.endsWith('/media/v2/probes')) {
        probeId = body.id;
        return { ok: true, json: async () => ({ id: probeId, state: 'ready', presentation: { defaults } }) };
      }
      submitted = true;
      return { ok: true, json: async () => ({ id: probeId, submissionId: body.submissionId, gid: 'quota-safe-gid' }) };
    },
  });
  const clients = background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'motrixnext', motrixNextPort: '29110', motrixNextSecret: 'secret' }),
    notify() {},
    async getPendingRayburstRequest() { return null; },
    async savePendingRayburstRequest() {
      throw new Error('Invalid call to browser.storage.session.set(). Exceeded storage quota.');
    },
    async removePendingRayburstRequest() {
      throw new Error('Invalid call to browser.storage.session.set(). Exceeded storage quota.');
    },
  });

  const result = await clients.sendTask({
    url: 'https://cdn.example.com/master.m3u8',
    filename: 'master.m3u8',
    mime: 'application/vnd.apple.mpegurl',
    streamProtocol: 'hls',
    headers: { cookie: `session=${'x'.repeat(20_000)}` },
  });

  assert.equal(result.ok, true);
  assert.equal(result.gid, 'quota-safe-gid');
  assert.equal(submitted, true);
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

test('Gopeed HLS send creates a native task and forwards safe playlist headers', async () => {
  const requests = [];
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
      gopeedToken: 'gopeed-token',
    },
    {
      fetch: async (url, options = {}) => {
        requests.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
        return {
          ok: true,
          async json() {
            return { code: 0, data: 'gopeed-hls-1' };
          },
        };
      },
    }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_gopeed_hls',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/live/master.m3u8?token=1',
    pageUrl: 'https://example.com/watch/live',
    filename: 'Live event.m3u8',
    headers: {
      accept: 'application/vnd.apple.mpegurl',
      authorization: 'Bearer stream-token',
      cookie: 'sid=abc123',
      origin: 'https://example.com',
      referer: 'https://example.com/player',
      range: 'bytes=0-',
      'content-type': 'application/vnd.apple.mpegurl',
      'content-disposition': 'attachment; filename="master.m3u8"',
      'user-agent': 'Browser UA',
      'x-playback-token': 'playback-token',
    },
    mime: 'application/vnd.apple.mpegurl',
    streamProtocol: 'hls',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_gopeed_hls',
  });

  assert.equal(result.ok, true);
  assert.equal(result.gid, 'gopeed-hls-1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers['X-Api-Token'], 'gopeed-token');
  assert.match(requests[0].url, /\/api\/v1\/tasks$/);
  assert.deepEqual(requests[0].body, {
    req: {
      url: 'https://cdn.example.com/live/master.m3u8?token=1',
      extra: {
        header: {
          accept: 'application/vnd.apple.mpegurl',
          authorization: 'Bearer stream-token',
          cookie: 'sid=abc123',
          origin: 'https://example.com',
          referer: 'https://example.com/player',
          'user-agent': 'Browser UA',
          'x-playback-token': 'playback-token',
        },
      },
    },
  });
});

test('Gopeed HLS send does not gate task creation on the reported version', async () => {
  const requests = [];
  const background = loadBackgroundRuntime(
    { downloaderType: 'gopeed' },
    {
      fetch: async (url, options = {}) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ code: 0, data: 'gopeed-hls-dev' }) };
      },
    }
  );

  const result = await background.BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'gopeed', gopeedApi: 'http://127.0.0.1:9999' }),
    notify() {},
  }).sendTask({
    url: 'https://cdn.example.com/master.m3u8',
    filename: 'master.m3u8',
    mime: 'application/vnd.apple.mpegurl',
    streamProtocol: 'hls',
  });

  assert.equal(result.ok, true);
  assert.equal(result.gid, 'gopeed-hls-dev');
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/api\/v1\/tasks$/);
});

test('Gopeed rejects unsupported stream inputs before creating a normal file task', async () => {
  let requestCount = 0;
  const clients = loadBackgroundRuntime(
    { downloaderType: 'gopeed' },
    { fetch: async () => { requestCount += 1; throw new Error('must not request'); } }
  ).BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'gopeed', gopeedApi: 'http://127.0.0.1:9999' }),
    notify() {},
  });

  const extensionless = await clients.sendTask({
    url: 'https://cdn.example.com/playback?id=1',
    mime: 'application/vnd.apple.mpegurl',
    streamProtocol: 'hls',
  });
  const dash = await clients.sendTask({
    url: 'https://cdn.example.com/manifest.mpd',
    mime: 'application/dash+xml',
    streamProtocol: 'dash',
  });

  assert.equal(extensionless.unsupported, true);
  assert.match(extensionless.error, /\.m3u8/);
  assert.equal(dash.unsupported, true);
  assert.match(dash.error, /DASH/);
  assert.equal(requestCount, 0);
});

test('Gopeed unsupported media failures retain their actionable alert type and message', async () => {
  const background = loadBackgroundRuntime({ downloaderType: 'gopeed' });
  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_gopeed_dash',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/manifest.mpd',
    filename: 'manifest.mpd',
    mime: 'application/dash+xml',
    streamProtocol: 'dash',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_gopeed_dash',
  });
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });

  assert.equal(result.unsupported, true);
  assert.match(result.error, /DASH/);
  assert.equal(state.uiAlert?.type, 'unsupported');
  assert.equal(state.uiAlert?.message, result.error);
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

test('AB DM HLS media uses the native HLS source without manifest fallback', async () => {
  const requests = [];
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'abdownload',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
      abDownloadSilent: false,
    },
    {
      fetch: async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body) });
        return { ok: true, status: 200 };
      },
    }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_abdm_hls',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/quality/index.m3u8?token=1',
    pageUrl: 'https://example.com/watch/live',
    filename: 'Live event.m3u8',
    headers: {
      accept: 'application/vnd.apple.mpegurl',
      authorization: 'Bearer stream-token',
      cookie: 'sid=abc123',
      origin: 'https://example.com',
      referer: 'https://example.com/player',
      range: 'bytes=0-',
      'content-type': 'application/vnd.apple.mpegurl',
      'content-disposition': 'attachment; filename="index.m3u8"',
      'user-agent': 'Browser UA',
      'x-playback-token': 'playback-token',
    },
    mime: 'application/vnd.apple.mpegurl',
    streamProtocol: 'hls',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_abdm_hls',
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://localhost:15151/start-headless-download');
  assert.deepEqual(requests[0].body, {
    downloadSource: {
      link: 'https://cdn.example.com/quality/index.m3u8?token=1',
      type: 'hls',
      headers: {
        accept: 'application/vnd.apple.mpegurl',
        authorization: 'Bearer stream-token',
        cookie: 'sid=abc123',
        origin: 'https://example.com',
        referer: 'https://example.com/player',
        'user-agent': 'Browser UA',
        'x-playback-token': 'playback-token',
      },
      downloadPage: 'https://example.com/watch/live',
    },
    name: 'Live event.ts',
    startDownload: true,
  });
});

test('AB DM HLS rejection does not retry as a normal manifest download', async () => {
  let requestCount = 0;
  const clients = loadBackgroundRuntime(
    { downloaderType: 'abdownload' },
    {
      fetch: async () => {
        requestCount += 1;
        return { ok: false, status: 500 };
      },
    }
  ).BackgroundDownloaders.createClients({
    getConfig: () => ({
      downloaderType: 'abdownload',
      externalLauncherHost: 'localhost',
      externalLauncherPort: '15151',
      abDownloadSilent: false,
    }),
    notify() {},
  });

  const result = await clients.sendTask({
    url: 'https://cdn.example.com/quality/index.m3u8',
    filename: 'index.m3u8',
    streamProtocol: 'hls',
  });

  assert.equal(result.actionable, true);
  assert.equal(result.unsupported, undefined);
  assert.match(result.error, /HTTP 500/);
  assert.equal(requestCount, 1);
});

test('AB DM HLS HTTP errors distinguish unsupported input from service configuration failures', async () => {
  const cases = [
    { status: 400, unsupported: true, pattern: /HTTP 400/ },
    { status: 401, actionable: true, pattern: /API 密钥/ },
    { status: 404, actionable: true, pattern: /接口不存在/ },
    { status: 503, actionable: true, pattern: /HTTP 503/ },
  ];

  for (const expected of cases) {
    const clients = loadBackgroundRuntime(
      { downloaderType: 'abdownload' },
      { fetch: async () => ({ ok: false, status: expected.status }) }
    ).BackgroundDownloaders.createClients({
      getConfig: () => ({ downloaderType: 'abdownload' }),
      notify() {},
    });
    const result = await clients.sendTask({
      url: 'https://cdn.example.com/quality/index.m3u8',
      streamProtocol: 'hls',
    });

    assert.equal(result.unsupported, expected.unsupported);
    assert.equal(result.actionable, expected.actionable);
    assert.match(result.error, expected.pattern);
  }
});

test('AB DM rejects live HLS before creating a finite playlist task', async () => {
  let requestCount = 0;
  const background = loadBackgroundRuntime(
    { downloaderType: 'abdownload' },
    { fetch: async () => { requestCount += 1; throw new Error('must not request'); } }
  );

  background.__backgroundTestHooks.mediaManager.clearMediaResources();
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_abdm_live_hls',
    tabId: 1,
    resourceUrl: 'https://cdn.example.com/live/index.m3u8',
    filename: 'live.m3u8',
    streamProtocol: 'hls',
    isLive: true,
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_MEDIA_TASK',
    id: 'media_abdm_live_hls',
  });

  assert.equal(result.unsupported, true);
  assert.match(result.error, /直播 HLS/);
  assert.equal(requestCount, 0);
});

test('AB DM rejects DASH before creating a normal manifest task', async () => {
  let requestCount = 0;
  const clients = loadBackgroundRuntime(
    { downloaderType: 'abdownload' },
    { fetch: async () => { requestCount += 1; throw new Error('must not request'); } }
  ).BackgroundDownloaders.createClients({
    getConfig: () => ({ downloaderType: 'abdownload' }),
    notify() {},
  });

  const result = await clients.sendTask({
    url: 'https://cdn.example.com/manifest.mpd',
    filename: 'manifest.mpd',
    streamProtocol: 'dash',
  });

  assert.equal(result.unsupported, true);
  assert.match(result.error, /DASH/);
  assert.equal(requestCount, 0);
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
  assert.equal(state.uiAlert?.downloaderLabel, 'AB DM');
  assert.equal(result.downloaderLabel, 'AB DM');
});

test('pending confirmation send failure does not open a new task surface', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
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
  assert.equal(nextState.uiAlert?.message, '与 Aria2 连接失败，检查 Aria2 是否正在运行');
});

test('context menu sends to NeatDM directly without confirmation', async () => {
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

  await invokeContextMenuClick(background, {
    menuItemId: 'send-to-aria2',
    linkUrl: 'https://example.com/file.zip',
  }, {
    id: 1,
    url: 'https://example.com/page',
  });

  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].url, 'ws://127.0.0.1:10007/download');
  assert.match(sockets[0].sent[0], /^1:GET\r\n2:https:\/\/example\.com\/file\.zip\r\n6:normal\r\n4:file\.zip\r\n/);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('context menu sends to AB DM directly with /add when not silent', async () => {
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

  await invokeContextMenuClick(background, {
    menuItemId: 'send-to-aria2',
    linkUrl: 'https://example.com/file.zip',
  }, {
    id: 1,
    url: 'https://example.com/page',
  });

  assert.equal(requestedUrl, 'http://localhost:15151/add');
  assert.deepEqual(requestBody, [{
    link: 'https://example.com/file.zip',
    downloadPage: 'https://example.com/page',
  }]);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('context menu sends to AB DM directly with headless endpoint when silent', async () => {
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

  await invokeContextMenuClick(background, {
    menuItemId: 'send-to-aria2',
    linkUrl: 'https://example.com/file.zip',
  }, {
    id: 1,
    url: 'https://example.com/page',
  });

  assert.equal(requestedUrl, 'http://localhost:15151/start-headless-download');
  assert.deepEqual(requestBody.downloadSource, {
    link: 'https://example.com/file.zip',
    downloadPage: 'https://example.com/page',
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
});

test('context menu respects aria2 silent downloads and sends immediately', async () => {
  let requestUrl = '';
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
      aria2Silent: true,
    },
    {
      fetch: async (url, options) => {
        requestUrl = url;
        requestBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            return { result: 'aria2-gid-1' };
          },
        };
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

  assert.equal(requestUrl, 'http://127.0.0.1:6800/jsonrpc');
  assert.equal(requestBody.method, 'aria2.addUri');
  assert.deepEqual(requestBody.params[0], ['https://example.com/file.zip']);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.equal(state.tasks['aria2-gid-1']?.provider, 'aria2');
  assert.equal(state.tasks['aria2-gid-1']?.status, 'active');
});

test('context menu respects gopeed silent downloads and sends immediately', async () => {
  let requestUrl = '';
  let requestBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
      gopeedSilent: true,
    },
    {
      fetch: async (url, options) => {
        requestUrl = url;
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

  await invokeContextMenuClick(background, {
    menuItemId: 'send-to-aria2',
    linkUrl: 'https://example.com/file.zip',
  }, {
    id: 1,
    url: 'https://example.com/page',
  });

  assert.equal(requestUrl, 'http://127.0.0.1:9999/api/v1/tasks');
  assert.equal(requestBody.req.url, 'https://example.com/file.zip');

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(Object.keys(state.pending || {}).length, 0);
  assert.equal(state.tasks['gopeed-task-1']?.provider, 'gopeed');
  assert.equal(state.tasks['gopeed-task-1']?.status, 'sent');
});

test('context menu enters pending queue for gopeed by default', async () => {
  let fetchCalled = false;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'gopeed',
      gopeedApi: 'http://127.0.0.1:9999',
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

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  const pending = Object.values(state.pending || {});
  assert.equal(pending.length, 1);
  assert.equal(pending[0].url, 'https://example.com/file.zip');
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

test('AB DM connection test uses localhost host and incoming port override', async () => {
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

  assert.equal(requestedUrl, 'http://localhost:17000/queues');
  assert.equal(result.ok, false);
  assert.equal(result.mode, 'abdownload');
  assert.equal(result.error, '与 AB DM 连接失败，检查 AB DM 是否正在运行');
});

test('ARIA2_RPC proxy forwards whitelisted methods and rejects others', async () => {
  let lastRpcBody = null;
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'aria2',
      aria2Rpc: 'http://localhost:6800/jsonrpc',
      aria2Secret: '',
    },
    {
      fetch: async (_url, options) => {
        lastRpcBody = JSON.parse(options.body);
        return {
          ok: true,
          async json() {
            if (lastRpcBody.method === 'aria2.tellActive') {
              return {
                result: [
                  {
                    gid: 'mgr-active-1',
                    status: 'active',
                    totalLength: '1000',
                    completedLength: '500',
                    downloadSpeed: '1024',
                    files: [{ path: '/dl/movie.mp4', uris: [{ uri: 'https://example.com/movie.mp4' }] }],
                  },
                ],
              };
            }
            if (lastRpcBody.method === 'aria2.tellStopped') {
              return {
                result: [
                  {
                    gid: 'new-gid-1',
                    status: 'complete',
                    files: [{ path: '/dl/movie.mp4', uris: [{ uri: 'https://cdn.example.com/movie.mp4' }] }],
                  },
                ],
              };
            }
            if (lastRpcBody.method === 'aria2.getGlobalStat') {
              return { result: { numActive: '1', numWaiting: '2', numStopped: '3', downloadSpeed: '1024' } };
            }
            if (lastRpcBody.method === 'aria2.addUri') {
              return { result: 'new-gid-1' };
            }
            if (lastRpcBody.method === 'aria2.removeDownloadResult') {
              return { result: 'OK' };
            }
            if (lastRpcBody.method === 'aria2.purgeDownloadResult') {
              return { result: 'OK' };
            }
            if (lastRpcBody.method === 'aria2.getOption') {
              return { result: { 'max-overall-download-limit': '5242880' } };
            }
            if (lastRpcBody.method === 'aria2.changeGlobalOption') {
              return { result: 'OK' };
            }
            throw new Error(`unexpected rpc method ${lastRpcBody.method}`);
          },
        };
      },
    }
  );

  const active = await invokeBackgroundMessage(background, { type: 'ARIA2_RPC', method: 'tellActive' });
  assert.equal(active.ok, true);
  assert.equal(active.result[0].gid, 'mgr-active-1');
  assert.equal(active.result[0].status, 'active');
  assert.ok(Number(active.result[0].addedTime) > 0);
  assert.equal(lastRpcBody.method, 'aria2.tellActive');

  const stat = await invokeBackgroundMessage(background, { type: 'ARIA2_RPC', method: 'getGlobalStat', params: [] });
  assert.equal(stat.ok, true);
  assert.equal(stat.result.numActive, '1');
  assert.equal(stat.result.numWaiting, '2');

  const redownload = await invokeBackgroundMessage(background, {
    type: 'ARIA2_RPC',
    method: 'addUri',
    params: [['https://example.com/movie.mp4'], {}],
  });
  assert.equal(redownload.ok, true);
  assert.equal(redownload.result, 'new-gid-1');
  assert.deepEqual(lastRpcBody.params, [['https://example.com/movie.mp4'], {}]);

  const stopped = await invokeBackgroundMessage(background, { type: 'ARIA2_RPC', method: 'tellStopped', params: [0, 1000] });
  assert.deepEqual(stopped.result[0].downlinkOriginalUris, ['https://example.com/movie.mp4']);
  assert.ok(Number(stopped.result[0].addedTime) > 0);

  const removed = await invokeBackgroundMessage(background, {
    type: 'ARIA2_RPC',
    method: 'removeDownloadResult',
    params: ['new-gid-1'],
  });
  assert.equal(removed.ok, true);
  const afterRemove = await invokeBackgroundMessage(background, { type: 'ARIA2_RPC', method: 'tellStopped', params: [0, 1000] });
  assert.equal(afterRemove.result[0].downlinkOriginalUris, undefined);

  await invokeBackgroundMessage(background, {
    type: 'ARIA2_RPC',
    method: 'addUri',
    params: [['https://example.com/movie.mp4'], {}],
  });
  const purged = await invokeBackgroundMessage(background, {
    type: 'ARIA2_RPC',
    method: 'purgeDownloadResult',
    params: [],
  });
  assert.equal(purged.ok, true);
  const afterPurge = await invokeBackgroundMessage(background, { type: 'ARIA2_RPC', method: 'tellStopped', params: [0, 1000] });
  assert.equal(afterPurge.result[0].downlinkOriginalUris, undefined);

  const speedLimit = await invokeBackgroundMessage(background, {
    type: 'ARIA2_RPC',
    method: 'changeGlobalOption',
    params: [{ 'max-overall-download-limit': '5242880' }],
  });
  assert.equal(speedLimit.ok, true);

  const options = await invokeBackgroundMessage(background, { type: 'ARIA2_RPC', method: 'getOption' });
  assert.equal(options.ok, true);
  assert.equal(options.result['max-overall-download-limit'], '5242880');

  const blocked = await invokeBackgroundMessage(background, { type: 'ARIA2_RPC', method: 'system.listMethods' });
  assert.equal(blocked.ok, false);
  assert.match(blocked.error, /Unsupported aria2 method/);
});

test('Aria2 RPC proxy adds cached trackers to magnet tasks', async () => {
  let rpcRequest;
  const background = loadBackgroundRuntime(
    { aria2Trackers: ['udp://tracker.example:80/announce'] },
    {
      fetch: async (_url, options) => {
        rpcRequest = JSON.parse(options.body);
        return {
          ok: true,
          async json() { return { result: 'magnet-gid' }; },
        };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, {
    type: 'ARIA2_RPC',
    method: 'addUri',
    params: [['magnet:?xt=urn:btih:abc'], {}],
  });

  assert.equal(result.ok, true);
  assert.equal(rpcRequest.params[1]['bt-tracker'], 'udp://tracker.example:80/announce');
});

test('tracker refresh keeps cached values for failed subscriptions and stores the cache locally', async () => {
  const background = loadBackgroundRuntime(
    {
      aria2TrackerSubscriptions: ['https://lists.example/ok.txt', 'https://lists.example/down.txt'],
      aria2Trackers: ['udp://cached.example:80/announce'],
    },
    {
      fetch: async (url) => {
        if (url === 'https://lists.example/down.txt') throw new Error('network offline');
        return {
          ok: true,
          status: 200,
          async text() {
            return 'udp://new.example:443/announce\n\nhttps://tracker.example/announce';
          },
        };
      },
    }
  );

  const result = await invokeBackgroundMessage(background, { type: 'REFRESH_ARIA2_TRACKERS' });

  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(result.failed.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(result.trackers)), [
    'udp://new.example:443/announce',
    'https://tracker.example/announce',
    'udp://cached.example:80/announce',
  ]);
  const cacheWrite = background.chrome._localStorageWrites.find((values) => values.aria2TrackersUpdatedAt);
  assert.deepEqual(JSON.parse(JSON.stringify(cacheWrite.aria2Trackers)), JSON.parse(JSON.stringify(result.trackers)));
});

test('tracker refresh preserves the last usable cache when every subscription fails', async () => {
  const cachedTrackers = ['udp://cached.example:80/announce'];
  const background = loadBackgroundRuntime(
    {
      aria2TrackerSubscriptions: ['https://lists.example/empty.txt'],
      aria2Trackers: cachedTrackers,
    },
    {
      fetch: async () => ({
        ok: true,
        status: 200,
        async text() { return '# temporarily empty'; },
      }),
    }
  );

  const result = await invokeBackgroundMessage(background, { type: 'REFRESH_ARIA2_TRACKERS' });

  assert.equal(result.ok, true);
  assert.equal(result.updated, false);
  assert.equal(result.preserved, true);
  assert.match(result.failed[0].error, /未解析到有效 Tracker/);
  assert.deepEqual(JSON.parse(JSON.stringify(result.trackers)), cachedTrackers);
  assert.equal(background.chrome._localStorageWrites.some((values) => values.aria2Trackers), false);
});

test('concurrent tracker refresh requests share one subscription fetch', async () => {
  let fetchCount = 0;
  let releaseFetch;
  const background = loadBackgroundRuntime(
    { aria2TrackerSubscriptions: ['https://lists.example/trackers.txt'] },
    {
      fetch: async () => {
        fetchCount += 1;
        await new Promise((resolve) => { releaseFetch = resolve; });
        return {
          ok: true,
          status: 200,
          async text() { return 'udp://tracker.example:80/announce'; },
        };
      },
    }
  );

  const first = invokeBackgroundMessage(background, { type: 'REFRESH_ARIA2_TRACKERS' });
  const second = invokeBackgroundMessage(background, { type: 'REFRESH_ARIA2_TRACKERS' });
  await new Promise((resolve) => setImmediate(resolve));
  releaseFetch();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(fetchCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(firstResult)), JSON.parse(JSON.stringify(secondResult)));
});

test('MotrixNext connection test validates the incoming secret through stat endpoint', async () => {
  const requests = [];
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '29110',
      motrixNextSecret: 'saved-secret',
    },
    {
      fetch: async (url, options = {}) => {
        requests.push({ url, headers: options.headers || {}, method: options.method || 'GET' });
        if (url === 'http://127.0.0.1:17001/ping') {
          return { ok: true, status: 200, json: async () => ({ product: 'rayburst', status: 'ok', version: '4.0.0' }) };
        }
        if (url === 'http://127.0.0.1:17001/stat') {
          return options.headers?.Authorization === 'Bearer live-secret'
            ? { ok: true, status: 200 }
            : { ok: false, status: 401 };
        }
        if (url === 'http://127.0.0.1:17001/downloads/capabilities') {
          return { ok: true, status: 200, json: async () => ({ product: 'rayburst', protocolVersion: 2, filenameHints: true }) };
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
      url: 'http://127.0.0.1:17001/ping',
      method: 'GET',
      headers: {},
    },
    {
      url: 'http://127.0.0.1:17001/stat',
      method: 'GET',
      headers: { 'X-Rayburst-Client': 'rayburst-connect', Authorization: 'Bearer live-secret' },
    },
    {
      url: 'http://127.0.0.1:17001/downloads/capabilities',
      method: 'GET',
      headers: { 'X-Rayburst-Client': 'rayburst-connect', Authorization: 'Bearer live-secret' },
    },
  ]);
});

test('MotrixNext connection test fails when incoming secret is rejected', async () => {
  const background = loadBackgroundRuntime(
    {
      downloaderType: 'motrixnext',
      motrixNextPort: '29110',
      motrixNextSecret: 'saved-secret',
    },
    {
      fetch: async (url) => {
        if (url === 'http://127.0.0.1:17001/ping') return { ok: true, status: 200, json: async () => ({ product: 'rayburst', status: 'ok', version: '4.0.0' }) };
        if (url === 'http://127.0.0.1:17001/stat') return { ok: false, status: 401 };
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
  assert.equal(result.error, '与 Rayburst 连接失败，检查 Rayburst 是否正在运行');
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

test('badge updates ignore the normal race when the target tab has already closed', async () => {
  const warnings = [];
  const background = loadBackgroundRuntime(
    { __badgeError: 'No tab with id: 823017455.' },
    {
      console: {
        ...console,
        warn(...args) {
          warnings.push(args);
        },
      },
    }
  );

  background.__backgroundTestHooks.updateActionBadgeForTab(823017455, 2);
  await Promise.resolve();

  assert.equal(background.chrome._actionCalls.setBadgeBackgroundColor.length, 1);
  assert.equal(background.chrome._actionCalls.setBadgeTextColor.length, 1);
  assert.equal(background.chrome._actionCalls.setBadgeText.length, 1);
  assert.equal(warnings.length, 0);
});

test('badge updates still report unexpected action API failures', async () => {
  const warnings = [];
  const background = loadBackgroundRuntime(
    { __badgeError: 'Action API unavailable' },
    {
      console: {
        ...console,
        warn(...args) {
          warnings.push(args);
        },
      },
    }
  );

  background.__backgroundTestHooks.updateActionBadgeForTab(12, 1);
  await Promise.resolve();

  assert.equal(warnings.length, 3);
  assert.ok(warnings.every((args) => args[0] === '[Downlink][badge] failed to update tab badge'));
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

test('legacy disabled global media sniffing migrates to wildcard blacklist', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffing: true,
    __activeTabs: [{ id: 12, windowId: 3, active: true, url: 'https://example.com/watch' }],
    __tabsById: { 12: { id: 12, windowId: 3, url: 'https://example.com/watch' } },
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      mediaSniffing: false,
    },
  });

  assert.equal(result.ok, true);
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, true);
  assert.equal(state.config.mediaSniffingBlacklist, '*');
  assert.deepEqual(JSON.parse(JSON.stringify(state.mediaBlacklistBlockedTabs)), [12]);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '', tabId: 12 });
});

test('wildcard media sniffing blacklist blocks media responses only', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: '*',
    __activeTabs: [{ id: 12, windowId: 3, active: true }],
    __tabsById: { 12: { id: 12, windowId: 3, url: 'https://example.com/watch' } },
  });

  await invokeResponseHeaders(background, {
    tabId: 12,
    frameId: 0,
    url: 'https://cdn.example.com/video.mp4',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-length', value: '2048' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, true);
  assert.deepEqual(JSON.parse(JSON.stringify(state.media)), {});
});

test('auto capture switch updates the badge while wildcard media sniffing blacklist is active', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: '*',
    __activeTabs: [{ id: 12, windowId: 3, active: true, url: 'https://example.com/watch' }],
    __tabsById: { 12: { id: 12, windowId: 3, url: 'https://example.com/watch' } },
  });

  let result = await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      autoCapture: false,
    },
  });

  assert.equal(result.ok, true);
  let state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, false);
  assert.equal(state.config.mediaSniffingBlacklist, '*');
  assert.deepEqual(JSON.parse(JSON.stringify(state.pausedTabs)), [12]);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '✕', tabId: 12 });

  result = await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      autoCapture: true,
    },
  });

  assert.equal(result.ok, true);
  state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.autoCapture, true);
  assert.equal(state.config.mediaSniffingBlacklist, '*');
  assert.deepEqual(JSON.parse(JSON.stringify(state.mediaBlacklistBlockedTabs)), [12]);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '', tabId: 12 });
});

test('media sniffing blacklist matches configured domains and subdomains only', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: 'x.com, youtube.com',
    __tabsById: {
      12: { id: 12, windowId: 3, url: 'https://music.youtube.com/watch?v=1' },
      13: { id: 13, windowId: 3, url: 'https://example.com/watch' },
    },
  });

  const response = {
    frameId: 0,
    url: 'https://cdn.example.net/video.mp4',
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
  };
  await invokeResponseHeaders(background, { ...response, tabId: 12 });
  await invokeResponseHeaders(background, { ...response, tabId: 13 });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.media[12], undefined);
  assert.equal(state.media[13].length, 1);
});

test('default media sniffing blacklist includes x.com and youtube.com', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    __tabsById: {
      12: { id: 12, windowId: 3, url: 'https://x.com/user/status/1' },
    },
  });

  await invokeResponseHeaders(background, {
    tabId: 12,
    frameId: 0,
    url: 'https://video.twimg.com/video.mp4',
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.mediaSniffingBlacklist, 'x.com,youtube.com');
  assert.equal(state.media[12], undefined);
});

test('default download interception blacklist includes web.telegram.org and skips browser download capture', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
  });

  await invokeDownloadCreated(background, {
    id: 51,
    url: 'https://web.telegram.org/k/download/file.zip',
    finalUrl: 'https://web.telegram.org/k/download/file.zip',
    referrer: 'https://web.telegram.org/k/',
    filename: 'file.zip',
    mime: 'application/zip',
    state: 'in_progress',
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.downloadInterceptionBlacklist, 'web.telegram.org');
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  assert.deepEqual(JSON.parse(JSON.stringify(state.pending)), {});
});

test('download interception blacklist matches the current website instead of redirected resource URL', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    captureExtensions: 'zip',
  });
  const sourceUrl = 'https://web.telegram.org/k/download/123';
  const cdnUrl = 'https://cdn.telegram-cdn.example/file.zip';

  const tracked = await invokeBackgroundMessage(
    background,
    {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: sourceUrl,
      filename: 'telegram-file',
    },
    { tab: { id: 12, windowId: 34, url: 'https://web.telegram.org/k/' } }
  );
  assert.equal(tracked.ok, true);

  await invokeSendHeaders(background, {
    url: sourceUrl,
    tabId: 44,
    method: 'GET',
    requestHeaders: [],
  });
  await invokeResponseHeaders(background, {
    url: sourceUrl,
    tabId: 44,
    type: 'main_frame',
    statusCode: 302,
    responseHeaders: [
      { name: 'location', value: cdnUrl },
    ],
  });
  await invokeResponseHeaders(background, {
    url: cdnUrl,
    tabId: 44,
    type: 'main_frame',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-disposition', value: 'attachment; filename="file.zip"' },
      { name: 'content-type', value: 'application/zip' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.deepEqual(JSON.parse(JSON.stringify(state.pending)), {});
  assert.deepEqual(background.chrome._downloadCalls.cancel, []);
  assert.equal(background.chrome._actionCalls.openPopup, 0);
});

test('download interception blacklist does not block media sniffing', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    __tabsById: {
      12: { id: 12, windowId: 3, url: 'https://web.telegram.org/k/' },
    },
  });

  await invokeSendHeaders(background, {
    tabId: 12,
    frameId: 0,
    url: 'https://cdn.example.net/video.mp4',
    method: 'GET',
    requestHeaders: [
      { name: 'Referer', value: 'https://web.telegram.org/k/' },
      { name: 'Cookie', value: 'session=live' },
    ],
  });
  await invokeResponseHeaders(background, {
    tabId: 12,
    frameId: 0,
    url: 'https://cdn.example.net/video.mp4',
    statusCode: 200,
    responseHeaders: [
      { name: 'content-type', value: 'video/mp4' },
      { name: 'content-length', value: '2048' },
    ],
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.downloadInterceptionBlacklist, 'web.telegram.org');
  assert.equal(state.media[12].length, 1);
  assert.equal(state.media[12][0].headers.referer, 'https://web.telegram.org/k/');
  assert.equal(state.media[12][0].headers.cookie, 'session=live');
});

test('media sniffing blacklist does not block download interception', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: 'example.com',
    downloadInterceptionBlacklist: '',
  });

  await invokeDownloadCreated(background, {
    id: 52,
    url: 'https://example.com/file.zip',
    finalUrl: 'https://example.com/file.zip',
    filename: 'file.zip',
    mime: 'application/zip',
    state: 'in_progress',
  });

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.deepEqual(background.chrome._downloadCalls.cancel, [52]);
  assert.equal(Object.keys(state.pending).length, 1);
});

test('removing a domain from media sniffing blacklist restores sniffing for that website', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: 'youtube.com',
    __activeTabs: [{ id: 12, windowId: 3, active: true, url: 'https://www.youtube.com/watch?v=1' }],
    __tabsById: {
      12: { id: 12, windowId: 3, url: 'https://www.youtube.com/watch?v=1' },
    },
  });

  let state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.deepEqual(JSON.parse(JSON.stringify(state.mediaBlacklistBlockedTabs)), [12]);

  const result = await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      mediaSniffingBlacklist: '',
    },
  });
  assert.equal(result.ok, true);

  await invokeResponseHeaders(background, {
    tabId: 12,
    frameId: 0,
    url: 'https://cdn.example.net/video.mp4',
    statusCode: 200,
    responseHeaders: [{ name: 'content-type', value: 'video/mp4' }],
  });

  state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.mediaSniffingBlacklist, '');
  assert.deepEqual(JSON.parse(JSON.stringify(state.mediaBlacklistBlockedTabs)), []);
  assert.equal(state.media[12].length, 1);
});

test('media sniffing blacklist preserves commas while editing', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: 'x.com',
    __activeTabs: [{ id: 12, windowId: 3, active: true, url: 'https://x.com/user/status/1' }],
    __tabsById: {
      12: { id: 12, windowId: 3, url: 'https://x.com/user/status/1' },
    },
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'SAVE_CONFIG',
    config: {
      mediaSniffingBlacklist: 'x.com,',
    },
  });
  assert.equal(result.ok, true);

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.mediaSniffingBlacklist, 'x.com,');
  assert.deepEqual(JSON.parse(JSON.stringify(state.mediaBlacklistBlockedTabs)), [12]);
});

test('adding current site to media blacklist persists it and blocks sniffing immediately', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: 'x.com,',
    __activeTabs: [{ id: 12, windowId: 3, active: true, url: 'https://video.example.com/watch' }],
    __tabsById: {
      12: { id: 12, windowId: 3, url: 'https://video.example.com/watch' },
    },
  });
  background.__backgroundTestHooks.mediaManager.upsertMediaResource({
    id: 'media_12',
    tabId: 12,
    resourceUrl: 'https://cdn.example.com/video.mp4',
    filename: 'video.mp4',
    mime: 'video/mp4',
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'ADD_SITE_TO_MEDIA_BLACKLIST',
    tabId: 12,
  });
  assert.equal(result.ok, true);
  assert.equal(result.hostname, 'video.example.com');
  assert.equal(result.mediaSniffingBlacklist, 'x.com,video.example.com');

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.mediaSniffingBlacklist, 'x.com,video.example.com');
  assert.deepEqual(JSON.parse(JSON.stringify(state.mediaBlacklistBlockedTabs)), [12]);
  assert.equal(state.media[12], undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(background.chrome._actionCalls.setBadgeText.at(-1))), { text: '', tabId: 12 });
});

test('removing current site from media blacklist persists it and restores sniffing immediately', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: 'x.com,example.com',
    __activeTabs: [{ id: 12, windowId: 3, active: true, url: 'https://video.example.com/watch' }],
    __tabsById: {
      12: { id: 12, windowId: 3, url: 'https://video.example.com/watch' },
    },
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'REMOVE_SITE_FROM_MEDIA_BLACKLIST',
    tabId: 12,
  });
  assert.equal(result.ok, true);
  assert.equal(result.mediaSniffingBlacklist, 'x.com');

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.mediaSniffingBlacklist, 'x.com');
  assert.deepEqual(JSON.parse(JSON.stringify(state.mediaBlacklistBlockedTabs)), []);
});

test('wildcard blacklist cannot remove only the current site', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    mediaSniffingBlacklist: '*',
    __activeTabs: [{ id: 12, windowId: 3, active: true, url: 'https://example.com/watch' }],
    __tabsById: {
      12: { id: 12, windowId: 3, url: 'https://example.com/watch' },
    },
  });

  const result = await invokeBackgroundMessage(background, {
    type: 'REMOVE_SITE_FROM_MEDIA_BLACKLIST',
    tabId: 12,
  });
  assert.equal(result.ok, false);
  assert.equal(result.globalDisabled, true);
  assert.equal(result.error, '媒体嗅探已全局禁用，请在设置中删除 * 后再恢复');

  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.mediaSniffingBlacklist, '*');
  assert.deepEqual(JSON.parse(JSON.stringify(state.mediaBlacklistBlockedTabs)), [12]);
});

test('storage auto capture changes pause active tab sniffing and update the badge', async () => {
  const background = loadBackgroundRuntime({
    autoCapture: true,
    __activeTabs: [{ id: 12, windowId: 3, active: true }],
  });

  assert.equal(typeof background.chrome._listeners.storageOnChanged, 'function');
  background.chrome.storage.local.set = async (values) => {
    background.chrome._listeners.storageOnChanged(Object.fromEntries(
      Object.entries(values).map(([key, newValue]) => [key, { newValue }])
    ), 'local');
  };
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


test('saved connection settings survive restart with stale or empty sync storage', async () => {
  for (const failSyncSave of [false, true]) {
    const localValues = {};
    let syncValues = { motrixNextPort: '29110' };
    const storage = {
      local: {
        get(defaults, callback) { callback({ ...defaults, ...localValues }); },
        async set(values) { Object.assign(localValues, values); },
      },
      sync: {
        get(defaults, callback) { callback({ ...defaults, ...syncValues }); },
        async set(values) {
          if (failSyncSave) throw new Error('sync unavailable');
          Object.assign(syncValues, values);
        },
      },
    };
    const saved = {
      downloaderType: 'motrixnext',
      motrixNextPort: '16888',
      motrixNextSecret: 'saved-secret',
      aria2Rpc: 'http://localhost:7777/jsonrpc',
      gopeedApi: 'http://127.0.0.1:9998',
      externalLauncherPort: '15199',
    };
    const first = loadBackgroundRuntime({}, { storage });
    assert.equal((await invokeBackgroundMessage(first, { type: 'SAVE_CONFIG', config: saved })).ok, true);
    for (const staleSync of [{}, { motrixNextPort: '29110' }]) {
      syncValues = staleSync;
      const restarted = loadBackgroundRuntime({}, { storage });
      const state = await invokeBackgroundMessage(restarted, { type: 'GET_STATE' });
      for (const [key, value] of Object.entries(saved)) assert.equal(state.config[key], value);
    }
  }
});

test('existing sync settings load when no local settings have been saved', async () => {
  const background = loadBackgroundRuntime({ motrixNextPort: '16999' }, {
    storage: { local: { get(defaults, callback) { callback({ ...defaults }); } } },
  });
  const state = await invokeBackgroundMessage(background, { type: 'GET_STATE' });
  assert.equal(state.config.motrixNextPort, '16999');
});


test('incoming sync updates and removals remain effective after restart', async () => {
  const local = { motrixNextPort: '16999' };
  let background;
  const storage = {
    local: {
      get(defaults, callback) { callback({ ...defaults, ...local }); },
      async set(values) {
        Object.assign(local, values);
        background.chrome._listeners.storageOnChanged(Object.fromEntries(
          Object.entries(values).map(([key, newValue]) => [key, { newValue }])
        ), 'local');
      },
    },
  };
  background = loadBackgroundRuntime({}, { storage });
  for (const newValue of ['17000', undefined]) {
    await background.chrome._listeners.storageOnChanged({ motrixNextPort: { newValue } }, 'sync');
    const expected = newValue ?? '29110';
    assert.equal((await invokeBackgroundMessage(background, { type: 'GET_STATE' })).config.motrixNextPort, expected);
    background = loadBackgroundRuntime({}, { storage });
    assert.equal((await invokeBackgroundMessage(background, { type: 'GET_STATE' })).config.motrixNextPort, expected);
  }
});

test('failed sync persistence does not apply a temporary config change', async () => {
  const background = loadBackgroundRuntime({ motrixNextPort: '16999' }, { console: { ...console, warn() {} } });
  background.chrome.storage.local.set = async () => { throw new Error('write failed'); };
  await background.chrome._listeners.storageOnChanged({ motrixNextPort: { newValue: '17000' } }, 'sync');
  assert.equal((await invokeBackgroundMessage(background, { type: 'GET_STATE' })).config.motrixNextPort, '16999');
});
