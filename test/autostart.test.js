'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { linuxExecPath, buildDesktopEntry, quoteExecArg, HIDDEN_ARG } = require('../src/main/autostart');

test('linuxExecPath: $APPIMAGE only when running from inside $APPDIR', () => {
  const appDir = '/tmp/.mount_AugenPkq1Zx';
  const appImage = '/home/me/Apps/AugenPause-1.0.0.AppImage';
  const inside = `${appDir}/augenpause`;

  assert.equal(linuxExecPath({ APPIMAGE: appImage, APPDIR: appDir }, inside), appImage);
  assert.equal(linuxExecPath({ APPIMAGE: appImage, APPDIR: `${appDir}/` }, inside), appImage, 'trailing slash');
  // installed from .deb/.rpm but started from a shell that inherited AppImage variables
  assert.equal(linuxExecPath({ APPIMAGE: appImage, APPDIR: appDir }, '/opt/AugenPause/augenpause'), '/opt/AugenPause/augenpause');
  assert.equal(linuxExecPath({ APPIMAGE: appImage }, '/opt/AugenPause/augenpause'), '/opt/AugenPause/augenpause');
  assert.equal(linuxExecPath({ APPIMAGE: appImage, APPDIR: '' }, inside), inside);
  // prefix of another directory does not count
  assert.equal(linuxExecPath({ APPIMAGE: appImage, APPDIR: '/tmp/.mount_Aug' }, inside), inside);
  assert.equal(linuxExecPath({ APPDIR: appDir }, inside), inside, 'no APPIMAGE → execPath');
  assert.equal(linuxExecPath({}, '/usr/bin/augenpause'), '/usr/bin/augenpause');
});

test('desktop entry Exec quoting', () => {
  const entry = buildDesktopEntry({ execPath: '/opt/Augen Pause/augenpause', args: ['--ozone-platform=x11', HIDDEN_ARG] });
  assert.match(entry, /^Exec="\/opt\/Augen Pause\/augenpause" --ozone-platform=x11 --hidden$/m);
  assert.equal(quoteExecArg('100%'), '"100%%"');
  assert.throws(() => quoteExecArg('a\nb'));
});
