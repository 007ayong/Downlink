const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement({ href, target = '', download = undefined } = {}) {
  const attrs = {};
  if (download !== undefined) attrs.download = download;
  return {
    href,
    target,
    parentElement: null,
    getAttribute(name) {
      if (name === 'download') return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      return null;
    },
    closest(selector) {
      return selector === 'a[href], area[href]' ? this : null;
    },
  };
}

function createClickEvent(target) {
  return {
    target,
    button: 0,
    detail: 1,
    defaultPrevented: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagationCalled: false,
    stopPropagation() {
      this.stopPropagationCalled = true;
    },
  };
}

function loadContentScript({ config = {}, sendMessage } = {}) {
  const listeners = {};
  const openedWindows = [];
  let assignedLocation = 'https://page.example/current';
  const context = {
    URL,
    setTimeout,
    clearTimeout,
    window: {
      open(url, target) {
        openedWindows.push({ url, target });
      },
    },
    location: {
      href: assignedLocation,
    },
    document: {
      addEventListener(type, listener, options) {
        listeners[type] ||= [];
        listeners[type].push({ listener, options });
      },
    },
    chrome: {
      runtime: {
        sendMessage: sendMessage || (async () => ({ ok: true })),
      },
      storage: {
        sync: {
          get(defaults, callback) {
            callback?.({ ...defaults, ...config });
          },
        },
        onChanged: {
          addListener() {},
        },
      },
    },
  };

  Object.defineProperty(context, 'location', {
    get() {
      return context.window.location;
    },
    set(value) {
      assignedLocation = String(value);
      context.window.location.href = assignedLocation;
    },
  });
  Object.defineProperty(context.window, 'location', {
    get() {
      return {
        get href() {
          return assignedLocation;
        },
        set href(value) {
          assignedLocation = String(value);
        },
      };
    },
    set(value) {
      assignedLocation = String(value);
    },
  });

  context.globalThis = context;
  context.self = context;
  const script = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
  vm.runInNewContext(script, context, { filename: 'content-script.js' });

  async function dispatchClick(element) {
    const event = createClickEvent(element);
    for (const entry of listeners.click || []) {
      entry.listener(event);
      await Promise.resolve();
    }
    await Promise.resolve();
    return event;
  }

  async function dispatchPointerdown(element, props = {}) {
    const event = { ...createClickEvent(element), ...props };
    for (const entry of listeners.pointerdown || []) {
      entry.listener(event);
      await Promise.resolve();
    }
    await Promise.resolve();
    return event;
  }

  return {
    dispatchClick,
    dispatchPointerdown,
    openedWindows,
    get locationHref() {
      return assignedLocation;
    },
  };
}

test('direct capture restores navigation when background declines interception', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      if (message.type === 'CAPTURE_LINK_DOWNLOAD') return { ok: false, captured: false, fallback: true };
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, true);
  assert.equal(messages.some(message => message.type === 'CAPTURE_LINK_DOWNLOAD'), true);
  assert.equal(runtime.locationHref, 'https://files.example/file.zip');
});

test('accepted direct capture failure does not fall back to browser download', async () => {
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      if (message.type === 'CAPTURE_LINK_DOWNLOAD') return { ok: false, captured: true, fallback: false, error: 'downloader offline' };
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, true);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});

test('direct capture restores navigation when message send fails', async () => {
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      if (message.type === 'CAPTURE_LINK_DOWNLOAD') throw new Error('background unavailable');
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  await runtime.dispatchClick(link);

  assert.equal(runtime.locationHref, 'https://files.example/file.zip');
});

test('direct capture restores navigation when extension context is invalidated', async () => {
  const runtime = loadContentScript({
    sendMessage() {
      throw new Error('Extension context invalidated.');
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, true);
  assert.equal(runtime.locationHref, 'https://files.example/file.zip');
});

test('bypass gesture ignores invalidated extension context before click', async () => {
  const runtime = loadContentScript({
    sendMessage() {
      throw new Error('Extension context invalidated.');
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  await runtime.dispatchPointerdown(link, { altKey: true });
  await runtime.dispatchClick(link);

  assert.equal(runtime.locationHref, 'https://files.example/file.zip');
});

test('probe candidates with new-window targets are not intercepted', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: false };
    },
  });
  const link = createElement({ href: 'https://files.example/download?id=1', target: '_blank' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, false);
  assert.equal(messages.some(message => message.type === 'PROBE_LINK_DOWNLOAD'), false);
  assert.deepEqual(runtime.openedWindows, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});

test('path segments containing download are probed before same-window navigation', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: false, captured: false, fallback: true };
    },
  });
  const link = createElement({
    href: 'https://github.com/WinApps-share/winapps/releases/download/v1.3.2/winapps-v1.3.2-linux-amd64',
  });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, true);
  assert.equal(messages.some(message => message.type === 'PROBE_LINK_DOWNLOAD'), true);
  assert.equal(runtime.locationHref, link.href);
});

test('direct file links with new-window targets are not intercepted', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip', target: '_blank' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, false);
  assert.equal(messages.some(message => message.type === 'CAPTURE_LINK_DOWNLOAD'), false);
  assert.deepEqual(runtime.openedWindows, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});
