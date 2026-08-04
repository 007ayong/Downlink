(function initDnrCapturePage() {
  const titleEl = document.getElementById('title');
  const statusEl = document.getElementById('status');
  const urlEl = document.getElementById('url');
  const openBtn = document.getElementById('openBtn');
  const backBtn = document.getElementById('backBtn');

  function setResult(title, status, url = '') {
    titleEl.textContent = title;
    statusEl.textContent = status;
    urlEl.textContent = url;
    urlEl.hidden = !url;
  }

  openBtn.addEventListener('click', async () => {
    try {
      if (chrome.action?.openPopup) await chrome.action.openPopup();
      else await chrome.runtime.sendMessage({ type: 'OPEN_TASK_SURFACE' });
    } catch {
      await chrome.runtime.sendMessage({ type: 'OPEN_TASK_SURFACE' }).catch(() => {});
    }
  });
  backBtn.addEventListener('click', () => history.back());

  chrome.runtime.sendMessage({
    type: 'CAPTURE_DNR_DOWNLOAD',
    referrer: document.referrer || '',
  }).then((result) => {
    if (!result?.ok) {
      setResult('未能接管下载', result?.error || '没有找到原始下载地址。');
      return;
    }
    if (result.pending) {
      setResult('下载已拦截', '任务正在等待确认，请打开 Downlink 面板继续。', result.url || '');
      openBtn.hidden = false;
      return;
    }
    setResult('已发送到下载器', 'Safari 没有启动重复下载。', result.url || '');
  }).catch((error) => {
    setResult('未能接管下载', error?.message || String(error));
  });
})();
