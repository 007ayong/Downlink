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

  function looksLikeDownloadLink(link) {
    if (!link) return false;
    const href = link.href || '';
    const downloadAttr = link.getAttribute?.('download');
    const label = [
      downloadAttr || '',
      link.getAttribute?.('aria-label') || '',
      link.textContent || '',
      href,
    ].join(' ');
    return Boolean(
      downloadAttr !== undefined && downloadAttr !== null ||
      /\.(zip|rar|7z|tar|gz|bz2|xz|iso|dmg|exe|msi|deb|pkg|apk|mp4|mkv|avi|mov|webm|mp3|flac|wav|pdf|torrent)(?:[?#]|$)/i.test(href) ||
      /\b(download|artifact)\b/i.test(label)
    );
  }

  function cleanLinkFilename(value = '') {
    return String(value || '')
      .replace(/\s+/g, ' ')
      .replace(/\s*\([^)]*(?:new tab|opens)[^)]*\)\s*$/i, '')
      .replace(/^\s*download\s+/i, '')
      .trim();
  }

  function inferLinkFilename(link) {
    if (!link) return '';
    const downloadName = cleanLinkFilename(link.getAttribute?.('download') || '');
    if (downloadName) return downloadName;
    const ariaName = cleanLinkFilename(link.getAttribute?.('aria-label') || '');
    if (ariaName) return ariaName;
    const textName = cleanLinkFilename(link.textContent || '');
    if (textName) return textName;
    try {
      return cleanLinkFilename(new URL(link.href || '').pathname.split('/').pop() || '');
    } catch {
      return cleanLinkFilename(String(link.href || '').split('?')[0].split('/').pop() || '');
    }
  }

  function trackDownloadClickIntent(event) {
    const link = findLink(event.target);
    if (!looksLikeDownloadLink(link)) return;
    return sendTrackDownloadClickIntent(link);
  }

  function sendTrackDownloadClickIntent(link) {
    if (!looksLikeDownloadLink(link)) return Promise.resolve();
    const message = {
      type: 'TRACK_DOWNLOAD_CLICK',
      url: link.href || '',
    };
    const filename = inferLinkFilename(link);
    if (filename) message.filename = filename;
    return sendRuntimeMessage(message).catch(() => {});
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

  function navigateToLink(link, openedWindow) {
    const url = link?.href || '';
    if (!url) return;
    if (openedWindow) {
      try {
        openedWindow.location = url;
        return;
      } catch {}
    }
    const target = String(link.target || '').trim();
    if (target && target.toLowerCase() !== '_self') {
      window.open(url, target);
      return;
    }
    window.location.href = url;
  }

  function handleBypassClick(event) {
    const expectedModifier = normalizeShortcut(config.captureBypassModifier || DEFAULT_CONFIG.captureBypassModifier);
    if (expectedModifier === 'none' || shortcutFromEvent(event) !== expectedModifier) return false;

    const link = findLink(event.target);
    if (!link?.href) return false;
    if (!looksLikeDownloadLink(link)) return false;

    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();

    let openedWindow = null;
    const target = String(link.target || '').trim();
    if (target && target.toLowerCase() !== '_self') {
      try {
        openedWindow = window.open('about:blank', target);
      } catch {}
    }

    Promise.resolve()
      .then(() => sendTrackDownloadClickIntent(link))
      .then(() => sendRuntimeMessage({
        type: 'BYPASS_NEXT_DOWNLOAD',
        url: link.href || '',
        modifier: expectedModifier,
      }))
      .catch(() => null)
      .then(() => navigateToLink(link, openedWindow));

    return true;
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

  document.addEventListener('pointerdown', (event) => {
    trackDownloadClickIntent(event);
    handleBypassGesture(event);
  }, true);
  document.addEventListener('click', (event) => {
    if (handleBypassClick(event)) return;
    if (event.detail === 0) trackDownloadClickIntent(event);
    if (event.detail !== 0) return;
    handleBypassGesture(event);
  }, true);
})();
