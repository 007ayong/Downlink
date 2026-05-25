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
    let mediaResources = {};
    let mediaBadgeCounts = {};
    let previewRulesByTab = {};
    let metadataRulesByMediaId = {};
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
        }
        delete mediaResources[tabId];
        delete mediaBadgeCounts[tabId];
        updateActionBadgeForTab(tabId, getMediaCount(tabId), isSniffingPaused(tabId));
        return;
      }
      for (const mediaId of Object.keys(metadataRulesByMediaId)) {
        clearMetadataRule(mediaId);
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
      return 200000 + (parseInt(hashString(key), 36) % 100000);
    }

    function buildPreviewRequestHeaders(media) {
      const requestHeaders = [];
      const headers = media?.headers || {};
      ['referer', 'origin', 'authorization', 'user-agent', 'cookie'].forEach((key) => {
        if (headers[key]) requestHeaders.push({ header: key, operation: 'set', value: String(headers[key]) });
      });
      return requestHeaders;
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

    async function prepareHeaderRule(media, { ruleId, tabId } = {}) {
      if (!media?.resourceUrl) throw new Error(t('mediaUrlInvalid', undefined, '媒体地址无效'));
      if (!chrome.declarativeNetRequest?.updateSessionRules) {
        throw new Error(t('previewHeadersUnsupported', undefined, '当前浏览器不支持预览请求补头'));
      }

      const requestHeaders = buildPreviewRequestHeaders(media);

      if (requestHeaders.length) {
        const condition = {
          regexFilter: `^${escapeRegex(media.resourceUrl)}$`,
          resourceTypes: ['media'],
        };
        if (typeof tabId === 'number' && tabId >= 0) condition.tabIds = [tabId];
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [ruleId],
          addRules: [{
            id: ruleId,
            priority: 1,
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
        };
      } else {
        delete previewRulesByTab[tabId];
      }
      return result;
    }

    async function prepareMetadataRule(media) {
      const ruleId = getMetadataRuleId(media);
      const result = await prepareHeaderRule(media, { ruleId });
      if (result.headersApplied.length && media?.id) {
        if (metadataRulesByMediaId[media.id]?.cleanupTimer) {
          clearTimeout(metadataRulesByMediaId[media.id].cleanupTimer);
        }
        const cleanupTimer = setTimeout(() => {
          clearMetadataRule(media.id);
        }, METADATA_RULE_TTL_MS);
        metadataRulesByMediaId[media.id] = {
          ruleId,
          resourceUrl: media.resourceUrl,
          cleanupTimer,
        };
      } else if (media?.id) {
        await clearMetadataRule(media.id);
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
        broadcastUpdate();
      }
    }

    function clearTabState(tabId) {
      for (const item of mediaResources[tabId] || []) {
        clearMetadataRule(item.id);
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
      broadcastUpdate();
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
      clearMetadataRule,
      clearPreviewRule,
      clearTabState,
      findMediaResourceById,
      getState,
      handleMediaResponse,
      hasMediaResource,
      isSniffingPaused,
      pauseSniffing,
      prepareMetadataRule,
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
