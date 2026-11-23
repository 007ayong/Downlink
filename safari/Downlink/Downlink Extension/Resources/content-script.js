(function initDownloadClickTracking() {
  const defaultCaptureExtensions = globalThis.ConfigDefaults?.DEFAULT_CAPTURE_EXTENSIONS || '';
  const configStorageAreaKey = '__downlinkConfigStorageArea';
  const safariCaptureResponseTimeoutMs = 2500;
  let captureExtensionPattern = buildCaptureExtensionPattern(defaultCaptureExtensions);
  let storedCaptureExtensions;
  let safariAllowlistPatterns = [];
  let activeConfigStorageArea = '';

  function isSafariExtensionRuntime() {
    try {
      return String(chrome.runtime?.getURL?.('') || '').startsWith('safari-web-extension://');
    } catch {
      return false;
    }
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

  function applyCaptureExtensions(value, overrides) {
    storedCaptureExtensions = value;
    if (overrides && Object.hasOwn(overrides, 'savedText') && overrides.savedText !== value) {
      overrides = null;
    }
    const rules = globalThis.ConfigDefaults?.resolveCaptureExtensions(value, overrides) ?? value ?? defaultCaptureExtensions;
    captureExtensionPattern = buildCaptureExtensionPattern(rules);
  }

  function updateCaptureExtensions(changes) {
    if (!changes.captureExtensions && !changes.captureExtensionOverrides) return;
    const value = changes.captureExtensions ? changes.captureExtensions.newValue : storedCaptureExtensions;
    applyCaptureExtensions(value, changes.captureExtensionOverrides?.newValue);
  }

  function applySafariDownloadAllowlist(value, overrides) {
    if (!isSafariExtensionRuntime()) return;
    const defaults = globalThis.ConfigDefaults;
    const rules = defaults?.resolveSafariDownloadRules(value, overrides);
    const patterns = defaults?.buildSafariDownloadAllowlistPatterns(rules) || [];
    safariAllowlistPatterns = patterns.map((pattern) => new RegExp(pattern));
  }

  function applyStoredCaptureSettings(stored, fallback = {}) {
    const settings = { ...fallback, ...stored };
    applyCaptureExtensions(settings.captureExtensions, settings.captureExtensionOverrides);
    applySafariDownloadAllowlist(settings.safariDownloadAllowlist, settings.safariDownloadRuleOverrides);
  }

  function updateSafariDownloadAllowlist(changes) {
    if (changes.safariDownloadAllowlist || changes.safariDownloadRuleOverrides) {
      applySafariDownloadAllowlist(
        changes.safariDownloadAllowlist?.newValue,
        changes.safariDownloadRuleOverrides?.newValue
      );
    }
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

  async function loadStoredCaptureSettings() {
    let localStored = {};
    try {
      localStored = await getStoredConfig(chrome.storage.local, null);
    } catch {}

    const localHasConfig = Object.prototype.hasOwnProperty.call(localStored, 'captureExtensions');
    if (localStored?.[configStorageAreaKey] === 'local') {
      activeConfigStorageArea = 'local';
      applyStoredCaptureSettings(localStored);
      return;
    }

    try {
      const syncStored = await getStoredConfig(chrome.storage.sync, null);
      const syncHasConfig = Object.prototype.hasOwnProperty.call(syncStored, 'captureExtensions');
      if (localStored?.[configStorageAreaKey] === 'sync') {
        activeConfigStorageArea = 'sync';
        applyStoredCaptureSettings(syncStored, localStored);
        return;
      }
      activeConfigStorageArea = syncHasConfig ? 'sync' : (localHasConfig ? 'local' : 'sync');
      applyStoredCaptureSettings(activeConfigStorageArea === 'local' ? localStored : syncStored, localStored);
    } catch {
      activeConfigStorageArea = localStored?.[configStorageAreaKey] === 'sync' ? 'sync' : 'local';
      applyStoredCaptureSettings(localStored);
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
        } else if (response.recoveryMode === 'stay') {
          const showStatus = () => {
            const message = (key, fallback) => chrome.i18n?.getMessage?.(key) || fallback;
            const page = document.createElement('main');
            page.className = 'downlink-bridge-status';
            const panel = document.createElement('section');
            panel.className = 'downlink-bridge-panel';
            panel.setAttribute('aria-labelledby', 'downlink-bridge-title');
            const tile = document.createElement('span');
            tile.className = 'downlink-bridge-icon';
            const icon = document.createElement('img');
            icon.src = chrome.runtime.getURL('icons/icon300.png');
            icon.alt = '';
            icon.width = 80;
            icon.height = 80;
            tile.append(icon);
            const details = document.createElement('div');
            details.className = 'downlink-bridge-details';
            const title = document.createElement('h1');
            title.id = 'downlink-bridge-title';
            title.textContent = response.pending
              ? message('safariBridgePending', 'Confirm download')
              : message('safariBridgeSent', 'Download sent');
            const status = document.createElement('p');
            status.textContent = response.pending
              ? message('safariBridgePendingDetail', 'Confirm this task in the Downlink window to start the download.')
              : message('safariBridgeSentDetail', 'You can view progress in your downloader.');
            details.append(title, status);
            panel.append(tile, details);
            page.append(panel);
            if (window.history.length > 1) {
              const back = document.createElement('button');
              back.className = 'downlink-bridge-back';
              back.type = 'button';
              back.textContent = message('safariBridgeBack', 'Go back');
              back.addEventListener('click', () => window.history.back());
              details.append(back);
            }
            document.title = `${title.textContent} · Downlink`;
            document.body.append(page);
          };
          if (document.body) showStatus();
          else document.addEventListener('DOMContentLoaded', showStatus, { once: true });
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
    let matchesSafariAllowlist = false;
    try {
      const url = new URL(href);
      path = url.pathname;
      url.hash = '';
      matchesSafariAllowlist = safariAllowlistPatterns.some((pattern) => pattern.test(url.href));
    } catch {}
    return Boolean(
      downloadAttr !== undefined && downloadAttr !== null ||
      captureExtensionPattern?.test(href) ||
      matchesSafariAllowlist ||
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
    const downloadFilename = String(link.getAttribute?.('download') || '').trim();
    if (downloadFilename) message.downloadFilename = downloadFilename;

    const restoreBrowserNavigation = () => {
      window.location.href = link.href;
    };

    // The downloader can accept a task while its reply is still in flight.
    sendRuntimeMessage(message)
      .then((result) => {
        if (!result?.ok) restoreBrowserNavigation();
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

  loadStoredCaptureSettings().catch(() => applyCaptureExtensions(defaultCaptureExtensions));
  chrome.storage.onChanged?.addListener?.((changes, areaName) => {
    if (areaName && !['sync', 'local'].includes(areaName)) return;
    if (areaName === 'local' && Object.prototype.hasOwnProperty.call(changes || {}, configStorageAreaKey)) {
      const nextArea = changes[configStorageAreaKey]?.newValue;
      if (nextArea === 'sync' || nextArea === 'local') activeConfigStorageArea = nextArea;
      if (activeConfigStorageArea === 'local' && (changes.captureExtensions || changes.captureExtensionOverrides)) {
        updateCaptureExtensions(changes);
        updateSafariDownloadAllowlist(changes);
      } else {
        loadStoredCaptureSettings().catch(() => {});
      }
      return;
    }
    if (activeConfigStorageArea && areaName && areaName !== activeConfigStorageArea) return;
    updateCaptureExtensions(changes);
    updateSafariDownloadAllowlist(changes);
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
    const parseHlsManifestMetadata = (buffer) => {
      let manifest = '';
      try {
        manifest = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
      } catch {
        return null;
      }
      if (!/^\s*#EXTM3U\b/i.test(manifest)) return null;
      const lines = manifest.split(/\r?\n/).map((line) => line.trim());
      const variantUrls = [];
      for (let index = 0; index < lines.length; index += 1) {
        if (!/^#EXT-X-STREAM-INF:/i.test(lines[index])) continue;
        const relativeUrl = lines.slice(index + 1).find((line) => line && !line.startsWith('#'));
        if (!relativeUrl) continue;
        try { variantUrls.push(new URL(relativeUrl, resourceUrl).href); } catch {}
      }
      const resolutions = Array.from(manifest.matchAll(/\bRESOLUTION\s*=\s*(\d+)x(\d+)/gi))
        .map((match) => ({ width: Number(match[1]) || 0, height: Number(match[2]) || 0 }))
        .filter(({ width, height }) => width > 0 && height > 0)
        .sort((a, b) => (b.width * b.height) - (a.width * a.height));
      const bestResolution = resolutions[0] || { width: 0, height: 0 };
      const durations = Array.from(manifest.matchAll(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gmi));
      if (!durations.length && !bestResolution.width && !variantUrls.length) return null;
      const duration = durations.reduce((total, match) => total + Number(match[1] || 0), 0);
      const isLive = durations.length
        ? !/^#EXT-X-ENDLIST\s*$/mi.test(manifest) && !/^#EXT-X-PLAYLIST-TYPE\s*:\s*VOD\s*$/mi.test(manifest)
        : undefined;
      return { ...bestResolution, duration, isLive, variantUrls };
    };
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
      const duration = mediaEl.duration;
      const liveState = duration === Infinity
        ? { isLive: true }
        : Number.isFinite(duration) && duration > 0 ? { isLive: false } : {};
      finish({
        ok: true,
        width,
        height,
        duration: Number.isFinite(duration) ? duration : 0,
        ...liveState,
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
        const hlsMetadata = parseHlsManifestMetadata(xhr.response);
        if (hlsMetadata) {
          finish({
            ok: true,
            width: hlsMetadata.width,
            height: hlsMetadata.height,
            duration: hlsMetadata.duration,
            isLive: hlsMetadata.isLive,
            variantUrls: hlsMetadata.variantUrls,
            kind: 'video',
          });
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

  const bilibiliTitlesByCid = new Map();
  const readBilibiliScripts = new WeakSet();

  function readBilibiliMediaState(script) {
    if (script.nodeName !== 'SCRIPT' || readBilibiliScripts.has(script)) return;
    const source = script.textContent || '';
    const assignment = /^\s*(window\.__INITIAL_STATE__|const playurlSSRData)\s*=\s*(?=\{)/.exec(source);
    if (!assignment) return;
    const start = assignment[0].length;
    // Find the end of the JSON object without executing the script that follows it.
    let depth = 0;
    let quoted = false;
    let end = start;
    for (; end < source.length; end++) {
      const char = source[end];
      if (quoted) {
        if (char === '\\') end++;
        else if (char === '"') quoted = false;
      } else if (char === '"') {
        quoted = true;
      } else if (char === '{') {
        depth++;
      } else if (char === '}' && --depth === 0) {
        break;
      }
    }
    try {
      const data = JSON.parse(source.slice(start, end + 1));
      readBilibiliScripts.add(script);
      if (assignment[1] === 'const playurlSSRData') {
        const cid = data.data?.result?.arc?.cid;
        const title = document.title.trim();
        // The server-rendered player data and heading refer to the initial episode.
        if (cid && title && location.href === mediaPage.href && mediaPage.pathname.startsWith('/bangumi/play/')) {
          bilibiliTitlesByCid.set(String(cid), title.replace(/[-_](?:番剧|电影|电视剧|纪录片)[-_].*$/, ''));
        }
        return;
      }
      const { videoData, related } = data;
      if (!videoData) return;
      for (const video of Array.isArray(related) ? related : []) {
        if (video.cid && video.title) bilibiliTitlesByCid.set(String(video.cid), video.title);
      }
      for (const section of videoData.ugc_season?.sections || []) {
        for (const episode of section.episodes || []) {
          if (episode.cid && episode.title) bilibiliTitlesByCid.set(String(episode.cid), episode.title);
        }
      }
      if (videoData.cid && videoData.title) bilibiliTitlesByCid.set(String(videoData.cid), videoData.title);
      if (videoData.pages?.length > 1) {
        for (const part of videoData.pages) {
          if (part.cid && part.part) bilibiliTitlesByCid.set(String(part.cid), part.part);
        }
      }
    } catch {
      // An incomplete or unrelated script is not a title source.
    }
  }

  const mediaPage = new URL(location.href);
  if (mediaPage.hostname === 'www.bilibili.com' &&
      /^\/(?:video\/|bangumi\/play\/)/.test(mediaPage.pathname)) {
    for (const script of document.scripts || []) readBilibiliMediaState(script);
    const observer = new MutationObserver((records) => {
      for (const { addedNodes, removedNodes } of records) {
        // The site can remove an inline data script immediately after execution.
        for (const script of addedNodes) readBilibiliMediaState(script);
        for (const script of removedNodes) readBilibiliMediaState(script);
      }
    });
    observer.observe(document, { childList: true, subtree: true });
  }

  chrome.runtime.onMessage?.addListener?.((message, _sender, sendResponse) => {
    if (message?.type === 'GET_MEDIA_PAGE_TITLE') {
      const url = new URL(location.href);
      // Bilibili can change the active part without updating the document or Media Session title.
      const isBilibiliVideo = url.hostname === 'www.bilibili.com' && url.pathname.startsWith('/video/');
      const part = isBilibiliVideo
        ? document.querySelector(
          '#multi_page .cur-list li.on .part, .multi-page-v1 .cur-list li.on .part'
        )
        : null;
      const heading = isBilibiliVideo ? document.querySelector('h1.video-title')?.textContent.trim() : '';
      sendResponse({
        url: url.href,
        titlesByCid: Array.isArray(message.cids)
          ? message.cids.flatMap((cid) => bilibiliTitlesByCid.has(cid) ? [[cid, bilibiliTitlesByCid.get(cid)]] : [])
          : [],
        title: part?.textContent.trim() || heading || navigator.mediaSession?.metadata?.title?.trim() || document.title.trim(),
      });
      return undefined;
    }
    if (message?.type !== 'PROBE_MEDIA_METADATA_IN_PAGE') return undefined;
    return probeMediaMetadataInPage(message, sendResponse);
  });
})();
