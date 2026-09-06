const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const safariBackgroundPath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink Extension',
  'Resources',
  'background.js'
);
const safariViewControllerPath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink',
  'ViewController.swift'
);
const safariAppDelegatePath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink',
  'AppDelegate.swift'
);
const safariHostMainHtmlPath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink',
  'Resources',
  'Base.lproj',
  'Main.html'
);
const safariHostScriptPath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink',
  'Resources',
  'Script.js'
);

function readSafariBackground() {
  return fs.readFileSync(safariBackgroundPath, 'utf8');
}

function loadSafariRedirectPatternBuilder() {
  const source = readSafariBackground();
  const functionSource = source.slice(
    source.indexOf('function buildSafariDownloadRedirectPatterns'),
    source.indexOf('function isSafariDnrDownloadCandidate')
  );
  const context = { SAFARI_DOWNLOAD_ENDPOINT_REDIRECT_PATTERNS: [] };
  vm.runInNewContext(`${functionSource}; this.buildPatterns = buildSafariDownloadRedirectPatterns;`, context);
  return context.buildPatterns;
}

function loadSafariBridgeMessageValidator() {
  const source = readSafariBackground();
  const functionSource = source.slice(
    source.indexOf('function safariLocalBridgeTargetUrl'),
    source.indexOf('function isSafariLocalBridgeNavigationUrl')
  );
  const context = { URL };
  vm.runInNewContext(`${functionSource}; this.validate = isValidSafariLocalBridgeMessageContext;`, context);
  return context.validate;
}

function loadSafariBadgeUpdater(badgeError) {
  const source = readSafariBackground();
  const functionSource = source.slice(
    source.indexOf('function observeTabScopedActionCall'),
    source.indexOf('function getActiveTabs')
  );
  const calls = [];
  const warnings = [];
  const rejectBadgeUpdate = (operation, payload) => {
    calls.push({ operation, payload });
    return Promise.reject(new Error(badgeError));
  };
  const context = {
    config: { autoCapture: true },
    chrome: {
      action: {
        setBadgeBackgroundColor: (payload) => rejectBadgeUpdate('setBadgeBackgroundColor', payload),
        setBadgeTextColor: (payload) => rejectBadgeUpdate('setBadgeTextColor', payload),
        setBadgeText: (payload) => rejectBadgeUpdate('setBadgeText', payload),
      },
    },
    console: {
      warn(...args) {
        warnings.push(args);
      },
    },
  };
  vm.runInNewContext(`${functionSource}; this.updateBadge = updateActionBadgeForTab;`, context);
  return { updateBadge: context.updateBadge, calls, warnings };
}

test('Safari disabled badge uses ASCII text', () => {
  const source = readSafariBackground();
  assert.match(source, /isCaptureDisabled \? 'OFF'/);
  assert.doesNotMatch(source, /isCaptureDisabled \? '✕'/);
});

test('Safari badge updates ignore a closed-tab Promise rejection', async () => {
  const runtime = loadSafariBadgeUpdater('No tab with id: 823017455.');

  runtime.updateBadge(823017455, 2);
  await Promise.resolve();

  assert.equal(runtime.calls.length, 3);
  assert.equal(runtime.warnings.length, 0);
});

test('Safari badge updates report unexpected Promise rejections', async () => {
  const runtime = loadSafariBadgeUpdater('Action API unavailable');

  runtime.updateBadge(12, 1);
  await Promise.resolve();

  assert.equal(runtime.calls.length, 3);
  assert.equal(runtime.warnings.length, 3);
  assert.ok(runtime.warnings.every((args) => args[0] === '[Downlink][badge] failed to update tab badge'));
});

test('Safari config saves synchronize DNR rules directly', () => {
  const source = readSafariBackground();
  const saveFunction = source.slice(
    source.indexOf('async function saveConfigAndSync'),
    source.indexOf('function queueAutoCaptureToggle')
  );
  assert.match(saveFunction, /await installSafariDownloadRedirectRules\(\)/);
});

test('Safari DNR takeover redirects browser downloads to the native loopback bridge', () => {
  const source = readSafariBackground();
  const installFunction = source.slice(
    source.indexOf('async function installSafariDownloadRedirectRules'),
    source.indexOf('function addHostnameToMediaSniffingBlacklist')
  );
  assert.match(installFunction, /removeRuleIds: SAFARI_DOWNLOAD_REDIRECT_RULE_IDS/);
  assert.match(installFunction, /addRules: \[\]/);
  assert.match(installFunction, /removeRuleIds: \[\]/);
  assert.match(installFunction, /type: 'redirect'/);
  assert.match(installFunction, /regexSubstitution: `\$\{bridgeUrl\}\/\?url=\\\\1#\\\\1`/);
  assert.match(installFunction, /isUrlFilterCaseSensitive: false/);
  assert.doesNotMatch(installFunction, /extensionPath:/);
  assert.doesNotMatch(installFunction, /type: 'block'/);
});

test('Safari wildcard DNR patterns require a file extension in the URL path', () => {
  const buildPatterns = loadSafariRedirectPatternBuilder();
  const patterns = buildPatterns({ captureExtensions: '*' }).map((pattern) => new RegExp(pattern, 'i'));
  const matches = (url) => patterns.some((pattern) => pattern.test(url));

  assert.equal(matches('https://google.com'), false);
  assert.equal(matches('https://sub.example.com?source=test'), false);
  assert.equal(matches('https://example.com/releases/file.zip'), true);
  assert.equal(matches('https://example.com/releases/file.zip?token=abc'), true);
});

test('Safari validates that the native bridge stays on randomized loopback HTTP', () => {
  const source = readSafariBackground();
  assert.match(source, /parsed\.protocol === 'http:'/);
  assert.match(source, /parsed\.hostname === '127\.0\.0\.1'/);
  assert.match(source, /START_DNR_BRIDGE/);
  assert.match(source, /SAFARI_LOCAL_BRIDGE_KEEPALIVE_MS = 5000/);
  assert.match(source, /probeSafariLocalBridge\(bridgeUrl\)/);
  assert.match(source, /local DNR bridge navigation error observed/);
  assert.match(source, /failed local bridge download tab closed/);
  assert.match(source, /failed local bridge navigation went back/);
});

test('Safari local bridge message captures the URL carried by DNR substitution', () => {
  const source = readSafariBackground();
  const handler = source.slice(
    source.indexOf("case 'CAPTURE_LOCAL_DNR_BRIDGE'"),
    source.indexOf("case 'CAPTURE_DNR_DOWNLOAD'")
  );
  assert.match(handler, /const url = String\(msg\.url \|\| ''\)/);
  assert.match(handler, /isValidSafariLocalBridgeMessageContext\(senderUrl, url, candidate\)/);
  assert.match(handler, /invalid-dnr-document-context/);
  assert.match(handler, /captureSource: 'safari-local-dnr-bridge'/);
  assert.match(handler, /captureReason: 'dnr-regex-substitution'/);
});

test('Safari accepts an authenticated bridge document when DNR events arrive out of order', () => {
  const validate = loadSafariBridgeMessageValidator();
  const target = 'https://files.example/release.zip?token=abc';
  const bridge = `http://127.0.0.1:17651/downlink-dnr/123e4567-e89b-12d3-a456-426614174000/#${target}`;

  assert.equal(validate(bridge, target, null), true);
  assert.equal(validate(bridge, target, { url: target }), true);
  assert.equal(validate(bridge, target, { url: 'https://files.example/other.zip' }), false);
  assert.equal(validate('https://attacker.example/', target, null), false);
});

test('Safari carries other-resource targets in the authenticated HTTP bridge request', () => {
  const source = readSafariBackground();
  const handler = source.slice(
    source.indexOf('function handleSafariSendHeaders'),
    source.indexOf('try {\n  chrome.webRequest.onSendHeaders.addListener')
  );

  assert.match(handler, /safariLocalBridgeRequestTargetUrl\(details\.url\)/);
  assert.match(handler, /details\.type === 'other'/);
  assert.match(handler, /captureSource: 'safari-local-dnr-other'/);
  assert.match(handler, /openPendingSurface: true/);
});

test('Safari native bridge accepts target-bearing query requests', () => {
  const source = fs.readFileSync(safariAppDelegatePath, 'utf8');
  assert.ok(source.includes('request.hasPrefix("GET \\(expectedPath)?")'));
  assert.ok(source.includes('request.hasPrefix("HEAD \\(expectedPath)?")'));
});

test('Safari browser bypass suppresses every direct capture path for the redirect chain', () => {
  const source = readSafariBackground();
  const bypassFunction = source.slice(
    source.indexOf('async function installSafariDnrBypassRule'),
    source.indexOf('async function probeSafariLocalBridge')
  );
  const directCapture = source.slice(
    source.indexOf('function captureSafariUrlDirectly'),
    source.indexOf('function createResponseCaptureGate')
  );
  const navigationListener = source.slice(
    source.indexOf('chrome.webNavigation?.onBeforeNavigate'),
    source.indexOf('chrome.webNavigation?.onErrorOccurred')
  );

  assert.match(bypassFunction, /action: \{ type: 'allow' \}/);
  assert.match(bypassFunction, /regexFilter: '\^https\?:\/\/'/);
  assert.match(bypassFunction, /tabIds: \[tabId\]/);
  assert.match(directCapture, /await isSafariDnrBypassActive\(tabId, url\)/);
  assert.match(navigationListener, /await isSafariDnrBypassActive\(details\.tabId, details\.url\)/);
});

test('Safari redirect observation records context without submitting a premature task', () => {
  const source = readSafariBackground();
  const handler = source.slice(
    source.indexOf('function navigateSafariRedirectToDnrBridge'),
    source.indexOf('function isDownloadInProgress')
  );
  assert.match(handler, /redirect download candidate recorded for DNR bridge/);
  assert.doesNotMatch(handler, /captureSafariUrlDirectly\(/);
  assert.doesNotMatch(handler, /scheduleSafariBlockedNavigationRecovery\(/);
});

test('Safari waits for the local bridge document before submitting a task', () => {
  const source = readSafariBackground();
  const listener = source.slice(
    source.indexOf('chrome.webNavigation?.onBeforeNavigate'),
    source.indexOf('chrome.webNavigation?.onErrorOccurred')
  );
  const bridgeBranch = listener.slice(0, listener.indexOf('if (!isSafariDnrDownloadCandidate'));
  const candidateBranch = listener.slice(listener.indexOf('if (!isSafariDnrDownloadCandidate'));

  assert.match(bridgeBranch, /safariLocalBridgeTargetUrl\(details\.url\)/);
  assert.match(bridgeBranch, /candidate && candidate\.url !== bridgedUrl/);
  assert.match(bridgeBranch, /awaiting document confirmation/);
  assert.doesNotMatch(bridgeBranch, /captureSafariUrlDirectly\(\{/);
  assert.doesNotMatch(candidateBranch, /captureSafariUrlDirectly\(\{/);
});

test('Safari download response marking excludes playback and fetch resources', () => {
  const source = readSafariBackground();
  const handler = source.slice(
    source.indexOf('async function handleSafariHeadersReceived'),
    source.indexOf('chrome.webRequest.onBeforeRedirect')
  );
  assert.match(handler, /const explicitAttachment = \/attachment\/i\.test\(contentDisposition\)/);
  assert.match(handler, /const downloadLikeRequest = isUserDownloadLikeResponse\(details\)/);
  assert.match(handler, /!explicitAttachment && !downloadLikeRequest\) return/);
});

test('Safari restores the bridge tab before opening pending task UI', () => {
  const source = readSafariBackground();
  const captureHandler = source.slice(
    source.indexOf("case 'CAPTURE_LOCAL_DNR_BRIDGE'"),
    source.indexOf("case 'CAPTURE_DNR_DOWNLOAD'")
  );
  const delayedOpen = source.slice(
    source.indexOf('function scheduleSafariBridgePendingSurface'),
    source.indexOf('async function enqueuePendingDownload')
  );
  const fallbackWindow = source.slice(
    source.indexOf('async function openTaskFallbackWindow'),
    source.indexOf('function getTab')
  );

  assert.match(captureHandler, /openPendingSurface: false/);
  assert.match(captureHandler, /sourceTabId: candidate\?\.sourceTabId \?\? openerTabId/);
  assert.match(captureHandler, /stableSourcePageUrl/);
  assert.match(captureHandler, /scheduleSafariBridgeRecovery/);
  assert.match(captureHandler, /bridgeHandled/);
  assert.match(captureHandler, /closeBridgeTab/);
  assert.match(captureHandler, /sendResponse\(\{ \.\.\.result, url, bridgeHandled, closeBridgeTab, recoveryMode \}\)/);
  assert.match(captureHandler, /scheduleSafariBridgePendingSurface\(result\.key\)/);
  assert.match(delayedOpen, /setTimeout/);
  assert.match(delayedOpen, /openTaskSurfaceForTask\(taskInfo\)/);
  assert.match(fallbackWindow, /chrome\.windows\.create/);
  assert.match(fallbackWindow, /chrome\.runtime\.getURL\('popup\.html'\)/);
});

test('Safari restores successful bridge navigations without replaying redirect history', () => {
  const source = readSafariBackground();
  const recoveryFunction = source.slice(
    source.indexOf('function scheduleSafariBridgeRecovery'),
    source.indexOf('async function enqueuePendingDownload')
  );
  assert.match(recoveryFunction, /sourceTabId/);
  assert.match(recoveryFunction, /chrome\.tabs\.update/);
  assert.match(recoveryFunction, /chrome\.tabs\.remove/);
  assert.match(recoveryFunction, /url: returnUrl \|\| 'about:blank'/);
  assert.doesNotMatch(recoveryFunction, /goBack|history\.back/);
  assert.match(recoveryFunction, /successful local bridge navigation recovered/);
});

test('Safari records committed pages and created navigation targets as bridge recovery sources', () => {
  const source = readSafariBackground();
  const listeners = source.slice(
    source.indexOf('chrome.webNavigation?.onCommitted'),
    source.indexOf('chrome.webNavigation?.onBeforeNavigate')
  );
  assert.match(listeners, /rememberSafariCommittedPage/);
  assert.match(listeners, /onCreatedNavigationTarget/);
  assert.match(listeners, /sourceTabId/);
  assert.match(listeners, /safariCreatedNavigationSources\.set/);
});

test('Safari DNR bridge reuses the deduplicated URL capture path', () => {
  const source = readSafariBackground();
  const handler = source.slice(
    source.indexOf("case 'CAPTURE_DNR_DOWNLOAD'"),
    source.indexOf("case 'OPEN_TASK_SURFACE'")
  );
  assert.match(handler, /captureSafariUrlDirectly\(\{/);
  assert.match(handler, /captureSource: 'safari-dnr-bridge'/);
  assert.doesNotMatch(handler, /queueOrSendCapturedDownload\(/);
});

function loadSafariConfigStorage(local, sync, { failLocalWrite = false, failLocalRead = false, failSyncRead = false } = {}) {
  const source = readSafariBackground();
  const context = {
    DEFAULT_CONFIG: { downloaderType: 'aria2', aria2Rpc: 'http://localhost:6800/jsonrpc', motrixNextPort: '16801' },
    CONFIG_STORAGE_AREA_KEY: '__downlinkConfigStorageArea',
    activeConfigStorageArea: '',
    chrome: { storage: { local, sync } },
    async storageGet(area, keys) {
      if (failLocalRead && area === local) throw new Error('local read failed');
      if (failSyncRead && area === sync) throw new Error('sync read failed');
      if (keys == null) return { ...area };
      return Object.fromEntries(Object.entries(keys).map(([key, fallback]) =>
        [key, Object.prototype.hasOwnProperty.call(area, key) ? area[key] : fallback]));
    },
    async storageSet(area, values) {
      if (failLocalWrite && area === local) throw new Error('local write failed');
      Object.assign(area, values);
    },
  };
  vm.runInNewContext(source.slice(source.indexOf('async function loadStoredConfig()'),
    source.indexOf('function normalizeCaptureExtensionsConfig')), context);
  return context;
}

test('Safari restores local connection settings over stale sync after restart', async () => {
  const local = {};
  const sync = { motrixNextPort: '16801' };
  const first = loadSafariConfigStorage(local, sync);
  await first.loadStoredConfig();
  await first.saveStoredConfig({ motrixNextPort: '16999', aria2Rpc: 'http://localhost:7777/jsonrpc' });
  const restarted = loadSafariConfigStorage(local, sync);
  const restored = await restarted.loadStoredConfig();
  assert.equal(restored.motrixNextPort, '16999');
  assert.equal(restored.aria2Rpc, 'http://localhost:7777/jsonrpc');
  assert.equal(restarted.activeConfigStorageArea, 'local');
  assert.match(readSafariBackground(), /areaName !== activeConfigStorageArea/);
});

test('Safari migrates old sync-marked local backups without replacing saved ports', async () => {
  for (const marker of ['sync', undefined]) {
    const local = { __downlinkConfigStorageArea: marker, motrixNextPort: '16999' };
    const runtime = loadSafariConfigStorage(local, { motrixNextPort: '16801' });
    assert.equal((await runtime.loadStoredConfig()).motrixNextPort, '16999');
    assert.equal(local.__downlinkConfigStorageArea, 'local');
  }
});

test('Safari imports existing sync settings when local storage is empty', async () => {
  const local = {};
  const runtime = loadSafariConfigStorage(local, { motrixNextPort: '16999' });
  assert.equal((await runtime.loadStoredConfig()).motrixNextPort, '16999');
  assert.equal(local.motrixNextPort, '16999');
});

test('Safari rejects saves when local persistence fails and retains readable settings', async () => {
  const runtime = loadSafariConfigStorage({ motrixNextPort: '16999' }, {}, { failLocalWrite: true });
  assert.equal((await runtime.loadStoredConfig()).motrixNextPort, '16999');
  await assert.rejects(runtime.saveStoredConfig({ motrixNextPort: '17000' }), /local write failed/);
});

test('Safari settings flow keeps the persistent host app alive', () => {
  const source = fs.readFileSync(safariViewControllerPath, 'utf8');
  const appDelegateSource = fs.readFileSync(safariAppDelegatePath, 'utf8');
  const mainHtml = fs.readFileSync(safariHostMainHtmlPath, 'utf8');
  const hostScript = fs.readFileSync(safariHostScriptPath, 'utf8');

  assert.match(source, /func windowShouldClose\(_ sender: NSWindow\) -> Bool/);
  assert.match(source, /hideSetupWindow\(\)/);
  assert.match(source, /setActivationPolicy\(\.accessory\)/);
  assert.match(source, /return false/);
  assert.doesNotMatch(source, /terminate\(/);
  assert.match(appDelegateSource, /applicationShouldTerminateAfterLastWindowClosed/);
  assert.match(appDelegateSource, /applicationShouldHandleReopen/);
  assert.match(appDelegateSource, /SO_NOSIGPIPE/);
  assert.match(appDelegateSource, /func sendAll/);
  assert.match(appDelegateSource, /keyAELaunchedAsLogInItem/);
  assert.match(appDelegateSource, /launchedAsLoginItem/);
  assert.doesNotMatch(mainHtml, /Quit and Open/);
  assert.doesNotMatch(hostScript, /Quit and Open/);
});


test('Safari read failures never overwrite saved settings or commit migration', async () => {
  for (const failures of [{ failLocalRead: true }, { failSyncRead: true }, { failLocalRead: true, failSyncRead: true }]) {
    const local = { motrixNextPort: '16999' };
    const sync = { motrixNextPort: '17000' };
    await loadSafariConfigStorage(local, sync, failures).loadStoredConfig();
    assert.deepEqual(local, { motrixNextPort: '16999' });
    assert.equal((await loadSafariConfigStorage(local, sync).loadStoredConfig()).motrixNextPort, '16999');
  }
  const local = {};
  const sync = { motrixNextPort: '17000' };
  await loadSafariConfigStorage(local, sync, { failSyncRead: true }).loadStoredConfig();
  assert.deepEqual(local, {});
  assert.equal((await loadSafariConfigStorage(local, sync).loadStoredConfig()).motrixNextPort, '17000');
});
