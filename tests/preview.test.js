const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement(tagName = 'div') {
  const listeners = {};
  return {
    tagName,
    children: [],
    dataset: {},
    className: '',
    classList: {
      add() {},
      remove() {},
      toggle() {},
    },
    textContent: '',
    hidden: false,
    value: '',
    currentTime: 0,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    replaceChildren(...children) {
      this.children = children;
    },
    addEventListener(type, handler) {
      listeners[type] = listeners[type] || [];
      listeners[type].push(handler);
    },
    setAttribute() {},
    focus() {},
    select() {},
    blur() {},
    _listeners: listeners,
  };
}

test('Safari preview streams authenticated media through its source tab', async () => {
  const elements = new Map();
  const players = [];
  const scriptingCalls = [];
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createElement());
    return elements.get(id);
  };
  const document = {
    title: '',
    getElementById: getElement,
    querySelector(selector) {
      if (selector === '.audio-title') return null;
      return createElement();
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      const element = createElement(tagName);
      if (tagName === 'video' || tagName === 'audio') players.push(element);
      return element;
    },
    createElementNS(_namespace, tagName) {
      return createElement(tagName);
    },
  };

  let sourceBufferUpdateEnd = null;
  const sourceBuffer = {
    updating: false,
    buffered: { length: 0, start: () => 0, end: () => 0 },
    addEventListener(type, handler) {
      if (type === 'updateend') sourceBufferUpdateEnd = handler;
    },
    appendBuffer() {
      this.updating = true;
      setTimeout(() => {
        this.updating = false;
        sourceBufferUpdateEnd?.();
      }, 0);
    },
    remove() {},
  };
  class FakeMediaSource {
    static isTypeSupported() { return true; }
    constructor() {
      this.readyState = 'closed';
      this.listeners = {};
    }
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    }
    addSourceBuffer() {
      return sourceBuffer;
    }
    endOfStream() {
      this.readyState = 'ended';
    }
  }
  class FakeURL extends URL {
    static createObjectURL(mediaSource) {
      setTimeout(() => {
        mediaSource.readyState = 'open';
        mediaSource.listeners.sourceopen?.();
      }, 0);
      return 'blob:safari-authenticated-preview';
    }
    static revokeObjectURL() {}
  }

  const media = {
    id: 'media_1',
    tabId: 42,
    resourceUrl: 'https://cdn.example.com/authenticated-video.m4s',
    filename: 'video.m4s',
    kind: 'video',
    mime: 'application/octet-stream',
    size: 8,
    width: 1920,
    height: 1080,
    headers: {},
  };
  const chrome = {
    storage: { sync: { get(_defaults, callback) { callback({ language: 'auto' }); } } },
    runtime: {
      lastError: null,
      getURL(value) {
        return `safari-web-extension://test/${value}`;
      },
      sendMessage(message, callback) {
        if (message.type === 'GET_MEDIA_ITEM') callback({ ok: true, media });
        else callback?.({ ok: true, headersApplied: [] });
      },
    },
    tabs: {
      query(_query, callback) {
        callback([{ id: 99 }]);
      },
    },
    scripting: {
      executeScript(details, callback) {
        scriptingCalls.push(details);
        callback([{
          result: {
            ok: true,
            base64: Buffer.from([0x61, 0x76, 0x63, 0x43, 1, 0x64, 0, 0x28]).toString('base64'),
            byteLength: 8,
            totalSize: 8,
            ranged: true,
            oversized: false,
          },
        }]);
      },
    },
  };
  const context = {
    console,
    Buffer,
    URL: FakeURL,
    URLSearchParams,
    MediaSource: FakeMediaSource,
    Uint8Array,
    atob,
    btoa,
    setTimeout,
    clearTimeout,
    location: { search: '?id=media_1' },
    navigator: { clipboard: { writeText: async () => {} } },
    document,
    chrome,
    window: { addEventListener() {} },
    globalThis: null,
  };
  context.globalThis = context;

  const script = fs.readFileSync(path.join(__dirname, '..', 'preview.js'), 'utf8');
  vm.runInNewContext(script, context, { filename: 'preview.js' });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal(scriptingCalls.length, 1);
  assert.equal(scriptingCalls[0].target.tabId, 42);
  assert.equal(scriptingCalls[0].world, 'MAIN');
  assert.equal(players.length, 1);
  assert.equal(players[0].src, 'blob:safari-authenticated-preview');
  assert.notEqual(players[0].src, media.resourceUrl);
});
