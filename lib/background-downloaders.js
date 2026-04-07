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
  const stripHash = shared.stripHash || ((url) => url || '');
  const buildContentDisposition = shared.buildContentDisposition || (() => '');

  const NEATDM_ENDPOINT = 'ws://127.0.0.1:10007/download';
  const NEATDM_PROTOCOL = 'neatextension.v1';
  const ARIA2_RPC_TIMEOUT_MS = 3000;
  const DOWNLOADERS = {
    aria2: { label: (cfg) => cfg.aria2Label || 'Aria2' },
    abdownload: { label: () => 'AB DM' },
    neatdm: { label: () => 'NeatDM' },
  };

  function createClients({ getConfig, notify, onBeforeAria2Send, onAria2TaskQueued }) {
    let rpcId = 1;
    const EXTERNAL_LAUNCHER_TIMEOUT_MS = 3000;

    function getDownloaderLabel(type = getConfig().downloaderType, cfg = getConfig()) {
      return DOWNLOADERS[type]?.label?.(cfg) || type;
    }

    function buildConnectionFailureText(label) {
      return t('connectionFailedWithLabel', [label], `与 ${label} 连接失败，检查 ${label} 是否正在运行`);
    }

    function notifyConnectionFailure(type) {
      const label = getDownloaderLabel(type);
      notify(
        t('connectionFailedTitle', [label], `与 ${label} 连接失败`),
        t('connectionFailedBody', [label], `检查 ${label} 是否正在运行`)
      );
      return buildConnectionFailureText(label);
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

    async function aria2Call(method, params = [], overrideConfig) {
      const config = overrideConfig || getConfig();
      const secret = config.aria2Secret ? `token:${config.aria2Secret}` : undefined;
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
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      return data.result;
    }

    async function getAria2GlobalStat(overrideConfig) {
      return aria2Call('getGlobalStat', [], overrideConfig);
    }

    async function getAria2Status(gid) {
      return aria2Call('tellStatus', [gid]);
    }

    async function addUriToAria2(url, filename, headers = {}, extraOpts = {}) {
      const config = getConfig();
      const opts = {};
      if (config.saveDir) opts.dir = config.saveDir;
      if (filename) opts.out = filename;
      const headerLines = [];
      ['cookie', 'referer', 'origin', 'authorization', 'user-agent'].forEach((key) => {
        if (headers[key]) headerLines.push(`${key}: ${headers[key]}`);
      });
      if (headerLines.length) opts.header = headerLines;
      Object.assign(opts, extraOpts);
      return aria2Call('addUri', [[url], opts]);
    }

    function buildExternalEndpoint(overrideConfig) {
      const config = overrideConfig || getConfig();
      const host = (config.externalLauncherHost || 'localhost').trim() || 'localhost';
      const port = String(config.externalLauncherPort || '15151').trim() || '15151';
      const path = String(config.externalLauncherPath || '/start-headless-download').trim() || '/start-headless-download';
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      return `http://${host}:${port}${normalizedPath}`;
    }

    function buildAbDownloadRequest(taskInfo, extraOpts = {}) {
      const config = getConfig();
      const path = String(config.externalLauncherPath || '/start-headless-download').trim() || '/start-headless-download';
      const normalizedPath = path.startsWith('/') ? path : `/${path}`;
      const folder = extraOpts.dir || config.saveDir || '';
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
        const endpoint = buildExternalEndpoint();
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
        return { ok: true };
      } catch (err) {
        const message = notifyConnectionFailure('abdownload');
        return { ok: false, error: message };
      }
    }

    function getNeatdmMode(taskInfo = {}) {
      if (taskInfo.neatdmMode) return String(taskInfo.neatdmMode);
      const url = taskInfo.url || '';
      const mime = taskInfo.mime || '';
      const kind = taskInfo.kind || mediaKindOf(url, mime);
      const extension = guessMediaExtension(url, mime);
      if (extension === 'm3u8') return 'hls';
      if (kind === 'video' || kind === 'audio') return 'media';
      return 'normal';
    }

    function buildNeatdmMessage(taskInfo) {
      const headers = normalizeRequestHeaders(taskInfo.headers || {});
      const pageUrl = stripHash(taskInfo.downloadPage || taskInfo.referrer || '');
      const contentType = headers['content-type'] || taskInfo.mime || '';
      const contentDisposition = taskInfo.contentDisposition || headers['content-disposition'] || buildContentDisposition(taskInfo.filename || '');
      const cookies = headers.cookie || '';
      const mode = getNeatdmMode(taskInfo);
      const lines = [
        '1:GET',
        `2:${taskInfo.url || ''}`,
        `6:${mode}`,
        `4:${taskInfo.filename || ''}`,
      ];

      const origin = taskInfo.origin || deriveOrigin(taskInfo.url, pageUrl);
      const referer = pageUrl;
      const downloadPage = pageUrl;
      const mime = contentType || 'application/octet-stream';
      const size = taskInfo.size ? String(taskInfo.size) : '';

      if (origin) lines.push(`Origin: ${origin}`);
      if (referer) lines.push(`Referer: ${referer}`);
      if (downloadPage) lines.push(`5:${downloadPage}`);
      if (cookies) lines.push(`Cookie: ${cookies}`);
      if (contentType) lines.push(`Content-Type: ${contentType}`);
      if (contentDisposition) lines.push(`Content-Disposition: ${contentDisposition}`);
      if (mime) lines.push(`8:${mime}`);
      if (size) lines.push(`7:${size}`);
      for (const [key, value] of Object.entries(headers)) {
        if (!value) continue;
        if (!String(key).toLowerCase().startsWith('x-')) continue;
        lines.push(`${key}: ${value}`);
      }

      return `${lines.join('\r\n')}\r\n`;
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

        socket.onopen = () => finish(resolve, socket);
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
      let socket;
      try {
        socket = await openNeatdmSocket();
        socket.send(buildNeatdmMessage(taskInfo));
        socket.close();
        return { ok: true };
      } catch (err) {
        try { socket?.close(); } catch {}
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
        const gid = await addUriToAria2(taskInfo.url, taskInfo.filename, taskInfo.headers || {}, extraOpts);
        onAria2TaskQueued?.(gid, taskInfo);
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
      if (config.downloaderType === 'neatdm') return sendToNeatdm(normalizedTask);
      onBeforeAria2Send?.();
      return sendToAria2(normalizedTask, extraOpts);
    }

    return {
      aria2Call,
      buildExternalEndpoint,
      getAria2GlobalStat,
      getAria2Status,
      getDownloaderLabel,
      sendTask,
      testNeatdmConnection,
    };
  }

  global.BackgroundDownloaders = {
    createClients,
  };
})(globalThis);
