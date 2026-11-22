const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'popup-app.js'), 'utf8');

function render(commit) {
  const elements = { extensionVersionValue: {}, extensionBuildValue: {} };
  const fn = source.match(/function renderExtensionVersion\(\) \{[\s\S]*?\n\}/)[0];
  vm.runInNewContext(`${fn}\nrenderExtensionVersion();`, {
    POPUP_BUILD_COMMIT: commit,
    getExtensionVersion: () => '1.3.14',
    document: { getElementById: (id) => elements[id] },
  });
  return elements.extensionBuildValue;
}

test('popup displays clean and dirty build hashes and hides unstamped source', () => {
  const hash = 'a'.repeat(40);
  assert.equal(render(hash).textContent, 'aaaaaaaa');
  assert.equal(render(hash).hidden, false);
  assert.equal(render(hash).title, `Git: ${hash}`);
  assert.equal(render(hash + '*').textContent, 'aaaaaaaa*');
  assert.match(render(hash + '*').title, /uncommitted changes/);
  assert.equal(render('__DOWNLINK_BUILD_COMMIT__').hidden, true);
});

test('packaging and Safari stamp the actual Git HEAD and working tree state', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'downlink-build-commit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const copy = (file) => {
    const dst = path.join(dir, file);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(path.join(root, file), dst, { recursive: true });
  };
  const script = fs.readFileSync(path.join(root, 'scripts/package-extension.mjs'), 'utf8');
  const files = [...script.match(/const archivePaths = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const file of [...files, 'package.json', 'scripts/package-extension.mjs', 'scripts/sync-versions.mjs',
    'scripts/stamp-safari-build.sh', 'safari/Downlink/Downlink.xcodeproj/project.pbxproj',
    'safari/Downlink/Downlink Extension/Resources/manifest.json',
    'safari/Downlink/Downlink Extension/Resources/popup-app.js']) copy(file);
  fs.writeFileSync(path.join(dir, '.gitignore'), 'dist/\n');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  const commit = () => {
    git('-c', 'user.name=Build Test', '-c', 'user.email=build@example.com', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture');
    return git('rev-parse', 'HEAD');
  };
  let hash = commit();
  const build = (suffix) => {
    execFileSync(process.execPath, ['scripts/package-extension.mjs', 'all'], { cwd: dir });
    for (const target of ['chromium', 'firefox']) {
      const contents = fs.readFileSync(path.join(dir, 'dist', target, 'popup-app.js'), 'utf8');
      assert.ok(contents.includes(`const POPUP_BUILD_COMMIT = '${hash}${suffix}';`));
      const version = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'))).version;
      const archived = execFileSync('unzip', ['-p', `dist/downlink-v${version}-${target}.zip`, 'popup-app.js'], { cwd: dir, encoding: 'utf8' });
      assert.equal(archived, contents);
    }
    const output = path.join(dir, 'dist/safari/Resources');
    fs.mkdirSync(output, { recursive: true });
    execFileSync('sh', ['scripts/stamp-safari-build.sh'], {
      cwd: dir,
      env: { ...process.env, SRCROOT: path.join(dir, 'safari/Downlink'), TARGET_BUILD_DIR: path.join(dir, 'dist/safari'), UNLOCALIZED_RESOURCES_FOLDER_PATH: 'Resources' },
    });
    assert.ok(fs.readFileSync(path.join(output, 'popup-app.js'), 'utf8').includes(`const POPUP_BUILD_COMMIT = '${hash}${suffix}';`));
  };
  build('');
  assert.equal(git('status', '--porcelain'), '');
  fs.appendFileSync(path.join(dir, 'popup-app.js'), '\n// local edit\n');
  build('*');
  git('add', 'popup-app.js');
  hash = commit();
  build('');
});
