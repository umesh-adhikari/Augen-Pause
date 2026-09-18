'use strict';

/**
 * createUpdater() – the update check itself (docs/ARCHITECTURE.md §12).
 * electron is never required: app, net, notifier, shell.openExternal, electron-updater, the clock and
 * the timers are all injected.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createUpdater, FIRST_CHECK_DELAY_MS, BREAK_RETRY_DELAY_MS, UPDATE_PARTITION } = require('../src/main/updater');
const { RELEASES_API_URL } = require('../src/main/update-util');

const DL = 'https://github.com/umesh-adhikari/Augen-Pause/releases/download';
const flush = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

function release(tag, extra = {}) {
  return {
    tag_name: tag,
    name: `AugenPause ${tag}`,
    body: 'Neue Funktionen',
    html_url: `https://github.com/umesh-adhikari/Augen-Pause/releases/tag/${tag}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: `AugenPause-Setup-${tag.replace(/^v/, '')}-x64.exe`, browser_download_url: `${DL}/${tag}/AugenPause-Setup-${tag.replace(/^v/, '')}-x64.exe`, size: 70000000 },
      { name: `AugenPause-${tag.replace(/^v/, '')}-x64.dmg`, browser_download_url: `${DL}/${tag}/AugenPause-${tag.replace(/^v/, '')}-x64.dmg`, size: 90000000 },
      { name: `AugenPause-${tag.replace(/^v/, '')}-x86_64.AppImage`, browser_download_url: `${DL}/${tag}/AugenPause-${tag.replace(/^v/, '')}-x86_64.AppImage`, size: 95000000 },
    ],
    ...extra,
  };
}

/** Fake Electron `net`: plan = { status?, body?, chunks?, error?, silent? } or a function of the call index. */
function fakeNet(plan) {
  const calls = [];
  const net = {
    calls,
    request(options) {
      const headers = {};
      const listeners = new Map();
      calls.push({ options, headers });
      const request = {
        setHeader(name, value) {
          headers[name] = value;
        },
        on(event, fn) {
          listeners.set(event, fn);
          return request;
        },
        abort() {
          listeners.set('aborted-called', true);
        },
        end() {
          const step = typeof plan === 'function' ? plan(calls.length, options) : plan;
          setImmediate(() => {
            if (!step || step.silent) return; // nothing ever answers → timeout path
            if (step.error) {
              const fn = listeners.get('error');
              if (fn) fn(new Error(step.error));
              return;
            }
            const responseHandlers = {};
            const response = {
              statusCode: step.status === undefined ? 200 : step.status,
              on(event, fn) {
                responseHandlers[event] = fn;
                return response;
              },
            };
            const onResponse = listeners.get('response');
            if (onResponse) onResponse(response);
            setImmediate(() => {
              const chunks = step.chunks || [Buffer.from(step.body === undefined ? '[]' : step.body, 'utf8')];
              if (responseHandlers.data) for (const chunk of chunks) responseHandlers.data(chunk);
              if (responseHandlers.end) responseHandlers.end();
            });
          });
        },
      };
      return request;
    },
  };
  return net;
}

function fakeTimers(startMs = 1700000000000) {
  let nowMs = startMs;
  let seq = 0;
  const jobs = new Map();
  return {
    now: () => nowMs,
    setTimer(fn, ms) {
      seq += 1;
      const id = seq;
      jobs.set(id, { fn, at: nowMs + Math.max(0, Number(ms) || 0) });
      return { id, unref() {} };
    },
    clearTimer(handle) {
      if (handle && jobs.has(handle.id)) jobs.delete(handle.id);
    },
    count: () => jobs.size,
    nextDelay() {
      let min = null;
      for (const job of jobs.values()) if (min === null || job.at < min) min = job.at;
      return min === null ? null : min - nowMs;
    },
    async advance(ms) {
      nowMs += ms;
      const due = [...jobs.entries()].filter(([, job]) => job.at <= nowMs).sort((a, b) => a[1].at - b[1].at);
      for (const [id, job] of due) {
        jobs.delete(id);
        job.fn();
        await flush();
      }
      await flush();
    },
  };
}

function harness(options = {}) {
  const states = [];
  const logs = [];
  const notifications = [];
  const opened = [];
  const settings = {
    updates: { autoCheck: true, intervalHours: 24, autoDownload: false, includePrerelease: false },
    general: { notifications: true },
    breaks: { strictMode: true },
    ...(options.settings || {}),
  };
  const timers = options.timers || null;
  const updater = createUpdater({
    app: { getVersion: () => options.version || '1.0.0', isPackaged: true },
    settings: { get: () => settings },
    getState: () => options.state || null,
    onState: (update) => states.push(update),
    notifier: { updateAvailable: (info) => notifications.push(info) },
    shellOpen: (url) => {
      opened.push(url);
      return Promise.resolve();
    },
    net: options.net,
    log: (...args) => logs.push(args.join(' ')),
    isStrictBreak: options.isStrictBreak,
    isBreakRunning: options.isBreakRunning,
    prepareQuit: options.prepareQuit,
    requireAutoUpdater: options.requireAutoUpdater,
    runtime: {
      platform: 'win32',
      arch: 'x64',
      packaged: true,
      electronVersion: '44.4.1',
      env: {},
      ...(options.runtime || {}),
    },
    now: timers ? timers.now : undefined,
    setTimer: timers ? timers.setTimer : undefined,
    clearTimer: timers ? timers.clearTimer : undefined,
  });
  return { updater, states, logs, notifications, opened, settings };
}

// ---------------------------------------------------------------------------------------------

test('initial state has exactly the §12 shape', () => {
  const { updater } = harness({ net: fakeNet({}) });
  const state = updater.getUpdateState();
  assert.deepEqual(Object.keys(state).sort(), [
    'assetName', 'assetUrl', 'capability', 'currentVersion', 'error', 'lastCheckAt', 'latestVersion',
    'legacyBuild', 'notes', 'progress', 'releaseUrl', 'status',
  ]);
  assert.deepEqual(state, {
    capability: 'auto', // Windows NSIS install – it degrades to 'manual' in start() without electron-updater
    status: 'idle',
    currentVersion: '1.0.0',
    latestVersion: null,
    releaseUrl: null,
    assetUrl: null,
    assetName: null,
    progress: 0,
    lastCheckAt: null,
    error: null,
    legacyBuild: false,
    notes: null,
  });
  // a fresh object every time – renderers must never get a live reference
  assert.notEqual(updater.getUpdateState(), state);
  // electron-updater is not installed here, so the honest capability after start() is 'manual'
  updater.start();
  assert.equal(updater.getUpdateState().capability, 'manual');
  updater.stop();
});

test('check(): a newer release becomes status "available" with the matching asset', async () => {
  const net = fakeNet({ body: JSON.stringify([release('v1.0.0'), release('v1.2.0'), release('v1.1.0')]) });
  const h = harness({ net });
  const result = await h.updater.check({ manual: true });
  assert.deepEqual(result, { ok: true });

  const state = h.updater.getUpdateState();
  assert.equal(state.status, 'available');
  assert.equal(state.latestVersion, '1.2.0');
  assert.equal(state.releaseUrl, 'https://github.com/umesh-adhikari/Augen-Pause/releases/tag/v1.2.0');
  assert.equal(state.assetName, 'AugenPause-Setup-1.2.0-x64.exe');
  assert.equal(state.assetUrl, `${DL}/v1.2.0/AugenPause-Setup-1.2.0-x64.exe`);
  assert.equal(state.error, null);
  assert.ok(Number.isFinite(state.lastCheckAt));
  assert.match(state.notes, /Neue Funktionen/);
  // 'checking' was pushed before the result
  assert.deepEqual(h.states.map((s) => s.status), ['checking', 'available']);
  // and the user was told once
  assert.deepEqual(h.notifications, [{ version: '1.2.0' }]);
});

test('check(): request shape – https, api.github.com, User-Agent, Accept, no credentials', async () => {
  const net = fakeNet({ body: '[]' });
  const h = harness({ net, version: '1.0.0' });
  await h.updater.check({ manual: true });
  assert.equal(net.calls.length, 1);
  const { options, headers } = net.calls[0];
  assert.equal(options.url, RELEASES_API_URL);
  assert.match(options.url, /^https:\/\/api\.github\.com\//);
  assert.equal(options.method, 'GET');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.useSessionCookies, false);
  assert.equal(options.partition, UPDATE_PARTITION, 'own session – the default one cancels non-app requests');
  assert.equal(headers['User-Agent'], 'AugenPause/1.0.0');
  assert.equal(headers.Accept, 'application/vnd.github+json');
  // an empty release list is "up to date", not an error
  assert.equal(h.updater.getUpdateState().status, 'up-to-date');
  assert.equal(h.updater.getUpdateState().error, null);
});

test('check(): the running version is never downgraded and equal versions are up to date', async () => {
  const net = fakeNet({ body: JSON.stringify([release('v1.0.0'), release('v0.9.0')]) });
  const h = harness({ net, version: '1.0.0' });
  await h.updater.check({ manual: true });
  const state = h.updater.getUpdateState();
  assert.equal(state.status, 'up-to-date');
  assert.equal(state.latestVersion, '1.0.0');
  assert.equal(state.assetUrl, null);
  assert.deepEqual(h.notifications, [], 'no notification without an update');
});

test('check(): prereleases and drafts follow the settings', async () => {
  const payload = JSON.stringify([
    release('v1.0.0'),
    release('v2.0.0', { draft: true }),
    release('v1.5.0-beta.1', { prerelease: true }),
  ]);
  const stable = harness({ net: fakeNet({ body: payload }) });
  await stable.updater.check({ manual: true });
  assert.equal(stable.updater.getUpdateState().status, 'up-to-date', 'only a draft and a prerelease are newer');

  const beta = harness({
    net: fakeNet({ body: payload }),
    settings: { updates: { autoCheck: true, intervalHours: 24, autoDownload: false, includePrerelease: true } },
  });
  await beta.updater.check({ manual: true });
  assert.equal(beta.updater.getUpdateState().latestVersion, '1.5.0-beta.1');
});

test('check(): every failure ends in status "error" with a short code and no stack', async () => {
  const cases = [
    [{ status: 403, body: 'rate limited' }, 'http-403'],
    [{ status: 404, body: '' }, 'http-404'],
    [{ status: 500, body: '' }, 'http-500'],
    [{ body: 'not json at all' }, 'bad-json'],
    [{ body: '{"message":"Not Found"}' }, 'bad-json'],
    [{ error: 'ENOTFOUND api.github.com' }, 'ENOTFOUND api.github.com'],
    [{ chunks: [Buffer.alloc(300 * 1024)] }, 'too-large'],
  ];
  for (const [plan, code] of cases) {
    const h = harness({ net: fakeNet(plan) });
    const result = await h.updater.check({ manual: true });
    assert.deepEqual(result, { ok: false, error: code }, JSON.stringify(plan));
    const state = h.updater.getUpdateState();
    assert.equal(state.status, 'error');
    assert.equal(state.error, code);
    assert.ok(state.error.length <= 60 && !state.error.includes('\n'), 'short code, never a stack');
    assert.ok(Number.isFinite(state.lastCheckAt), 'a failed check still counts as a check');
    assert.equal(state.latestVersion, null);
  }
});

test('check(): a request that never answers times out after 10 s', async () => {
  const timers = fakeTimers();
  const h = harness({ net: fakeNet({ silent: true }), timers });
  const pending = h.updater.check({ manual: true });
  await flush();
  assert.equal(h.updater.getUpdateState().status, 'checking');
  await timers.advance(10000);
  assert.deepEqual(await pending, { ok: false, error: 'timeout' });
  assert.equal(h.updater.getUpdateState().error, 'timeout');
  assert.equal(timers.count(), 0, 'the timeout timer is cleaned up');
});

test('at most one check in flight', async () => {
  const net = fakeNet({ body: JSON.stringify([release('v1.2.0')]) });
  const h = harness({ net });
  const first = h.updater.check({ manual: true });
  const second = await h.updater.check({ manual: true });
  assert.deepEqual(second, { ok: false, error: 'busy' });
  assert.deepEqual(await first, { ok: true });
  assert.equal(net.calls.length, 1);
});

test('notification: at most once per version, and never when notifications are off', async () => {
  const net = fakeNet({ body: JSON.stringify([release('v1.2.0')]) });
  const h = harness({ net });
  await h.updater.check({ manual: true });
  await h.updater.check({ manual: true });
  await h.updater.check({ manual: true });
  assert.deepEqual(h.notifications, [{ version: '1.2.0' }], 'only once for 1.2.0');
  assert.ok(h.logs.some((line) => line.includes('update notification for 1.2.0')));

  const quiet = harness({
    net: fakeNet({ body: JSON.stringify([release('v1.2.0')]) }),
    settings: { general: { notifications: false } },
  });
  await quiet.updater.check({ manual: true });
  assert.deepEqual(quiet.notifications, []);
  assert.equal(quiet.updater.getUpdateState().status, 'available', 'the state is filled either way');
});

test('a newer version notifies again', async () => {
  let payload = JSON.stringify([release('v1.2.0')]);
  const net = fakeNet(() => ({ body: payload }));
  const h = harness({ net });
  await h.updater.check({ manual: true });
  payload = JSON.stringify([release('v1.3.0')]);
  await h.updater.check({ manual: true });
  assert.deepEqual(h.notifications, [{ version: '1.2.0' }, { version: '1.3.0' }]);
});

// ---------------------------------------------------------------------------------------------
// mandatory break + scheduling

const STRICT_BREAK = { phase: 'break', break: { strict: true, canSkip: false, remainingMs: 60000 } };

test('no check while a mandatory break runs', async () => {
  const net = fakeNet({ body: '[]' });
  const h = harness({ net, state: STRICT_BREAK, isStrictBreak: () => true });
  assert.deepEqual(await h.updater.check({ manual: true }), { ok: false, error: 'strict-mode' });
  assert.deepEqual(await h.updater.check({ manual: false }), { ok: false, error: 'strict-mode' });
  assert.equal(net.calls.length, 0, 'nothing left the machine');
  assert.equal(h.updater.getUpdateState().status, 'idle');
});

test('scheduling: first check after ~30 s, then every intervalHours', async () => {
  const timers = fakeTimers();
  const net = fakeNet({ body: JSON.stringify([release('v1.2.0')]) });
  const h = harness({ net, timers });
  h.updater.start();
  assert.equal(timers.nextDelay(), FIRST_CHECK_DELAY_MS);
  await timers.advance(FIRST_CHECK_DELAY_MS - 1000);
  assert.equal(net.calls.length, 0, 'nothing in the first 20 s (§12)');
  await timers.advance(1000);
  assert.equal(net.calls.length, 1);
  assert.equal(h.updater.getUpdateState().status, 'available');
  // next one in 24 h
  assert.equal(timers.nextDelay(), 24 * 3600000);
  await timers.advance(24 * 3600000);
  assert.equal(net.calls.length, 2);
  h.updater.stop();
  assert.equal(timers.count(), 0);
});

test('scheduling: a mandatory break postpones the scheduled check', async () => {
  const timers = fakeTimers();
  const net = fakeNet({ body: '[]' });
  let inBreak = true;
  const h = harness({ net, timers, isStrictBreak: () => inBreak });
  h.updater.start();
  await timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(net.calls.length, 0, 'skipped – a mandatory break runs');
  assert.equal(timers.nextDelay(), BREAK_RETRY_DELAY_MS, 'retried later');
  inBreak = false;
  await timers.advance(BREAK_RETRY_DELAY_MS);
  assert.equal(net.calls.length, 1);
});

test('autoCheck off: nothing is scheduled and nothing is sent, manual checks still work', async () => {
  const timers = fakeTimers();
  const net = fakeNet({ body: JSON.stringify([release('v1.2.0')]) });
  const h = harness({
    net,
    timers,
    settings: { updates: { autoCheck: false, intervalHours: 24, autoDownload: false, includePrerelease: false } },
  });
  h.updater.start();
  assert.equal(timers.count(), 0, 'no timer at all');
  await timers.advance(48 * 3600000);
  assert.equal(net.calls.length, 0);
  assert.deepEqual(await h.updater.check({ manual: false }), { ok: false, error: 'disabled' });
  assert.equal(net.calls.length, 0);
  // the user can still ask explicitly
  assert.deepEqual(await h.updater.check({ manual: true }), { ok: true });
  assert.equal(net.calls.length, 1);
  assert.equal(h.updater.getUpdateState().status, 'available');
});

test('onSettingsChanged reschedules (interval change and switching autoCheck on/off)', async () => {
  const timers = fakeTimers();
  const net = fakeNet({ body: '[]' });
  const h = harness({ net, timers });
  h.updater.start();
  await timers.advance(FIRST_CHECK_DELAY_MS);
  assert.equal(net.calls.length, 1);
  assert.equal(timers.nextDelay(), 24 * 3600000);

  h.settings.updates.intervalHours = 6;
  h.updater.onSettingsChanged();
  assert.equal(timers.nextDelay(), 6 * 3600000);

  h.settings.updates.autoCheck = false;
  h.updater.onSettingsChanged();
  assert.equal(timers.count(), 0);
  await timers.advance(72 * 3600000);
  assert.equal(net.calls.length, 1, 'no further request');

  h.settings.updates.autoCheck = true;
  h.updater.onSettingsChanged();
  assert.ok(timers.count() > 0);
});

test('a dev run does not check on its own (§12)', async () => {
  const timers = fakeTimers();
  const net = fakeNet({ body: '[]' });
  const h = harness({ net, timers, runtime: { packaged: false } });
  h.updater.start();
  await timers.advance(72 * 3600000);
  assert.equal(net.calls.length, 0);
  assert.ok(h.logs.some((line) => line.includes('dev run')));
  assert.deepEqual(await h.updater.check({ manual: true }), { ok: true }, 'manual checks still work');
});

// ---------------------------------------------------------------------------------------------
// capability 'manual'

test('manual capability: download() and openReleasePage() open allowlisted URLs only', async () => {
  const net = fakeNet({ body: JSON.stringify([release('v1.2.0')]) });
  const h = harness({ net, runtime: { platform: 'darwin', arch: 'x64' } });
  assert.equal(h.updater.getUpdateState().capability, 'manual');
  await h.updater.check({ manual: true });
  assert.equal(h.updater.getUpdateState().assetName, 'AugenPause-1.2.0-x64.dmg');

  assert.deepEqual(await h.updater.download(), { ok: true });
  assert.deepEqual(h.opened, [`${DL}/v1.2.0/AugenPause-1.2.0-x64.dmg`]);
  assert.deepEqual(h.updater.openReleasePage(), { ok: true });
  assert.equal(h.opened[1], 'https://github.com/umesh-adhikari/Augen-Pause/releases/tag/v1.2.0');
  // never a quit-and-install without electron-updater
  assert.deepEqual(h.updater.install(), { ok: false, error: 'not-supported' });
});

test('manual capability: without an update nothing is downloaded, the release page still opens', async () => {
  const h = harness({ net: fakeNet({ body: '[]' }), runtime: { platform: 'darwin' } });
  assert.deepEqual(await h.updater.download(), { ok: false, error: 'no-update' });
  assert.deepEqual(h.opened, []);
  assert.deepEqual(h.updater.openReleasePage(), { ok: true });
  assert.deepEqual(h.opened, ['https://github.com/umesh-adhikari/Augen-Pause/releases/latest']);
});

test('a release whose asset URL is not allowlisted is never opened', async () => {
  const spoofed = release('v1.2.0', {
    html_url: 'https://evil.example/release',
    assets: [{ name: 'AugenPause-Setup-1.2.0-x64.exe', browser_download_url: 'https://evil.example/x.exe' }],
  });
  const h = harness({ net: fakeNet({ body: JSON.stringify([spoofed]) }), runtime: { platform: 'darwin' } });
  await h.updater.check({ manual: true });
  const state = h.updater.getUpdateState();
  assert.equal(state.status, 'available');
  assert.equal(state.assetUrl, null, 'the hostile asset is dropped');
  assert.equal(state.releaseUrl, 'https://github.com/umesh-adhikari/Augen-Pause/releases/tag/v1.2.0');
  await h.updater.download();
  assert.deepEqual(h.opened, ['https://github.com/umesh-adhikari/Augen-Pause/releases/tag/v1.2.0']);
});

test('the legacy macOS build is only ever offered a legacy asset', async () => {
  const legacy = release('v1.2.0');
  legacy.assets.push({
    name: 'AugenPause-1.2.0-legacy-x64.dmg',
    browser_download_url: `${DL}/v1.2.0/AugenPause-1.2.0-legacy-x64.dmg`,
  });
  const h = harness({
    net: fakeNet({ body: JSON.stringify([legacy]) }),
    runtime: { platform: 'darwin', arch: 'x64', electronVersion: '32.3.3' },
  });
  assert.equal(h.updater.getUpdateState().legacyBuild, true);
  assert.equal(h.updater.getUpdateState().capability, 'manual');
  await h.updater.check({ manual: true });
  assert.equal(h.updater.getUpdateState().assetName, 'AugenPause-1.2.0-legacy-x64.dmg');
});

// ---------------------------------------------------------------------------------------------
// capability 'auto' (electron-updater)

function fakeAutoUpdater({ downloadFails = false } = {}) {
  const handlers = new Map();
  const calls = [];
  const au = {
    autoDownload: true,
    allowDowngrade: true,
    allowPrerelease: false,
    autoInstallOnAppQuit: false,
    logger: 'console',
    on(event, fn) {
      handlers.set(event, fn);
      return au;
    },
    emit(event, payload) {
      const fn = handlers.get(event);
      if (fn) fn(payload);
    },
    async checkForUpdates() {
      calls.push('checkForUpdates');
      return { updateInfo: { version: '1.2.0' }, cancellationToken: 'token' };
    },
    async downloadUpdate(token) {
      calls.push(`downloadUpdate:${token}`);
      if (downloadFails) throw new Error('ENOSPC no space left');
      au.emit('download-progress', { percent: 42 });
      au.emit('update-downloaded', { version: '1.2.0' });
    },
    quitAndInstall(silent, forceRunAfter) {
      calls.push(`quitAndInstall:${silent}:${forceRunAfter}`);
    },
    calls,
  };
  return au;
}

test('capability auto: electron-updater is configured exactly as §12 demands', async () => {
  const au = fakeAutoUpdater();
  const h = harness({
    net: fakeNet({ body: JSON.stringify([release('v1.2.0')]) }),
    requireAutoUpdater: () => ({ autoUpdater: au }),
    settings: { updates: { autoCheck: true, intervalHours: 24, autoDownload: false, includePrerelease: true } },
  });
  assert.equal(h.updater.getUpdateState().capability, 'auto', 'Windows NSIS install');
  h.updater.start();
  assert.equal(au.autoDownload, false);
  assert.equal(au.allowDowngrade, false);
  assert.equal(au.allowPrerelease, true, 'from the settings');
  assert.equal(au.autoInstallOnAppQuit, true);
  assert.equal(au.logger, null);
});

test('capability auto: download() reports progress and ends in "ready", install() quits', async () => {
  const au = fakeAutoUpdater();
  const quits = [];
  const h = harness({
    net: fakeNet({ body: JSON.stringify([release('v1.2.0')]) }),
    requireAutoUpdater: () => ({ autoUpdater: au }),
    prepareQuit: () => quits.push('flushed'),
  });
  await h.updater.check({ manual: true });
  assert.equal(h.updater.getUpdateState().status, 'available');

  assert.deepEqual(await h.updater.download(), { ok: true });
  assert.deepEqual(au.calls, ['checkForUpdates', 'downloadUpdate:token']);
  const progressStates = h.states.filter((s) => s.status === 'downloading');
  assert.ok(progressStates.some((s) => Math.abs(s.progress - 0.42) < 1e-9), 'progress 0..1');
  const state = h.updater.getUpdateState();
  assert.equal(state.status, 'ready');
  assert.equal(state.progress, 1);

  assert.deepEqual(h.updater.install(), { ok: true });
  assert.deepEqual(quits, ['flushed'], 'stats are flushed before the app quits');
  assert.deepEqual(au.calls.slice(-1), ['quitAndInstall:false:true']);
  // nothing is opened in a browser in this mode
  assert.deepEqual(h.opened, []);
});

test('capability auto: install() is refused during a break, download() during a mandatory one', async () => {
  const au = fakeAutoUpdater();
  let strict = false;
  let breakRunning = true;
  const h = harness({
    net: fakeNet({ body: JSON.stringify([release('v1.2.0')]) }),
    requireAutoUpdater: () => ({ autoUpdater: au }),
    isStrictBreak: () => strict,
    isBreakRunning: () => breakRunning,
  });
  await h.updater.check({ manual: true });
  await h.updater.download();
  assert.equal(h.updater.getUpdateState().status, 'ready');

  assert.deepEqual(h.updater.install(), { ok: false, error: 'break-running' });
  strict = true;
  assert.deepEqual(h.updater.install(), { ok: false, error: 'strict-mode' });
  assert.deepEqual(await h.updater.download(), { ok: false, error: 'strict-mode' });
  assert.deepEqual(h.updater.openReleasePage(), { ok: false, error: 'strict-mode' });
  assert.ok(!au.calls.some((call) => call.startsWith('quitAndInstall')));

  strict = false;
  breakRunning = false;
  assert.deepEqual(h.updater.install(), { ok: true });
});

test('capability auto: a failing download ends in "error" with a short code', async () => {
  const au = fakeAutoUpdater({ downloadFails: true });
  const h = harness({
    net: fakeNet({ body: JSON.stringify([release('v1.2.0')]) }),
    requireAutoUpdater: () => ({ autoUpdater: au }),
  });
  await h.updater.check({ manual: true });
  const result = await h.updater.download();
  assert.equal(result.ok, false);
  const state = h.updater.getUpdateState();
  assert.equal(state.status, 'error');
  assert.match(state.error, /ENOSPC/);
  assert.ok(state.error.length <= 60);
  // an electron-updater error event lands in the state too
  au.emit('error', new Error('signature verification failed'));
  assert.equal(h.updater.getUpdateState().error, 'signature verification failed');
});

test('updates.autoDownload starts the download right after a successful check', async () => {
  const au = fakeAutoUpdater();
  const h = harness({
    net: fakeNet({ body: JSON.stringify([release('v1.2.0')]) }),
    requireAutoUpdater: () => ({ autoUpdater: au }),
    settings: { updates: { autoCheck: true, intervalHours: 24, autoDownload: true, includePrerelease: false } },
  });
  await h.updater.check({ manual: true });
  await flush();
  await flush();
  assert.deepEqual(au.calls, ['checkForUpdates', 'downloadUpdate:token']);
  assert.equal(h.updater.getUpdateState().status, 'ready');
});

test('a missing electron-updater falls back to manual instead of crashing', async () => {
  const h = harness({
    net: fakeNet({ body: JSON.stringify([release('v1.2.0')]) }),
    requireAutoUpdater: () => {
      throw new Error("Cannot find module 'electron-updater'");
    },
  });
  // Windows NSIS would be 'auto' – without the dependency it degrades
  h.updater.start();
  assert.equal(h.updater.getUpdateState().capability, 'manual');
  assert.ok(h.logs.some((line) => line.includes('electron-updater is not available')));
  await h.updater.check({ manual: true });
  assert.deepEqual(await h.updater.download(), { ok: true });
  assert.deepEqual(h.opened, [`${DL}/v1.2.0/AugenPause-Setup-1.2.0-x64.exe`], 'opened in the browser instead');
  assert.deepEqual(h.updater.install(), { ok: false, error: 'not-supported' });
});

test('a broken electron-updater export falls back to manual as well', () => {
  const h = harness({ net: fakeNet({ body: '[]' }), requireAutoUpdater: () => ({}) });
  h.updater.start();
  assert.equal(h.updater.getUpdateState().capability, 'manual');
  assert.ok(h.logs.some((line) => line.includes('falling back to manual updates')));
});

test('createUpdater survives missing dependencies', async () => {
  const updater = createUpdater({});
  assert.equal(updater.getUpdateState().status, 'idle');
  assert.deepEqual(await updater.check({ manual: true }), { ok: false, error: 'net-unavailable' });
  assert.equal(updater.getUpdateState().error, 'net-unavailable');
  assert.doesNotThrow(() => updater.start());
  assert.doesNotThrow(() => updater.stop());
  assert.doesNotThrow(() => updater.onSettingsChanged());
  assert.deepEqual(updater.install(), { ok: false, error: 'not-supported' });
  assert.deepEqual(updater.openReleasePage(), { ok: false, error: 'not-supported' });
});
