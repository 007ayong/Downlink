const key = 'downlinkSafariProbeLogs';
const logsEl = document.getElementById('logs');
const refreshEl = document.getElementById('refresh');
const clearEl = document.getElementById('clear');
const pingEl = document.getElementById('ping');
const statusEl = document.getElementById('status');

function setStatus(t, k) { statusEl.textContent = t; statusEl.className = 'status' + (k ? ' ' + k : ''); }
function esc(v) { return String(v).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;'); }

function classifyEntry(message) {
  if (/skip/.test(message)) return 'skip';
  if (/cancel/.test(message)) return 'cancel';
  if (/aria2/.test(message)) return 'aria2';
  return '';
}

function render(logs) {
  if (!Array.isArray(logs) || !logs.length) { logsEl.className = 'empty'; logsEl.textContent = '暂无日志。'; return; }
  logsEl.className = '';
  logsEl.innerHTML = logs.slice().reverse().map((e) => {
    const cls = classifyEntry(e.message || '');
    return `<section class="entry${cls ? ' ' + cls : ''}"><div class="meta"><span>${esc(e.time || '')}</span><span class="message">${esc(e.message || '')}</span></div><pre>${esc(JSON.stringify(e.data || {}, null, 2))}</pre></section>`;
  }).join('');
}

function loadLogs() {
  try {
    chrome.storage.local.get({ [key]: [] }, (s) => {
      if (chrome.runtime.lastError) { logsEl.className = 'empty'; logsEl.textContent = 'storage读失败：' + chrome.runtime.lastError.message; return; }
      render(s[key]);
    });
  } catch (e) { logsEl.className = 'empty'; logsEl.textContent = 'storage不可用：' + (e && e.message || e); }
}

function clearLogs() {
  chrome.storage.local.set({ [key]: [] }, () => { loadLogs(); setStatus('日志已清空', 'info'); });
}

function ping() {
  setStatus('正在 Ping 后台…', 'info');
  try {
    chrome.runtime.sendMessage({ type: 'PROBE_PING' }, (r) => {
      if (chrome.runtime.lastError) { setStatus('后台无响应：' + chrome.runtime.lastError.message, 'err'); return; }
      if (!r || r.type !== 'PROBE_PONG') { setStatus('后台返回异常：' + JSON.stringify(r), 'err'); return; }
      setStatus('后台已响应 @ ' + r.at, 'ok');
    });
  } catch (e) { setStatus('sendMessage失败：' + (e && e.message || e), 'err'); }
}

refreshEl.addEventListener('click', () => { loadLogs(); });
clearEl.addEventListener('click', clearLogs);
pingEl.addEventListener('click', ping);
loadLogs();
ping();
