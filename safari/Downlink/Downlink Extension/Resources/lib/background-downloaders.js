(function initBackgroundDownloaders(global) {
  const t = global.Localization?.t || ((key, substitutions, fallback = key) => {
    if (fallback && substitutions !== undefined) {
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
    }
    return fallback || key;
  });
  const shared = global.BackgroundShared || {};
  const normalizeRequestHeaders = shared.normalizeRequestHeaders || ((headers) => headers || {});
  const deriveOrigin = shared.deriveOrigin || (() => '');
  const ensureFilenameExtension = shared.ensureFilenameExtension || ((filename) => filename);
  const mediaKindOf = shared.mediaKindOf || (() => '');
  const guessMediaExtension = shared.guessMediaExtension || (() => '');
  const extOf = shared.extOf || (() => '');
  const extensionFromMime = shared.extensionFromMime || (() => '');
  const streamProtocolOf = shared.streamProtocolOf || (() => '');
  const stripHash = shared.stripHash || ((url) => url || '');
  const buildContentDisposition = shared.buildContentDisposition || (() => '');
  const VIDEO_EXTENSIONS = shared.VIDEO_EXTENSIONS || new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', 'm4s']);
  const AUDIO_EXTENSIONS = shared.AUDIO_EXTENSIONS || new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4s']);

  const NEATDM_ENDPOINT = 'ws://127.0.0.1:10007/download';
  const NEATDM_PROTOCOL = 'neatextension.v1';
  const ARIA2_RPC_TIMEOUT_MS = 3000;
  const DOWNLOADERS = {
    aria2: { label: (cfg) => cfg.aria2Label || 'Aria2' },
    motrixnext: { label: () => 'Rayburst (Motrix Next)' },
    gopeed: { label: () => 'Gopeed' },
    abdownload: { label: () => 'AB DM' },
    neatdm: { label: () => 'NeatDM' },
  };

  function createClients({
    getConfig,
    notify,
    onBeforeAria2Send,
    onAria2TaskQueued,
    onGopeedTaskQueued,
    getPendingRayburstRequest,
    savePendingRayburstRequest,
    removePendingRayburstRequest,
    fetchRequest = fetch,
  }) {
    let rpcId = 1;
    const pendingRayburstMemory = new Map();
    const EXTERNAL_LAUNCHER_TIMEOUT_MS = 3000;
    const CONNECTION_FAILURE_NOTIFY_COOLDOWN_MS = 30000;
    const lastConnectionFailureNotifiedAt = {};

    function getDownloaderLabel(type = getConfig().downloaderType, cfg = getConfig()) {
      return DOWNLOADERS[type]?.label?.(cfg) || type;
    }

    function buildConnectionFailureText(label) {
      return t('connectionFailedWithLabel', [label], `与 ${label} 连接失败，检查 ${label} 是否正在运行`);
    }

    function notifyConnectionFailure(type) {
      const label = getDownloaderLabel(type);
      const now = Date.now();
      const lastNotifiedAt = lastConnectionFailureNotifiedAt[type] || 0;
      if (now - lastNotifiedAt >= CONNECTION_FAILURE_NOTIFY_COOLDOWN_MS) {
        lastConnectionFailureNotifiedAt[type] = now;
        notify(
          t('connectionFailedTitle', [label], `与 ${label} 连接失败`),
          t('connectionFailedBody', [label], `检查 ${label} 是否正在运行`)
        );
      }
      return buildConnectionFailureText(label);
    }

    function clearConnectionFailureNotificationCooldown(type) {
      delete lastConnectionFailureNotifiedAt[type];
    }

    function logRayburstCacheFailure(operation, error) {
      globalThis.writeProbeLog?.('Rayburst retry cache unavailable', {
        operation,
        error: error?.message || String(error || ''),
      });
    }

    async function readPendingRayburstRequest(fingerprint) {
      if (pendingRayburstMemory.has(fingerprint)) return pendingRayburstMemory.get(fingerprint);
      try {
        const request = await getPendingRayburstRequest?.(fingerprint);
        if (request) pendingRayburstMemory.set(fingerprint, request);
        return request || null;
      } catch (error) {
        logRayburstCacheFailure('read', error);
        return null;
      }
    }

    async function persistPendingRayburstRequest(fingerprint, request) {
      pendingRayburstMemory.set(fingerprint, request);
      try {
        await savePendingRayburstRequest?.(fingerprint, request);
      } catch (error) {
        logRayburstCacheFailure('write', error);
      }
    }

    async function clearPendingRayburstRequest(fingerprint) {
      pendingRayburstMemory.delete(fingerprint);
      try {
        await removePendingRayburstRequest?.(fingerprint);
      } catch (error) {
        logRayburstCacheFailure('remove', error);
      }
    }

    async function fetchWithTimeout(url, options = {}, timeoutMs = EXTERNAL_LAUNCHER_TIMEOUT_MS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetchRequest(url, {
          ...options,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    }

    async function httpError(response) {
      let detail = '';
      try {
        detail = String(await response.text()).trim().slice(0, 500);
      } catch {}
      return new Error(detail ? `HTTP ${response.status}: ${detail}` : `HTTP ${response.status}`);
    }

    function endpointForLog(value = '') {
      try {
        const endpoint = new URL(String(value || ''));
        endpoint.username = '';
        endpoint.password = '';
        endpoint.search = '';
        endpoint.hash = '';
        return endpoint.toString();
      } catch {
        return value ? '<configured endpoint>' : '';
      }
    }

    async function aria2Call(method, params = [], overrideConfig) {
      const config = overrideConfig || getConfig();
      const secret = config.aria2Secret ? `token:${config.aria2Secret}` : undefined;
      const logUrl = endpointForLog(config.aria2Rpc);
      try {
        const res = await fetchWithTimeout(config.aria2Rpc, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: String(rpcId++),
            method: `aria2.${method}`,
            params: secret ? [secret, ...params] : params,
          }),
        }, ARIA2_RPC_TIMEOUT_MS);
        if (!res.ok) {
          const probe = globalThis.writeProbeLog;
          if (probe) probe('aria2 http error', { method, status: res.status, url: logUrl });
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.error) {
          const probe = globalThis.writeProbeLog;
          if (probe) probe('aria2 rpc error', { method, error: data.error });
          throw new Error(data.error.message);
        }
        return data.result;
      } catch (error) {
        const probe = globalThis.writeProbeLog;
        if (probe) probe('aria2 call failed', { method, url: logUrl, message: error?.message || String(error), stack: error?.stack || '' });
        throw error;
      }
    }

    async function getAria2GlobalStat(overrideConfig) {
      return aria2Call('getGlobalStat', [], overrideConfig);
    }

    async function getAria2Status(gid) {
      return aria2Call('tellStatus', [gid]);
    }

    async function getGopeedTasks(overrideConfig) {
      return gopeedRequest('/api/v1/tasks', overrideConfig, { method: 'GET' });
    }

    async function addUriToAria2(url, filename, headers = {}, extraOpts = {}) {
      const config = getConfig();
      const opts = {};
      if (filename) opts.out = filename;
      const headerLines = [];
      ['cookie', 'referer', 'origin', 'authorization', 'user-agent'].forEach((key) => {
        if (headers[key]) headerLines.push(`${key}: ${headers[key]}`);
      });
      if (headerLines.length) opts.header = headerLines;
      Object.assign(opts, extraOpts);
      if (
        !opts['bt-tracker'] &&
        /^magnet:/i.test(String(url || '').trim()) &&
        Array.isArray(config.aria2Trackers) &&
        config.aria2Trackers.length
      ) {
        opts['bt-tracker'] = config.aria2Trackers.join(',');
      }
      return aria2Call('addUri', [[url], opts]);
    }

    function getAbDownloadPath(extraOpts = {}, overrideConfig) {
      if (extraOpts.abDownloadMode === 'headless') return '/start-headless-download';
      if (extraOpts.abDownloadMode === 'add') return '/add';
      const config = overrideConfig || getConfig();
      return config.abDownloadSilent ? '/start-headless-download' : '/add';
    }

    function buildExternalEndpoint(overrideConfig, pathOverride) {
      const config = overrideConfig || getConfig();
      const host = (config.externalLauncherHost || 'localhost').trim() || 'localhost';
      const port = String(config.externalLauncherPort || '15151').trim() || '15151';
      const path = String(pathOverride || config.externalLauncherPath || '/start-headless-download').trim() || '/start-headless-download';
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      return `http://${host}:${port}${normalizedPath}`;
    }

    function buildMotrixNextEndpoint(overrideConfig, pathOverride = '/add') {
      const config = overrideConfig || getConfig();
      const port = String(config.motrixNextPort || '29110').trim() || '29110';
      const path = String(pathOverride || '/add').trim() || '/add';
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      return `http://127.0.0.1:${port}${normalizedPath}`;
    }

    function buildGopeedEndpoint(overrideConfig, pathOverride = '/api/v1/tasks') {
      const config = overrideConfig || getConfig();
      const api = String(config.gopeedApi || 'http://127.0.0.1:9999').trim() || 'http://127.0.0.1:9999';
      const normalizedApi = api.replace(/\/+$/, '');
      const path = String(pathOverride || '/api/v1/tasks').trim() || '/api/v1/tasks';
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      return `${normalizedApi}${normalizedPath}`;
    }

    function buildAbDownloadRequest(taskInfo, extraOpts = {}) {
      const config = getConfig();
      const path = getAbDownloadPath(extraOpts, config);
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      const folder = extraOpts.dir || '';
      const downloadPage = taskInfo.downloadPage || taskInfo.referrer || '';
      const streamProtocol = taskInfo.streamProtocol || streamProtocolOf(taskInfo.url, taskInfo.mime, taskInfo.filename);
      const isHls = streamProtocol === 'hls';
      const headers = isHls
        ? buildStreamingRequestHeaders(taskInfo)
        : normalizeRequestHeaders(taskInfo.headers || {});

      if (normalizedPath === '/add') {
        const payload = { link: taskInfo.url || '' };
        if (Object.keys(headers).length) payload.headers = headers;
        if (downloadPage) payload.downloadPage = downloadPage;
        return [payload];
      }

      const payload = {
        downloadSource: {
          link: taskInfo.url || '',
        },
      };
      if (isHls) {
        payload.downloadSource.type = 'hls';
        payload.startDownload = true;
      }
      if (Object.keys(headers).length) payload.downloadSource.headers = headers;
      if (downloadPage) payload.downloadSource.downloadPage = downloadPage;
      if (folder) payload.folder = folder;
      if (taskInfo.filename) {
        payload.name = isHls
          ? taskInfo.filename.replace(/(?:\.[^.]+)?$/, '.ts')
          : taskInfo.filename;
      }
      if (typeof extraOpts.queueId === 'number') payload.queueId = extraOpts.queueId;
      return payload;
    }

    function buildAbDownloadFallbackRequest(taskInfo) {
      return {
        downloadSource: {
          link: taskInfo.url || '',
        },
      };
    }

    async function sendToExternalLauncher(taskInfo, extraOpts = {}) {
      const streamProtocol = taskInfo.streamProtocol || streamProtocolOf(taskInfo.url, taskInfo.mime, taskInfo.filename);
      if (streamProtocol && streamProtocol !== 'hls') {
        return {
          ok: false,
          unsupported: true,
          error: `AB DM 暂不支持 ${streamProtocol.toUpperCase()} 流媒体下载`,
        };
      }
      if (streamProtocol === 'hls' && taskInfo.isLive === true) {
        return {
          ok: false,
          unsupported: true,
          error: 'AB DM 暂不支持直播 HLS 录制',
        };
      }
      try {
        const effectiveOpts = streamProtocol === 'hls'
          ? { ...extraOpts, abDownloadMode: 'headless' }
          : extraOpts;
        const path = getAbDownloadPath(effectiveOpts);
        const endpoint = buildExternalEndpoint(undefined, path);
        const payload = buildAbDownloadRequest(taskInfo, effectiveOpts);
        let res = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok && res.status === 500 && endpoint.endsWith('/start-headless-download') && streamProtocol !== 'hls') {
          res = await fetchWithTimeout(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildAbDownloadFallbackRequest(taskInfo)),
          });
        }
        if (!res.ok && streamProtocol === 'hls') {
          const status = res.status;
          if ([400, 415, 422].includes(status)) {
            return {
              ok: false,
              unsupported: true,
              error: `AB DM 未接受 HLS 任务（HTTP ${status}）；请确认使用 1.7.0 或更高版本，以及非加密、TS 分片的媒体清单`,
            };
          }
          if (status === 401 || status === 403) {
            return {
              ok: false,
              actionable: true,
              error: `AB DM 拒绝访问（HTTP ${status}），请检查 API 密钥或访问配置`,
            };
          }
          if (status === 404) {
            return {
              ok: false,
              actionable: true,
              error: 'AB DM HLS 接口不存在（HTTP 404），请检查服务地址和 AB DM 版本',
            };
          }
          return {
            ok: false,
            actionable: true,
            error: `AB DM 处理 HLS 任务失败（HTTP ${status}）`,
          };
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        clearConnectionFailureNotificationCooldown('abdownload');
        return { ok: true };
      } catch (err) {
        const message = notifyConnectionFailure('abdownload');
        return { ok: false, error: message };
      }
    }

    function sanitizeRayburstHeaderValue(value) {
      return String(value ?? '').replace(/[\u0000-\u0008\u000a-\u001f\u007f]/g, ' ').trim();
    }

    function rayburstHttpUrl(value) {
      const text = String(value || '').trim();
      if (!text || text.length > 16384) return '';
      try {
        const parsed = new URL(text);
        return ['http:', 'https:'].includes(parsed.protocol) && !parsed.username && !parsed.password
          ? parsed.href
          : '';
      } catch {
        return '';
      }
    }

    function truncateRayburstUtf16(value, limit) {
      let result = '';
      let units = 0;
      for (const character of String(value || '')) {
        const next = character.length;
        if (units + next > limit) break;
        result += character;
        units += next;
      }
      return result;
    }

    function rayburstByteLength(value) {
      const text = String(value || '');
      if (globalThis.TextEncoder) return new TextEncoder().encode(text).length;
      return unescape(encodeURIComponent(text)).length;
    }

    function buildRayburstRequestHeaders(headers, pageUrl = '') {
      const allowedHeaders = new Set([
        'accept', 'accept-language', 'authorization', 'cookie', 'dnt', 'origin', 'referer',
        'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'sec-fetch-dest',
        'sec-fetch-mode', 'sec-fetch-site', 'user-agent',
      ]);
      const normalized = normalizeRequestHeaders(headers || {});
      const result = [];
      const names = new Set();
      let totalBytes = 0;
      const append = (rawName, rawValue) => {
        const name = String(rawName || '').toLowerCase();
        const value = sanitizeRayburstHeaderValue(rawValue);
        const bytes = rayburstByteLength(name) + rayburstByteLength(value);
        if (!value || !allowedHeaders.has(name) || names.has(name) || result.length >= 32
          || rayburstByteLength(name) > 128 || rayburstByteLength(value) > 8192
          || totalBytes + bytes > 16384) return;
        names.add(name);
        totalBytes += bytes;
        result.push({ name, value });
      };
      Object.entries(normalized).forEach(([name, value]) => append(name, value));
      if (!names.has('referer')) append('referer', pageUrl);
      return result;
    }

    function rayburstPageUrl(taskInfo = {}) {
      const headers = normalizeRequestHeaders(taskInfo.headers || {});
      const candidates = [
        stripHash(taskInfo.downloadPage || ''),
        stripHash(taskInfo.referrer || ''),
        stripHash(headers.referer || ''),
        deriveOrigin(taskInfo.url, ''),
      ];
      return candidates.map(rayburstHttpUrl).find(Boolean) || '';
    }

    function buildMotrixNextRequest(taskInfo, id) {
      const headers = normalizeRequestHeaders(taskInfo.headers || {});
      const payload = { id, url: taskInfo.url || '' };
      const referer = taskInfo.referrer || taskInfo.downloadPage || headers.referer || '';
      const cookie = headers.cookie || '';
      const userAgent = headers['user-agent'] || '';
      const allowedHeaders = new Set([
        'accept', 'accept-language', 'dnt', 'origin', 'sec-ch-ua', 'sec-ch-ua-mobile',
        'sec-ch-ua-platform', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site',
        'sec-fetch-user', 'upgrade-insecure-requests',
      ]);
      const requestHeaders = Object.entries(headers)
        .map(([name, value]) => ({ name: String(name).toLowerCase(), value: sanitizeRayburstHeaderValue(value) }))
        .filter(({ name, value }) => value && allowedHeaders.has(name));
      if (taskInfo.finalUrl && taskInfo.finalUrl !== taskInfo.url) payload.finalUrl = taskInfo.finalUrl;
      if (taskInfo.filename) {
        payload.filename = taskInfo.filename;
        payload.filenameSource = taskInfo.captureSource === 'browser-download' ? 'browser' : 'suggested';
      }
      if (referer) payload.referer = sanitizeRayburstHeaderValue(referer);
      if (cookie) payload.cookie = sanitizeRayburstHeaderValue(cookie);
      if (userAgent) payload.userAgent = sanitizeRayburstHeaderValue(userAgent);
      if (requestHeaders.length) payload.requestHeaders = requestHeaders;
      return payload;
    }

    function buildRayburstMediaHeaders(config) {
      const headers = {
        'Content-Type': 'application/json',
        'X-Rayburst-Client': 'rayburst-connect',
      };
      if (config.motrixNextSecret) headers.Authorization = `Bearer ${config.motrixNextSecret}`;
      return headers;
    }

    function buildRayburstMediaRequest(taskInfo, id, protocol) {
      const sourceUrl = rayburstHttpUrl(taskInfo.url);
      const pageUrl = rayburstPageUrl(taskInfo) || (() => {
        try { return sourceUrl ? new URL(sourceUrl).origin : ''; } catch { return ''; }
      })();
      const filename = truncateRayburstUtf16(taskInfo.filename || '', 255);
      const requestHeaders = buildRayburstRequestHeaders(taskInfo.headers, pageUrl);
      return {
        id,
        source: {
          url: sourceUrl,
          kind: protocol,
          pageUrl,
          // Rayburst prefers title over filename as its output hint. When the
          // list has an explicit (possibly edited) filename, let it win.
          title: filename ? '' : truncateRayburstUtf16(taskInfo.pageTitle || '', 512),
          filename,
          mime: truncateRayburstUtf16(taskInfo.mime || '', 128),
          requestContexts: [{ url: sourceUrl, headers: requestHeaders }],
          input: { manifests: [], tracks: [], keys: [] },
        },
      };
    }

    function buildRayburstCollectionRequest(taskInfos, id, filename = '') {
      const requestContextsByOrigin = new Map();
      const tracks = taskInfos.map((taskInfo, index) => {
        const contextUrl = rayburstHttpUrl(taskInfo.url);
        if (!contextUrl) throw new Error('unsupported_source: invalid_http_url');
        const pageUrl = rayburstPageUrl(taskInfo) || new URL(contextUrl).origin;
        const scopedHeaders = buildRayburstRequestHeaders(taskInfo.headers, pageUrl);
        const contextOrigin = new URL(contextUrl).origin;
        const existingContext = requestContextsByOrigin.get(contextOrigin);
        if (existingContext) {
          const merged = Object.fromEntries([
            ...scopedHeaders.map((header) => [header.name, header.value]),
            ...existingContext.headers.map((header) => [header.name, header.value]),
          ]);
          existingContext.headers = buildRayburstRequestHeaders(merged, pageUrl);
        } else {
          requestContextsByOrigin.set(contextOrigin, { url: contextUrl, headers: scopedHeaders });
        }
        return {
          id: `downlink-${taskInfo.rayburstTrackType}-${index + 1}`,
          type: taskInfo.rayburstTrackType,
          urls: [taskInfo.url || ''],
        };
      });
      const first = taskInfos[0] || {};
      const firstTrackUrl = tracks[0]?.urls?.[0] || '';
      const pageUrl = rayburstPageUrl(first) || new URL(firstTrackUrl).origin;
      return {
        id,
        source: {
          url: `https://rayburst.invalid/collection/${id}`,
          kind: 'collection',
          pageUrl,
          title: filename ? '' : truncateRayburstUtf16(first.pageTitle || '', 512),
          filename: truncateRayburstUtf16(filename, 255),
          mime: '',
          requestContexts: Array.from(requestContextsByOrigin.values()),
          input: { manifests: [], tracks, keys: [] },
        },
      };
    }

    function newRayburstMediaId() {
      return globalThis.crypto?.randomUUID?.()
        || `00000000-0000-4000-8000-${Math.random().toString(16).slice(2).padEnd(12, '0').slice(0, 12)}`;
    }

    function rayburstMediaFingerprint(taskInfo, protocol) {
      const request = taskInfo.rayburstMediaRequest
        ? { ...taskInfo.rayburstMediaRequest, id: '' }
        : buildRayburstMediaRequest(taskInfo, '', protocol);
      if (protocol === 'collection' && request.source) {
        request.source = { ...request.source, url: 'https://rayburst.invalid/collection' };
      }
      return `media:${JSON.stringify(request)}`;
    }

    async function getOrCreateRayburstMediaRequest(taskInfo, protocol) {
      const fingerprint = rayburstMediaFingerprint(taskInfo, protocol);
      const saved = await readPendingRayburstRequest(fingerprint);
      const sourceUrl = taskInfo.rayburstMediaRequest?.source?.url || taskInfo.url;
      if (saved?.id && saved?.submissionId
        && (saved?.source?.url === sourceUrl || (protocol === 'collection' && saved?.source?.kind === 'collection'))) {
        return { fingerprint, request: saved };
      }
      const request = {
        ...(taskInfo.rayburstMediaRequest || buildRayburstMediaRequest(taskInfo, newRayburstMediaId(), protocol)),
        submissionId: newRayburstMediaId(),
      };
      await persistPendingRayburstRequest(fingerprint, request);
      return { fingerprint, request };
    }

    async function sendMediaToRayburst(taskInfo, protocol, overrideConfig) {
      const config = { ...getConfig(), ...(overrideConfig || {}) };
      if (!String(config.motrixNextSecret || '').trim()) {
        throw new Error('Rayburst 媒体 API 要求配置扩展 API 密钥；普通下载成功不代表媒体 API 已授权');
      }
      const headers = buildRayburstMediaHeaders(config);
      const basePath = '/media/v2';
      const capabilitiesRes = await fetchWithTimeout(
        buildMotrixNextEndpoint(config, `${basePath}/capabilities`),
        { method: 'GET', headers },
      );
      if (!capabilitiesRes.ok) throw await httpError(capabilitiesRes);
      const capabilities = await capabilitiesRes.json();
      if (capabilities?.product !== 'rayburst'
        || capabilities?.protocolVersion !== 2
        || !capabilities?.sourceKinds?.includes(protocol)
        || capabilities?.requestContexts !== true) {
        throw new Error('Unsupported Rayburst media protocol');
      }

      const { fingerprint, request } = await getOrCreateRayburstMediaRequest(taskInfo, protocol);
      const { id, submissionId } = request;
      if (!rayburstHttpUrl(request?.source?.url) || !rayburstHttpUrl(request?.source?.pageUrl)
        || !Array.isArray(request?.source?.requestContexts)
        || request.source.requestContexts.some((context) => !rayburstHttpUrl(context?.url))) {
        await clearPendingRayburstRequest(fingerprint);
        throw new Error('unsupported_source: invalid_http_url');
      }
      const probeRequest = { id, source: request.source };
      const createRes = await fetchWithTimeout(buildMotrixNextEndpoint(config, `${basePath}/probes`), {
        method: 'POST', headers, body: JSON.stringify(probeRequest),
      });
      if (!createRes.ok) throw await httpError(createRes);
      let probe = await createRes.json();
      if (probe?.state === 'submitted') {
        if (probe?.id !== id || probe?.submissionId !== submissionId || !probe?.gid) {
          throw new Error('Invalid Rayburst media receipt');
        }
        await clearPendingRayburstRequest(fingerprint);
        clearConnectionFailureNotificationCooldown('motrixnext');
        return { ok: true, gid: probe.gid, media: true };
      }
      for (let attempt = 0; probe?.state === 'probing' && attempt < 80; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const statusRes = await fetchWithTimeout(buildMotrixNextEndpoint(config, `${basePath}/probes/${id}`), {
          method: 'GET', headers,
        });
        if (!statusRes.ok) throw await httpError(statusRes);
        probe = await statusRes.json();
      }
      if (probe?.state === 'probing') {
        return { ok: false, pending: true, error: 'Rayburst 仍在解析媒体，请稍后重试' };
      }
      if (probe?.state === 'failed' || probe?.state === 'cancelled') {
        await clearPendingRayburstRequest(fingerprint);
      }
      if (probe?.state !== 'ready' || !probe?.presentation?.defaults) {
        throw new Error(probe?.error || 'Rayburst media probe did not become ready');
      }
      let selection = probe.presentation.defaults;
      if (taskInfo.rayburstSelection) {
        const formats = Array.isArray(probe.presentation.formats) ? probe.presentation.formats : [];
        const requestedFormat = taskInfo.rayburstSelection.format;
        selection = {
          ...probe.presentation.defaults,
          format: formats.includes(requestedFormat)
            ? requestedFormat
            : probe.presentation.defaults.format,
        };
      }
      const submitRes = await fetchWithTimeout(buildMotrixNextEndpoint(config, `${basePath}/probes/${id}/submit`), {
        method: 'POST',
        headers,
        body: JSON.stringify({ submissionId, selection }),
      }, 5000);
      if (!submitRes.ok) throw await httpError(submitRes);
      const receipt = await submitRes.json();
      if (receipt?.id !== id || receipt?.submissionId !== submissionId || !receipt?.gid) {
        throw new Error('Invalid Rayburst media receipt');
      }
      await clearPendingRayburstRequest(fingerprint);
      clearConnectionFailureNotificationCooldown('motrixnext');
      notify(t('sentToLabel', [getDownloaderLabel('motrixnext')], `已发送到 ${getDownloaderLabel('motrixnext')}`), taskInfo.filename || taskInfo.url.slice(0, 80));
      return { ok: true, gid: receipt.gid, media: true };
    }

    async function sendRayburstCollection(taskInfos, filename, format = 'mp4', overrideConfig) {
      if (!Array.isArray(taskInfos) || taskInfos.length !== 2) {
        return { ok: false, unsupported: true, error: '请选择一条视频和一条音频进行合并' };
      }
      const trackTypes = taskInfos.map((item) => item.rayburstTrackType).sort();
      if (trackTypes[0] !== 'audio' || trackTypes[1] !== 'video') {
        return { ok: false, unsupported: true, error: '所选资源必须包含一条可识别的视频和一条音频' };
      }
      try {
        const collectionId = newRayburstMediaId();
        const request = buildRayburstCollectionRequest(taskInfos, collectionId, filename);
        const videoId = request.source.input.tracks.find((track) => track.type === 'video')?.id;
        const audioId = request.source.input.tracks.find((track) => track.type === 'audio')?.id;
        return await sendMediaToRayburst({
          ...taskInfos[0],
          url: request.source.url,
          filename,
          rayburstMediaRequest: request,
          rayburstSelection: {
            videoId,
            audioId,
            subtitleId: null,
            format: format === 'mkv' ? 'mkv' : 'mp4',
          },
        }, 'collection', overrideConfig);
      } catch (err) {
        const detail = err?.message || String(err || '');
        if (detail.includes('unsupported_selection')) {
          return {
            ok: false,
            unsupported: true,
            actionable: true,
            error: 'Rayburst 拒绝了探测后生成的默认音视频组合，请确认所选资源可单独播放且未受 DRM 保护',
          };
        }
        if (detail.includes('unsupported_source')) {
          return {
            ok: false,
            unsupported: true,
            actionable: true,
            error: 'Rayburst 无法解析所选媒体源，请确认音频和视频均为可访问的 HTTP(S) 直链',
          };
        }
        const message = notifyConnectionFailure('motrixnext');
        return { ok: false, error: detail ? `${message}：${detail}` : message };
      }
    }

    function rayburstRequestFingerprint(taskInfo) {
      return JSON.stringify(buildMotrixNextRequest(taskInfo, ''));
    }

    async function getOrCreateRayburstRequest(taskInfo) {
      const fingerprint = rayburstRequestFingerprint(taskInfo);
      const saved = await readPendingRayburstRequest(fingerprint);
      if (saved?.id && saved?.url === taskInfo.url) return { fingerprint, request: saved };
      const id = globalThis.crypto?.randomUUID?.()
        || `downlink-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const request = buildMotrixNextRequest(taskInfo, id);
      await persistPendingRayburstRequest(fingerprint, request);
      return { fingerprint, request };
    }

    async function sendToMotrixNext(taskInfo, overrideConfig) {
      try {
        const streamProtocol = taskInfo.streamProtocol || streamProtocolOf(taskInfo.url, taskInfo.mime, taskInfo.filename);
        if (streamProtocol) return await sendMediaToRayburst(taskInfo, streamProtocol, overrideConfig);
        const config = { ...getConfig(), ...(overrideConfig || {}) };
        const endpoint = buildMotrixNextEndpoint(config, '/add');
        const headers = {
          'Content-Type': 'application/json',
          'X-Rayburst-Client': 'rayburst-connect',
        };
        if (config.motrixNextSecret) {
          headers.Authorization = `Bearer ${config.motrixNextSecret}`;
        }
        const capabilitiesRes = await fetchWithTimeout(
          buildMotrixNextEndpoint(config, '/downloads/capabilities'),
          { method: 'GET', headers },
        );
        if (!capabilitiesRes.ok) throw new Error(`HTTP ${capabilitiesRes.status}`);
        const capabilities = await capabilitiesRes.json();
        if (capabilities?.product !== 'rayburst' || capabilities?.protocolVersion !== 2 || capabilities?.filenameHints !== true) {
          throw new Error('Unsupported Rayburst download protocol');
        }
        const { fingerprint, request } = await getOrCreateRayburstRequest(taskInfo);
        const res = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(request),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const receipt = await res.json();
        if (receipt?.id !== request.id || !['submitted', 'needs-confirmation', 'cancelled'].includes(receipt?.action)) {
          throw new Error('Invalid Rayburst download receipt');
        }
        if (receipt.action === 'submitted' && !receipt.gid) throw new Error('Missing Rayburst task id');
        await clearPendingRayburstRequest(fingerprint);
        clearConnectionFailureNotificationCooldown('motrixnext');
        if (receipt.action === 'cancelled') {
          return { ok: false, cancelled: true, error: 'Rayburst 已取消下载' };
        }
        if (receipt.action === 'needs-confirmation') {
          notify('Rayburst 等待确认', taskInfo.filename || taskInfo.url.slice(0, 80));
          return { ok: true, pending: true, action: receipt.action };
        }
        notify(t('sentToLabel', [getDownloaderLabel('motrixnext')], `已发送到 ${getDownloaderLabel('motrixnext')}`), taskInfo.filename || taskInfo.url.slice(0, 80));
        return { ok: true, gid: receipt.gid, action: receipt.action };
      } catch (err) {
        const message = notifyConnectionFailure('motrixnext');
        const detail = err?.message || String(err || '');
        const probe = globalThis.writeProbeLog;
        if (probe) probe('Rayburst send failed', {
          url: endpointForLog(taskInfo.url),
          streamProtocol: taskInfo.streamProtocol || streamProtocolOf(taskInfo.url, taskInfo.mime, taskInfo.filename),
          error: detail,
        });
        return { ok: false, error: detail ? `${message}：${detail}` : message };
      }
    }

    async function testMotrixNextConnection(overrideConfig) {
      try {
        const pingEndpoint = buildMotrixNextEndpoint(overrideConfig, '/ping');
        const statEndpoint = buildMotrixNextEndpoint(overrideConfig, '/stat');
        const capabilitiesEndpoint = buildMotrixNextEndpoint(overrideConfig, '/downloads/capabilities');
        const headers = { 'X-Rayburst-Client': 'rayburst-connect' };
        if (overrideConfig?.motrixNextSecret) {
          headers.Authorization = `Bearer ${overrideConfig.motrixNextSecret}`;
        }
        const pingRes = await fetchWithTimeout(pingEndpoint, { method: 'GET' }, EXTERNAL_LAUNCHER_TIMEOUT_MS);
        if (!pingRes.ok) throw new Error(`HTTP ${pingRes.status}`);
        const ping = await pingRes.json();
        if (ping?.product !== 'rayburst' || ping?.status !== 'ok' || !ping?.version) throw new Error('Unsupported product');
        const statRes = await fetchWithTimeout(statEndpoint, { headers }, EXTERNAL_LAUNCHER_TIMEOUT_MS);
        if (!statRes.ok) throw new Error(`HTTP ${statRes.status}`);
        const capabilitiesRes = await fetchWithTimeout(capabilitiesEndpoint, { headers }, EXTERNAL_LAUNCHER_TIMEOUT_MS);
        if (!capabilitiesRes.ok) throw new Error(`HTTP ${capabilitiesRes.status}`);
        const capabilities = await capabilitiesRes.json();
        if (capabilities?.product !== 'rayburst' || capabilities?.protocolVersion !== 2 || capabilities?.filenameHints !== true) {
          throw new Error('Unsupported protocol');
        }
        return { ok: true, mode: 'motrixnext', message: t('connectedToEndpoint', [pingEndpoint], `已连接 ${pingEndpoint}`) };
      } catch {
        return { ok: false, mode: 'motrixnext', error: buildConnectionFailureText('MotrixNext') };
      }
    }

    function buildGopeedHeaders(taskInfo) {
      const headers = normalizeRequestHeaders(taskInfo.headers || {});
      const blockedHeaders = new Set([
        'accept-encoding',
        'connection',
        'content-length',
        'host',
        'if-range',
        'range',
      ]);
      for (const key of blockedHeaders) delete headers[key];
      if (!headers.referer && (taskInfo.referrer || taskInfo.downloadPage)) {
        headers.referer = taskInfo.referrer || taskInfo.downloadPage;
      }
      if (!headers['content-type'] && taskInfo.mime) headers['content-type'] = taskInfo.mime;
      if (!headers['content-disposition'] && taskInfo.contentDisposition) {
        headers['content-disposition'] = taskInfo.contentDisposition;
      }
      headers['accept-encoding'] = 'identity';
      return headers;
    }

    function getGopeedStreamProtocol(taskInfo = {}) {
      return taskInfo.streamProtocol || streamProtocolOf(taskInfo.url, taskInfo.mime, taskInfo.filename);
    }

    function buildStreamingRequestHeaders(taskInfo) {
      const headers = normalizeRequestHeaders(taskInfo.headers || {});
      const allowedNames = new Set([
        'accept',
        'accept-language',
        'authorization',
        'cookie',
        'dnt',
        'origin',
        'referer',
        'sec-ch-ua',
        'sec-ch-ua-mobile',
        'sec-ch-ua-platform',
        'sec-fetch-dest',
        'sec-fetch-mode',
        'sec-fetch-site',
        'user-agent',
      ]);
      const forwarded = {};
      for (const [name, value] of Object.entries(headers)) {
        const normalizedName = String(name).toLowerCase();
        if (!allowedNames.has(normalizedName) && !normalizedName.startsWith('x-')) continue;
        const sanitizedValue = sanitizeRayburstHeaderValue(value);
        if (sanitizedValue) forwarded[normalizedName] = sanitizedValue;
      }
      if (!forwarded.referer && (taskInfo.referrer || taskInfo.downloadPage)) {
        forwarded.referer = sanitizeRayburstHeaderValue(taskInfo.referrer || taskInfo.downloadPage);
      }
      return forwarded;
    }

    function getGopeedStreamUnsupportedReason(taskInfo = {}) {
      const protocol = getGopeedStreamProtocol(taskInfo);
      if (!protocol) return '';
      if (protocol !== 'hls') return `Gopeed 暂不支持 ${protocol.toUpperCase()} 流媒体下载`;
      if (extOf(taskInfo.url || '') !== 'm3u8') {
        return 'Gopeed 原生 HLS 当前要求清单 URL 以 .m3u8 结尾';
      }
      return '';
    }

    function buildGopeedRequest(taskInfo, extraOpts = {}) {
      const isHls = getGopeedStreamProtocol(taskInfo) === 'hls';
      const requestHeaders = isHls ? buildStreamingRequestHeaders(taskInfo) : buildGopeedHeaders(taskInfo);
      const payload = {
        req: {
          url: taskInfo.url || '',
          extra: {
            header: requestHeaders,
          },
        },
      };
      if (taskInfo.method && String(taskInfo.method).toUpperCase() !== 'GET') {
        payload.req.extra.method = String(taskInfo.method).toUpperCase();
      }
      if (typeof taskInfo.body === 'string' && taskInfo.body) {
        payload.req.extra.body = taskInfo.body;
      }
      if (taskInfo.labels && typeof taskInfo.labels === 'object') {
        payload.req.labels = taskInfo.labels;
      }
      if ((!isHls && taskInfo.filename) || extraOpts.gopeedSingleThread) {
        payload.opts = {};
        if (!isHls && taskInfo.filename) payload.opts.name = taskInfo.filename;
        if (extraOpts.gopeedSingleThread) {
          payload.opts.extra = { connections: 1 };
        }
      }
      return payload;
    }

    async function gopeedRequest(path, overrideConfig, options = {}) {
      const config = overrideConfig || getConfig();
      const headers = { ...(options.headers || {}) };
      if (config.gopeedToken) headers['X-Api-Token'] = config.gopeedToken;
      const res = await fetchWithTimeout(buildGopeedEndpoint(config, path), {
        ...options,
        headers,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data?.code !== 0) throw new Error(data?.msg || `Gopeed error ${data?.code ?? ''}`.trim());
      return data.data;
    }

    async function sendToGopeed(taskInfo, extraOpts = {}) {
      const unsupportedReason = getGopeedStreamUnsupportedReason(taskInfo);
      if (unsupportedReason) return { ok: false, unsupported: true, error: unsupportedReason };
      try {
        const data = await gopeedRequest('/api/v1/tasks', undefined, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildGopeedRequest(taskInfo, extraOpts)),
        });
        const gid = (typeof data === 'string' && data) || data?.id || `gopeed_${Date.now()}_${Math.random().toString(36).slice(2)}`;
        onGopeedTaskQueued?.(gid, taskInfo);
        clearConnectionFailureNotificationCooldown('gopeed');
        notify(t('sentToLabel', [getDownloaderLabel('gopeed')], `已发送到 ${getDownloaderLabel('gopeed')}`), taskInfo.filename || taskInfo.url.slice(0, 80));
        return { ok: true, gid };
      } catch (err) {
        const message = notifyConnectionFailure('gopeed');
        return { ok: false, error: message };
      }
    }

    async function testGopeedConnection(overrideConfig) {
      try {
        const endpoint = buildGopeedEndpoint(overrideConfig, '/api/v1/info');
        await gopeedRequest('/api/v1/info', overrideConfig, { method: 'GET' });
        return { ok: true, mode: 'gopeed', message: t('connectedToEndpoint', [endpoint], `已连接 ${endpoint}`) };
      } catch {
        return { ok: false, mode: 'gopeed', error: buildConnectionFailureText('Gopeed') };
      }
    }

    function getNeatdmMode(taskInfo = {}) {
      if (taskInfo.neatdmMode) return String(taskInfo.neatdmMode);
      if (taskInfo.streamProtocol === 'hls') return 'hls';
      const url = taskInfo.url || '';
      const mime = taskInfo.mime || '';
      const kind = taskInfo.kind || mediaKindOf(url, mime, taskInfo.filename || '');
      const extension = guessMediaExtension(url, mime);
      if (extension === 'm3u8') return 'hls';
      if (kind === 'video' || kind === 'audio' || kind === 'media') return 'media';
      return 'normal';
    }

    function buildNeatdmMessage(taskInfo) {
      const headers = normalizeRequestHeaders(taskInfo.headers || {});
      const pageUrl = stripHash(taskInfo.downloadPage || taskInfo.referrer || '');
      const contentType = headers['content-type'] || taskInfo.mime || '';
      const cookies = headers.cookie || '';
      const mode = getNeatdmMode(taskInfo);

      const originalFileExt = extOf(taskInfo.filename || '');
      const hadMediaExt = originalFileExt && (VIDEO_EXTENSIONS.has(originalFileExt) || AUDIO_EXTENSIONS.has(originalFileExt));
      const hadHlsManifestExt = mode === 'hls' && originalFileExt === 'm3u8';
      const removedOutputExt = hadMediaExt || hadHlsManifestExt;
      let filename = taskInfo.filename || '';
      if (removedOutputExt) {
        filename = filename.replace(/\.[^.]+$/, '');
      }

      const contentDisposition = taskInfo.contentDisposition || headers['content-disposition'] || buildContentDisposition(filename || '');
      const lines = [
        '1:GET',
        `2:${taskInfo.url || ''}`,
        `6:${mode}`,
        `4:${filename}`,
      ];

      const origin = headers.origin || (mode === 'hls' ? '' : taskInfo.origin || deriveOrigin(taskInfo.url, pageUrl));
      const referer = pageUrl;
      const downloadPage = pageUrl;
      const mime = contentType || 'application/octet-stream';
      const size = taskInfo.size ? String(taskInfo.size) : '';

      console.log('[NeatDM] Build message:', {
        originalFilename: taskInfo.filename,
        sentFilename: filename,
        removedExt: removedOutputExt
      });

      if (origin) lines.push(`Origin: ${origin}`);
      if (referer) lines.push(`Referer: ${referer}`);
      if (downloadPage) lines.push(`5:${downloadPage}`);
      if (cookies) lines.push(`Cookie: ${cookies}`);
      if (!removedOutputExt && contentType) lines.push(`Content-Type: ${contentType}`);
      if (!removedOutputExt && contentDisposition) lines.push(`Content-Disposition: ${contentDisposition}`);
      if (!removedOutputExt && mime) lines.push(`8:${mime}`);
      if (size) lines.push(`7:${size}`);
      const forwardedHeaderNames = new Map([
        ['accept', 'Accept'],
        ['accept-language', 'Accept-Language'],
        ['authorization', 'Authorization'],
        ['dnt', 'DNT'],
        ['sec-ch-ua', 'Sec-CH-UA'],
        ['sec-ch-ua-mobile', 'Sec-CH-UA-Mobile'],
        ['sec-ch-ua-platform', 'Sec-CH-UA-Platform'],
        ['sec-fetch-dest', 'Sec-Fetch-Dest'],
        ['sec-fetch-mode', 'Sec-Fetch-Mode'],
        ['sec-fetch-site', 'Sec-Fetch-Site'],
        ['user-agent', 'User-Agent'],
      ]);
      for (const [key, value] of Object.entries(headers)) {
        if (!value) continue;
        const normalizedName = String(key).toLowerCase();
        const forwardedName = forwardedHeaderNames.get(normalizedName)
          || (normalizedName.startsWith('x-') ? normalizedName : '');
        if (!forwardedName) continue;
        lines.push(`${forwardedName}: ${sanitizeRayburstHeaderValue(value)}`);
      }

      const message = `${lines.join('\r\n')}\r\n`;
      console.log('[NeatDM] Full message:\n' + message);
      return message;
    }

    function openNeatdmSocket() {
      return new Promise((resolve, reject) => {
        let settled = false;
        let socket;
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          handler(value);
        };
        const timer = setTimeout(() => {
          try { socket?.close(); } catch {}
          finish(reject, new Error(t('downloaderConnectionFailed', undefined, '与下载器连接失败，检查下载器是否正在运行')));
        }, 3000);

        try {
          socket = new WebSocket(NEATDM_ENDPOINT, NEATDM_PROTOCOL);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }

        socket.onopen = () => {
          socket.onerror = null;
          socket.onclose = null;
          finish(resolve, socket);
        };
        socket.onerror = () => {
          try { socket.close(); } catch {}
          finish(reject, new Error(t('downloaderConnectionFailed', undefined, '与下载器连接失败，检查下载器是否正在运行')));
        };
        socket.onclose = () => {
          if (!settled) finish(reject, new Error(t('downloaderOffline', ['NeatDM'], 'NeatDM 未连接')));
        };
      });
    }

    function sendNeatdmMessage(message) {
      return new Promise((resolve, reject) => {
        let settled = false;
        let socket;
        const finish = (handler, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          handler(value);
        };
        const timer = setTimeout(() => {
          try { socket?.close(); } catch {}
          finish(reject, new Error(t('downloaderConnectionFailed', undefined, '与下载器连接失败，检查下载器是否正在运行')));
        }, 3000);

        try {
          socket = new WebSocket(NEATDM_ENDPOINT, NEATDM_PROTOCOL);
        } catch (err) {
          clearTimeout(timer);
          reject(err);
          return;
        }

        socket.onopen = () => {
          try {
            socket.send(message);
            socket.onerror = null;
            socket.onclose = null;
            try { socket.close(); } catch {}
            finish(resolve, socket);
          } catch (err) {
            try { socket.close(); } catch {}
            finish(reject, err);
          }
        };
        socket.onerror = () => {
          try { socket.close(); } catch {}
          finish(reject, new Error(t('downloaderConnectionFailed', undefined, '与下载器连接失败，检查下载器是否正在运行')));
        };
        socket.onclose = () => {
          if (!settled) finish(reject, new Error(t('downloaderOffline', ['NeatDM'], 'NeatDM 未连接')));
        };
      });
    }

    async function testNeatdmConnection() {
      try {
        const socket = await openNeatdmSocket();
        socket.close();
        return { ok: true, mode: 'neatdm', message: t('neatdmConnected', [NEATDM_ENDPOINT], `已连接 ${NEATDM_ENDPOINT}`) };
      } catch {
        return { ok: false, mode: 'neatdm', error: buildConnectionFailureText('NeatDM') };
      }
    }

    async function sendToNeatdm(taskInfo) {
      try {
        await sendNeatdmMessage(buildNeatdmMessage(taskInfo));
        clearConnectionFailureNotificationCooldown('neatdm');
        return { ok: true };
      } catch (err) {
        return { ok: false, error: notifyConnectionFailure('neatdm') };
      }
    }

    function normalizeTaskInfo(taskInfo = {}, extraOpts = {}) {
      const headers = normalizeRequestHeaders(taskInfo.headers || {});
      const referrer = taskInfo.referrer || headers.referer || '';
      const origin = taskInfo.origin || headers.origin || deriveOrigin(taskInfo.url, referrer);
      const filename = ensureFilenameExtension(taskInfo.filename || '', taskInfo.url, taskInfo.mime || '');
      const downloadPage = taskInfo.downloadPage || referrer || '';
      const contentDisposition = taskInfo.contentDisposition || headers['content-disposition'] || '';

      return {
        ...taskInfo,
        ...extraOpts,
        headers,
        filename,
        referrer,
        origin,
        downloadPage,
        contentDisposition,
        mime: taskInfo.mime || '',
        size: taskInfo.size || 0,
        addedAt: taskInfo.addedAt || Date.now(),
      };
    }

    async function sendToAria2(taskInfo, extraOpts = {}) {
      try {
        const config = getConfig();
        const aria2Opts = { ...extraOpts };
        const defaultSaveLocation = config.aria2SaveLocations?.[0];
        if (
          config.aria2Silent &&
          config.aria2CustomSaveEnabled &&
          !aria2Opts.dir &&
          defaultSaveLocation?.path
        ) {
          aria2Opts.dir = defaultSaveLocation.path;
        }
        const gid = await addUriToAria2(taskInfo.url, taskInfo.filename, taskInfo.headers || {}, aria2Opts);
        await onAria2TaskQueued?.(gid, taskInfo);
        clearConnectionFailureNotificationCooldown('aria2');
        notify(t('sentToLabel', [getDownloaderLabel()], `已发送到 ${getDownloaderLabel()}`), taskInfo.filename || taskInfo.url.slice(0, 80));
        return { ok: true, gid };
      } catch (err) {
        const message = notifyConnectionFailure('aria2');
        return { ok: false, error: message };
      }
    }

    async function sendTask(taskInfo, extraOpts = {}) {
      const config = getConfig();
      const normalizedTask = normalizeTaskInfo(taskInfo, extraOpts);
      if (config.downloaderType === 'abdownload') return sendToExternalLauncher(normalizedTask, extraOpts);
      if (config.downloaderType === 'motrixnext') return sendToMotrixNext(normalizedTask, extraOpts.connectionConfig);
      if (config.downloaderType === 'gopeed') return sendToGopeed(normalizedTask, extraOpts);
      if (config.downloaderType === 'neatdm') return sendToNeatdm(normalizedTask);
      onBeforeAria2Send?.();
      return sendToAria2(normalizedTask, extraOpts);
    }

    return {
      aria2Call,
      buildExternalEndpoint,
      getAria2GlobalStat,
      getAria2Status,
      getGopeedTasks,
      getDownloaderLabel,
      sendRayburstCollection,
      sendTask,
      testNeatdmConnection,
      testMotrixNextConnection,
      testGopeedConnection,
    };
  }

  global.BackgroundDownloaders = {
    createClients,
  };
})(globalThis);
