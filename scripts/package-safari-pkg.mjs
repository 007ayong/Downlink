import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const { version } = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const dist = join(root, 'dist');
const app = join(dist, 'safari/DerivedData/Build/Products/Release/Downlink.app');
const output = join(dist, `downlink-v${version}-safari.pkg`);
const appVersion = execFileSync('/usr/libexec/PlistBuddy', [
  '-c', 'Print CFBundleShortVersionString', join(app, 'Contents/Info.plist'),
], { encoding: 'utf8' }).trim();

if (appVersion !== version) {
  throw new Error(`Downlink.app version ${appVersion} does not match ${version}. Run npm run safari:build.`);
}

const work = mkdtempSync(join(dist, '.safari-pkg-'));
try {
  const payload = join(work, 'payload');
  const components = join(work, 'components.plist');
  const installer = join(work, 'Downlink.pkg');
  mkdirSync(payload);
  // Archive the app so downloading the installer does not expose another
  // runnable Safari extension host to Launch Services.
  execFileSync('/usr/bin/ditto', [app, join(payload, 'Downlink.app')], { stdio: 'inherit' });
  execFileSync('/usr/bin/pkgbuild', ['--analyze', '--root', payload, components], { stdio: 'inherit' });
  const componentList = JSON.parse(execFileSync('/usr/bin/plutil', [
    '-convert', 'json', '-o', '-', components,
  ], { encoding: 'utf8' }));
  function disableRelocation(bundles) {
    for (const bundle of bundles) {
      bundle.BundleIsRelocatable = false;
      if (bundle.ChildBundles) disableRelocation(bundle.ChildBundles);
    }
  }
  disableRelocation(componentList);
  writeFileSync(components, JSON.stringify(componentList));
  execFileSync('/usr/bin/plutil', ['-convert', 'xml1', components]);
  const signingIdentity = process.env.DOWNLINK_INSTALLER_SIGN_IDENTITY;
  execFileSync('/usr/bin/pkgbuild', [
    '--root', payload, '--component-plist', components,
    '--identifier', 'cc.winapps.downlink.installer', '--version', version,
    '--install-location', '/Applications',
    ...(signingIdentity ? ['--sign', signingIdentity, '--timestamp'] : []),
    installer,
  ], { stdio: 'inherit' });
  renameSync(installer, output);
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(output);
