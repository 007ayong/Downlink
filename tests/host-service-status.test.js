const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../popup-app.js'), 'utf8');
const statusSource = source.slice(source.indexOf('// The native health check is read-only;'));
function popup({ safari = true, response = { connected: false }, fail = false } = {}) {
  const elements = Object.fromEntries(['hostServiceBanner', 'hostServiceLabel', 'hostServiceHelp', 'hostServiceRetry'].map(id => [id, {
    hidden: true, dataset: {}, listeners: {}, addEventListener(event, fn) { this.listeners[event] = fn; },
  }]));
  let calls = 0;
  const runtime = { sendMessage(message, callback) {
    calls++;
    if (fail) runtime.lastError = { message: 'Extension unavailable' };
    callback(response);
    delete runtime.lastError;
  } };
  const context = {
    isSafariPopupRuntime: () => safari,
    document: { readyState: 'complete', hidden: false, getElementById: id => elements[id] },
    chrome: { runtime, i18n: { getUILanguage: () => 'zh-CN' } }, navigator: { language: 'zh-CN' },
    window: { addEventListener() {} }, setInterval: () => 1, clearInterval() {},
    setTimeout: () => 1, clearTimeout() {},
  };
  vm.runInNewContext(statusSource, context);
  return { elements, calls: () => calls, setResponse(value) { response = value; } };
}
const flush = () => new Promise(resolve => setImmediate(resolve));
test('Safari disconnected service offers recovery, then clears warning after restart', async () => {
  const app = popup();
  await flush();
  assert.equal(app.elements.hostServiceBanner.dataset.state, 'offline');
  assert.equal(app.elements.hostServiceHelp.hidden, false);
  assert.match(app.elements.hostServiceHelp.textContent, /启动后台服务/);
  app.setResponse({ connected: true });
  await app.elements.hostServiceRetry.listeners.click();
  assert.equal(app.elements.hostServiceBanner.dataset.state, 'online');
  assert.equal(app.elements.hostServiceHelp.hidden, true);
  assert.equal(app.elements.hostServiceRetry.disabled, false);
});
test('Native messaging failure produces a recoverable connection warning', async () => {
  const app = popup({ fail: true });
  await flush();
  assert.equal(app.elements.hostServiceBanner.dataset.state, 'offline');
  assert.equal(app.elements.hostServiceRetry.disabled, false);
});
test('Other browsers do not show a Safari service warning or send probes', async () => {
  const app = popup({ safari: false });
  await flush();
  assert.equal(app.calls(), 0);
  assert.equal(app.elements.hostServiceBanner.hidden, true);
});
