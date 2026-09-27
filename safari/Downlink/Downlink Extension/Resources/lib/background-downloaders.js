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
  }) {
    let rpcId = 1;
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

    async function fetchWithTimeout(url, options = {}, timeoutMs = EXTERNAL_LAUNCHER_TIMEOUT_MS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          ...options,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
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
      const headers = normalizeRequestHeaders(taskInfo.headers || {});

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
      if (Object.keys(headers).length) payload.downloadSource.headers = headers;
      if (downloadPage) payload.downloadSource.downloadPage = downloadPage;
      if (folder) payload.folder = folder;
      if (taskInfo.filename) payload.name = taskInfo.filename;
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
      try {
        const path = getAbDownloadPath(extraOpts);
        const endpoint = buildExternalEndpoint(undefined, path);
        const payload = buildAbDownloadRequest(taskInfo, extraOpts);
        let res = await fetchWithTimeout(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (!res.ok && res.status === 500 && endpoint.endsWith('/start-headless-download')) {
          res = await fetchWithTimeout(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(buildAbDownloadFallbackRequest(taskInfo)),
          });
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

    function rayburstRequestFingerprint(taskInfo) {
      return JSON.stringify(buildMotrixNextRequest(taskInfo, ''));
    }

    async function getOrCreateRayburstRequest(taskInfo) {
      const fingerprint = rayburstRequestFingerprint(taskInfo);
      const saved = await getPendingRayburstRequest?.(fingerprint);
      if (saved?.id && saved?.url === taskInfo.url) return { fingerprint, request: saved };
      const id = globalThis.crypto?.randomUUID?.()
        || `downlink-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const request = buildMotrixNextRequest(taskInfo, id);
      await savePendingRayburstRequest?.(fingerprint, request);
      return { fingerprint, request };
    }

    async function sendToMotrixNext(taskInfo) {
      try {
        const config = getConfig();
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
        await removePendingRayburstRequest?.(fingerprint);
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
        return { ok: false, error: message };
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

    function buildGopeedRequest(taskInfo, extraOpts = {}) {
      const requestHeaders = buildGopeedHeaders(taskInfo);
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
      if (taskInfo.filename || extraOpts.gopeedSingleThread) {
        payload.opts = {};
        if (taskInfo.filename) payload.opts.name = taskInfo.filename;
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
      let filename = taskInfo.filename || '';
      if (hadMediaExt) {
        filename = filename.replace(/\.[^.]+$/, '');
      }

      const contentDisposition = taskInfo.contentDisposition || headers['content-disposition'] || buildContentDisposition(filename || '');
      const lines = [
        '1:GET',
        `2:${taskInfo.url || ''}`,
        `6:${mode}`,
        `4:${filename}`,
      ];

      const origin = taskInfo.origin || deriveOrigin(taskInfo.url, pageUrl);
      const referer = pageUrl;
      const downloadPage = pageUrl;
      const mime = contentType || 'application/octet-stream';
      const size = taskInfo.size ? String(taskInfo.size) : '';

      console.log('[NeatDM] Build message:', {
        originalFilename: taskInfo.filename,
        sentFilename: filename,
        removedExt: hadMediaExt
      });

      if (origin) lines.push(`Origin: ${origin}`);
      if (referer) lines.push(`Referer: ${referer}`);
      if (downloadPage) lines.push(`5:${downloadPage}`);
      if (cookies) lines.push(`Cookie: ${cookies}`);
      if (!hadMediaExt && contentType) lines.push(`Content-Type: ${contentType}`);
      if (!hadMediaExt && contentDisposition) lines.push(`Content-Disposition: ${contentDisposition}`);
      if (!hadMediaExt && mime) lines.push(`8:${mime}`);
      if (size) lines.push(`7:${size}`);
      for (const [key, value] of Object.entries(headers)) {
        if (!value) continue;
        if (!String(key).toLowerCase().startsWith('x-')) continue;
        lines.push(`${key}: ${value}`);
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
      if (config.downloaderType === 'motrixnext') return sendToMotrixNext(normalizedTask);
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
