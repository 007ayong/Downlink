const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement({ href, target = '', download = undefined, ariaLabel = '', textContent = '' } = {}) {
  const attrs = {};
  if (download !== undefined) attrs.download = download;
  if (ariaLabel) attrs['aria-label'] = ariaLabel;
  return {
    href,
    target,
    textContent,
    parentElement: null,
    getAttribute(name) {
      if (name === 'download') return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
      if (name === 'aria-label') return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : null;
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
    stopImmediatePropagationCalled: false,
    stopImmediatePropagation() {
      this.stopImmediatePropagationCalled = true;
    },
  };
}

function flushAsyncHandlers() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function loadContentScript({ config = {}, sendMessage } = {}) {
  const listeners = {};
  const storageChangeListeners = [];
  const openedWindows = [];
  let assignedLocation = 'https://page.example/current';

  const context = {
    URL,
    setTimeout,
    clearTimeout,
    window: {
      open(url, target) {
        const openedWindow = {
          url,
          target,
          location: url,
        };
        openedWindows.push(openedWindow);
        return openedWindow;
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
        local: {
          get(defaults, callback) {
            callback?.({ ...defaults });
          },
        },
        onChanged: {
          addListener(listener) {
            storageChangeListeners.push(listener);
          },
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
  const configDefaultsScript = fs.readFileSync(path.join(__dirname, '..', 'lib', 'config-defaults.js'), 'utf8');
  vm.runInNewContext(configDefaultsScript, context, { filename: 'lib/config-defaults.js' });
  const script = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
  vm.runInNewContext(script, context, { filename: 'content-script.js' });

  async function dispatchClick(element, props = {}) {
    const event = { ...createClickEvent(element), ...props };
    for (const entry of listeners.click || []) {
      entry.listener(event);
      await Promise.resolve();
    }
    await Promise.resolve();
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
    dispatchStorageChange(changes, areaName = 'sync') {
      for (const listener of storageChangeListeners) listener(changes, areaName);
    },
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

test('direct file links with new-window targets are tracked before source-tab download navigation resumes', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip', target: '_blank' });

  const event = await runtime.dispatchClick(link);
  await flushAsyncHandlers();

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopPropagationCalled, true);
  assert.deepEqual(messages.map(message => ({ ...message })), [{
    type: 'TRACK_DOWNLOAD_CLICK',
    url: 'https://files.example/file.zip',
    filename: 'file.zip',
  }]);
  assert.deepEqual(runtime.openedWindows, []);
  assert.equal(runtime.locationHref, 'https://files.example/file.zip');
});

test('new-window links use shared default capture extensions for click intent tracking', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/client_zh-cn.esd', target: '_blank' });

  const event = await runtime.dispatchClick(link);
  await flushAsyncHandlers();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(messages.map(message => ({ ...message })), [{
    type: 'TRACK_DOWNLOAD_CLICK',
    url: 'https://files.example/client_zh-cn.esd',
    filename: 'client_zh-cn.esd',
  }]);
  assert.equal(runtime.locationHref, 'https://files.example/client_zh-cn.esd');
});

test('new-window links use stored capture extensions for click intent tracking', async () => {
  const messages = [];
  const runtime = loadContentScript({
    config: { captureExtensions: 'zip,custom' },
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/package.custom', target: '_blank' });

  const event = await runtime.dispatchClick(link);
  await flushAsyncHandlers();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(messages.map(message => ({ ...message })), [{
    type: 'TRACK_DOWNLOAD_CLICK',
    url: 'https://files.example/package.custom',
    filename: 'package.custom',
  }]);
  assert.equal(runtime.locationHref, 'https://files.example/package.custom');
});

test('capture extension storage changes update new-window click intent tracking', async () => {
  const messages = [];
  const runtime = loadContentScript({
    config: { captureExtensions: 'zip' },
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });

  runtime.dispatchStorageChange({
    captureExtensions: { oldValue: 'zip', newValue: 'custom' },
  });
  const link = createElement({ href: 'https://files.example/package.custom', target: '_blank' });

  const event = await runtime.dispatchClick(link);
  await flushAsyncHandlers();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(messages.map(message => ({ ...message })), [{
    type: 'TRACK_DOWNLOAD_CLICK',
    url: 'https://files.example/package.custom',
    filename: 'package.custom',
  }]);
  assert.equal(runtime.locationHref, 'https://files.example/package.custom');
});

test('modified clicks on new-window download links still resume in the source tab', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip', target: '_blank' });

  const event = await runtime.dispatchClick(link, { altKey: true });
  await flushAsyncHandlers();

  assert.equal(event.defaultPrevented, true);
  assert.deepEqual(messages.map(message => ({ ...message })), [{
    type: 'TRACK_DOWNLOAD_CLICK',
    url: 'https://files.example/file.zip',
    filename: 'file.zip',
  }]);
  assert.deepEqual(runtime.openedWindows, []);
  assert.equal(runtime.locationHref, 'https://files.example/file.zip');
});

test('ordinary new-window links are not intercepted', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/readme', target: '_blank' });

  const event = await runtime.dispatchClick(link);
  await flushAsyncHandlers();

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(messages, []);
  assert.deepEqual(runtime.openedWindows, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});

test('new-window artifact links report their source tab without intercepting navigation', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({
    href: 'https://github.com/oceandrift7/YTLocalQueue/actions/runs/26190396891/artifacts/7121736843',
    target: '_blank',
    ariaLabel: 'Download YTLocalQueue-deb (opens in a new tab)',
    textContent: 'YTLocalQueue-deb',
  });

  const event = await runtime.dispatchPointerdown(link);

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(messages.map(message => ({ ...message })), [{
    type: 'TRACK_DOWNLOAD_CLICK',
    url: 'https://github.com/oceandrift7/YTLocalQueue/actions/runs/26190396891/artifacts/7121736843',
    filename: 'YTLocalQueue-deb',
  }]);
  assert.deepEqual(runtime.openedWindows, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});
