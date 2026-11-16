(function initConfigDefaults(global) {
  const LEGACY_DEFAULT_CAPTURE_EXTENSIONS = 'zip,rar,7z,tar,gz,bz2,xz,iso,dmg,exe,msi,deb,pkg,apk,mp4,m4s,mkv,avi,mov,webm,mp3,flac,wav,pdf,torrent';
  const DEFAULT_CAPTURE_EXTENSIONS = `${LEGACY_DEFAULT_CAPTURE_EXTENSIONS},esd,cab,msu,wim,xip,msixbundle,ipa,tipa,appimage`;

  function buildSafariDownloadAllowlistPatterns(value = '') {
    const patterns = new Set();
    const escape = (literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const entry of String(value || '').split(/[,\n]+/)) {
      const rule = entry.trim();
      const parts = /^(?:(https?):\/\/)?([^\s/?#@\\*]+)(\/[^\s?#\\*]+)(?:\?([^\s&=#*]+=[^\s&#*]*))?$/i.exec(rule);
      if (!parts) continue;
      const [, protocol, host, path, parameter] = parts;
      const scheme = protocol?.toLowerCase() || 'https';
      let url;
      try {
        url = new URL(`${scheme}://${host}${path}`);
      } catch {
        continue;
      }
      if (url.pathname === '/' || (url.hostname === '127.0.0.1' && url.pathname.startsWith('/downlink-dnr/'))) continue;
      const pathPattern = url.pathname.endsWith('/')
        ? `${escape(url.pathname.slice(0, -1))}(?:/[^?#]*)?`
        : escape(url.pathname);
      const queryPattern = parameter
        ? `\\?(?:[^#]*&)?${escape(parameter)}(?:&[^#]*)?`
        : '(?:[?][^#]*)?';
      patterns.add(`^(${protocol ? scheme : 'https?'}://${escape(url.host)}${pathPattern}${queryPattern})$`);
    }
    return [...patterns];
  }

  const defaults = {
    DEFAULT_CAPTURE_EXTENSIONS,
    LEGACY_DEFAULT_CAPTURE_EXTENSIONS,
    buildSafariDownloadAllowlistPatterns,
  };

  global.ConfigDefaults = defaults;
  if (typeof module !== 'undefined' && module.exports) module.exports = defaults;
})(typeof globalThis !== 'undefined' ? globalThis : this);
