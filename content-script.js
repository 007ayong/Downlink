(function initDownloadBypassShortcut() {
  const DEFAULT_CONFIG = {
    captureBypassModifier: 'alt',
  };

  let config = { ...DEFAULT_CONFIG };

  function applyConfig(nextConfig = {}) {
    config = {
      ...config,
      ...nextConfig,
      captureBypassModifier: normalizeShortcut(nextConfig.captureBypassModifier || config.captureBypassModifier || DEFAULT_CONFIG.captureBypassModifier),
    };
  }

  function normalizeShortcut(value) {
    const tokens = String(value || '')
      .toLowerCase()
      .replace(/control/g, 'ctrl')
      .replace(/option/g, 'alt')
      .replace(/command|cmd|meta/g, 'cmd')
      .split(/[^a-z]+/)
      .filter(Boolean);
    if (tokens.includes('none') || tokens.includes('off')) return 'none';
    const ordered = ['ctrl', 'alt', 'shift', 'cmd'].filter((key) => tokens.includes(key));
    return ordered.join('+') || DEFAULT_CONFIG.captureBypassModifier;
  }

  function shortcutFromEvent(event) {
    const keys = [];
    if (event.ctrlKey) keys.push('ctrl');
    if (event.altKey) keys.push('alt');
    if (event.shiftKey) keys.push('shift');
    if (event.metaKey) keys.push('cmd');
    return keys.join('+');
  }

  function findLink(target) {
    if (!target) return null;
    if (typeof target.closest === 'function') return target.closest('a[href], area[href]');
    let node = target;
    while (node) {
      if (node.href && /^(A|AREA)$/i.test(node.tagName || '')) return node;
      node = node.parentElement;
    }
    return null;
  }

  function sendRuntimeMessage(message) {
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.then === 'function') return result;
      return Promise.resolve(result);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function handleBypassGesture(event) {
    const expectedModifier = normalizeShortcut(config.captureBypassModifier || DEFAULT_CONFIG.captureBypassModifier);
    if (expectedModifier === 'none' || shortcutFromEvent(event) !== expectedModifier) return;

    const link = findLink(event.target);
    const url = link?.href;

    sendRuntimeMessage({
      type: 'BYPASS_NEXT_DOWNLOAD',
      url: url || '',
      modifier: expectedModifier,
    }).catch(() => {});
  }

  chrome.storage?.sync?.get?.(DEFAULT_CONFIG, applyConfig);
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== 'sync') return;
    const nextConfig = {};
    for (const key of ['captureBypassModifier']) {
      if (changes[key]) nextConfig[key] = changes[key].newValue;
    }
    if (!Object.keys(nextConfig).length) return;
    applyConfig(nextConfig);
  });

  document.addEventListener('pointerdown', handleBypassGesture, true);
  document.addEventListener('click', (event) => {
    if (event.detail !== 0) return;
    handleBypassGesture(event);
  }, true);
})();
