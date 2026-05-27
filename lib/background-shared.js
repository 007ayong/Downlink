(function initBackgroundShared(global) {
  const FilenameLogic = global.FilenameLogic || null;
  const CAPTURE_MIME_PREFIXES = [
    'application/octet-stream', 'application/zip', 'application/x-rar',
    'application/x-7z-compressed', 'application/x-tar', 'application/gzip',
    'application/x-bzip2', 'application/x-xz', 'application/x-iso9660-image',
    'application/x-msdownload', 'application/vnd.android.package-archive',
    'application/x-apple-diskimage', 'application/x-deb', 'application/pdf',
    'application/x-bittorrent', 'video/', 'audio/',
  ];
  const DOCUMENT_MIME_TYPES = new Set([
    'text/html',
    'text/xml',
    'application/xhtml+xml',
  ]);
  const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', 'm4s']);
  const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4s']);
  const BLOCKED_MEDIA_SNIFF_EXTENSIONS = new Set(['ts']);

  function dirname(filePath = '') {
    if (!filePath) return '';
    const parts = filePath.split(/[\\/]/).filter(Boolean);
    if (parts.length <= 1) return filePath;
    const normalized = filePath.replace(/[\\/]+$/, '');
    const idx = normalized.lastIndexOf('/');
    const winIdx = normalized.lastIndexOf('\\');
    const cutIdx = Math.max(idx, winIdx);
    return cutIdx >= 0 ? normalized.slice(0, cutIdx) : normalized;
  }

  function deriveOrigin(url, referrer = '') {
    try {
      return new URL(url).origin;
    } catch {
      try {
        return new URL(referrer).origin;
      } catch {
        return '';
      }
    }
  }

  function normalizeRequestHeaders(headers = {}) {
    const normalized = {};
    for (const [key, value] of Object.entries(headers || {})) {
      if (!value) continue;
      normalized[String(key).toLowerCase()] = String(value);
    }
    return normalized;
  }

  function extOf(str) {
    if (FilenameLogic?.extOf) return FilenameLogic.extOf(str);
    const match = (str || '').match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
    return match ? match[1].toLowerCase() : '';
  }

  function decodeTextWithCharset(bytes, charset = 'utf-8') {
    if (FilenameLogic?.decodeTextWithCharset) return FilenameLogic.decodeTextWithCharset(bytes, charset);
    const normalized = String(charset || 'utf-8').trim().toLowerCase().replace(/_/g, '-');
    try {
      return new TextDecoder(normalized || 'utf-8').decode(new Uint8Array(bytes));
    } catch {
      try {
        return new TextDecoder('utf-8').decode(new Uint8Array(bytes));
      } catch {
        return bytes.map(byte => String.fromCharCode(byte)).join('');
      }
    }
  }

  function decodeRfc2047Words(value = '') {
    if (FilenameLogic?.decodeRfc2047Words) return FilenameLogic.decodeRfc2047Words(value);
    const text = String(value || '');
    if (!text.includes('=?')) return text;
    return text.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset, encoding, payload) => {
      try {
        let bytes = [];
        if (encoding.toLowerCase() === 'b') {
          const normalized = payload.replace(/\s+/g, '');
          const binary = atob(normalized);
          bytes = Array.from(binary, ch => ch.charCodeAt(0));
        } else {
          const qp = payload.replace(/_/g, ' ');
          for (let i = 0; i < qp.length; i++) {
            const ch = qp[i];
            if (ch === '=' && /^[0-9A-Fa-f]{2}$/.test(qp.slice(i + 1, i + 3))) {
              bytes.push(parseInt(qp.slice(i + 1, i + 3), 16));
              i += 2;
            } else {
              bytes.push(ch.charCodeAt(0));
            }
          }
        }
        return decodeTextWithCharset(bytes, charset);
      } catch {
        return match;
      }
    });
  }

  function decodePercentEncodedText(value = '', charset = 'utf-8') {
    if (FilenameLogic?.decodePercentEncodedText) return FilenameLogic.decodePercentEncodedText(value, charset);
    const input = String(value || '');
    if (!/%[0-9a-fA-F]{2}/.test(input)) return input;
    if (/^utf-?8$/i.test(String(charset || 'utf-8'))) {
      try {
        return decodeURIComponent(input);
      } catch {}
    }
    const bytes = [];
    for (let i = 0; i < input.length; i++) {
      const ch = input[i];
      if (ch === '%' && i + 2 < input.length && /^[0-9A-Fa-f]{2}$/.test(input.slice(i + 1, i + 3))) {
        bytes.push(parseInt(input.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        bytes.push(ch.charCodeAt(0) & 0xff);
      }
    }
    return decodeTextWithCharset(bytes, charset);
  }

  function decodeHttpFilename(value = '') {
    if (FilenameLogic?.decodeHttpFilename) return FilenameLogic.decodeHttpFilename(value);
    const text = decodeRfc2047Words(String(value || '').trim().replace(/^["']|["']$/g, ''));
    if (!text) return '';
    if (!/%[0-9a-fA-F]{2}/.test(text)) return text;
    try {
      return decodeURIComponent(text);
    } catch {
      return text;
    }
  }

  function filenameFromUrl(url = '') {
    if (FilenameLogic?.filenameFromUrl) return FilenameLogic.filenameFromUrl(url);
    try {
      return decodeHttpFilename(new URL(url).pathname.split('/').pop() || '');
    } catch {
      try {
        return decodeHttpFilename(url.split('?')[0].split('/').pop() || '');
      } catch {
        return url.split('?')[0].split('/').pop() || '';
      }
    }
  }

  function extensionFromMime(mime = '') {
    if (FilenameLogic?.extensionFromMime) return FilenameLogic.extensionFromMime(mime);
    const normalized = String(mime).split(';')[0].trim().toLowerCase();
    const map = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/ogg': 'ogv',
      'video/quicktime': 'mov',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/opus': 'opus',
      'audio/flac': 'flac',
    };
    return map[normalized] || '';
  }

  function guessMediaExtension(url = '', mime = '') {
    if (FilenameLogic?.guessMediaExtension) return FilenameLogic.guessMediaExtension(url, mime);
    return extOf(url) || extensionFromMime(mime);
  }

  function sanitizeFilenamePart(value = '') {
    if (FilenameLogic?.sanitizeFilenamePart) return FilenameLogic.sanitizeFilenamePart(value);
    return String(value)
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function ensureFilenameExtension(filename = '', url = '', mime = '') {
    if (FilenameLogic?.ensureFilenameExtension) return FilenameLogic.ensureFilenameExtension(filename, url, mime);
    const cleanName = sanitizeFilenamePart(decodeHttpFilename(filename));
    const ext = guessMediaExtension(url, mime);
    if (!cleanName) return ext ? `media.${ext}` : 'media';
    if (/\.[a-z0-9]{2,5}$/i.test(cleanName)) return cleanName;
    return ext ? `${cleanName}.${ext}` : cleanName;
  }

  function isLowQualityFilename(filename = '') {
    if (FilenameLogic?.isLowQualityFilename) return FilenameLogic.isLowQualityFilename(filename);
    const cleanName = sanitizeFilenamePart(filename).toLowerCase();
    if (!cleanName) return true;
    const basename = cleanName.replace(/\.[a-z0-9]{2,5}$/i, '');
    if (!basename) return true;
    if (/^(media|video|audio|play|stream|download|file)$/.test(basename)) return true;
    if (/^[a-f0-9]{16,}$/i.test(basename)) return true;
    if (/^\d{10,}$/.test(basename)) return true;
    return false;
  }

  function pickDisplayFilename(item = {}) {
    if (FilenameLogic?.pickDisplayFilename) return FilenameLogic.pickDisplayFilename(item);
    const preferred = sanitizeFilenamePart(item.filename || '');
    if (preferred && !isLowQualityFilename(preferred)) return preferred;
    const urlName = sanitizeFilenamePart(filenameFromUrl(item.resourceUrl || ''));
    if (urlName && !isLowQualityFilename(urlName)) return urlName;
    const pageTitle = sanitizeFilenamePart(item.pageTitle || '');
    if (pageTitle) {
      if (item.kind === 'audio') return `${pageTitle}-audio`;
      if (item.kind === 'video') return `${pageTitle}-video`;
      return `${pageTitle}-media`;
    }
    const host = (() => {
      try {
        return new URL(item.pageUrl || item.referrer || item.resourceUrl || '').hostname.replace(/^www\./, '');
      } catch {
        return 'media';
      }
    })();
    return `${host || 'media'}-${item.kind === 'audio' ? 'audio' : item.kind === 'video' ? 'video' : 'media'}`;
  }

  function fallbackMediaFilename(item = {}) {
    if (FilenameLogic?.fallbackMediaFilename) return FilenameLogic.fallbackMediaFilename(item);
    return ensureFilenameExtension(pickDisplayFilename(item), item.resourceUrl, item.mime);
  }

  function filenameFromCD(cd) {
    if (FilenameLogic?.filenameFromCD) return FilenameLogic.filenameFromCD(cd);
    if (!cd) return '';
    let match = cd.match(/filename\*\s*=\s*([^;]+)/i);
    if (match) {
      const rawValue = match[1].trim().replace(/^["']|["']$/g, '');
      const parts = rawValue.match(/^([^']*)'[^']*'(.*)$/);
      const charset = parts?.[1] || 'utf-8';
      const encodedPart = parts ? parts[2] : rawValue;
      const decoded = decodePercentEncodedText(encodedPart, charset);
      if (decoded) return decoded;
    }
    match = cd.match(/filename\s*=\s*["']?([^"';\r\n]+)["']?/i);
    return match ? decodeHttpFilename(match[1].trim().replace(/["']/g, '')) : '';
  }

  function cleanExpired(map) {
    const now = Date.now();
    for (const [key, value] of map) {
      if (now > value.expiresAt) map.delete(key);
    }
  }

  function mediaKindOf(url = '', mime = '', filename = '') {
    if (FilenameLogic?.mediaKindOf) return FilenameLogic.mediaKindOf(url, mime, filename);
    const normalizedMime = String(mime).split(';')[0].trim().toLowerCase();
    // 屏蔽纯文本 MIME，避免误将 text/plain 标记为媒体
    if (normalizedMime === 'text/plain') return '';
    if (normalizedMime.startsWith('video/')) return 'video';
    if (normalizedMime.startsWith('audio/')) return 'audio';
    const ext = extOf(url) || extOf(filename);
    const inVideo = VIDEO_EXTENSIONS.has(ext);
    const inAudio = AUDIO_EXTENSIONS.has(ext);
    // 若扩展同时在音视频集合中，视为通用媒体（可能是视频也可能是音频）
    if (inVideo && inAudio) return 'media';
    if (inVideo) return 'video';
    if (inAudio) return 'audio';
    return '';
  }

  function isBlockedMediaSniffResource(url = '', mime = '', filename = '') {
    const normalizedMime = String(mime).split(';')[0].trim().toLowerCase();
    if (normalizedMime === 'video/mp2t') return true;
    // 屏蔽特定的分片 MIME 类型（如 MPEG-TS / ISO segment）
    if (normalizedMime === 'video/iso.segment') return true;
    return BLOCKED_MEDIA_SNIFF_EXTENSIONS.has(extOf(url)) || BLOCKED_MEDIA_SNIFF_EXTENSIONS.has(extOf(filename));
  }

  function isDirectMediaResource(url = '', mime = '', filename = '') {
    if (isBlockedMediaSniffResource(url, mime, filename)) return false;
    return Boolean(mediaKindOf(url, mime, filename));
  }

  function hashString(str = '') {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i);
      hash |= 0;
    }
    return Math.abs(hash).toString(36);
  }

  function totalSizeFromHeaders(contentLength = '', contentRange = '') {
    const rangeMatch = String(contentRange || '').match(/\/(\d+)\s*$/);
    if (rangeMatch) return Number.parseInt(rangeMatch[1], 10) || 0;
    return Number.parseInt(contentLength, 10) || 0;
  }

  function escapeRegex(str = '') {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function stripHash(url = '') {
    const value = String(url || '').trim();
    if (!value) return '';
    const hashIndex = value.indexOf('#');
    return hashIndex >= 0 ? value.slice(0, hashIndex) : value;
  }

  function buildContentDisposition(filename = '') {
    const cleanName = sanitizeFilenamePart(filename);
    if (!cleanName) return '';
    const quoted = cleanName.replace(/(["\\])/g, '\\$1');
    return `attachment; filename="${quoted}"; filename*=UTF-8''${encodeURIComponent(cleanName)}`;
  }

  function captureExts(config = {}) {
    return String(config.captureExtensions || '')
      .split(',')
      .map(item => item.trim().toLowerCase())
      .filter(Boolean);
  }

  function shouldCaptureByExt(config = {}, url, filename) {
    const exts = captureExts(config);
    if (!exts.length) return false;
    return exts.includes(extOf(url)) || exts.includes(extOf(filename));
  }

  function shouldCaptureByMime(config = {}, mime, url = '', filename = '') {
    if (!config.captureMime || !mime) return false;
    const normalized = String(mime).split(';')[0].trim().toLowerCase();
    if (isDocumentMime(normalized)) return false;
    // 如果是通用二进制类型，则结合后缀判断以提高准确性
    if (normalized === 'application/octet-stream') {
      const ext = extOf(url) || extOf(filename) || '';
      if (!ext) return false;
      if (VIDEO_EXTENSIONS.has(ext) || AUDIO_EXTENSIONS.has(ext)) return true;
      const exts = captureExts(config);
      return exts.includes(ext);
    }
    return CAPTURE_MIME_PREFIXES.some(prefix => normalized.startsWith(prefix));
  }

  function isDocumentMime(mime = '') {
    const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
    return DOCUMENT_MIME_TYPES.has(normalized);
  }

  function classifyDownloadCandidate(config = {}, candidate = {}) {
    const url = candidate.url || '';
    const contentDisposition = candidate.contentDisposition || '';
    const mime = String(candidate.mime || '').split(';')[0].trim().toLowerCase();
    const headerFilename = filenameFromCD(contentDisposition);
    const filename = decodeHttpFilename(headerFilename || candidate.filename || filenameFromUrl(url) || '');
    const hasDownloadAttribute = Boolean(candidate.hasDownloadAttribute);
    const byDisposition = /attachment/i.test(contentDisposition);
    const byExt = shouldCaptureByExt(config, url, filename);
    const byMime = shouldCaptureByMime(config, mime, url, filename);
    const documentMime = isDocumentMime(mime);

    let reason = '';
    let confidence = '';
    if (documentMime) {
      reason = '';
      confidence = '';
    } else if (hasDownloadAttribute) {
      reason = 'download-attribute';
      confidence = 'explicit';
    } else if (byDisposition) {
      reason = 'content-disposition';
      confidence = 'strong';
    } else if (byExt) {
      reason = 'extension';
      confidence = 'strong';
    } else if (byMime) {
      reason = 'mime';
      confidence = 'weak';
    }

    return {
      shouldCapture: Boolean(reason),
      reason,
      confidence,
      filename,
      mime,
      contentDisposition,
      byDisposition,
      byExt,
      byMime,
      documentMime,
      hasDownloadAttribute,
      source: candidate.source || '',
    };
  }

  global.BackgroundShared = {
    buildContentDisposition,
    captureExts,
    classifyDownloadCandidate,
    cleanExpired,
    decodeHttpFilename,
    decodePercentEncodedText,
    decodeRfc2047Words,
    decodeTextWithCharset,
    deriveOrigin,
    dirname,
    ensureFilenameExtension,
    escapeRegex,
    extOf,
    fallbackMediaFilename,
    filenameFromCD,
    filenameFromUrl,
    guessMediaExtension,
    extensionFromMime,
    hashString,
    isDocumentMime,
    isDirectMediaResource,
    isLowQualityFilename,
    mediaKindOf,
    normalizeRequestHeaders,
    pickDisplayFilename,
    sanitizeFilenamePart,
    shouldCaptureByExt,
    shouldCaptureByMime,
    stripHash,
    totalSizeFromHeaders,
    VIDEO_EXTENSIONS,
    AUDIO_EXTENSIONS,
  };
})(globalThis);
