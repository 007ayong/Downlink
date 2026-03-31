const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createChromeStub() {
  return {
    storage: {
      sync: {
        get(defaults, callback) {
          callback?.(defaults);
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
        addListener() {},
      },
      cancel(_id, callback) {
        callback?.();
      },
      erase() {},
    },
    runtime: {
      onMessage: {
        addListener() {},
      },
      onInstalled: {
        addListener() {},
      },
      onStartup: {
        addListener() {},
      },
      lastError: null,
    },
    contextMenus: {
      removeAll(callback) {
        callback?.();
      },
      create() {},
      onClicked: {
        addListener() {},
      },
    },
    tabs: {
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

function loadBackgroundRuntime() {
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
    fetch: async () => {
      throw new Error('unexpected fetch in background test');
    },
    atob(value) {
      return Buffer.from(value, 'base64').toString('binary');
    },
    chrome: createChromeStub(),
    importScripts() {},
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
