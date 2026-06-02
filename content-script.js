(function initDownloadClickTracking() {
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
})();
