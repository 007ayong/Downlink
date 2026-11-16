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
const safariPopupPath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink Extension',
  'Resources',
  'popup.js'
);
const safariPopupAppPath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink Extension',
  'Resources',
  'popup-app.js'
);
const safariPopupHtmlPath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink Extension',
  'Resources',
  'popup.html'
);
const safariHandlerPath = path.join(
  __dirname,
  '..',
  'safari',
  'Downlink',
  'Downlink Extension',
  'SafariWebExtensionHandler.swift'
);

function readSafariBackground() {
  return fs.readFileSync(safariBackgroundPath, 'utf8');
}

test('Safari sends local downloader HTTP requests through the native loopback bridge', () => {
  const background = readSafariBackground();
  const handler = fs.readFileSync(safariHandlerPath, 'utf8');
  assert.match(background, /async function safariLocalServiceFetch/);
  assert.match(background, /'127\.0\.0\.1', 'localhost', '\[::1\]'/);
  assert.match(background, /type: 'LOCAL_HTTP_REQUEST'/);
  assert.match(background, /fetchRequest: safariLocalServiceFetch/);
  assert.match(handler, /LOCAL_HTTP_REQUEST/);
  assert.match(handler, /"127\.0\.0\.1", "localhost", "::1"/);
  assert.match(handler, /URLSession\.shared\.dataTask/);
});

function loadSafariRedirectPatternBuilder() {
  const source = readSafariBackground();
  const functionSource = source.slice(
    source.indexOf('function buildSafariDownloadRedirectPatterns'),
    source.indexOf('function isSafariDnrDownloadCandidate')
  );
  const context = { ConfigDefaults: require('../lib/config-defaults.js') };
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

function loadSafariBadgeUpdater(badgeError, synchronouslyThrowingOperation = '') {
  const source = readSafariBackground();
  const functionSource = source.slice(
    source.indexOf('function observeTabScopedActionCall'),
    source.indexOf('function getActiveTabs')
  );
  const calls = [];
  const warnings = [];
  const rejectBadgeUpdate = (operation, payload) => {
    calls.push({ operation, payload });
    if (operation === synchronouslyThrowingOperation) throw new Error(badgeError);
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

test('Safari media tasks preserve stream metadata for Rayburst', () => {
  const source = readSafariBackground();
  const handler = source.slice(
    source.indexOf("case 'ADD_MEDIA_TASK'"),
    source.indexOf("case 'GET_MEDIA_ITEM'")
  );
  assert.match(handler, /kind: media\.kind \|\| ''/);
  assert.match(handler, /streamProtocol: media\.streamProtocol \|\| ''/);
  assert.match(handler, /isLive: typeof media\.isLive === 'boolean' \? media\.isLive : undefined/);
  assert.match(handler, /pageTitle: media\.pageTitle \|\| ''/);
  assert.match(handler, /taskOrigin: 'media-sniffing'/);
  assert.match(handler, /motrixNextConnectionConfig: msg\.connectionConfig/);
  const sendWrapper = source.slice(
    source.indexOf('async function hydrateSafariTaskRequestContext'),
    source.indexOf('async function pollTasks')
  );
  assert.match(sendWrapper, /await getCookieHeaderForUrl\(taskInfo\.url\)/);
  assert.match(sendWrapper, /if \(cookieHeader\) headers\.cookie = cookieHeader/);
  assert.match(sendWrapper, /headers\['user-agent'\] = navigator\.userAgent/);
  assert.match(sendWrapper, /sendTaskToDownloader\(hydratedTaskInfo, extraOpts, providerContext\)/);
});

test('Safari packages the complete Rayburst collection merge workflow', () => {
  const background = readSafariBackground();
  const popupApp = fs.readFileSync(safariPopupAppPath, 'utf8');
  const popupHtml = fs.readFileSync(safariPopupHtmlPath, 'utf8');
  const handler = background.slice(
    background.indexOf("case 'ADD_RAYBURST_MEDIA_COLLECTION'"),
    background.indexOf("case 'GET_MEDIA_ITEM'")
  );

  assert.match(popupHtml, /id="rayburstMergeBar"/);
  assert.match(popupHtml, /id="rayburstMergeFormatPicker"/);
  assert.match(popupApp, /type: 'ADD_RAYBURST_MEDIA_COLLECTION'/);
  assert.match(popupApp, /currentConfig\.downloaderType === 'motrixnext'/);
  assert.match(handler, /hydrateSafariTaskRequestContext/);
  assert.match(handler, /sendRayburstCollection/);
  assert.match(handler, /msg\.format/);
});

test('Safari popup exposes the media display classifier used by media cards', () => {
  const source = fs.readFileSync(safariPopupPath, 'utf8');
  assert.match(source, /const \{[\s\S]*\bmediaDisplayKind,[\s\S]*\} = popupUi;/);
  assert.match(source, /globalThis\.mediaDisplayKind = mediaDisplayKind;/);
});

test('Safari popup leaves preview header preparation to the preview page', () => {
  const source = fs.readFileSync(safariPopupPath, 'utf8');
  const start = source.indexOf('function openPreviewTab');
  const end = source.indexOf('\nglobalThis.DEFAULT_HEADER_LOGO', start);
  const openPreviewFunction = source.slice(start, end);

  assert.match(openPreviewFunction, /chrome\.tabs\.create/);
  assert.doesNotMatch(openPreviewFunction, /PREPARE_MEDIA_PREVIEW/);
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

test('Safari badge text still updates when a badge color API throws synchronously', () => {
  const runtime = loadSafariBadgeUpdater('Unsupported API', 'setBadgeBackgroundColor');

  runtime.updateBadge(12, 2);

  assert.deepEqual(runtime.calls.map((call) => call.operation), [
    'setBadgeBackgroundColor',
    'setBadgeTextColor',
    'setBadgeText',
  ]);
  assert.equal(runtime.calls.at(-1).payload.text, '2');
});

test('Safari content script parses finite HLS manifests before media-element probing', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'content-script.js'), 'utf8');
  assert.match(source, /const parseHlsManifestMetadata/);
  assert.match(source, /#EXTINF:/);
  assert.match(source, /RESOLUTION/);
  assert.match(source, /#EXT-X-ENDLIST/);
  assert.match(source, /isLive: hlsMetadata\.isLive/);
});

test('Safari background metadata probing uses the Promise form of tabs.sendMessage', () => {
  const source = readSafariBackground();
  const start = source.indexOf('function probeMediaMetadataInTab');
  const end = source.indexOf('\nconst mediaManager =', start);
  const probeFunction = source.slice(start, end);

  assert.match(probeFunction, /const request = chrome\.tabs\.sendMessage/);
  assert.match(probeFunction, /request\.then\(finish/);
  assert.doesNotMatch(probeFunction, /chrome\.tabs\.sendMessage\([\s\S]*?\},\s*\(result\)/);
});

test('Safari resets media before navigation instead of after early HLS responses', () => {
  const source = readSafariBackground();
  const committedHandler = source.slice(
    source.indexOf("chrome.webNavigation?.onCommitted?.addListener?."),
    source.indexOf("chrome.webNavigation?.onCreatedNavigationTarget?.addListener?.")
  );
  const beforeNavigateHandler = source.slice(
    source.indexOf("chrome.webNavigation?.onBeforeNavigate?.addListener?."),
    source.indexOf("chrome.webNavigation?.onErrorOccurred?.addListener?.")
  );
  const updatedHandler = source.slice(
    source.indexOf("chrome.tabs.onUpdated.addListener"),
    source.indexOf("chrome.runtime.onStartup.addListener")
  );

  assert.doesNotMatch(committedHandler, /clearTabState|clearPreviewRule/);
  assert.match(committedHandler, /syncMediaSniffingStateForTab\(details\.tabId, details\.url\)/);
  assert.match(beforeNavigateHandler, /mediaManager\.clearTabState\(details\.tabId\)/);
  assert.match(beforeNavigateHandler, /mediaManager\.clearPreviewRule\(details\.tabId\)/);
  assert.doesNotMatch(updatedHandler, /clearTabState|clearPreviewRule/);
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
  assert.match(installFunction, /type: 'redirect'/);
  assert.match(installFunction, /regexSubstitution: `\$\{bridgeUrl\}\/\?url=\\\\1#\\\\1`/);
  assert.match(installFunction, /condition: \{\s+regexFilter,\s+isUrlFilterCaseSensitive,/);
  assert.doesNotMatch(installFunction, /extensionPath:/);
  assert.doesNotMatch(installFunction, /type: 'block'/);
});

test('Safari queues session-rule mutations and avoids reinstalling unchanged redirects', async () => {
  const source = readSafariBackground();
  const updates = [];
  const timers = [];
  let reads = 0;
  let activeWrites = 0;
  const context = {
    config: { autoCapture: true, pattern: 'zip' },
    safariLocalBridgeUrl: 'http://127.0.0.1:1234',
    SAFARI_DOWNLOAD_REDIRECT_RULE_IDS: [80000001, 80000002],
    SAFARI_DOWNLOAD_BYPASS_RULE_ID_BASE: 81000000,
    safariDnrBypassRules: new Map(),
    safariDnrQueue: Promise.resolve(),
    buildSafariDownloadRedirectPatterns: () => [
      { regexFilter: context.config.pattern, isUrlFilterCaseSensitive: false },
    ],
    ensureSafariLocalBridge: async () => context.safariLocalBridgeUrl,
    setTimeout: (callback) => timers.push(callback),
    writeProbeLog: () => {},
    chrome: {
      declarativeNetRequest: {
        async updateSessionRules(options) {
          activeWrites += 1;
          assert.equal(activeWrites, 1);
          await Promise.resolve();
          updates.push(structuredClone(options));
          activeWrites -= 1;
        },
        async getSessionRules() {
          reads += 1;
          return [{ id: 81000007, action: { type: 'allow' }, condition: { tabIds: [7] } }];
        },
      },
    },
  };
  const operations = source.slice(
    source.indexOf('function queueSafariDnrOperation'),
    source.indexOf('async function probeSafariLocalBridge')
  ) + source.slice(
    source.indexOf('async function installSafariDownloadRedirectRules'),
    source.indexOf('function addHostnameToMediaSniffingBlacklist')
  );
  vm.runInNewContext(
    `let safariDnrBypassRecovery, safariDownloadRulesKey, safariInstalledDownloadRuleIds;
     let safariInstalledDownloadBridge = '';
     ${operations}`,
    context
  );

  const sync = () => context.installSafariDownloadRedirectRules();
  const url = 'https://example.com/download.zip';
  assert.deepEqual(await Promise.all([
    sync(), sync(), context.isSafariDnrBypassActive(7, url), context.isSafariDnrBypassActive(8, url),
  ]), [true, true, true, false]);
  assert.equal(reads, 1);
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], { removeRuleIds: [80000001, 80000002], addRules: [] });
  assert.deepEqual(updates[1].removeRuleIds, []);

  context.config.pattern = 'exe';
  await Promise.all([sync(), context.updateSafariSessionRules({ removeRuleIds: [42] })]);
  assert.equal(updates.length, 4);
  const replacement = updates.find((entry) => entry.addRules?.[0]?.condition.regexFilter === 'exe');
  assert.deepEqual(replacement.removeRuleIds, [80000001]);

  context.safariLocalBridgeUrl = '';
  await Promise.all([sync(), sync()]);
  assert.equal(updates.length, 5);
  assert.deepEqual(updates[4], { removeRuleIds: [80000001], addRules: [] });
  context.safariLocalBridgeUrl = 'http://127.0.0.1:4321';
  await sync();
  assert.equal(updates.length, 6);
  assert.match(updates[5].addRules[0].action.redirect.regexSubstitution, /:4321/);

  assert.equal(await context.installSafariDnrBypassRule(7, url), true);
  await timers[0]();
  assert.equal(await context.isSafariDnrBypassActive(7, url), true);
  await timers[1]();
  assert.equal(await context.isSafariDnrBypassActive(7, url), false);
  assert.equal(reads, 1);
});

test('Safari wildcard DNR patterns require a file extension in the URL path', () => {
  const buildPatterns = loadSafariRedirectPatternBuilder();
  const patterns = buildPatterns({ captureExtensions: '*' }).map(({ regexFilter }) => new RegExp(regexFilter, 'i'));
  const matches = (url) => patterns.some((pattern) => pattern.test(url));

  assert.equal(matches('https://google.com'), false);
  assert.equal(matches('https://sub.example.com?source=test'), false);
  assert.equal(matches('https://example.com/releases/file.zip'), true);
  assert.equal(matches('https://example.com/releases/file.zip?token=abc'), true);
});

test('Safari DNR allowlist matches opaque redirect targets and preserves the signed URL', () => {
  const buildPatterns = loadSafariRedirectPatternBuilder();
  const rules = buildPatterns({
    captureExtensions: 'zip',
    safariDownloadAllowlist: 'cdn.example.com/File, files.example.com/releases/?action=download, ignored.example',
  });
  const capture = (url) => rules
    .map(({ regexFilter, isUrlFilterCaseSensitive }) =>
      new RegExp(regexFilter, isUrlFilterCaseSensitive ? '' : 'i').exec(url)?.[1])
    .find(Boolean);

  const target = 'https://cdn.example.com/File?id=123&sig=a%2Fb%3D';
  const prefixTarget = 'https://files.example.com/releases/build?sig=a%2Fb&action=download&part=1';
  assert.equal(capture(target), target);
  assert.equal(capture(prefixTarget), prefixTarget);
  for (const url of [
    'https://cdn.example.com/file',
    'https://cdn.example.com/FilePreview',
    'https://cdn.example.com.evil.test/File',
    'https://files.example.com/releases-other/build?action=download',
    'https://files.example.com/releases/build?action=preview',
    'https://files.example.com/releases/build?xaction=download',
    'https://files.example.com/releases/build?action=download-preview',
    'https://ignored.example/login',
  ]) assert.equal(capture(url), undefined, url);
  assert.equal(capture('https://example.com/file.ZIP'), 'https://example.com/file.ZIP');
});

test('Safari resolves allowlisted filenames from headers and defers opaque names when HEAD fails', async () => {
  const source = readSafariBackground();
  const context = {
    URL, AbortController, setTimeout, clearTimeout,
    ...require('../filename-logic.js'),
    config: { safariDownloadAllowlist: 'cdn.example.com/file' },
    ConfigDefaults: require('../lib/config-defaults.js'),
    responseHeadersCache: new Map(),
  };
  const code = source.slice(source.indexOf('function isSafariDownloadAllowlisted'), source.indexOf('function isSafariDnrDownloadCandidate'))
    + source.slice(source.indexOf('function normalizeSourceFilename'), source.indexOf('function rememberDownloadClickIntent'))
    + source.slice(source.indexOf('function preferredUrlFilename'), source.indexOf('function getResponseHeaderValue'))
    + source.slice(source.indexOf('async function resolveSafariDownloadMetadata'), source.indexOf('function captureSafariUrlDirectly'));
  vm.runInNewContext(code, context);

  const url = 'https://cdn.example.com/file?token=a%2Fb';
  const requests = [];
  const disposition = "attachment; filename=fallback.zip; filename*=UTF-8''%E6%8A%A5%E5%91%8A.zip";
  context.fetch = async (target, options) => {
    requests.push({ target, options });
    return new Response(null, { headers: { 'content-disposition': disposition, 'content-type': 'application/zip' } });
  };
  const resolve = (target = url, options) => context.resolveSafariDownloadMetadata(target, {}, '', options);
  const result = await resolve();
  assert.equal(result.filename, '报告.zip');
  assert.equal(result.mime, 'application/zip');
  assert.equal(requests[0].target, url);
  assert.equal(requests[0].options.method, 'HEAD');
  assert.equal(requests[0].options.credentials, 'include');

  const signed = `${url}&response-content-disposition=${encodeURIComponent(disposition)}`;
  assert.equal((await resolve(signed)).filename, '报告.zip');
  assert.equal((await resolve('https://cdn.example.com/release.zip')).filename, 'release.zip');
  assert.equal((await resolve('https://cdn.example.com/other', { downloadFilename: '报告.zip' })).filename, '报告.zip');
  assert.equal(requests.length, 1);
  assert.equal((await resolve('https://cdn.example.com/other')).filename, '报告.zip');

  context.fetch = async () => new Response(null, { status: 405 });
  assert.equal((await resolve(`${url}&filename=release.zip`)).filename, 'release.zip');
  const fallback = await resolve();
  assert.equal(fallback.filename, '');
  assert.equal(fallback.autoDetectFilename, true);

  context.fetch = async () => ({
    ok: true,
    url: 'https://cdn.example.com/login.html',
    headers: new Headers({ 'content-type': 'text/html; charset=UTF-8' }),
  });
  const login = await resolve();
  assert.equal(login.filename, '');
  assert.equal(login.mime, '');
  assert.equal(login.autoDetectFilename, true);

  context.fetch = async () => new Response(null, {
    headers: { 'content-type': 'text/html', 'content-disposition': 'attachment; filename=report.html' },
  });
  assert.equal((await resolve()).filename, 'report.html');
});

test('Safari opens direct-click confirmation before filename lookup and gates downloader submission', async () => {
  const source = readSafariBackground();
  const handler = source.slice(source.indexOf("case 'CAPTURE_LINK_DOWNLOAD'"), source.indexOf("case 'REJECT_DOWNLOAD'"));
  const pendingDownloads = {};
  const events = [];
  let requiresConfirmation = true;
  let finishLookup;
  const context = {
    URL,
    config: { autoCapture: true },
    requestHeadersCache: new Map(),
    getCookieHeaderForUrl: async () => '',
    pendingDownloads,
    isDownloadInterceptionBlockedForSource: () => false,
    deriveOrigin: () => '',
    shouldConfirmBeforeSend: () => requiresConfirmation,
    enqueuePendingDownload: async (item, { openSurface }) => {
      assert.equal(openSurface, false);
      pendingDownloads[item.key] = item;
      events.push('queued');
      return item.key;
    },
    openTaskSurfaceForTask: async () => { events.push('panel'); },
    resolveSafariDownloadMetadata: () => new Promise((resolve) => {
      events.push('lookup');
      finishLookup = resolve;
    }),
    broadcastUpdate: () => {},
    writeProbeLog: () => {},
    sendTask: async (item) => { events.push(item.filename); return { ok: true }; },
    queueOrSendCapturedDownload: async (item) => { events.push(item.filename); return { ok: true }; },
  };
  vm.runInNewContext(`this.handle = async (msg, sendResponse, sender = {}) => { switch (msg.type) { ${handler} } };`, context);

  let reply;
  const click = { type: 'CAPTURE_LINK_DOWNLOAD', url: 'https://example.com/file?id=1' };
  const capture = context.handle(click, (result) => { reply = result; });
  await new Promise(setImmediate);
  assert.deepEqual(events, ['queued', 'panel', 'lookup']);
  const key = reply.key;
  assert.equal(pendingDownloads[key].filenameResolving, true);
  await context.handle({ type: 'CONFIRM_DOWNLOAD', key }, (result) => { reply = result; });
  assert.equal(reply.filenameResolving, true);
  finishLookup({ filename: '报告.zip' });
  await capture;
  assert.equal(pendingDownloads[key].filename, '报告.zip');
  await context.handle({ type: 'CONFIRM_DOWNLOAD', key, filename: '重命名.zip' }, () => {});
  assert.equal(events.at(-1), '重命名.zip');
  assert.equal(pendingDownloads[key], undefined);

  events.length = 0;
  requiresConfirmation = false;
  const silent = context.handle(click, () => {});
  await new Promise(setImmediate);
  assert.deepEqual(events, ['lookup']);
  finishLookup({ filename: '报告.zip' });
  await silent;
  assert.deepEqual(events, ['lookup', '报告.zip']);
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

test('Safari uses the generic successful-task hook for floating-panel rotation', () => {
  const source = readSafariBackground();
  const clients = source.slice(
    source.indexOf('const downloaderClients = downloaders.createClients'),
    source.indexOf('function rayburstMergeTrackType')
  );
  assert.match(clients, /onTaskAccepted/);
  assert.match(clients, /if \(!trackable \|\| !gid\)/);
  assert.doesNotMatch(clients, /onBeforeAria2Send|onAria2TaskQueued|onGopeedTaskQueued/);
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
    DEFAULT_CONFIG: { downloaderType: 'aria2', aria2Rpc: 'http://localhost:6800/jsonrpc', motrixNextPort: '29110' },
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
  const sync = { motrixNextPort: '29110' };
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
    const runtime = loadSafariConfigStorage(local, { motrixNextPort: '29110' });
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
