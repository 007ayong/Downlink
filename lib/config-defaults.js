(function initConfigDefaults(global) {
  const LEGACY_DEFAULT_CAPTURE_EXTENSIONS = 'zip,rar,7z,tar,gz,bz2,xz,iso,dmg,exe,msi,deb,pkg,apk,mp4,m4s,mkv,avi,mov,webm,mp3,flac,wav,pdf,torrent';
  const DEFAULT_CAPTURE_EXTENSIONS = `${LEGACY_DEFAULT_CAPTURE_EXTENSIONS},esd,cab,msu,wim,xip,msixbundle,ipa,tipa,appimage`;

  const defaults = {
    DEFAULT_CAPTURE_EXTENSIONS,
    LEGACY_DEFAULT_CAPTURE_EXTENSIONS,
  };

  global.ConfigDefaults = defaults;
  if (typeof module !== 'undefined' && module.exports) module.exports = defaults;
})(typeof globalThis !== 'undefined' ? globalThis : this);
