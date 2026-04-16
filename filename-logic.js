(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
    return;
  }
  root.FilenameLogic = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'ogv', 'm4s']);
  const AUDIO_EXTENSIONS = new Set(['mp3', 'm4a', 'aac', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4s']);

  function decodeBase64(payload) {
    const normalized = String(payload || '').replace(/\s+/g, '');
    if (typeof atob === 'function') return atob(normalized);
    return Buffer.from(normalized, 'base64').toString('binary');
  }

  function sanitizeFilenamePart(value = '') {
    return String(value)
      .replace(/[\\/:*?"<>|]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
  }

  function decodeTextWithCharset(bytes, charset = 'utf-8') {
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
    const text = String(value || '');
    if (!text.includes('=?')) return text;
    return text.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset, encoding, payload) => {
      try {
        let bytes = [];
        if (encoding.toLowerCase() === 'b') {
          const binary = decodeBase64(payload);
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
    const input = String(value || '').replace(/\+/g, '%20');
    if (!/%[0-9a-fA-F]{2}/.test(input)) return input;
    if (/^utf-?8$/i.test(String(charset || 'utf-8'))) {
      try {
        return decodeURIComponent(input);
      } catch {
        // fall through to byte-based decoding
      }
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
    const text = decodeRfc2047Words(String(value || '').trim().replace(/^["']|["']$/g, ''));
    if (!text) return '';
    const normalized = text.replace(/\+/g, '%20');
    if (!/%[0-9a-fA-F]{2}/.test(normalized)) return text;
    try {
      return decodeURIComponent(normalized);
    } catch {
      return text;
    }
  }

  function filenameFromCD(cd) {
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

  function extOf(str) {
    const match = (str || '').match(/\.([a-zA-Z0-9]+)(?:[?#]|$)/);
    return match ? match[1].toLowerCase() : '';
  }

  function filenameFromUrl(url = '') {
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
    return extOf(url) || extensionFromMime(mime);
  }

  function ensureFilenameExtension(filename = '', url = '', mime = '') {
    const cleanName = sanitizeFilenamePart(decodeHttpFilename(filename));
    const ext = guessMediaExtension(url, mime);
    if (!cleanName) return ext ? `media.${ext}` : 'media';
    if (/\.[a-z0-9]{2,5}$/i.test(cleanName)) return cleanName;
    return ext ? `${cleanName}.${ext}` : cleanName;
  }

  function isLowQualityFilename(filename = '') {
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
    const preferred = sanitizeFilenamePart(item.filename || '');
    if (preferred && !isLowQualityFilename(preferred)) return preferred;
    const urlName = sanitizeFilenamePart(filenameFromUrl(item.resourceUrl || ''));
    if (urlName && !isLowQualityFilename(urlName)) return urlName;
    const pageTitle = sanitizeFilenamePart(item.pageTitle || '');
    if (pageTitle) return `${pageTitle}-${item.kind === 'audio' ? 'audio' : 'video'}`;
    const host = (() => {
      try {
        return new URL(item.pageUrl || item.referrer || item.resourceUrl || '').hostname.replace(/^www\./, '');
      } catch {
        return 'media';
      }
    })();
    return `${host || 'media'}-${item.kind === 'audio' ? 'audio' : 'video'}`;
  }

  function fallbackMediaFilename(item = {}) {
    return ensureFilenameExtension(pickDisplayFilename(item), item.resourceUrl, item.mime);
  }

  function mediaKindOf(url = '', mime = '', filename = '') {
    const normalizedMime = String(mime).split(';')[0].trim().toLowerCase();
    if (normalizedMime === 'text/plain') return '';
    if (normalizedMime.startsWith('video/')) return 'video';
    if (normalizedMime.startsWith('audio/')) return 'audio';
    const ext = extOf(url) || extOf(filename);
    const inVideo = VIDEO_EXTENSIONS.has(ext);
    const inAudio = AUDIO_EXTENSIONS.has(ext);
    if (inVideo && inAudio) return 'media';
    if (inVideo) return 'video';
    if (inAudio) return 'audio';
    return '';
  }

  return {
    sanitizeFilenamePart,
    decodeTextWithCharset,
    decodeRfc2047Words,
    decodePercentEncodedText,
    decodeHttpFilename,
    filenameFromCD,
    extOf,
    filenameFromUrl,
    extensionFromMime,
    guessMediaExtension,
    ensureFilenameExtension,
    isLowQualityFilename,
    pickDisplayFilename,
    fallbackMediaFilename,
    mediaKindOf,
  };
});
