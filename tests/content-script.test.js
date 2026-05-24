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

test('direct file clicks are left to browser download creation', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(messages, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});

test('download attribute links are left to browser download creation', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/generated', download: 'generated.zip' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(messages, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});

test('suspicious download links are left to browser navigation and download creation', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/download?id=1' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(messages, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});

test('normal clicks tolerate invalidated extension context', async () => {
  const runtime = loadContentScript({
    sendMessage() {
      throw new Error('Extension context invalidated.');
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  const event = await runtime.dispatchClick(link);

  assert.equal(event.defaultPrevented, false);
  assert.equal(runtime.locationHref, 'https://page.example/current');
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

  assert.equal(runtime.locationHref, 'https://page.example/current');
});

test('bypass gesture still marks next download for matching modifier', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  await runtime.dispatchPointerdown(link, { altKey: true });

  assert.deepEqual(messages.map(message => ({ ...message })), [{
    type: 'BYPASS_NEXT_DOWNLOAD',
    url: 'https://files.example/file.zip',
    modifier: 'alt',
  }]);
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
  assert.deepEqual(messages, []);
  assert.deepEqual(runtime.openedWindows, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});
