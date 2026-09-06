const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

async function runtime(applied = '8', split = applied, search = '') {
  const elements = new Map();
  function element() {
    return { value: '', dataset: {}, style: {}, validity: {}, classList: { add() {}, toggle() {} },
      listeners: {}, addEventListener(name, fn) { this.listeners[name] = fn; },
      setCustomValidity(message) { this.validationMessage = message; }, reportValidity() {},
      querySelectorAll() { return []; }, replaceChildren() {}, appendChild() {}, append() {},
      setAttribute() {}, focus() {} };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const calls = [];
  const config = { aria2Rpc: 'http://localhost:6800/jsonrpc', aria2TrackerSubscriptions: [], aria2PanelConnections: '5' };
  vm.runInNewContext(fs.readFileSync(require('node:path').join(__dirname, '../aria2-settings.js'), 'utf8'), {
    URL, URLSearchParams, location: { search, origin: 'https://example.com' },
    document: { body: element(), getElementById: get, querySelector: () => element(), createElement: element },
    window: { addEventListener() {} }, setTimeout() {}, clearTimeout() {},
    chrome: { storage: { sync: { get(defaults, cb) { cb({ ...defaults, ...config }); } } }, runtime: {
      sendMessage(message, cb) {
        calls.push(message);
        cb({ ok: true, config, result: message.method === 'getGlobalOption' ? { 'max-connection-per-server': applied, split } : 'OK' });
      }
    } }
  });
  await new Promise(resolve => setImmediate(resolve));
  calls.length = 0;
  return { get, calls, async submit(value) { get('connections').value = value; await get('form').listeners.submit({ preventDefault() {} }); } };
}

test('8 is applied and verified before saving', async () => {
  const page = await runtime();
  await page.submit('8');
  assert.deepEqual(page.calls.map(c => c.method || c.type), ['changeGlobalOption', 'getGlobalOption', 'SAVE_CONFIG']);
  assert.equal(page.calls[0].params[0]['max-connection-per-server'], '8');
  assert.equal(page.calls[0].params[0].split, '8');
  assert.equal('max-concurrent-downloads' in page.calls[0].params[0], false);
});

test('invalid connections never reaches RPC or storage', async () => {
  for (const value of ['0', '-1', '2.5', 'abc', '1e2', '24', '17']) {
    const page = await runtime();
    await page.submit(value);
    assert.equal(page.calls.length, 0, value);
    assert.match(page.get('connections').validationMessage, /整数/);
  }
});

test('mismatched server value reports failure without saving requested value', async () => {
  const page = await runtime('5');
  await page.submit('8');
  assert.equal(page.calls.some(c => c.type === 'SAVE_CONFIG'), false);
  assert.match(page.get('toast').textContent, /请求 8，aria2 返回每服务器 5/);
});

test('empty connections preserves the server option', async () => {
  const page = await runtime('5');
  await page.submit('');
  assert.equal('max-connection-per-server' in page.calls[0].params[0], false);
  assert.equal(page.calls.at(-1).type, 'SAVE_CONFIG');
});

test('single-server summary uses the lower limit and keeps raw values in details', async () => {
  const page = await runtime('64', '16');
  assert.equal(page.get('connectionsStatus').textContent, '当前单任务连接上限：16（新任务，单服务器）');
  assert.match(page.get('connectionsDetails').textContent, /每服务器连接数 64，分段连接数 16/);
});

test('missing server option does not display a misleading zero limit', async () => {
  const page = await runtime('', '16');
  assert.equal(page.get('connectionsStatus').textContent, '当前单任务连接上限：未知');
});


test('RPC profiles preserve old connection, switch and delete without applying global options', async () => {
  const page = await runtime('8', '8', '?section=rpc');
  assert.equal(page.get('rpcProfileName').value, '默认配置');
  page.get('rpcSecret').value = 'first-secret';
  page.get('addRpcProfile').onclick();
  page.get('rpcProfileName').value = 'NAS';
  page.get('rpcHost').value = 'nas.local';
  page.get('rpcSecret').value = 'second-secret';
  await page.submit('');
  const saved = page.calls.at(-1).config;
  assert.equal(saved.aria2Profiles.length, 2);
  assert.equal(saved.aria2Profiles[0].secret, 'first-secret');
  assert.equal(saved.aria2Profiles[1].name, 'NAS');
  assert.equal(saved.aria2Rpc, 'http://nas.local:6800/jsonrpc');
  assert.equal(saved.aria2Secret, 'second-secret');
  assert.equal(saved.aria2ActiveProfileId, saved.aria2Profiles[1].id);
  assert.equal(page.calls.some(call => call.type === 'ARIA2_RPC'), false);
  page.get('deleteRpcProfile').onclick();
  await page.submit('');
  assert.equal(page.calls.at(-1).config.aria2Profiles.length, 1);
  assert.equal(page.calls.at(-1).config.aria2Secret, 'first-secret');
  assert.equal(page.get('deleteRpcProfile').disabled, true);
});

test('blank profile name prevents saving', async () => {
  const page = await runtime('8', '8', '?section=rpc');
  page.get('rpcProfileName').value = ' ';
  await page.submit('');
  assert.equal(page.calls.length, 0);
  assert.match(page.get('rpcError').textContent, /配置名称/);
});
