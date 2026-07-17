(function initDownloadClickTracking() {
  const defaultCaptureExtensions = globalThis.ConfigDefaults?.DEFAULT_CAPTURE_EXTENSIONS || '';
  const legacyDefaultCaptureExtensions = globalThis.ConfigDefaults?.LEGACY_DEFAULT_CAPTURE_EXTENSIONS || '';
  let captureExtensionPattern = buildCaptureExtensionPattern(defaultCaptureExtensions);

  function normalizeCaptureExtensionsConfig(value) {
    if (value === undefined || value === null) return defaultCaptureExtensions;
    const normalized = String(value || '').replace(/\s+/g, '').toLowerCase();
    if (legacyDefaultCaptureExtensions && normalized === legacyDefaultCaptureExtensions) return defaultCaptureExtensions;
    return value;
  }

  function buildCaptureExtensionPattern(value = '') {
    const exts = String(value || '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean)
      .map((item) => item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!exts.length || exts.includes('\\*')) return /\.([a-zA-Z0-9]+)(?:[?#]|$)/i;
    return exts.length ? new RegExp(`\\.(${exts.join('|')})(?:[?#]|$)`, 'i') : null;
  }

  function applyCaptureExtensions(value) {
    captureExtensionPattern = buildCaptureExtensionPattern(normalizeCaptureExtensionsConfig(value));
  }

  function loadStoredCaptureExtensions() {
    const defaults = { captureExtensions: defaultCaptureExtensions };
    const finish = (stored = {}) => applyCaptureExtensions(stored.captureExtensions);
    const fallbackToLocal = () => {
      try {
        const localResult = chrome.storage.local?.get?.(defaults, finish);
        if (localResult && typeof localResult.then === 'function') localResult.then(finish).catch(() => finish(defaults));
        if (!chrome.storage.local?.get) finish(defaults);
      } catch {
        finish(defaults);
      }
    };

    try {
      const syncResult = chrome.storage.sync?.get?.(defaults, (stored) => {
        if (chrome.runtime?.lastError) {
          fallbackToLocal();
          return;
        }
        finish(stored);
      });
      if (syncResult && typeof syncResult.then === 'function') syncResult.then(finish).catch(fallbackToLocal);
      if (!chrome.storage.sync?.get) fallbackToLocal();
    } catch {
      fallbackToLocal();
    }
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
      captureExtensionPattern?.test(href) ||
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

  function handleTrackedNewTabDownloadClick(event) {
    const link = findLink(event.target);
    if (!link?.href || !looksLikeDownloadLink(link)) return false;

    const target = String(link.target || '').trim();
    if (!target || target.toLowerCase() === '_self') return false;

    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();

    Promise.resolve()
      .then(() => sendTrackDownloadClickIntent(link))
      .catch(() => null)
      .then(() => {
        window.location.href = link.href || '';
      });

    return true;
  }

  document.addEventListener('pointerdown', (event) => {
    trackDownloadClickIntent(event);
  }, true);
  document.addEventListener('click', (event) => {
    if (handleTrackedNewTabDownloadClick(event)) return;
    if (event.detail === 0) trackDownloadClickIntent(event);
    if (event.detail !== 0) return;
  }, true);

  loadStoredCaptureExtensions();
  chrome.storage.onChanged?.addListener?.((changes, areaName) => {
    if (areaName && !['sync', 'local'].includes(areaName)) return;
    if (!Object.prototype.hasOwnProperty.call(changes || {}, 'captureExtensions')) return;
    applyCaptureExtensions(changes.captureExtensions.newValue);
  });
})();
