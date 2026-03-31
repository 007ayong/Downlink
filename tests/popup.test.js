const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElementStub() {
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
      add() {},
      remove() {},
      toggle() {},
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
  };
}

function loadPopupRuntime() {
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
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        if (message?.type === 'GET_STATE') {
          callback?.({
            tasks: {},
            pending: {},
            media: {},
            config: {},
            hiddenTaskGids: [],
          });
          return;
        }
        if (message?.type === 'TEST_CONNECTION') {
          callback?.({ ok: false, error: 'stubbed' });
          return;
        }
        callback?.({ ok: true });
      },
      getURL(value) {
        return value;
      },
      onMessage: {
        addListener() {},
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

  const script = fs.readFileSync(path.join(__dirname, '..', 'popup.js'), 'utf8');
  vm.runInNewContext(script, context, { filename: 'popup.js' });
  return context;
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
