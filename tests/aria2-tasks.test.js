const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAria2TasksRuntime(options = {}) {
  const control = {
    backgroundConfig: { aria2Rpc: 'http://localhost:6800/jsonrpc', aria2Secret: '' },
    localConfig: { aria2Rpc: 'http://localhost:6800/jsonrpc', aria2Secret: '' },
    rpcError: '',
    deferRpc: false,
    pendingRpc: [],
    storageListener: null,
    ...options,
  };
  const makeElement = () => {
    const classes = new Set();
    const children = [];
    const element = {
      classList: {
        add(...names) { names.forEach((name) => classes.add(name)); },
        remove(...names) { names.forEach((name) => classes.delete(name)); },
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : !!force;
          if (enabled) classes.add(name); else classes.delete(name);
          return enabled;
        },
        contains(name) { return classes.has(name); },
      },
    dataset: {},
    style: {},
    children,
    attributes: [],
    append(...nodes) { children.push(...nodes); },
    appendChild(node) { children.push(node); return node; },
    insertBefore(node, before) {
      const index = before ? children.indexOf(before) : -1;
      if (index < 0) children.push(node); else children.splice(index, 0, node);
      return node;
    },
    replaceChildren(...nodes) { children.splice(0, children.length, ...nodes); },
    addEventListener() {},
    removeEventListener() {},
    remove() {},
    setAttribute() {},
    removeAttribute() {},
    getAttribute() { return ''; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    contains() { return false; },
    focus() {},
    scrollIntoView() {},
    textContent: '',
    value: '',
    };
    Object.defineProperty(element, 'className', {
      get() { return Array.from(classes).join(' '); },
      set(value) {
        classes.clear();
        String(value || '').split(/\s+/).filter(Boolean).forEach((name) => classes.add(name));
      },
    });
    return element;
  };
  const elements = new Map();
  const document = {
    title: '',
    body: makeElement(),
    activeElement: null,
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    querySelectorAll() { return []; },
    createElement() { return makeElement(); },
    createDocumentFragment() { return makeElement(); },
    addEventListener() {},
  };
  const window = {
    localStorage: {
      getItem() { return null; },
      setItem() {},
    },
    addEventListener() {},
    matchMedia() { return { matches: false }; },
    setTimeout,
  };
  const context = {
    console,
    URL,
    navigator: { language: 'en-US' },
    location: { origin: 'https://extension.example' },
    document,
    window,
    setTimeout,
    clearTimeout,
    setInterval() { return 1; },
    clearInterval() {},
    chrome: {
      storage: {
        local: {
          get(defaults, callback) { callback({ ...defaults, ...control.localConfig }); },
        },
        sync: {
          get(defaults, callback) { callback({ ...defaults }); },
        },
        onChanged: {
          addListener(listener) { control.storageListener = listener; },
        },
      },
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
          if (message.type === 'GET_STATE') {
            callback({ config: { ...control.backgroundConfig } });
            return;
          }
          if (control.deferRpc) {
            control.pendingRpc.push({ message, callback });
            return;
          }
          if (control.rpcError) {
            callback({ ok: false, error: control.rpcError });
            return;
          }
          const result = message.method === 'getGlobalStat' ? {} : [];
          callback({ ok: true, result });
        },
      },
    },
  };
  context.globalThis = context;
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, '..', 'aria2-tasks.js'), 'utf8'),
    context,
    { filename: 'aria2-tasks.js' },
  );
  context.__control = control;
  context.__elements = elements;
  return context;
}

test('Aria2 task details use the original URI from the normalized raw task', () => {
  const runtime = loadAria2TasksRuntime();
  const entries = runtime.__aria2TasksTestHooks.taskUriEntries({
    raw: {
      files: [{
        path: '/downloads/movie.mp4',
        uris: [{ uri: 'https://cdn.example.com/movie.mp4' }],
      }],
      downlinkOriginalUris: ['https://example.com/movie.mp4'],
    },
  });

  assert.deepEqual(JSON.parse(JSON.stringify(entries)), [{
    uri: 'https://example.com/movie.mp4',
    filePath: '/downloads/movie.mp4',
  }]);
});

test('Aria2 task creation time falls back to extension metadata when RPC omits it', () => {
  const runtime = loadAria2TasksRuntime();
  const addedAt = 1760000000000;
  const task = runtime.__aria2TasksTestHooks.normalizeTask({
    gid: 'metadata-gid',
    status: 'active',
    files: [],
  }, {
    'metadata-gid': { addedAt },
  });

  assert.equal(task.addedTime, Math.floor(addedAt / 1000));
});

test('Aria2 task creation time falls back to the first page observation', () => {
  const runtime = loadAria2TasksRuntime();
  const first = runtime.__aria2TasksTestHooks.normalizeTask({
    gid: 'observed-gid',
    status: 'active',
    files: [],
  });
  const second = runtime.__aria2TasksTestHooks.normalizeTask({
    gid: 'observed-gid',
    status: 'active',
    files: [],
  });

  assert.ok(first.addedTime > 0);
  assert.equal(second.addedTime, first.addedTime);
});

test('Magnet metadata transfer is not reported as completed payload progress', () => {
  const runtime = loadAria2TasksRuntime();
  const task = runtime.__aria2TasksTestHooks.normalizeTask({
    gid: 'magnet-metadata-gid',
    status: 'active',
    totalLength: '2048',
    completedLength: '2048',
    downlinkOriginalUris: ['magnet:?xt=urn:btih:abc123'],
    files: [],
  });

  assert.equal(task.total, 0);
  assert.equal(task.completed, 0);
  assert.equal(task.pct, 0);
  assert.equal(task.isMagnetMetadata, true);
  assert.equal(task.downloadProgressAvailable, false);
});

test('Resolved magnet task uses torrent payload lengths for progress', () => {
  const runtime = loadAria2TasksRuntime();
  const task = runtime.__aria2TasksTestHooks.normalizeTask({
    gid: 'magnet-payload-gid',
    status: 'active',
    totalLength: '1000',
    completedLength: '250',
    downlinkOriginalUris: ['magnet:?xt=urn:btih:abc123'],
    bittorrent: { info: { name: 'example' } },
    files: [],
  });

  assert.equal(task.total, 1000);
  assert.equal(task.completed, 250);
  assert.equal(task.pct, 25);
  assert.equal(task.isMagnetMetadata, false);
  assert.equal(task.downloadProgressAvailable, true);
});

test('Download speed maps to turtle, rabbit, and rocket indicators', () => {
  const runtime = loadAria2TasksRuntime();
  const speedIndicator = runtime.__aria2TasksTestHooks.speedIndicator;

  assert.equal(speedIndicator(256 * 1024).icon, '🐢');
  assert.equal(speedIndicator(2 * 1024 * 1024).icon, '🐇');
  assert.equal(speedIndicator(12 * 1024 * 1024).icon, '🚀');
  assert.equal(speedIndicator(1024 * 1024).icon, '🐇');
  assert.equal(speedIndicator(10 * 1024 * 1024).icon, '🚀');
});

test('Detail progress bar places the live speed marker at the progress endpoint', () => {
  const runtime = loadAria2TasksRuntime();
  const card = runtime.__aria2TasksTestHooks.createProgressBar(
    'Download progress', 100, '1 GB / 1 GB', false, true, 12 * 1024 * 1024, true,
  );
  const track = card.children[0].children[1];
  const marker = track.children[1];

  assert.equal(track.className, 'detail-progress-track');
  assert.equal(track.children[0].style.width, '100%');
  assert.equal(marker.style.left, '100%');
  assert.ok(marker.classList.contains('very-fast'));
  assert.equal(marker.children[0].textContent, '🚀');
});

test('Completed magnet metadata bootstrap is omitted after aria2 creates its payload task', () => {
  const runtime = loadAria2TasksRuntime();
  const snapshot = runtime.__aria2TasksTestHooks.buildSnapshot(
    [{
      gid: 'payload-gid',
      status: 'active',
      totalLength: '1000',
      completedLength: '100',
      bittorrent: { info: { name: 'example' } },
      files: [],
    }],
    [],
    [{
      gid: 'metadata-gid',
      status: 'complete',
      totalLength: '2048',
      completedLength: '2048',
      followedBy: ['payload-gid'],
      downlinkOriginalUris: ['magnet:?xt=urn:btih:abc123'],
      files: [],
    }],
    {},
  );

  assert.deepEqual(Array.from(snapshot.all, (task) => task.gid), ['payload-gid']);
  assert.equal(snapshot.all[0].pct, 10);
});

test('Optimistic pause status updates both list tasks and detail snapshot data', () => {
  const runtime = loadAria2TasksRuntime();
  const hooks = runtime.__aria2TasksTestHooks;
  const state = hooks.getState();
  const active = hooks.normalizeTask({
    gid: 'sync-gid',
    status: 'active',
    totalLength: '1000',
    completedLength: '100',
    downloadSpeed: '256',
    uploadSpeed: '64',
    files: [],
  });
  state.tasks = [active];
  state.snapshot = hooks.buildSnapshot([active.raw], [], [], {});
  state.detailGid = active.gid;

  assert.equal(hooks.applyTaskStatus([active.gid], 'paused'), true);
  assert.equal(state.tasks[0].status, 'paused');
  assert.equal(state.tasks[0].speed, 0);
  assert.equal(state.snapshot.all[0].status, 'paused');
  assert.equal(state.snapshot.activeTasks.length, 0);
  assert.equal(state.snapshot.pausedTasks[0].gid, active.gid);
});

test('Aria2 task actions use an in-page confirmation dialog instead of window.confirm', () => {
  const script = fs.readFileSync(path.join(__dirname, '..', 'aria2-tasks.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'aria2-tasks.html'), 'utf8');

  assert.doesNotMatch(script, /window\.confirm\s*\(/);
  assert.match(script, /confirmAction\s*\(/);
  assert.match(html, /<dialog[^>]+id="confirmDialog"/);
  assert.match(html, /id="confirmDialogAccept"/);
});

test('Aria2 connection status reads the committed storage target and reacts to later failures', async () => {
  const runtime = loadAria2TasksRuntime();
  await new Promise((resolve) => setImmediate(resolve));
  const { __control: control, __elements: elements } = runtime;

  assert.equal(elements.get('statusDot').classList.contains('ok'), true);
  control.backgroundConfig.aria2Rpc = 'http://stale.example:6800/jsonrpc';
  control.localConfig.aria2Rpc = 'http://nas.example:6800/jsonrpc';
  control.rpcError = 'connection refused';
  control.storageListener({ aria2Rpc: { newValue: control.localConfig.aria2Rpc } }, 'local');
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(elements.get('rpcEndpoint').textContent, /nas\.example/);
  assert.equal(elements.get('statusDot').classList.contains('bad'), true);
  assert.equal(elements.get('alert').classList.contains('show'), true);

  control.localConfig.aria2Rpc = 'http://localhost:6800/jsonrpc';
  control.rpcError = '';
  control.storageListener({ aria2Rpc: { newValue: control.localConfig.aria2Rpc } }, 'local');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get('statusDot').classList.contains('ok'), true);
  assert.equal(elements.get('alert').classList.contains('show'), false);
});

test('an older RPC result cannot overwrite the status of a newly selected connection', async () => {
  const runtime = loadAria2TasksRuntime();
  await new Promise((resolve) => setImmediate(resolve));
  const { __control: control, __elements: elements } = runtime;
  control.deferRpc = true;

  control.localConfig.aria2Rpc = 'http://old-nas.example:6800/jsonrpc';
  control.storageListener({ aria2Rpc: { newValue: control.localConfig.aria2Rpc } }, 'local');
  await new Promise((resolve) => setImmediate(resolve));
  const oldRequests = control.pendingRpc.splice(0);
  assert.equal(oldRequests.length, 4);

  control.localConfig.aria2Rpc = 'http://new-nas.example:6800/jsonrpc';
  control.storageListener({ aria2Rpc: { newValue: control.localConfig.aria2Rpc } }, 'local');
  oldRequests.forEach(({ message, callback }) => {
    callback({ ok: true, result: message.method === 'getGlobalStat' ? {} : [] });
  });
  await new Promise((resolve) => setImmediate(resolve));

  const newRequests = control.pendingRpc.splice(0);
  assert.equal(newRequests.length, 4);
  newRequests.forEach(({ callback }) => callback({ ok: false, error: 'new target unavailable' }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.match(elements.get('rpcEndpoint').textContent, /new-nas\.example/);
  assert.equal(elements.get('statusDot').classList.contains('bad'), true);
});

test('Polling order stays stable when RPC reverses tasks with the same timestamp', () => {
  const { sortTasks } = loadAria2TasksRuntime().__aria2TasksTestHooks;
  const tasks = ['c', 'a', 'b'].map((gid) => ({ gid, status: 'active', addedTime: 123 }));
  assert.equal(sortTasks([...tasks]).map((task) => task.gid).join(','), 'a,b,c');
  assert.equal(sortTasks([...tasks].reverse()).map((task) => task.gid).join(','), 'a,b,c');
});

test('Empty task lists receive the dedicated fill layout state', () => {
  const runtime = loadAria2TasksRuntime();
  runtime.__aria2TasksTestHooks.getState().tasks = [];
  runtime.__aria2TasksTestHooks.renderList();

  assert.equal(runtime.__elements.get('taskList').classList.contains('is-empty'), true);
});

test('Polling patches progress in place and retains added action elements', () => {
  const { patchTaskElement } = loadAria2TasksRuntime().__aria2TasksTestHooks;
  function element(tagName, text = '', attrs = {}, children = []) {
    const node = {
      tagName, textContent: text, children, dataset: {},
      get attributes() { return Object.entries(attrs).map(([name, value]) => ({ name, value })); },
      get lastElementChild() { return this.children.at(-1); },
      hasAttribute(name) { return name in attrs; },
      getAttribute(name) { return attrs[name] ?? null; },
      setAttribute(name, value) { attrs[name] = value; },
      removeAttribute(name) { delete attrs[name]; },
      appendChild(child) {
        child.remove();
        child.parent = this;
        this.children.push(child);
      },
      remove() {
        if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1);
        this.parent = null;
      },
    };
    children.forEach((child) => { child.parent = node; });
    return node;
  }
  const fill = element('DIV', '', { style: 'width: 10%' });
  const row = element('DIV', '', {}, [fill]);
  const action = element('BUTTON', 'Pause');
  const next = element('DIV', '', {}, [element('DIV', '', { style: 'width: 20%' }), action]);
  patchTaskElement(row, next);
  assert.equal(row.children[0], fill);
  assert.equal(fill.getAttribute('style'), 'width: 20%');
  assert.equal(row.children[1], action);
  patchTaskElement(row, element('DIV', '', {}, [element('DIV', '', { style: 'width: 30%' })]));
  assert.equal(row.children.length, 1);
  assert.equal(row.children[0], fill);
});
