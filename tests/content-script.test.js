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
  await runtime.dispatchClick(link, { altKey: true });
  await flushAsyncHandlers();

  assert.equal(runtime.locationHref, 'https://files.example/file.zip');
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

  assert.deepEqual(messages.map(message => ({ ...message })), [
    {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: 'https://files.example/file.zip',
      filename: 'file.zip',
    },
    {
      type: 'BYPASS_NEXT_DOWNLOAD',
      url: 'https://files.example/file.zip',
      modifier: 'alt',
    },
  ]);
});

test('bypass click waits for background marker before resuming same-tab download navigation', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/file.zip' });

  const event = await runtime.dispatchClick(link, { altKey: true });
  await flushAsyncHandlers();

  assert.equal(event.defaultPrevented, true);
  assert.equal(event.stopPropagationCalled, true);
  assert.equal(event.stopImmediatePropagationCalled, true);
  assert.deepEqual(messages.map(message => ({ ...message })), [
    {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: 'https://files.example/file.zip',
      filename: 'file.zip',
    },
    {
      type: 'BYPASS_NEXT_DOWNLOAD',
      url: 'https://files.example/file.zip',
      modifier: 'alt',
    },
  ]);
  assert.equal(runtime.locationHref, 'https://files.example/file.zip');
});

test('bypass click does not intercept ordinary links', async () => {
  const messages = [];
  const runtime = loadContentScript({
    sendMessage: async (message) => {
      messages.push(message);
      return { ok: true };
    },
  });
  const link = createElement({ href: 'https://files.example/readme' });

  const event = await runtime.dispatchClick(link, { altKey: true });
  await flushAsyncHandlers();

  assert.equal(event.defaultPrevented, false);
  assert.deepEqual(messages, []);
  assert.equal(runtime.locationHref, 'https://page.example/current');
});

test('bypass click resumes target window download navigation after marker is saved', async () => {
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
  assert.deepEqual(messages.map(message => ({ ...message })), [
    {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: 'https://files.example/file.zip',
      filename: 'file.zip',
    },
    {
      type: 'BYPASS_NEXT_DOWNLOAD',
      url: 'https://files.example/file.zip',
      modifier: 'alt',
    },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(runtime.openedWindows)), [{
    url: 'about:blank',
    target: '_blank',
    location: 'https://files.example/file.zip',
  }]);
  assert.equal(runtime.locationHref, 'https://page.example/current');
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
