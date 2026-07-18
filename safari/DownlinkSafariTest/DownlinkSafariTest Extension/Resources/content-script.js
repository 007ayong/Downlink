(function initDownloadClickTracking() {
  const defaultCaptureExtensions = globalThis.ConfigDefaults?.DEFAULT_CAPTURE_EXTENSIONS || '';
  const legacyDefaultCaptureExtensions = globalThis.ConfigDefaults?.LEGACY_DEFAULT_CAPTURE_EXTENSIONS || '';
  const configStorageAreaKey = '__downlinkConfigStorageArea';
  const safariCaptureResponseTimeoutMs = 2500;
  let captureExtensionPattern = buildCaptureExtensionPattern(defaultCaptureExtensions);
  let activeConfigStorageArea = '';

  function isSafariExtensionRuntime() {
    try {
      return String(chrome.runtime?.getURL?.('') || '').startsWith('safari-web-extension://');
    } catch {
      return false;
    }
  }

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

  function getStoredConfig(storageArea, defaults = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (stored, error = '') => {
        if (settled) return;
        settled = true;
        if (error) reject(new Error(error));
        else resolve(stored || {});
      };
      try {
        if (!storageArea?.get) {
          finish(null, 'storage-unavailable');
          return;
        }
        const result = storageArea.get(defaults, (stored) => {
          finish(stored, chrome.runtime?.lastError?.message || '');
        });
        result?.then?.((stored) => finish(stored)).catch?.((error) => finish(null, error?.message || String(error)));
      } catch (error) {
        finish(null, error?.message || String(error));
      }
    });
  }

  async function loadStoredCaptureExtensions() {
    let localStored = {};
    try {
      localStored = await getStoredConfig(chrome.storage.local, {});
    } catch {}

    const localHasConfig = Object.prototype.hasOwnProperty.call(localStored, 'captureExtensions');
    if (localStored?.[configStorageAreaKey] === 'local') {
      activeConfigStorageArea = 'local';
      applyCaptureExtensions(localHasConfig ? localStored.captureExtensions : defaultCaptureExtensions);
      return;
    }

    try {
      const syncStored = await getStoredConfig(chrome.storage.sync, {});
      const syncHasConfig = Object.prototype.hasOwnProperty.call(syncStored, 'captureExtensions');
      if (localStored?.[configStorageAreaKey] === 'sync') {
        activeConfigStorageArea = 'sync';
        applyCaptureExtensions(syncHasConfig
          ? syncStored.captureExtensions
          : (localHasConfig ? localStored.captureExtensions : defaultCaptureExtensions));
        return;
      }
      activeConfigStorageArea = syncHasConfig ? 'sync' : (localHasConfig ? 'local' : 'sync');
      applyCaptureExtensions(syncHasConfig
        ? syncStored.captureExtensions
        : (localHasConfig ? localStored.captureExtensions : defaultCaptureExtensions));
    } catch {
      activeConfigStorageArea = localStored?.[configStorageAreaKey] === 'sync' ? 'sync' : 'local';
      applyCaptureExtensions(localHasConfig ? localStored.captureExtensions : defaultCaptureExtensions);
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

  function safariLocalBridgeTarget() {
    if (!isSafariExtensionRuntime()) return '';
    const match = String(window.location.href || '').match(
      /^http:\/\/127\.0\.0\.1:\d+\/downlink-dnr\/[a-f0-9-]+\/(?:\?url=[^#]*)?#(https?:\/\/.*)$/i
    );
    return match?.[1] || '';
  }

  function handleSafariLocalBridgeNavigation() {
    const targetUrl = safariLocalBridgeTarget();
    if (!targetUrl) return false;
    const referrer = String(document.referrer || '');
    let recovered = false;
    const recover = () => {
      if (recovered) return;
      recovered = true;
      if (window.history.length > 1) {
        window.history.back();
        return;
      }
      window.location.replace(/^https?:\/\//i.test(referrer) ? referrer : 'about:blank');
    };
    const timeout = setTimeout(recover, safariCaptureResponseTimeoutMs);
    sendRuntimeMessage({
      type: 'CAPTURE_LOCAL_DNR_BRIDGE',
      url: targetUrl,
      referrer,
    }).then((response) => {
      clearTimeout(timeout);
      if (response?.bridgeHandled || response?.closeBridgeTab) {
        recovered = true;
        if (response?.closeBridgeTab) {
          try { window.close(); } catch {}
        }
        return;
      }
      if (response?.bypass && response?.resumeUrl === targetUrl) {
        recovered = true;
        window.location.replace(targetUrl);
        return;
      }
      recover();
    }).catch(recover);
    return true;
  }

  if (handleSafariLocalBridgeNavigation()) return;

  if (isSafariExtensionRuntime() && window === window.top && /^https?:\/\//i.test(window.location.href || '')) {
    sendRuntimeMessage({
      type: 'REGISTER_SAFARI_PAGE_CONTEXT',
      url: window.location.href || '',
    }).catch(() => {});
  }

  function looksLikeDownloadLink(link) {
    if (!link) return false;
    const href = link.href || '';
    const downloadAttr = link.getAttribute?.('download');
    const label = [link.getAttribute?.('aria-label') || '', link.textContent || ''].join(' ').trim();
    let path = '';
    try {
      path = new URL(href).pathname;
    } catch {}
    return Boolean(
      downloadAttr !== undefined && downloadAttr !== null ||
      captureExtensionPattern?.test(href) ||
      /\/artifacts?\/[^/]+\/?$/i.test(path) ||
      (/\bartifact\b/i.test(label) && /\/artifacts?(?:\/|$)/i.test(path))
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

  function handleSafariDownloadClick(event) {
    if (!isSafariExtensionRuntime() || event.defaultPrevented) return false;
    if (event.button !== undefined && event.button !== 0) return false;
    if (event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return false;

    const link = findLink(event.target);
    if (!link?.href || !looksLikeDownloadLink(link)) return false;
    try {
      if (!['http:', 'https:'].includes(new URL(link.href).protocol)) return false;
    } catch {
      return false;
    }

    event.preventDefault?.();
    event.stopPropagation?.();
    event.stopImmediatePropagation?.();

    const message = {
      type: 'CAPTURE_LINK_DOWNLOAD',
      url: link.href,
      referrer: window.location.href || '',
    };
    const filename = inferLinkFilename(link);
    if (filename) message.filename = filename;

    let settled = false;
    const restoreBrowserNavigation = () => {
      if (settled) return;
      settled = true;
      window.location.href = link.href;
    };
    const responseTimeout = setTimeout(restoreBrowserNavigation, safariCaptureResponseTimeoutMs);

    sendRuntimeMessage(message)
      .then((result) => {
        if (settled) return;
        settled = true;
        clearTimeout(responseTimeout);
        if (!result?.ok) window.location.href = link.href;
      })
      .catch(restoreBrowserNavigation);

    return true;
  }

  document.addEventListener('pointerdown', (event) => {
    trackDownloadClickIntent(event);
  }, true);
  document.addEventListener('click', (event) => {
    if (handleSafariDownloadClick(event)) return;
    if (handleTrackedNewTabDownloadClick(event)) return;
    if (event.detail === 0) trackDownloadClickIntent(event);
    if (event.detail !== 0) return;
  }, true);

  loadStoredCaptureExtensions().catch(() => applyCaptureExtensions(defaultCaptureExtensions));
  chrome.storage.onChanged?.addListener?.((changes, areaName) => {
    if (areaName && !['sync', 'local'].includes(areaName)) return;
    if (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes || {}, configStorageAreaKey)) {
      const nextArea = changes[configStorageAreaKey]?.newValue;
      if (nextArea === 'sync' || nextArea === 'local') activeConfigStorageArea = nextArea;
      if (activeConfigStorageArea === 'local' && Object.prototype.hasOwnProperty.call(changes || {}, 'captureExtensions')) {
        applyCaptureExtensions(changes.captureExtensions.newValue);
      } else {
        loadStoredCaptureExtensions().catch(() => {});
      }
      return;
    }
    if (activeConfigStorageArea && areaName && areaName !== activeConfigStorageArea) return;
    if (!Object.prototype.hasOwnProperty.call(changes || {}, 'captureExtensions')) return;
    applyCaptureExtensions(changes.captureExtensions.newValue);
  });

  function probeMediaMetadataInPage(message, sendResponse) {
    const resourceUrl = String(message?.resourceUrl || '');
    if (!/^https?:\/\//i.test(resourceUrl)) {
      sendResponse({ ok: false, error: 'invalid-media-url' });
      return false;
    }

    const mediaEl = document.createElement(message.kind === 'audio' ? 'audio' : 'video');
    let settled = false;
    let xhr = null;
    const parseMp4Metadata = (buffer) => {
      const bytes = new Uint8Array(buffer);
      const view = new DataView(buffer);
      let width = 0;
      let height = 0;
      let duration = 0;
      const readUint64 = (offset) => {
        if (offset + 8 > view.byteLength) return 0;
        return view.getUint32(offset) * 4294967296 + view.getUint32(offset + 4);
      };
      for (let index = 0; index + 100 < bytes.length; index += 1) {
        const isDurationHeader = bytes[index] === 0x6d &&
          (bytes[index + 1] === 0x76 || bytes[index + 1] === 0x64) &&
          bytes[index + 2] === 0x68 && bytes[index + 3] === 0x64;
        if (isDurationHeader) {
          const version = bytes[index + 4];
          const timescaleOffset = index + (version === 1 ? 28 : 16);
          const durationOffset = index + (version === 1 ? 32 : 20);
          if (durationOffset + (version === 1 ? 8 : 4) <= bytes.length) {
            const timescale = view.getUint32(timescaleOffset);
            const value = version === 1 ? readUint64(durationOffset) : view.getUint32(durationOffset);
            if (timescale && value && value !== 0xffffffff) duration = Math.max(duration, value / timescale);
          }
        }
        const isSidx = bytes[index] === 0x73 && bytes[index + 1] === 0x69 &&
          bytes[index + 2] === 0x64 && bytes[index + 3] === 0x78;
        if (isSidx && index + 32 <= bytes.length) {
          const version = bytes[index + 4];
          const timescale = view.getUint32(index + 12);
          const referenceCountOffset = index + (version === 1 ? 34 : 26);
          let totalDuration = 0;
          if (timescale && referenceCountOffset + 2 <= bytes.length) {
            const referenceCount = view.getUint16(referenceCountOffset);
            for (let entry = 0; entry < referenceCount; entry += 1) {
              const entryOffset = referenceCountOffset + 2 + entry * 12;
              if (entryOffset + 12 > bytes.length) break;
              totalDuration += view.getUint32(entryOffset + 4);
            }
          }
          if (timescale && totalDuration) duration = Math.max(duration, totalDuration / timescale);
        }
        if (bytes[index] === 0x74 && bytes[index + 1] === 0x6b &&
            bytes[index + 2] === 0x68 && bytes[index + 3] === 0x64) {
          const dimensionOffset = bytes[index + 4] === 1 ? 92 : 80;
          if (index + dimensionOffset + 8 <= bytes.length) {
            width = Math.round(view.getUint32(index + dimensionOffset) / 65536);
            height = Math.round(view.getUint32(index + dimensionOffset + 4) / 65536);
          }
        }
      }
      return { width, height, duration };
    };
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try {
        mediaEl.pause?.();
        mediaEl.removeAttribute?.('src');
        mediaEl.load?.();
        mediaEl.remove?.();
        xhr?.abort?.();
      } catch {}
      sendResponse(result);
    };
    const timeout = setTimeout(() => finish({ ok: false, error: 'metadata-timeout' }), 12000);

    mediaEl.preload = 'metadata';
    mediaEl.muted = true;
    mediaEl.playsInline = true;
    mediaEl.style.position = 'fixed';
    mediaEl.style.width = '1px';
    mediaEl.style.height = '1px';
    mediaEl.style.opacity = '0';
    mediaEl.style.pointerEvents = 'none';
    mediaEl.addEventListener('loadedmetadata', () => {
      const width = Number(mediaEl.videoWidth) || 0;
      const height = Number(mediaEl.videoHeight) || 0;
      finish({
        ok: true,
        width,
        height,
        duration: Number.isFinite(mediaEl.duration) ? mediaEl.duration : 0,
        kind: width && height ? 'video' : 'audio',
      });
    }, { once: true });
    mediaEl.addEventListener('error', () => finish({ ok: false, error: 'metadata-load-failed' }), { once: true });
    (document.body || document.documentElement).appendChild(mediaEl);
    const loadDirectly = () => {
      if (settled) return;
      mediaEl.src = resourceUrl;
      mediaEl.load?.();
    };
    try {
      xhr = new XMLHttpRequest();
      xhr.open('GET', resourceUrl, true);
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Range', 'bytes=0-2097151');
      xhr.onload = () => {
        if (settled) return;
        if (xhr.status < 200 || xhr.status >= 300 || !(xhr.response instanceof ArrayBuffer)) {
          loadDirectly();
          return;
        }
        if (xhr.response.byteLength > 2097152) {
          loadDirectly();
          return;
        }
        const { width, height, duration } = parseMp4Metadata(xhr.response);
        if (!width && !height && !duration) {
          loadDirectly();
          return;
        }
        finish({
          ok: true,
          width,
          height,
          duration,
          kind: width && height ? 'video' : 'audio',
        });
      };
      xhr.onerror = loadDirectly;
      xhr.send();
    } catch {
      loadDirectly();
    }
    return true;
  }

  chrome.runtime.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type !== 'PROBE_MEDIA_METADATA_IN_PAGE') return undefined;
    return probeMediaMetadataInPage(message, sendResponse);
  });
})();
