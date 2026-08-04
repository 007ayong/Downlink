const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const rootDir = path.resolve(__dirname, '..');
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

function write(root, file, contents) {
  const target = path.resolve(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, contents);
}

function safariJs(contents) {
  return Buffer.concat([UTF8_BOM, Buffer.from(contents)]);
}

function createFixture(t) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'downlink-safari-sync-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));

  const resourcesDir = path.resolve(
    fixture,
    'safari/Downlink/Downlink Extension/Resources',
  );
  write(fixture, 'manifest.json', '{"version":"1.2.3"}\n');
  write(fixture, 'package.json', '{"version":"1.2.3"}\n');
  write(
    fixture,
    'safari/Downlink/Downlink.xcodeproj/project.pbxproj',
    'MARKETING_VERSION = 1.2.3;\nCURRENT_PROJECT_VERSION = 3;\n',
  );
  write(fixture, 'safari/Downlink/Downlink Extension/Resources/manifest.json', '{"version":"1.2.3"}\n');
  write(fixture, 'shared.js', 'same\n');
  write(fixture, 'safari/Downlink/Downlink Extension/Resources/shared.js', safariJs('same\n'));
  write(fixture, 'shared-dir/nested.txt', 'same nested\n');
  write(fixture, 'safari/Downlink/Downlink Extension/Resources/shared-dir/nested.txt', 'same nested\n');
  write(fixture, 'safari/Downlink/Downlink Extension/Resources/safari-only.js', safariJs('Safari implementation\n'));

  return {
    rootDir: fixture,
    resourcesDir,
    sharedFiles: ['shared.js'],
    sharedDirectories: ['shared-dir'],
    safariOnlyFiles: ['manifest.json', 'safari-only.js'],
  };
}

test('Safari preflight is read-only and reports version and shared-file drift', async (t) => {
  const { checkSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  const packagePath = path.resolve(fixture.rootDir, 'package.json');
  const sharedPath = path.resolve(fixture.resourcesDir, 'shared.js');
  write(fixture.rootDir, 'package.json', '{"version":"9.9.9"}\n');
  write(fixture.resourcesDir, 'shared.js', 'stale\n');

  const packageBefore = fs.readFileSync(packagePath);
  const sharedBefore = fs.readFileSync(sharedPath);
  assert.throws(
    () => checkSafariResources(fixture),
    (error) => {
      assert.match(error.message, /package\.json version is 9\.9\.9, expected 1\.2\.3/);
      assert.match(error.message, /shared resource differs: shared\.js/);
      return true;
    },
  );
  assert.deepEqual(fs.readFileSync(packagePath), packageBefore);
  assert.deepEqual(fs.readFileSync(sharedPath), sharedBefore);
});

test('Safari preflight reports Xcode and Safari manifest version drift', async (t) => {
  const { checkSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  write(fixture.resourcesDir, 'manifest.json', '{"version":"1.2.2"}\n');
  write(
    fixture.rootDir,
    'safari/Downlink/Downlink.xcodeproj/project.pbxproj',
    'MARKETING_VERSION = 1.2.2;\nCURRENT_PROJECT_VERSION = 2;\n',
  );

  assert.throws(
    () => checkSafariResources(fixture),
    (error) => {
      assert.match(error.message, /Safari manifest version is 1\.2\.2, expected 1\.2\.3/);
      assert.match(error.message, /Xcode MARKETING_VERSION is 1\.2\.2, expected 1\.2\.3/);
      assert.match(error.message, /Xcode CURRENT_PROJECT_VERSION is 2, expected 3/);
      return true;
    },
  );
});

test('Safari preflight rejects missing Safari-only and directory resources', async (t) => {
  const { checkSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  fs.rmSync(path.resolve(fixture.resourcesDir, 'safari-only.js'));
  fs.rmSync(path.resolve(fixture.resourcesDir, 'shared-dir/nested.txt'));
  write(fixture.resourcesDir, 'shared-dir/unexpected.txt', 'unexpected\n');

  assert.throws(
    () => checkSafariResources(fixture),
    (error) => {
      assert.match(error.message, /Safari-only resource missing: safari-only\.js/);
      assert.match(error.message, /Safari shared resource missing: shared-dir\/nested\.txt/);
      assert.match(error.message, /unexpected Safari shared resource: shared-dir\/unexpected\.txt/);
      return true;
    },
  );
});

test('Safari preflight ignores Finder metadata in shared directories', async (t) => {
  const { checkSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  write(fixture.rootDir, 'shared-dir/.DS_Store', 'source Finder state\n');
  write(fixture.resourcesDir, 'shared-dir/.DS_Store', 'different Safari Finder state\n');

  assert.doesNotThrow(() => checkSafariResources(fixture));
});

test('Safari sync validates every source before writing anything', async (t) => {
  const { syncSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  const packagePath = path.resolve(fixture.rootDir, 'package.json');
  const safariManifestPath = path.resolve(fixture.resourcesDir, 'manifest.json');
  const xcodeProjectPath = path.resolve(
    fixture.rootDir,
    'safari/Downlink/Downlink.xcodeproj/project.pbxproj',
  );
  const sharedPath = path.resolve(fixture.resourcesDir, 'shared.js');
  write(fixture.rootDir, 'package.json', '{"version":"1.2.2"}\n');
  write(fixture.resourcesDir, 'manifest.json', '{"version":"1.2.2"}\n');
  write(
    fixture.rootDir,
    'safari/Downlink/Downlink.xcodeproj/project.pbxproj',
    'MARKETING_VERSION = 1.2.2;\nCURRENT_PROJECT_VERSION = 2;\n',
  );
  write(fixture.resourcesDir, 'shared.js', 'stale\n');
  fixture.sharedDirectories.push('missing-dir');

  const before = new Map(
    [packagePath, safariManifestPath, xcodeProjectPath, sharedPath]
      .map((file) => [file, fs.readFileSync(file)]),
  );
  assert.throws(
    () => syncSafariResources(fixture),
    /shared source directory missing: missing-dir\//,
  );
  for (const [file, contents] of before) {
    assert.deepEqual(fs.readFileSync(file), contents);
  }
});

test('Safari sync does not copy Finder metadata', async (t) => {
  const { syncSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  const safariMetadataPath = path.resolve(fixture.resourcesDir, 'shared-dir/.DS_Store');
  write(fixture.rootDir, 'shared-dir/.DS_Store', 'source Finder state\n');
  write(fixture.resourcesDir, 'shared-dir/.DS_Store', 'Safari Finder state\n');

  syncSafariResources(fixture);

  assert.equal(fs.existsSync(safariMetadataPath), false);
});

test('Safari preflight requires a UTF-8 BOM on every JavaScript file', async (t) => {
  const { checkSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  write(fixture.resourcesDir, 'shared.js', 'same\n');
  write(fixture.resourcesDir, 'safari-only.js', 'Safari implementation\n');

  assert.throws(
    () => checkSafariResources(fixture),
    (error) => {
      assert.match(error.message, /shared resource differs: shared\.js/);
      assert.match(error.message, /Safari JavaScript file missing UTF-8 BOM: shared\.js/);
      assert.match(error.message, /Safari JavaScript file missing UTF-8 BOM: safari-only\.js/);
      return true;
    },
  );
});

test('Safari sync prepends a UTF-8 BOM to shared JavaScript files', async (t) => {
  const { checkSafariResources, syncSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  write(fixture.resourcesDir, 'shared.js', 'stale\n');

  syncSafariResources(fixture);

  assert.deepEqual(
    fs.readFileSync(path.resolve(fixture.resourcesDir, 'shared.js')),
    safariJs('same\n'),
  );
  assert.doesNotThrow(() => checkSafariResources(fixture));
});

test('Safari sync leaves non-JavaScript files byte-identical and is idempotent', async (t) => {
  const { syncSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  const nestedPath = path.resolve(fixture.resourcesDir, 'shared-dir/nested.txt');
  const nestedBefore = fs.readFileSync(nestedPath);

  syncSafariResources(fixture);
  assert.deepEqual(fs.readFileSync(nestedPath), nestedBefore);
  assert.doesNotThrow(() => syncSafariResources(fixture));
});

test('Safari sync restores a missing UTF-8 BOM on Safari-only JavaScript files', async (t) => {
  const { checkSafariResources, syncSafariResources } = await import(
    path.join(rootDir, 'scripts/sync-safari-resources.mjs')
  );
  const fixture = createFixture(t);
  write(fixture.resourcesDir, 'safari-only.js', 'Safari implementation\n');

  syncSafariResources(fixture);

  assert.deepEqual(
    fs.readFileSync(path.resolve(fixture.resourcesDir, 'safari-only.js')),
    safariJs('Safari implementation\n'),
  );
  assert.doesNotThrow(() => checkSafariResources(fixture));
});

test('safari:build runs the read-only preflight before xcodebuild', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.resolve(rootDir, 'package.json'), 'utf8'));
  assert.equal(
    packageJson.scripts['safari:check'],
    'node scripts/sync-safari-resources.mjs --check',
  );
  assert.match(packageJson.scripts['safari:build'], /^npm run safari:check && xcodebuild /);
  assert.doesNotMatch(
    packageJson.scripts['safari:build'],
    /sync-safari-resources\.mjs(?! --check)/,
  );
});
