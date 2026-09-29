(function initBackgroundMedia(global) {
  const t = global.Localization?.t || ((key, substitutions, fallback = key) => {
    if (fallback && substitutions !== undefined) {
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
    }
    return fallback || key;
  });
  function createMediaManager({
    fallbackMediaFilename,
    escapeRegex,
    hashString,
    totalSizeFromHeaders,
    mediaKindOf,
    deriveOrigin,
    updateActionBadgeForTab,
    broadcastUpdate,
    getRequestHeaders,
    getTabSnapshot,
    probeMediaMetadata,
    canAutoProbeMediaMetadata = false,
  }) {
    const MEDIA_CACHE_LIMIT = 60;
    const METADATA_RULE_TTL_MS = 15000;
    const PREVIEW_RESOURCE_TYPES = ['media', 'xmlhttprequest', 'other'];
    const METADATA_RULE_BASE = 100000000;
    const METADATA_RULE_SPAN = 800000000;
    const HOVER_RULE_BASE = 1000000000;
    const HOVER_RULE_SPAN = 800000000;
    const HLS_PUBLISH_SETTLE_MS = 200;
    const HLS_MAX_PUBLISH_HOLD_MS = 1000;
    let mediaResources = {};
    let mediaBadgeCounts = {};
    let previewRulesByTab = {};
    let metadataRulesByMediaId = {};
    let hoverPreviewRulesByMediaId = {};
    let pausedTabs = new Set();
    let publishTimersByTab = {};
    let publishDeadlinesByTab = {};

    function publishedMedia(tabId) {
      // metadataPending describes probe work, while publishHeld is the actual
      // visibility gate. Keeping those states separate lets a completed HLS
      // master become visible even when one of its variants is still probing.
      return (mediaResources[tabId] || []).filter((item) => !item.publishHeld);
    }

    function publishMediaNow(tabId, { fallback = false } = {}) {
      const list = mediaResources[tabId] || [];
      const settledHeldItems = list.filter((item) => item.publishHeld && !item.metadataPending);
      for (const item of list) {
        if (!item.metadataPending) item.publishHeld = false;
      }
      if (fallback && !settledHeldItems.length) {
        // If every probe is stalled, expose one sniffed candidate instead of
        // publishing a burst of unresolved master/variant duplicates.
        const candidate = list.find((item) => item.publishHeld);
        if (candidate) candidate.publishHeld = false;
      }
      mediaBadgeCounts[tabId] = publishedMedia(tabId).length;
      updateActionBadgeForTab(tabId, mediaBadgeCounts[tabId], isSniffingPaused(tabId));
      broadcastUpdate(tabId);
    }

    function ensurePublishDeadline(tabId) {
      if (publishDeadlinesByTab[tabId]) return;
      publishDeadlinesByTab[tabId] = setTimeout(() => {
        delete publishDeadlinesByTab[tabId];
        if (publishTimersByTab[tabId]) clearTimeout(publishTimersByTab[tabId]);
        delete publishTimersByTab[tabId];
        // Metadata is optional. Never let a stalled Safari page probe make a
        // captured resource disappear for the full metadata timeout.
        publishMediaNow(tabId, { fallback: true });
      }, HLS_MAX_PUBLISH_HOLD_MS);
    }

    function hasUnclassifiedPendingMedia(tabId) {
      const list = mediaResources[tabId] || [];
      return list.some((item) => (
        item.metadataPending && !list.some((candidate) => (
          candidate.id !== item.id &&
          Array.isArray(candidate.variantUrls) &&
          candidate.variantUrls.includes(item.resourceUrl)
        ))
      ));
    }

    function publishStableMedia(tabId) {
      // A completed child must not become visible before a still-pending
      // master can identify and absorb it. Known variants do not block their
      // already-resolved master.
      if (hasUnclassifiedPendingMedia(tabId)) return;
      if (publishTimersByTab[tabId]) clearTimeout(publishTimersByTab[tabId]);
      publishTimersByTab[tabId] = setTimeout(() => {
        delete publishTimersByTab[tabId];
        if (hasUnclassifiedPendingMedia(tabId)) return;
        // Release only probes that have actually settled. A slow Safari child
        // playlist must not keep an already-resolved master playlist hidden.
        if (publishDeadlinesByTab[tabId]) clearTimeout(publishDeadlinesByTab[tabId]);
        delete publishDeadlinesByTab[tabId];
        publishMediaNow(tabId);
      }, HLS_PUBLISH_SETTLE_MS);
    }

    async function autoProbeMedia(item) {
      let result = null;
      try {
        result = await probeMediaMetadata?.(item);
      } catch {}
      updateMediaMetadata(item.id, {
        duration: Number.isFinite(Number(result?.duration)) ? Number(result.duration) : undefined,
        isLive: typeof result?.isLive === 'boolean' ? result.isLive : undefined,
        width: Number(result?.width) || 0,
        height: Number(result?.height) || 0,
        kind: ['audio', 'video', 'media'].includes(result?.kind) ? result.kind : undefined,
        variantUrls: Array.isArray(result?.variantUrls) ? result.variantUrls.slice(0, 50) : undefined,
        metadataFailed: !result?.ok,
        metadataProbed: true,
        metadataPending: false,
      });
    }

    function uniqueMediaFilename(filename, resourceUrl, list = []) {
      const conflicts = (candidate) => list.some((entry) => (
        entry.resourceUrl !== resourceUrl &&
        String(entry.filename || '').toLowerCase() === String(candidate || '').toLowerCase()
      ));
      if (!conflicts(filename)) return filename;

      const match = String(filename || '').match(/^(.*?)(\.[^.]+)?$/);
      const stem = match?.[1] || filename || 'media';
      const extension = match?.[2] || '';
      const stableId = String(hashString(resourceUrl)).padStart(6, '0').slice(-6);
      let candidate = `${stem}-${stableId}${extension}`;
      let sequence = 2;
      while (conflicts(candidate)) {
        candidate = `${stem}-${stableId}-${sequence}${extension}`;
        sequence += 1;
      }
      return candidate;
    }

    function upsertMediaResource(item) {
      if (!item || typeof item.tabId !== 'number' || item.tabId < 0 || !item.resourceUrl) return null;
      const list = mediaResources[item.tabId] || [];
      const idx = list.findIndex((entry) => entry.resourceUrl === item.resourceUrl);
      const filename = fallbackMediaFilename(item) || t('untitledMedia', undefined, '未命名媒体');
      const normalized = {
        ...item,
        detectedAt: item.detectedAt || Date.now(),
        filename: uniqueMediaFilename(filename, item.resourceUrl, list),
      };
      let changed = false;

      if (idx >= 0) {
        const current = list[idx];
        const next = { ...current };
        for (const [key, value] of Object.entries(normalized)) {
          if (value === undefined || value === '') continue;
          if (key === 'size' && current.size && value && value < current.size) continue;
          if (current[key] !== value) {
            next[key] = value;
            changed = true;
          }
        }
        list[idx] = next;
      } else {
        list.unshift(normalized);
        changed = true;
      }

      mediaResources[item.tabId] = list
        .sort((a, b) => (b.detectedAt || 0) - (a.detectedAt || 0))
        .slice(0, MEDIA_CACHE_LIMIT);

      const resource = mediaResources[item.tabId].find((entry) => entry.resourceUrl === item.resourceUrl) || null;
      return resource ? { resource, changed } : null;
    }

    function findMediaResourceById(id) {
      for (const tabId of Object.keys(mediaResources)) {
        const hit = (mediaResources[tabId] || []).find((item) => item.id === id);
        if (hit) return hit;
      }
      return null;
    }

    function hasMediaResource(tabId, resourceUrl) {
      if (typeof tabId !== 'number' || tabId < 0 || !resourceUrl) return false;
      return (mediaResources[tabId] || []).some((item) => item.resourceUrl === resourceUrl);
    }

    function findVariantParent(tabId, resourceUrl) {
      if (typeof tabId !== 'number' || tabId < 0 || !resourceUrl) return null;
      return (mediaResources[tabId] || []).find((item) => (
        Array.isArray(item.variantUrls) && item.variantUrls.includes(resourceUrl)
      )) || null;
    }

    function getMediaCount(tabId) {
      if (typeof tabId !== 'number' || tabId < 0) return 0;
      return publishedMedia(tabId).length;
    }

    function normalizeDetectedMediaMime(mime = '', streamProtocol = '') {
      const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
      const unreliableManifestMimes = new Set([
        '',
        'text/html',
        'text/plain',
        'application/octet-stream',
        'application/binary',
      ]);
      if (!unreliableManifestMimes.has(normalized)) return normalized;
      if (streamProtocol === 'hls') return 'application/vnd.apple.mpegurl';
      if (streamProtocol === 'dash') return 'application/dash+xml';
      return normalized;
    }

    function isBrowserExtensionUrl(value = '') {
      return /^(?:chrome|moz|safari-web|ms-browser)-extension:\/\//i.test(String(value || '').trim());
    }

    function unwrapManifestUrl(resourceUrl = '', mime = '') {
      const normalizedMime = String(mime || '').split(';')[0].trim().toLowerCase();
      if (normalizedMime !== 'text/html') return resourceUrl;
      try {
        const wrapper = new URL(resourceUrl);
        for (const name of ['url', 'src', 'source', 'play']) {
          const candidate = wrapper.searchParams.get(name);
          if (!candidate || !/^https?:\/\//i.test(candidate)) continue;
          const parsed = new URL(candidate);
          const extension = global.BackgroundShared.extOf(parsed.pathname);
          if (extension === 'm3u8' || extension === 'mpd') return parsed.href;
        }
      } catch {}
      return resourceUrl;
    }

    function requestHeadersForResolvedResource(observedUrl = '', resourceUrl = '') {
      const captured = { ...(getRequestHeaders(observedUrl) || {}) };
      try {
        if (new URL(observedUrl).origin === new URL(resourceUrl).origin) return captured;
      } catch {
        return captured;
      }
      // A resolver page may point at a manifest on an unrelated host. Never
      // forward resolver credentials or custom headers to that target.
      const safeNames = new Set(['accept', 'accept-language', 'dnt', 'referer', 'user-agent']);
      return Object.fromEntries(
        Object.entries(captured).filter(([name]) => safeNames.has(String(name).toLowerCase()))
      );
    }

    function clearMediaResources(tabId) {
      if (typeof tabId === 'number' && tabId >= 0) {
        if (publishTimersByTab[tabId]) clearTimeout(publishTimersByTab[tabId]);
        delete publishTimersByTab[tabId];
        if (publishDeadlinesByTab[tabId]) clearTimeout(publishDeadlinesByTab[tabId]);
        delete publishDeadlinesByTab[tabId];
        for (const item of mediaResources[tabId] || []) {
          clearMetadataRule(item.id);
          clearHoverPreviewRule(item.id);
        }
        delete mediaResources[tabId];
        delete mediaBadgeCounts[tabId];
        updateActionBadgeForTab(tabId, getMediaCount(tabId), isSniffingPaused(tabId));
        return;
      }
      for (const mediaId of Object.keys(metadataRulesByMediaId)) {
        clearMetadataRule(mediaId);
      }
      for (const mediaId of Object.keys(hoverPreviewRulesByMediaId)) {
        clearHoverPreviewRule(mediaId);
      }
      mediaResources = {};
      mediaBadgeCounts = {};
      pausedTabs.clear();
      for (const timer of Object.values(publishTimersByTab)) clearTimeout(timer);
      publishTimersByTab = {};
      for (const timer of Object.values(publishDeadlinesByTab)) clearTimeout(timer);
      publishDeadlinesByTab = {};
      chrome.action.setBadgeText({ text: '' });
    }

    function getPreviewRuleId(tabId) {
      return 100000 + tabId;
    }

    function getMetadataRuleId(media) {
      const key = media?.id || media?.resourceUrl || '';
      return METADATA_RULE_BASE + (parseInt(hashString(key), 36) % METADATA_RULE_SPAN);
    }

    function getHoverPreviewRuleId(media) {
      const key = media?.id || media?.resourceUrl || '';
      return HOVER_RULE_BASE + (parseInt(hashString(key), 36) % HOVER_RULE_SPAN);
    }

    function allocateRuleId(preferredId, base, span, registry, mediaId, reservedIds) {
      const cachedId = registry[mediaId]?.ruleId;
      if (cachedId) {
        reservedIds.add(cachedId);
        return cachedId;
      }
      let ruleId = preferredId;
      while (reservedIds.has(ruleId)) {
        ruleId = base + ((ruleId - base + 1) % span);
        if (ruleId === preferredId) throw new Error('No request-header rule IDs available');
      }
      reservedIds.add(ruleId);
      return ruleId;
    }

    function buildPreviewRequestHeaders(media) {
      const requestHeaders = [];
      const headers = media?.headers || {};
      const values = {
        referer: headers.referer || media?.referrer || media?.pageUrl || '',
        origin: headers.origin || '',
        authorization: headers.authorization || '',
        'user-agent': headers['user-agent'] || '',
        cookie: headers.cookie || '',
      };
      Object.entries(values).forEach(([key, value]) => {
        if (value) requestHeaders.push({ header: key, operation: 'set', value: String(value) });
      });
      return requestHeaders;
    }

    function getActivePreviewRequestInfo(resourceUrl) {
      if (!resourceUrl) return null;
      const matches = [];
      for (const entry of Object.values(metadataRulesByMediaId)) {
        if (entry.resourceUrl === resourceUrl) matches.push({ mode: 'metadata', requestHeaders: entry.requestHeaders || [] });
      }
      for (const entry of Object.values(hoverPreviewRulesByMediaId)) {
        if (entry.resourceUrl === resourceUrl) matches.push({ mode: 'hover', requestHeaders: entry.requestHeaders || [] });
      }
      for (const entry of Object.values(previewRulesByTab)) {
        if (entry.resourceUrl === resourceUrl) matches.push({ mode: 'preview-tab', requestHeaders: entry.requestHeaders || [] });
      }
      if (!matches.length) return null;
      return {
        modes: matches.map((entry) => entry.mode),
        expectedHeaders: Array.from(new Set(matches.flatMap((entry) => entry.requestHeaders.map((header) => header.header)))),
      };
    }

    async function clearPreviewRule(tabId) {
      if (typeof tabId !== 'number' || tabId < 0) return;
      if (!chrome.declarativeNetRequest?.updateSessionRules) return;
      try {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [getPreviewRuleId(tabId)],
        });
      } catch {}
      delete previewRulesByTab[tabId];
    }

    async function clearMetadataRule(mediaOrId) {
      const mediaId = typeof mediaOrId === 'string' ? mediaOrId : mediaOrId?.id;
      if (!mediaId) return;
      const cachedRule = metadataRulesByMediaId[mediaId];
      if (cachedRule?.cleanupTimer) clearTimeout(cachedRule.cleanupTimer);
      if (!chrome.declarativeNetRequest?.updateSessionRules) {
        delete metadataRulesByMediaId[mediaId];
        return;
      }
      const ruleId = cachedRule?.ruleId || (typeof mediaOrId === 'string' ? 0 : getMetadataRuleId(mediaOrId));
      delete metadataRulesByMediaId[mediaId];
      if (!ruleId) return;
      try {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId],
        });
      } catch {}
    }

    async function clearHoverPreviewRule(mediaOrId) {
      const mediaId = typeof mediaOrId === 'string' ? mediaOrId : mediaOrId?.id;
      if (!mediaId) return;
      const cachedRule = hoverPreviewRulesByMediaId[mediaId];
      if (!chrome.declarativeNetRequest?.updateSessionRules) {
        delete hoverPreviewRulesByMediaId[mediaId];
        return;
      }
      const ruleId = cachedRule?.ruleId || (typeof mediaOrId === 'string' ? 0 : getHoverPreviewRuleId(mediaOrId));
      delete hoverPreviewRulesByMediaId[mediaId];
      if (!ruleId) return;
      try {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId],
        });
      } catch {}
    }

    async function prepareHeaderRule(media, { ruleId, tabId, priority = 1 } = {}) {
      if (!media?.resourceUrl) throw new Error(t('mediaUrlInvalid', undefined, '媒体地址无效'));
      if (!chrome.declarativeNetRequest?.updateSessionRules) {
        throw new Error(t('previewHeadersUnsupported', undefined, '当前浏览器不支持预览请求补头'));
      }

      const requestHeaders = buildPreviewRequestHeaders(media);

      if (requestHeaders.length) {
        let regexFilter = `^${escapeRegex(media.resourceUrl)}$`;
        if (media.streamProtocol === 'hls') {
          try {
            // Native HLS loads the master, child playlists, keys and segments
            // as separate requests. Scope the captured headers to the same
            // origin and preview tab so credentials never leak cross-origin.
            regexFilter = `^${escapeRegex(`${new URL(media.resourceUrl).origin}/`)}`;
          } catch {}
        }
        const condition = {
          regexFilter,
          resourceTypes: PREVIEW_RESOURCE_TYPES,
        };
        if (typeof tabId === 'number' && tabId >= 0) condition.tabIds = [tabId];
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId],
          addRules: [{
            id: ruleId,
            priority,
            action: {
              type: 'modifyHeaders',
              requestHeaders,
            },
            condition,
          }],
        });
      } else {
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId],
        });
      }

      return { ok: true, headersApplied: requestHeaders.map((item) => item.header) };
    }

    async function preparePreviewRule(tabId, media) {
      if (typeof tabId !== 'number' || tabId < 0) throw new Error(t('previewTabInvalid', undefined, '预览标签页无效'));
      const result = await prepareHeaderRule(media, { ruleId: getPreviewRuleId(tabId), tabId });
      if (result.headersApplied.length) {
        previewRulesByTab[tabId] = {
          mediaId: media.id,
          resourceUrl: media.resourceUrl,
          requestHeaders: buildPreviewRequestHeaders(media),
        };
      } else {
        delete previewRulesByTab[tabId];
      }
      return result;
    }

    async function prepareMetadataRules(mediaList = []) {
      const reservedRuleIds = new Set(
        Object.values(metadataRulesByMediaId).map((entry) => entry?.ruleId).filter(Boolean)
      );
      const entries = mediaList
        .filter((media) => media?.id && media?.resourceUrl)
        .map((media) => ({
          media,
          ruleId: allocateRuleId(
            getMetadataRuleId(media),
            METADATA_RULE_BASE,
            METADATA_RULE_SPAN,
            metadataRulesByMediaId,
            media.id,
            reservedRuleIds
          ),
          requestHeaders: buildPreviewRequestHeaders(media),
        }));
      if (!entries.length) return { ok: true, items: [] };
      if (!chrome.declarativeNetRequest?.updateSessionRules) {
        throw new Error(t('previewHeadersUnsupported', undefined, '当前浏览器不支持预览请求补头'));
      }

      const addRules = entries
        .filter((entry) => entry.requestHeaders.length)
        .map((entry) => ({
          id: entry.ruleId,
          priority: 1,
          action: {
            type: 'modifyHeaders',
            requestHeaders: entry.requestHeaders,
          },
          condition: {
            regexFilter: `^${escapeRegex(entry.media.resourceUrl)}$`,
            resourceTypes: PREVIEW_RESOURCE_TYPES,
          },
        }));
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: entries.map((entry) => entry.ruleId),
        ...(addRules.length ? { addRules } : {}),
      });

      for (const entry of entries) {
        const mediaId = entry.media.id;
        if (metadataRulesByMediaId[mediaId]?.cleanupTimer) {
          clearTimeout(metadataRulesByMediaId[mediaId].cleanupTimer);
        }
        if (!entry.requestHeaders.length) {
          delete metadataRulesByMediaId[mediaId];
          continue;
        }
        const cleanupTimer = setTimeout(() => {
          clearMetadataRule(mediaId);
        }, METADATA_RULE_TTL_MS);
        metadataRulesByMediaId[mediaId] = {
          ruleId: entry.ruleId,
          resourceUrl: entry.media.resourceUrl,
          requestHeaders: entry.requestHeaders,
          cleanupTimer,
        };
      }

      return {
        ok: true,
        items: entries.map((entry) => ({
          id: entry.media.id,
          headersApplied: entry.requestHeaders.map((item) => item.header),
        })),
      };
    }

    async function prepareMetadataRule(media) {
      const result = await prepareMetadataRules([media]);
      return {
        ok: true,
        headersApplied: result.items[0]?.headersApplied || [],
      };
    }

    async function prepareHoverPreviewRule(media) {
      const reservedRuleIds = new Set(
        Object.values(hoverPreviewRulesByMediaId).map((entry) => entry?.ruleId).filter(Boolean)
      );
      const ruleId = allocateRuleId(
        getHoverPreviewRuleId(media),
        HOVER_RULE_BASE,
        HOVER_RULE_SPAN,
        hoverPreviewRulesByMediaId,
        media?.id,
        reservedRuleIds
      );
      const result = await prepareHeaderRule(media, { ruleId, priority: 2 });
      if (result.headersApplied.length && media?.id) {
        hoverPreviewRulesByMediaId[media.id] = {
          ruleId,
          resourceUrl: media.resourceUrl,
          requestHeaders: buildPreviewRequestHeaders(media),
        };
      } else if (media?.id) {
        await clearHoverPreviewRule(media.id);
      }
      return result;
    }

    async function handleMediaResponse(details) {
      if (details.tabId < 0) return;
      if (pausedTabs.has(details.tabId)) return;
      // Never sniff requests made by Downlink's own preview or management
      // pages. Otherwise previewing an HLS manifest captures its playlists
      // again and recursively creates media entries in the extension tab.
      if ([details.initiator, details.documentUrl, details.originUrl].some(isBrowserExtensionUrl)) return;

      let contentType = '';
      let contentDisposition = '';
      let contentLength = '';
      let contentRange = '';
      for (const header of details.responseHeaders || []) {
        const name = header.name.toLowerCase();
        if (name === 'content-type') contentType = header.value || '';
        if (name === 'content-disposition') contentDisposition = header.value || '';
        if (name === 'content-length') contentLength = header.value || '';
        if (name === 'content-range') contentRange = header.value || '';
      }

      const mime = contentType.split(';')[0].trim().toLowerCase();
      const resourceUrl = unwrapManifestUrl(details.url, mime);
      const filename = global.BackgroundShared.sanitizeFilenamePart(
        global.BackgroundShared.filenameFromCD(contentDisposition) || global.BackgroundShared.filenameFromUrl(resourceUrl) || ''
      );
      if (!global.BackgroundShared.isDirectMediaResource(resourceUrl, mime, filename)) return;
      if (details.statusCode === 206 && hasMediaResource(details.tabId, resourceUrl)) return;

      const tabSnapshot = await getTabSnapshot(details.tabId);
      if (isBrowserExtensionUrl(tabSnapshot.url)) return;
      const reqHeaders = requestHeadersForResolvedResource(details.url, resourceUrl);
      const streamProtocol = global.BackgroundShared.streamProtocolOf(resourceUrl, mime, filename);
      const detectedMime = normalizeDetectedMediaMime(mime, streamProtocol);
      const detectedKind = mediaKindOf(resourceUrl, mime, filename);
      const existingMedia = (mediaResources[details.tabId] || []).find((item) => item.resourceUrl === resourceUrl);
      const shouldAutoProbe = streamProtocol === 'hls' && canAutoProbeMediaMetadata &&
        !existingMedia?.metadataProbed && !existingMedia?.metadataPending;
      // Once a master playlist has identified this URL as one of its variants,
      // repeated live-playlist refreshes must not recreate a duplicate card.
      const variantParent = streamProtocol === 'hls'
        ? findVariantParent(details.tabId, resourceUrl)
        : null;
      if (variantParent?.variantMetadataMerged === true) return;
      const mediaResult = upsertMediaResource({
        id: `media_${details.tabId}_${hashString(resourceUrl)}`,
        tabId: details.tabId,
        frameId: details.frameId,
        resourceUrl,
        pageUrl: tabSnapshot.url || details.initiator || reqHeaders.referer || '',
        pageTitle: tabSnapshot.title || '',
        filename,
        mime: detectedMime,
        contentDisposition,
        size: totalSizeFromHeaders(contentLength, contentRange),
        headers: reqHeaders,
        origin: reqHeaders.origin || deriveOrigin(resourceUrl, reqHeaders.referer || ''),
        referrer: reqHeaders.referer || '',
        kind: detectedKind || (streamProtocol ? 'video' : ''),
        streamProtocol,
        metadataPending: shouldAutoProbe || existingMedia?.metadataPending === true,
        publishHeld: shouldAutoProbe || existingMedia?.publishHeld === true,
        detectedAt: Date.now(),
      });

      if (mediaResult?.changed) {
        if (shouldAutoProbe) {
          // Do not cancel the settle timer started by an already-completed
          // playlist. Safari often starts probing a child after the master has
          // resolved; cancelling here would hide the whole group until the
          // slowest child finishes or times out.
          ensurePublishDeadline(details.tabId);
          autoProbeMedia(mediaResult.resource);
          return;
        }
        mediaBadgeCounts[details.tabId] = getMediaCount(details.tabId);
        updateActionBadgeForTab(details.tabId, mediaBadgeCounts[details.tabId]);
        broadcastUpdate(details.tabId);
      }
    }

    function clearTabState(tabId) {
      for (const item of mediaResources[tabId] || []) {
        clearMetadataRule(item.id);
        clearHoverPreviewRule(item.id);
      }
      delete mediaResources[tabId];
      delete mediaBadgeCounts[tabId];
      if (publishTimersByTab[tabId]) clearTimeout(publishTimersByTab[tabId]);
      delete publishTimersByTab[tabId];
      if (publishDeadlinesByTab[tabId]) clearTimeout(publishDeadlinesByTab[tabId]);
      delete publishDeadlinesByTab[tabId];
      pausedTabs.delete(tabId);
    }

    function pauseSniffing(tabId) {
      if (typeof tabId === 'number' && tabId >= 0) {
        pausedTabs.add(tabId);
      }
    }

    function resumeSniffing(tabId) {
      if (typeof tabId === 'number' && tabId >= 0) {
        pausedTabs.delete(tabId);
      }
    }

    function isSniffingPaused(tabId) {
      return typeof tabId === 'number' && tabId >= 0 && pausedTabs.has(tabId);
    }

    function updateMediaMetadata(id, patch = {}) {
      const media = findMediaResourceById(id);
      if (!media) return false;
      const list = mediaResources[media.tabId] || [];
      const parent = list.find((entry) => (
        entry.id !== media.id &&
        Array.isArray(entry.variantUrls) &&
        entry.variantUrls.includes(media.resourceUrl)
      ));
      const target = parent || media;
      const childMetadataMerged = Boolean(parent && (
        Number(patch.duration) > 0 || typeof patch.isLive === 'boolean'
      ));
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined) continue;
        if (parent && ['metadataPending', 'metadataProbed', 'metadataFailed'].includes(key)) {
          media[key] = value;
          continue;
        }
        if (parent && (key === 'width' || key === 'height' || key === 'variantUrls' || key === 'kind')) continue;
        target[key] = value;
      }
      if (childMetadataMerged) target.variantMetadataMerged = true;

      if (Array.isArray(target.variantUrls) && target.variantUrls.length) {
        const variants = new Set(target.variantUrls);
        const removable = [];
        for (const entry of list) {
          if (entry.id === target.id || !variants.has(entry.resourceUrl)) continue;
          const isUpdatedChild = Boolean(childMetadataMerged && entry.id === media.id);
          const hasMetadata = Number(entry.duration) > 0 || typeof entry.isLive === 'boolean';
          if (!isUpdatedChild && !hasMetadata) continue;
          if (Number(entry.duration) > 0) target.duration = entry.duration;
          if (typeof entry.isLive === 'boolean') target.isLive = entry.isLive;
          removable.push(entry);
        }
        if (removable.length) {
          const removedIds = new Set(removable.map((entry) => entry.id));
          mediaResources[media.tabId] = list.filter((entry) => !removedIds.has(entry.id));
          for (const entry of removable) {
            clearMetadataRule(entry.id);
            clearHoverPreviewRule(entry.id);
          }
          mediaBadgeCounts[media.tabId] = getMediaCount(media.tabId);
          updateActionBadgeForTab(media.tabId, mediaBadgeCounts[media.tabId], isSniffingPaused(media.tabId));
        }
      }
      if (target.publishHeld || (mediaResources[media.tabId] || []).some((entry) => entry.publishHeld)) {
        publishStableMedia(media.tabId);
        return true;
      }
      broadcastUpdate(media.tabId);
      return true;
    }

    function getState() {
      const visibleMedia = {};
      for (const tabId of Object.keys(mediaResources)) visibleMedia[tabId] = publishedMedia(Number(tabId));
      return {
        media: visibleMedia,
        badgeCounts: mediaBadgeCounts,
        pausedTabs: Array.from(pausedTabs),
      };
    }

    return {
      clearMediaResources,
      clearHoverPreviewRule,
      clearMetadataRule,
      clearPreviewRule,
      clearTabState,
      findMediaResourceById,
      getActivePreviewRequestInfo,
      getState,
      handleMediaResponse,
      hasMediaResource,
      isSniffingPaused,
      pauseSniffing,
      prepareHoverPreviewRule,
      prepareMetadataRule,
      prepareMetadataRules,
      preparePreviewRule,
      resumeSniffing,
      upsertMediaResource,
      updateMediaMetadata,
    };
  }

  global.BackgroundMedia = {
    createMediaManager,
  };
})(globalThis);
