(function initPopupUI(global) {
  const t = global.Localization?.t || ((key, substitutions, fallback = key) => {
    if (fallback && substitutions !== undefined) {
      const values = Array.isArray(substitutions) ? substitutions : [substitutions];
      return String(fallback).replace(/\$(\d+)/g, (_, index) => String(values[Number(index) - 1] ?? ''));
    }
    return fallback || key;
  });
  const DEFAULT_HEADER_LOGO = 'icons/icon48.png';
  const DOWNLOADER_LOGOS = {
    aria2: DEFAULT_HEADER_LOGO,
    motrixnext: DEFAULT_HEADER_LOGO,
    abdownload: 'assets/provider-icons/abdownload.png',
    neatdm: 'assets/provider-icons/neatdm.png',
  };
  const FILE_ICON_BASE = 'assets/file-icons';
  const FILE_ICON_MAP = {
    default: `${FILE_ICON_BASE}/default.svg`,
    video: `${FILE_ICON_BASE}/video.svg`,
    audio: `${FILE_ICON_BASE}/audio.svg`,
    image: `${FILE_ICON_BASE}/image.svg`,
    archive: `${FILE_ICON_BASE}/archive.svg`,
    document: `${FILE_ICON_BASE}/document.svg`,
    pdf: `${FILE_ICON_BASE}/pdf.svg`,
    spreadsheet: `${FILE_ICON_BASE}/spreadsheet.svg`,
    executable: `${FILE_ICON_BASE}/executable.svg`,
    torrent: `${FILE_ICON_BASE}/torrent.svg`,
  };
  const EXECUTABLE_MIME_KEYWORDS = [
    'application/x-msdownload',
    'application/vnd.android.package-archive',
    'application/x-apple-diskimage',
    'application/x-deb',
    'application/vnd.debian.binary-package',
    'application/x-msi',
    'application/x-pkg',
    'application/x-executable',
  ];

  function getDownloaderName(cfg = {}) {
    if (cfg?.downloaderType === 'abdownload') return 'AB DM';
    if (cfg?.downloaderType === 'motrixnext') return 'MotrixNext';
    if (cfg?.downloaderType === 'neatdm') return 'NeatDM';
    return 'Aria2';
  }

  function getSendLabel(cfg = {}) {
    return t('sendToDownloader', [getDownloaderName(cfg)], `发送到 ${getDownloaderName(cfg)}`);
  }

  function getHeaderLogoSrc(cfg = {}) {
    return DOWNLOADER_LOGOS[cfg?.downloaderType] || DEFAULT_HEADER_LOGO;
  }

  function fmt(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
    return `${(bytes / Math.pow(1024, index)).toFixed(index > 0 ? 1 : 0)} ${units[index]}`;
  }

  function fmtSpeed(bytes) {
    if (!bytes || bytes <= 0) return '—';
    return `${fmt(bytes)}/s`;
  }

  function extFromName(name = '') {
    const normalized = String(name || '').trim().toLowerCase();
    if (!normalized.includes('.')) return '';
    return normalized.split('.').pop();
  }

  function getFileCategory({ name = '', mime = '', kind = '' } = {}) {
    if (kind === 'video' || String(mime).startsWith('video/')) return 'video';
    if (kind === 'audio' || String(mime).startsWith('audio/')) return 'audio';

    const normalizedMime = String(mime).split(';')[0].trim().toLowerCase();
    if (normalizedMime.startsWith('image/')) return 'image';
    if (normalizedMime === 'application/pdf') return 'pdf';
    if (EXECUTABLE_MIME_KEYWORDS.includes(normalizedMime)) return 'executable';
    if (normalizedMime.includes('spreadsheet') || normalizedMime === 'text/csv' || normalizedMime === 'application/csv') return 'spreadsheet';
    if (normalizedMime.includes('wordprocessingml') || normalizedMime.includes('msword') || normalizedMime.startsWith('text/')) return 'document';
    if (normalizedMime.includes('zip') || normalizedMime.includes('compressed') || normalizedMime.includes('archive') || normalizedMime.includes('7z')) return 'archive';
    if (normalizedMime.includes('bittorrent') || normalizedMime === 'application/x-bittorrent') return 'torrent';

    const ext = extFromName(name);
    const map = {
      mp4: 'video', mkv: 'video', avi: 'video', mov: 'video', webm: 'video', m4v: 'video',
      mp3: 'audio', flac: 'audio', wav: 'audio', aac: 'audio', m4a: 'audio', ogg: 'audio', opus: 'audio',
      jpg: 'image', jpeg: 'image', png: 'image', gif: 'image', webp: 'image', svg: 'image', bmp: 'image', avif: 'image',
      zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive', xz: 'archive',
      pdf: 'pdf',
      doc: 'document', docx: 'document', txt: 'document', md: 'document', rtf: 'document',
      xls: 'spreadsheet', xlsx: 'spreadsheet', csv: 'spreadsheet',
      exe: 'executable', msi: 'executable', dmg: 'executable', deb: 'executable', pkg: 'executable', apk: 'executable',
      torrent: 'torrent', magnet: 'torrent',
    };
    return map[ext] || 'default';
  }

  function getFileIcon(task = {}) {
    const category = getFileCategory(task);
    return FILE_ICON_MAP[category] || FILE_ICON_MAP.default;
  }

  function handleTaskIconError(event) {
    const img = event?.currentTarget;
    if (!img) return;
    const fallback = FILE_ICON_MAP.default;
    if (img.dataset.fallbackApplied === 'true' || img.src.endsWith(FILE_ICON_MAP.default)) return;
    img.dataset.fallbackApplied = 'true';
    img.src = fallback;
  }

  function getStateLabel(state) {
    const map = {
      active: t('stateActive', undefined, '下载中'),
      complete: t('stateComplete', undefined, '完成'),
      error: t('stateError', undefined, '错误'),
      paused: t('statePaused', undefined, '已暂停'),
      waiting: t('stateWaiting', undefined, '等待中'),
      removed: t('stateRemoved', undefined, '已移除'),
      sent: t('stateSent', undefined, '已唤起'),
    };
    return map[state] || state;
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function decodeDisplayFilename(value = '') {
    if (global.FilenameLogic?.decodeHttpFilename) return global.FilenameLogic.decodeHttpFilename(value);
    const text = String(value || '').trim();
    const decoded = text.replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (match, charset, encoding, payload) => {
      try {
        let bytes = [];
        if (encoding.toLowerCase() === 'b') {
          const binary = atob(payload.replace(/\s+/g, ''));
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
        return new TextDecoder(charset || 'utf-8').decode(new Uint8Array(bytes));
      } catch {
        return match;
      }
    });
    if (!/%[0-9a-fA-F]{2}/.test(decoded)) return decoded;
    try {
      return decodeURIComponent(decoded.replace(/\+/g, '%20'));
    } catch {
      return decoded;
    }
  }

  function mediaKindLabel(kind) {
    return kind === 'audio'
      ? t('mediaKindAudio', undefined, '音频')
      : t('mediaKindVideo', undefined, '视频');
  }

  function mediaResolutionLabel(item) {
    if (item.kind !== 'video' || !item.width || !item.height) return t('mediaResolutionPending', undefined, '分辨率待识别');
    return `${item.width}×${item.height}`;
  }

  function shouldAutoSwitchToMediaPanel(state) {
    return (
      state.mediaCount > state.previousMediaCount &&
      state.pendingCount === 0 &&
      state.currentTab !== 'media' &&
      state.mediaCount !== state.lastAutoSwitchedMediaCount
    );
  }

  function buildMediaRenderKey(media = []) {
    return media.map((item) => [
      item.id,
      item.resourceUrl,
      item.filename,
      item.size,
      item.kind,
      item.mime,
      item.width,
      item.height,
    ].join('|')).join('||');
  }

  global.PopupUI = {
    DEFAULT_HEADER_LOGO,
    buildMediaRenderKey,
    decodeDisplayFilename,
    escHtml,
    fmt,
    fmtSpeed,
    getDownloaderName,
    getFileCategory,
    getFileIcon,
    getHeaderLogoSrc,
    getSendLabel,
    getStateLabel,
    handleTaskIconError,
    mediaKindLabel,
    mediaResolutionLabel,
    shouldAutoSwitchToMediaPanel,
  };
})(globalThis);
