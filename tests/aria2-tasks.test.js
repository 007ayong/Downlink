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
