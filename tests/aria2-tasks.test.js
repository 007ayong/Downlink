const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadAria2TasksRuntime() {
  const makeElement = () => ({
    classList: {
      add() {},
      remove() {},
      toggle() {},
      contains() { return false; },
    },
    dataset: {},
    style: {},
    append() {},
    appendChild() {},
    replaceChildren() {},
    addEventListener() {},
    removeEventListener() {},
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
  });
  const document = {
    title: '',
    body: makeElement(),
    activeElement: null,
    getElementById() { return makeElement(); },
    querySelectorAll() { return []; },
    createElement() { return makeElement(); },
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
        sync: {
          get(defaults, callback) { callback({ ...defaults }); },
        },
      },
      runtime: {
        lastError: null,
        sendMessage(message, callback) {
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
