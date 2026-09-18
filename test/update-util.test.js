'use strict';

/**
 * Pure update helpers (docs/ARCHITECTURE.md §12): version compare, tag validation, release picking,
 * asset selection per platform/arch/variant, capability detection and the openExternal allowlist.
 * No electron, no network, no fs.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const u = require('../src/main/update-util');

// ---------------------------------------------------------------------------------------------
// versions

test('isValidTag follows the §12 pattern ^v?\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$', () => {
  for (const good of ['1.0.0', 'v1.0.0', '10.20.30', 'v2.0.0-beta', '1.0.0-rc.1', 'v1.0.0-alpha-2', '0.0.0']) {
    assert.equal(u.isValidTag(good), true, good);
  }
  for (const bad of [
    '1.0', 'v1', '1.0.0.0', 'V1.0.0', 'release-1.0.0', '1.0.0+build', ' 1.0.0', '1.0.0 ', 'v 1.0.0',
    '1.0.0-', '1.0.0-beta_1', '1.0.0-üü', '01.0.0-x/y', 'latest', '', 'v'.repeat(80), null, undefined, 1, {}, [],
  ]) {
    assert.equal(u.isValidTag(bad), false, String(bad));
  }
  assert.equal(u.isValidTag(`v1.0.0-${'a'.repeat(100)}`), false, 'length capped');
});

test('parseVersion strips the v prefix and splits the prerelease', () => {
  assert.deepEqual(u.parseVersion('v1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(u.parseVersion('1.2.3-rc.2'), { major: 1, minor: 2, patch: 3, prerelease: ['rc', '2'] });
  assert.equal(u.parseVersion('1.2.3-alpha..1'), null, 'empty identifier');
  assert.equal(u.parseVersion('nope'), null);
  assert.equal(u.normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(u.normalizeVersion('1.2.3'), '1.2.3');
  assert.equal(u.normalizeVersion('x'), null);
});

test('compareVersions: numeric, prerelease and malformed input', () => {
  assert.equal(u.compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(u.compareVersions('v1.0.0', '1.0.0'), 0, 'the v prefix is irrelevant');
  assert.equal(u.compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(u.compareVersions('1.1.0', '1.0.9'), 1);
  assert.equal(u.compareVersions('2.0.0', '10.0.0'), -1, 'numeric, not lexicographic');
  assert.equal(u.compareVersions('1.0.0', '1.0.0-rc.1'), 1, 'a release beats its prerelease');
  assert.equal(u.compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(u.compareVersions('1.0.0-rc.2', '1.0.0-rc.10'), -1, 'numeric identifiers compare numerically');
  assert.equal(u.compareVersions('1.0.0-alpha', '1.0.0-alpha.1'), -1, 'more identifiers win');
  assert.equal(u.compareVersions('1.0.0-alpha.1', '1.0.0-beta'), -1);
  assert.equal(u.compareVersions('1.0.0-1', '1.0.0-alpha'), -1, 'numeric < alphanumeric');
  for (const bad of ['', 'x', '1.0', null, undefined, 1, {}, [], '1.0.0-']) {
    assert.equal(u.compareVersions(bad, '1.0.0'), null, String(bad));
    assert.equal(u.compareVersions('1.0.0', bad), null, String(bad));
  }
});

test('isNewer is strict and never offers a downgrade or a malformed version', () => {
  assert.equal(u.isNewer('1.1.0', '1.0.0'), true);
  assert.equal(u.isNewer('v1.0.1', '1.0.0'), true);
  assert.equal(u.isNewer('1.0.0', '1.0.0'), false, 'equal is not newer');
  assert.equal(u.isNewer('0.9.0', '1.0.0'), false, 'no downgrade');
  assert.equal(u.isNewer('1.0.0-rc.1', '1.0.0'), false);
  assert.equal(u.isNewer('1.0.0', '1.0.0-rc.1'), true);
  for (const bad of ['', 'latest', 'v', '1.0', null, undefined, NaN, {}, [], 'v1.0.0.0']) {
    assert.equal(u.isNewer(bad, '1.0.0'), false, `latest ${String(bad)}`);
    assert.equal(u.isNewer('2.0.0', bad), false, `current ${String(bad)}`);
  }
  assert.equal(u.isPrereleaseVersion('1.0.0-beta.1'), true);
  assert.equal(u.isPrereleaseVersion('1.0.0'), false);
  assert.equal(u.isPrereleaseVersion('nope'), false);
});

// ---------------------------------------------------------------------------------------------
// URL allowlist

test('isAllowedUpdateUrl: only https://github.com/umesh-adhikari/Augen-Pause/releases/…', () => {
  const base = 'https://github.com/umesh-adhikari/Augen-Pause/releases';
  for (const good of [
    `${base}/tag/v1.2.0`,
    `${base}/latest`,
    `${base}/download/v1.2.0/AugenPause-Setup-1.2.0-x64.exe`,
    `${base}/download/v1.2.0/AugenPause-1.2.0-x86_64.AppImage`,
  ]) {
    assert.equal(u.isAllowedUpdateUrl(good), true, good);
  }
  for (const bad of [
    base, // the bare releases page (no trailing slash) is not in the allowlist
    'http://github.com/umesh-adhikari/Augen-Pause/releases/latest', // no plain http
    'https://github.com.evil.example/umesh-adhikari/Augen-Pause/releases/latest',
    'https://evil.example/github.com/umesh-adhikari/Augen-Pause/releases/latest',
    'https://raw.githubusercontent.com/umesh-adhikari/Augen-Pause/releases/x',
    'https://github.com:8443/umesh-adhikari/Augen-Pause/releases/latest',
    'https://user:pass@github.com/umesh-adhikari/Augen-Pause/releases/latest',
    'https://github.com/umesh-adhikari/Other-Repo/releases/latest',
    'https://github.com/someone/Augen-Pause/releases/latest',
    'https://github.com/umesh-adhikari/Augen-Pause/issues/1',
    'https://github.com/umesh-adhikari/Augen-Pause/releases/../../settings',
    'https://github.com/umesh-adhikari/Augen-Pause/releases/%2e%2e/%2e%2e/x',
    'https://github.com/UMESH-ADHIKARI/Augen-Pause/releases/latest',
    'javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,x',
    ' https://github.com/umesh-adhikari/Augen-Pause/releases/latest',
    'https://github.com/umesh-adhikari/Augen-Pause/releases/latest\nX',
    '', null, undefined, 42, {}, [],
  ]) {
    assert.equal(u.isAllowedUpdateUrl(bad), false, String(bad));
  }
  assert.equal(u.isAllowedUpdateUrl(`${base}/download/v1.0.0/${'a'.repeat(3000)}.exe`), false, 'length capped');
  assert.equal(u.isAllowedUpdateUrl(u.LATEST_RELEASE_URL), true, 'the fallback target is allowlisted');
});

test('releasePageUrl only for a valid tag', () => {
  assert.equal(u.releasePageUrl('v1.2.0'), 'https://github.com/umesh-adhikari/Augen-Pause/releases/tag/v1.2.0');
  assert.equal(u.releasePageUrl('1.2.0'), 'https://github.com/umesh-adhikari/Augen-Pause/releases/tag/1.2.0');
  assert.equal(u.isAllowedUpdateUrl(u.releasePageUrl('v1.2.0')), true);
  for (const bad of ['latest', '../evil', '', null, {}]) assert.equal(u.releasePageUrl(bad), null, String(bad));
  assert.equal(u.RELEASES_API_URL, 'https://api.github.com/repos/umesh-adhikari/Augen-Pause/releases');
  assert.equal(u.REPO_SLUG, 'umesh-adhikari/Augen-Pause');
});

// ---------------------------------------------------------------------------------------------
// releases

const DL = 'https://github.com/umesh-adhikari/Augen-Pause/releases/download';

function asset(name, version = '1.2.0') {
  return { name, browser_download_url: `${DL}/v${version}/${name}`, size: 1234 };
}

function release(tag, extra = {}) {
  return {
    tag_name: tag,
    name: `AugenPause ${tag}`,
    body: 'Fixes and improvements',
    html_url: `https://github.com/umesh-adhikari/Augen-Pause/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [],
    ...extra,
  };
}

test('normalizeRelease validates the tag, the URL and every asset', () => {
  const out = u.normalizeRelease(release('v1.2.0', {
    assets: [
      asset('AugenPause-Setup-1.2.0-x64.exe'),
      { name: 'evil.exe', browser_download_url: 'https://evil.example/evil.exe' },
      { name: '../../etc/passwd', browser_download_url: `${DL}/v1.2.0/x.exe` },
      { name: 'AugenPause-1.2.0-x64.dmg' }, // no URL
      'not an object',
    ],
  }));
  assert.equal(out.tag, 'v1.2.0');
  assert.equal(out.version, '1.2.0');
  assert.equal(out.draft, false);
  assert.equal(out.prerelease, false);
  assert.equal(out.url, 'https://github.com/umesh-adhikari/Augen-Pause/releases/tag/v1.2.0');
  assert.deepEqual(out.assets.map((a) => a.name), ['AugenPause-Setup-1.2.0-x64.exe']);
  assert.equal(out.notes, 'AugenPause v1.2.0\n\nFixes and improvements');

  // an untrusted html_url is replaced by the derived (allowlisted) release page
  const spoofed = u.normalizeRelease(release('v1.2.0', { html_url: 'https://evil.example/x' }));
  assert.equal(spoofed.url, 'https://github.com/umesh-adhikari/Augen-Pause/releases/tag/v1.2.0');

  // a tag that is not a version is no release at all
  for (const bad of [release('latest'), release(''), release(null), {}, null, 'x', 42]) {
    assert.equal(u.normalizeRelease(bad), null, JSON.stringify(bad));
  }
  // a prerelease tag counts as a prerelease even when GitHub does not say so
  assert.equal(u.normalizeRelease(release('v2.0.0-beta.1')).prerelease, true);
});

test('trimNotes: plain text, control characters stripped, ≤ 2000 chars', () => {
  assert.equal(u.trimNotes('Title', 'Body'), 'Title\n\nBody');
  assert.equal(u.trimNotes('Title', 'Title continues'), 'Title continues', 'no duplicated title');
  assert.equal(u.trimNotes('', ''), null);
  assert.equal(u.trimNotes('A B', 'CD'), 'AB\n\nCD');
  assert.equal(u.trimNotes('', 'x\r\ny'), 'x\ny');
  assert.ok(u.trimNotes('', 'x'.repeat(5000)).length <= u.MAX_NOTES_CHARS);
});

test('parseReleases rejects a non-list payload and drops invalid entries', () => {
  assert.equal(u.parseReleases('nope'), null);
  assert.equal(u.parseReleases(42), null);
  assert.equal(u.parseReleases(null), null);
  assert.deepEqual(u.parseReleases([]), []);
  assert.deepEqual(u.parseReleases([release('latest'), release('v1.0.0')]).map((r) => r.version), ['1.0.0']);
  // GitHub's error shape is an object, not a list – that is a failure, never "no releases"
  assert.equal(u.parseReleases({ message: 'Not Found', documentation_url: 'https://docs.github.com' }), null);
  assert.equal(u.parseReleases(release('v1.0.0')), null);
  assert.ok(u.parseReleases(new Array(500).fill(release('v1.0.0'))).length <= u.MAX_RELEASES);
});

test('pickRelease: newest valid, drafts skipped, prereleases only when allowed', () => {
  const payload = [
    release('v1.0.0'),
    release('v1.3.0', { draft: true }),
    release('v1.2.0-beta.1', { prerelease: true }),
    release('v1.1.0'),
    release('not-a-version'),
  ];
  assert.equal(u.pickRelease(payload).version, '1.1.0');
  assert.equal(u.pickRelease(payload, { includePrerelease: false }).version, '1.1.0');
  assert.equal(u.pickRelease(payload, { includePrerelease: true }).version, '1.2.0-beta.1');
  // a draft stays invisible even when it is the newest
  assert.equal(u.pickRelease([release('v9.0.0', { draft: true })]), null);
  assert.equal(u.pickRelease([]), null);
  assert.equal(u.pickRelease('nope'), null);
  // order in the payload does not matter
  assert.equal(u.pickRelease([release('v1.1.0'), release('v2.0.0'), release('v1.5.0')]).version, '2.0.0');
  assert.equal(u.selectNewestRelease(u.parseReleases(payload)).version, '1.1.0');
  assert.equal(u.selectNewestRelease(null), null);
});

// ---------------------------------------------------------------------------------------------
// capability (§12 table)

test('detectCapability follows the §12 table', () => {
  const packaged = { packaged: true, electronVersion: '44.4.1' };
  const win = u.detectCapability({ ...packaged, platform: 'win32', arch: 'x64' });
  assert.deepEqual({ capability: win.capability, variant: win.variant, legacyBuild: win.legacyBuild },
    { capability: 'auto', variant: 'nsis', legacyBuild: false });

  const portable = u.detectCapability({ ...packaged, platform: 'win32', portable: true });
  assert.equal(portable.capability, 'manual');
  assert.equal(portable.variant, 'portable');

  const appImage = u.detectCapability({ ...packaged, platform: 'linux', appImage: true });
  assert.equal(appImage.capability, 'auto');
  assert.equal(appImage.variant, 'AppImage');

  const deb = u.detectCapability({ ...packaged, platform: 'linux', linuxPackage: 'deb' });
  assert.equal(deb.capability, 'manual');
  assert.equal(deb.variant, 'deb');
  assert.equal(u.detectCapability({ ...packaged, platform: 'linux' }).variant, null, 'unknown package format');

  const mac = u.detectCapability({ ...packaged, platform: 'darwin', arch: 'arm64' });
  assert.equal(mac.capability, 'manual', 'unsigned builds cannot use Squirrel.Mac');
  assert.equal(mac.variant, 'dmg');
  assert.equal(mac.legacyBuild, false);

  const legacy = u.detectCapability({ packaged: true, platform: 'darwin', electronVersion: '32.3.3' });
  assert.equal(legacy.capability, 'manual');
  assert.equal(legacy.legacyBuild, true);

  // a dev run never checks automatically and never uses electron-updater
  for (const platform of ['win32', 'darwin', 'linux']) {
    const dev = u.detectCapability({ platform, packaged: false, appImage: true, electronVersion: '44.4.1' });
    assert.equal(dev.capability, 'manual', platform);
    assert.equal(dev.dev, true, platform);
  }
  // garbage in → the safe side
  assert.equal(u.detectCapability().capability, 'manual');
  assert.equal(u.detectCapability({}).legacyBuild, false);
  assert.equal(u.electronMajorOf('44.4.1'), 44);
  assert.equal(u.electronMajorOf('nope'), null);
});

// ---------------------------------------------------------------------------------------------
// asset selection

const ALL_ASSETS = [
  asset('AugenPause-Setup-1.2.0-x64.exe'),
  asset('AugenPause-Portable-1.2.0.exe'),
  asset('AugenPause-1.2.0-x64.dmg'),
  asset('AugenPause-1.2.0-arm64.dmg'),
  asset('AugenPause-1.2.0-legacy-x64.dmg'),
  asset('AugenPause-1.2.0-x86_64.AppImage'),
  asset('AugenPause-1.2.0-amd64.deb'),
  asset('AugenPause-1.2.0-x86_64.rpm'),
  asset('latest.yml'),
  asset('latest-mac.yml'),
].map((a) => ({ name: a.name, url: a.browser_download_url }));

function pick(variant, options = {}) {
  const found = u.selectAsset({ assets: ALL_ASSETS, variant, version: '1.2.0', ...options });
  return found ? found.name : null;
}

test('selectAsset picks the file that matches platform, arch and variant', () => {
  assert.equal(pick('nsis', { arch: 'x64' }), 'AugenPause-Setup-1.2.0-x64.exe');
  assert.equal(pick('portable', { arch: 'x64' }), 'AugenPause-Portable-1.2.0.exe');
  assert.equal(pick('dmg', { arch: 'x64' }), 'AugenPause-1.2.0-x64.dmg');
  assert.equal(pick('dmg', { arch: 'arm64' }), 'AugenPause-1.2.0-arm64.dmg');
  assert.equal(pick('AppImage', { arch: 'x64' }), 'AugenPause-1.2.0-x86_64.AppImage');
  assert.equal(pick('deb', { arch: 'x64' }), 'AugenPause-1.2.0-amd64.deb');
  assert.equal(pick('rpm', { arch: 'x64' }), 'AugenPause-1.2.0-x86_64.rpm');
  // a Setup is never offered as "portable" and vice versa
  assert.equal(pick('nsis', { arch: 'arm64' }), null, 'no arm64 installer in this release');
  assert.equal(pick('AppImage', { arch: 'arm64' }), null);
  assert.equal(pick('rpm', { arch: 'arm64' }), null, 'rpm uses aarch64');
});

test('selectAsset: the legacy macOS build only ever gets a legacy asset (§12)', () => {
  assert.equal(pick('dmg', { arch: 'x64', legacyBuild: true }), 'AugenPause-1.2.0-legacy-x64.dmg');
  assert.equal(pick('dmg', { arch: 'x64', legacyBuild: false }), 'AugenPause-1.2.0-x64.dmg');
  // a current build must never be handed the legacy dmg, even when it is the only one
  const onlyLegacy = [{ name: 'AugenPause-1.2.0-legacy-x64.dmg', url: `${DL}/v1.2.0/AugenPause-1.2.0-legacy-x64.dmg` }];
  assert.equal(u.selectAsset({ assets: onlyLegacy, variant: 'dmg', arch: 'x64' }), null);
  // …and a legacy build never a current one
  const onlyCurrent = [{ name: 'AugenPause-1.2.0-x64.dmg', url: `${DL}/v1.2.0/AugenPause-1.2.0-x64.dmg` }];
  assert.equal(u.selectAsset({ assets: onlyCurrent, variant: 'dmg', arch: 'x64', legacyBuild: true }), null);
});

test('selectAsset refuses anything that is not an allowlisted AugenPause artifact', () => {
  assert.equal(u.selectAsset({ assets: ALL_ASSETS, variant: null, arch: 'x64' }), null, 'unknown variant');
  assert.equal(u.selectAsset({ assets: ALL_ASSETS, variant: 'msi', arch: 'x64' }), null);
  assert.equal(u.selectAsset({ assets: ALL_ASSETS, variant: 'nsis', arch: 'sparc' }), null, 'unknown arch');
  assert.equal(u.selectAsset({ assets: [], variant: 'nsis', arch: 'x64' }), null);
  assert.equal(u.selectAsset({ variant: 'nsis', arch: 'x64' }), null);
  assert.equal(u.selectAsset(), null);
  // an asset whose URL is not allowlisted is invisible
  const spoofed = [{ name: 'AugenPause-Setup-1.2.0-x64.exe', url: 'https://evil.example/AugenPause-Setup-1.2.0-x64.exe' }];
  assert.equal(u.selectAsset({ assets: spoofed, variant: 'nsis', arch: 'x64' }), null);
  // a foreign file that merely ends in .exe
  const foreign = [{ name: 'Setup-x64.exe', url: `${DL}/v1.2.0/Setup-x64.exe` }];
  assert.equal(u.selectAsset({ assets: foreign, variant: 'nsis', arch: 'x64' }), null);
  // yml files are never offered as a download
  assert.ok(!['latest.yml', 'latest-mac.yml'].includes(pick('nsis', { arch: 'x64' })));
});

test('selectAsset prefers the asset carrying the release version', () => {
  const assets = [
    { name: 'AugenPause-Setup-1.1.0-x64.exe', url: `${DL}/v1.2.0/AugenPause-Setup-1.1.0-x64.exe` },
    { name: 'AugenPause-Setup-1.2.0-x64.exe', url: `${DL}/v1.2.0/AugenPause-Setup-1.2.0-x64.exe` },
  ];
  assert.equal(u.selectAsset({ assets, variant: 'nsis', arch: 'x64', version: '1.2.0' }).name,
    'AugenPause-Setup-1.2.0-x64.exe');
  assert.equal(u.selectAsset({ assets, variant: 'nsis', arch: 'x64', version: 'v1.1.0' }).name,
    'AugenPause-Setup-1.1.0-x64.exe');
});

test('nameTokens splits on - and . but keeps x86_64', () => {
  assert.deepEqual(u.nameTokens('AugenPause-1.2.0-x86_64.AppImage'), ['augenpause', '1', '2', '0', 'x86_64', 'appimage']);
  assert.deepEqual(u.nameTokens('AugenPause-Setup-1.2.0-x64.exe'), ['augenpause', 'setup', '1', '2', '0', 'x64', 'exe']);
});

// ---------------------------------------------------------------------------------------------
// settings view

test('readUpdateSettings normalises the §12 settings group', () => {
  assert.deepEqual(u.readUpdateSettings({
    updates: { autoCheck: true, intervalHours: 24, autoDownload: false, includePrerelease: false },
    general: { notifications: true },
  }), { autoCheck: true, intervalHours: 24, intervalMs: 24 * 3600000, autoDownload: false, includePrerelease: false, notifications: true });

  assert.equal(u.readUpdateSettings({ updates: { autoCheck: false } }).autoCheck, false);
  assert.equal(u.readUpdateSettings({ general: { notifications: false } }).notifications, false);
  // missing / hostile input → the documented defaults, interval clamped to 6..168
  for (const bad of [null, undefined, 'x', 42, [], { updates: 'x' }]) {
    const cfg = u.readUpdateSettings(bad);
    assert.equal(cfg.autoCheck, true, String(bad));
    assert.equal(cfg.intervalHours, 24, String(bad));
    assert.equal(cfg.autoDownload, false, String(bad));
  }
  assert.equal(u.readUpdateSettings({ updates: { intervalHours: 1 } }).intervalHours, 6);
  assert.equal(u.readUpdateSettings({ updates: { intervalHours: 1000 } }).intervalHours, 168);
  assert.equal(u.readUpdateSettings({ updates: { intervalHours: '48' } }).intervalHours, 48);
  assert.equal(u.readUpdateSettings({ updates: { intervalHours: NaN } }).intervalHours, 24);
});
