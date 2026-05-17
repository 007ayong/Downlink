(function initDownloadBypassShortcut() {
  const DEFAULT_CONFIG = {
    autoCapture: true,
    captureBypassModifier: 'alt',
    captureExtensions: 'zip,rar,7z,tar,gz,bz2,xz,iso,dmg,exe,msi,deb,pkg,apk,mp4,m4s,mkv,avi,mov,webm,mp3,flac,wav,pdf,torrent',
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

  function extOf(value = '') {
    const match = String(value || '').match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
    return match ? match[1].toLowerCase() : '';
  }

  function captureExts() {
    return String(config.captureExtensions || '')
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean);
  }

  function filenameFromUrl(url = '') {
    try {
      const name = new URL(url).pathname.split('/').pop() || '';
      return decodeURIComponent(name);
    } catch {
      try {
        return decodeURIComponent(String(url || '').split('?')[0].split('/').pop() || '');
      } catch {
        return String(url || '').split('?')[0].split('/').pop() || '';
      }
    }
  }

  function isDownloadableScheme(url = '') {
    try {
      return /^(https?|ftp):$/i.test(new URL(url).protocol);
    } catch {
      return false;
    }
  }

  function shouldEarlyCaptureLink(link) {
    if (!config.autoCapture || !link?.href || !isDownloadableScheme(link.href)) return false;
    const target = link.target || '';
    if (target && target !== '_self') return false;
    const downloadName = link.getAttribute('download');
    if (downloadName !== null) return true;
    const ext = extOf(link.href);
    return Boolean(ext && captureExts().includes(ext));
  }

  function shouldProbeDownloadLink(link) {
    if (!config.autoCapture || !link?.href || !isDownloadableScheme(link.href)) return false;
    if (shouldEarlyCaptureLink(link)) return false;
    const target = link.target || '';
    if (target && target !== '_self') return false;
    try {
      const parsed = new URL(link.href);
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      const basename = pathParts[pathParts.length - 1] || '';
      if (pathParts.some(part => /download/i.test(part))) return true;
      if (/^(download|downloads|file|files|export|attachment|getfile|downloadfile)$/i.test(basename)) return true;
      for (const key of parsed.searchParams.keys()) {
        if (/^(download|attachment|filename|file|export)$/i.test(key)) return true;
      }
    } catch {}
    return false;
  }

  function shouldIgnoreModifiedActivation(event) {
    const expectedModifier = normalizeShortcut(config.captureBypassModifier || DEFAULT_CONFIG.captureBypassModifier);
    const actualModifier = shortcutFromEvent(event);
    if (expectedModifier !== 'none' && actualModifier === expectedModifier) return true;
    return event.ctrlKey || event.metaKey || event.shiftKey || event.altKey;
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

  function handleEarlyDownloadCapture(event) {
    if (event.defaultPrevented || event.button > 0 || shouldIgnoreModifiedActivation(event)) return;

    const link = findLink(event.target);
    const shouldCaptureNow = shouldEarlyCaptureLink(link);
    const shouldProbe = !shouldCaptureNow && shouldProbeDownloadLink(link);
    if (!shouldCaptureNow && !shouldProbe) return;
    const downloadName = link.getAttribute('download') || '';

    event.preventDefault();
    event.stopPropagation();

    const fallbackNavigation = () => {
      const target = link.target || '';
      if (target && target !== '_self') {
        window.open(link.href, target);
        return;
      }
      location.href = link.href;
    };

    const message = shouldCaptureNow
      ? {
          type: 'CAPTURE_LINK_DOWNLOAD',
          url: link.href,
          filename: downloadName || filenameFromUrl(link.href),
          hasDownloadAttribute: link.getAttribute('download') !== null,
          referrer: location.href,
        }
      : {
          type: 'PROBE_LINK_DOWNLOAD',
          url: link.href,
          filename: filenameFromUrl(link.href),
          referrer: location.href,
        };

    sendRuntimeMessage(message)
      .then((res) => {
        if (res?.fallback) fallbackNavigation();
      })
      .catch(() => {
        fallbackNavigation();
      });
  }

  chrome.storage?.sync?.get?.(DEFAULT_CONFIG, applyConfig);
  chrome.storage?.onChanged?.addListener?.((changes, areaName) => {
    if (areaName !== 'sync') return;
    const nextConfig = {};
    for (const key of ['autoCapture', 'captureBypassModifier', 'captureExtensions']) {
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
  document.addEventListener('click', handleEarlyDownloadCapture);
})();
