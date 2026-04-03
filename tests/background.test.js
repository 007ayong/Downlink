const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createChromeStub(storedConfig = {}) {
  return {
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

function loadBackgroundRuntime(storedConfig = {}) {
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
    chrome: createChromeStub(storedConfig),
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
