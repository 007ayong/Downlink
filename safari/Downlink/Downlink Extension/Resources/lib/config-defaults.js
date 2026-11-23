(function initConfigDefaults(global) {
  // Baseline for profiles saved before per-suffix overrides were introduced.
  const CAPTURE_EXTENSIONS_MIGRATION_BASELINE = 'zip,rar,7z,tar,gz,bz2,xz,iso,dmg,exe,msi,deb,pkg,apk,mp4,m4s,mkv,avi,mov,webm,mp3,flac,wav,pdf,torrent,esd,cab,msu,wim,xip,msixbundle,ipa,tipa,appimage';
  const DEFAULT_CAPTURE_EXTENSIONS = CAPTURE_EXTENSIONS_MIGRATION_BASELINE;

  const MEDIA_SNIFFING_BLACKLIST_BASELINE = 'x.com,youtube.com';
  const DOWNLOAD_INTERCEPTION_BLACKLIST_BASELINE = 'web.telegram.org';
  const DEFAULT_MEDIA_SNIFFING_BLACKLIST = MEDIA_SNIFFING_BLACKLIST_BASELINE;
  const DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST = DOWNLOAD_INTERCEPTION_BLACKLIST_BASELINE;

  function resolveBlacklist(value, overrides, defaults, baseline) {
    if (value == null && !overrides) return defaults;
    if (!overrides && defaults === baseline) return String(value).trim();
    return resolveRuleList(value, overrides ?? getRuleListOverrides(value, baseline), defaults).replace(/, /g, ',');
  }

  const DEFAULT_SAFARI_DOWNLOAD_ALLOWLIST = 'download.winapps.cc/download/';

  function splitRuleList(value) {
    return [...new Set(String(value ?? '').split(/[,\n]+/).map((rule) => rule.trim()).filter(Boolean))];
  }

  function getRuleListOverrides(value, defaults) {
    const builtIn = splitRuleList(defaults);
    const rules = splitRuleList(value);
    return {
      added: rules.filter((rule) => !builtIn.includes(rule)),
      removed: builtIn.filter((rule) => !rules.includes(rule)),
    };
  }

  function resolveRuleList(value, overrides, defaults) {
    if (!Array.isArray(overrides?.added) || !Array.isArray(overrides?.removed)) {
      return String(value ?? defaults).trim();
    }
    return [...new Set([
      ...splitRuleList(defaults).filter((rule) => !overrides.removed.includes(rule)),
      ...overrides.added,
    ])].join(', ');
  }

  function getSafariDownloadRuleOverrides(value, defaults = DEFAULT_SAFARI_DOWNLOAD_ALLOWLIST) {
    return getRuleListOverrides(value, defaults);
  }

  function resolveSafariDownloadRules(value, overrides, defaults = DEFAULT_SAFARI_DOWNLOAD_ALLOWLIST) {
    return resolveRuleList(value, overrides, defaults);
  }

  function normalizeCaptureExtensionList(value) {
    return String(value ?? DEFAULT_CAPTURE_EXTENSIONS).replace(/\s+/g, '').toLowerCase();
  }

  function getCaptureExtensionOverrides(value, defaults = DEFAULT_CAPTURE_EXTENSIONS) {
    const rules = normalizeCaptureExtensionList(value);
    const entries = splitRuleList(rules);
    // Both an empty list and a wildcard have historically meant any suffix.
    if (!entries.length || entries.includes('*')) return null;
    return getRuleListOverrides(rules, defaults);
  }

  function resolveCaptureExtensions(value, overrides, defaults = DEFAULT_CAPTURE_EXTENSIONS) {
    if (overrides) return resolveRuleList(value, overrides, defaults).replace(/, /g, ',');
    if (value == null) return defaults;
    if (defaults === CAPTURE_EXTENSIONS_MIGRATION_BASELINE) return value;
    const migrated = getCaptureExtensionOverrides(value, CAPTURE_EXTENSIONS_MIGRATION_BASELINE);
    return resolveRuleList(value, migrated, defaults).replace(/, /g, ',');
  }

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
    DEFAULT_MEDIA_SNIFFING_BLACKLIST,
    DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST,
    getRuleListOverrides,
    resolveMediaSniffingBlacklist: (value, overrides) => resolveBlacklist(
      value, overrides, DEFAULT_MEDIA_SNIFFING_BLACKLIST, MEDIA_SNIFFING_BLACKLIST_BASELINE
    ),
    resolveDownloadInterceptionBlacklist: (value, overrides) => resolveBlacklist(
      value, overrides, DEFAULT_DOWNLOAD_INTERCEPTION_BLACKLIST, DOWNLOAD_INTERCEPTION_BLACKLIST_BASELINE
    ),
    DEFAULT_SAFARI_DOWNLOAD_ALLOWLIST,
    buildSafariDownloadAllowlistPatterns,
    getSafariDownloadRuleOverrides,
    resolveSafariDownloadRules,
    getCaptureExtensionOverrides,
    resolveCaptureExtensions,
  };

  global.ConfigDefaults = defaults;
  if (typeof module !== 'undefined' && module.exports) module.exports = defaults;
})(typeof globalThis !== 'undefined' ? globalThis : this);
