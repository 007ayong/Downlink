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
  }) {
    const MEDIA_CACHE_LIMIT = 60;
    const METADATA_RULE_TTL_MS = 15000;
    const PREVIEW_RESOURCE_TYPES = ['media', 'xmlhttprequest', 'other'];
    const METADATA_RULE_BASE = 100000000;
    const METADATA_RULE_SPAN = 800000000;
    const HOVER_RULE_BASE = 1000000000;
    const HOVER_RULE_SPAN = 800000000;
    let mediaResources = {};
    let mediaBadgeCounts = {};
    let previewRulesByTab = {};
    let metadataRulesByMediaId = {};
    let hoverPreviewRulesByMediaId = {};
    let pausedTabs = new Set();

    function upsertMediaResource(item) {
      if (!item || typeof item.tabId !== 'number' || item.tabId < 0 || !item.resourceUrl) return null;
      const list = mediaResources[item.tabId] || [];
      const idx = list.findIndex((entry) => entry.resourceUrl === item.resourceUrl);
      const normalized = {
        ...item,
        detectedAt: item.detectedAt || Date.now(),
        filename: fallbackMediaFilename(item) || t('untitledMedia', undefined, '未命名媒体'),
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

    function getMediaCount(tabId) {
      if (typeof tabId !== 'number' || tabId < 0) return 0;
      return (mediaResources[tabId] || []).length;
    }

    function clearMediaResources(tabId) {
      if (typeof tabId === 'number' && tabId >= 0) {
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
        const condition = {
          regexFilter: `^${escapeRegex(media.resourceUrl)}$`,
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
      const filename = global.BackgroundShared.sanitizeFilenamePart(
        global.BackgroundShared.filenameFromCD(contentDisposition) || global.BackgroundShared.filenameFromUrl(details.url) || ''
      );
      if (!global.BackgroundShared.isDirectMediaResource(details.url, mime, filename)) return;
      if (details.statusCode === 206 && hasMediaResource(details.tabId, details.url)) return;

      const tabSnapshot = await getTabSnapshot(details.tabId);
      const reqHeaders = getRequestHeaders(details.url);
      const mediaResult = upsertMediaResource({
        id: `media_${details.tabId}_${hashString(details.url)}`,
        tabId: details.tabId,
        frameId: details.frameId,
        resourceUrl: details.url,
        pageUrl: tabSnapshot.url || details.initiator || reqHeaders.referer || '',
        pageTitle: tabSnapshot.title || '',
        filename,
        mime,
        contentDisposition,
        size: totalSizeFromHeaders(contentLength, contentRange),
        headers: reqHeaders,
        origin: reqHeaders.origin || deriveOrigin(details.url, reqHeaders.referer || ''),
        referrer: reqHeaders.referer || '',
        kind: mediaKindOf(details.url, mime, filename),
        detectedAt: Date.now(),
      });

      if (mediaResult?.changed) {
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
      for (const [key, value] of Object.entries(patch)) {
        if (value !== undefined) media[key] = value;
      }
      broadcastUpdate(media.tabId);
      return true;
    }

    function getState() {
      return {
        media: mediaResources,
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
