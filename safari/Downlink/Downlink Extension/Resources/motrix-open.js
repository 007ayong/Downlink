(function initMotrixOpenPage() {
  const AUTO_CLOSE_DELAY_MS = 800;
  const deepLink = 'motrixnext://';

  const isZh = (navigator.language || '').toLowerCase().includes('zh');
  const text = isZh
    ? {
      title: '正在唤起 MotrixNext',
      desc: '如果浏览器弹出“打开外部应用”提示，请勾选“始终允许”并确认。',
      targetLabel: '目标协议：',
      launch: '再次唤起',
      close: '关闭此页',
      hint: '若未自动唤起，可点击“再次唤起”。此页面会自动关闭。',
    }
    : {
      title: 'Launching MotrixNext',
      desc: 'If the browser asks to open an external app, allow it and enable always allow.',
      targetLabel: 'Target protocol:',
      launch: 'Try again',
      close: 'Close this tab',
      hint: 'If auto-launch did not trigger, click "Try again". This page closes automatically.',
    };

  const titleEl = document.getElementById('title');
  const descEl = document.getElementById('desc');
  const targetLabelEl = document.getElementById('targetLabel');
  const launchBtn = document.getElementById('launchBtn');
  const closeBtn = document.getElementById('closeBtn');
  const hintEl = document.getElementById('hint');

  if (titleEl) titleEl.textContent = text.title;
  if (descEl) descEl.textContent = text.desc;
  if (targetLabelEl) {
    targetLabelEl.textContent = '';
    const label = document.createTextNode(`${text.targetLabel} `);
    const code = document.createElement('code');
    code.textContent = deepLink;
    targetLabelEl.appendChild(label);
    targetLabelEl.appendChild(code);
  }
  if (launchBtn) launchBtn.textContent = text.launch;
  if (closeBtn) closeBtn.textContent = text.close;
  if (hintEl) hintEl.textContent = text.hint;

  function launch() {
    // Use top-level navigation to trigger external protocol handling.
    window.location.assign(deepLink);
    setTimeout(closeCurrentTab, AUTO_CLOSE_DELAY_MS);
  }

  function closeCurrentTab() {
    if (typeof chrome === 'undefined' || !chrome.tabs?.getCurrent) {
      window.close();
      return;
    }
    chrome.tabs.getCurrent((tab) => {
      const tabId = tab?.id;
      if (typeof tabId === 'number' && chrome.tabs?.remove) {
        chrome.tabs.remove(tabId, () => {
          if (chrome.runtime?.lastError) window.close();
        });
        return;
      }
      window.close();
    });
  }

  launchBtn?.addEventListener('click', launch);
  closeBtn?.addEventListener('click', () => window.close());

  setTimeout(launch, 80);
})();
