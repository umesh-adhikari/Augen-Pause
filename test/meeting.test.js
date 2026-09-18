'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const m = require('../src/main/meeting');

// ---- Windows: reg query ---------------------------------------------------------------------

const REG_IN_USE = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe',
  '    LastUsedTimeStop    REG_QWORD    0x1db0a7c3e2f4a10',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone\\NonPackaged\\C:#Users#me#AppData#Roaming#Zoom#bin#Zoom.exe',
  '    LastUsedTimeStop    REG_QWORD    0x0',
  '',
  'End of search: 2 match(es) found.',
  '',
].join('\r\n');

const REG_IDLE_DE = [
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam\\MSTeams_8wekyb3d8bbwe',
  '    LastUsedTimeStop    REG_QWORD    0x1db0a7c3e2f4a10',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam\\NonPackaged\\C:#Program Files#Google#Chrome#Application#chrome.exe',
  '    LastUsedTimeStop    REG_QWORD    0x1dafe0f00a0b0c0',
  '',
  'Suche beendet: 2 Übereinstimmung(en) gefunden.',
  '',
].join('\r\n');

test('parseRegQuery: LastUsedTimeStop 0x0 means a device is in use', () => {
  assert.equal(m.parseRegQuery(REG_IN_USE), true);
  assert.equal(m.parseRegQuery(REG_IDLE_DE), false);
  assert.equal(m.parseRegQuery('    LastUsedTimeStop    REG_QWORD    0x0000\n'), true);
  assert.equal(m.parseRegQuery('    LastUsedTimeStop    REG_QWORD    0x00a\n'), false);
  assert.equal(m.parseRegQuery('    LastUsedTimeStart    REG_QWORD    0x0\n'), false);
  assert.equal(m.parseRegQuery('ERROR: The system was unable to find the specified registry key or value.'), false);
  assert.equal(m.parseRegQuery(''), false);
  assert.equal(m.parseRegQuery(null), false);
});

test('windows probe queries both ConsentStore keys via reg.exe with fixed args', async () => {
  const calls = [];
  const probe = m.createPlatformProbe(
    'win32',
    async (file, args) => {
      calls.push([file, args]);
      return args[1].endsWith('webcam') ? REG_IN_USE : REG_IDLE_DE;
    },
    { env: { SystemRoot: 'C:\\Windows' } },
  );
  assert.equal(await probe(), true);
  assert.deepEqual(calls, [
    ['C:\\Windows\\System32\\reg.exe', ['query', m.WINDOWS_CONSENT_KEYS[0], '/s', '/v', 'LastUsedTimeStop']],
    ['C:\\Windows\\System32\\reg.exe', ['query', m.WINDOWS_CONSENT_KEYS[1], '/s', '/v', 'LastUsedTimeStop']],
  ]);
  assert.match(m.WINDOWS_CONSENT_KEYS[0], /ConsentStore\\microphone$/);
  assert.match(m.WINDOWS_CONSENT_KEYS[1], /ConsentStore\\webcam$/);
});

test('windows probe: command failures count as "no meeting"', async () => {
  const failing = m.createPlatformProbe('win32', async () => {
    throw Object.assign(new Error('Command failed'), { code: 1 });
  }, { env: {} });
  assert.equal(await failing(), false);
  const oneFails = m.createPlatformProbe('win32', async (_file, args) => {
    if (args[1].endsWith('microphone')) throw new Error('timeout');
    return REG_IDLE_DE;
  }, { env: {} });
  assert.equal(await oneFails(), false);
});

test('windowsRegExe: always an absolute System32 path, never a PATH lookup', () => {
  assert.equal(m.windowsRegExe({ SystemRoot: 'D:\\Win' }), 'D:\\Win\\System32\\reg.exe');
  assert.equal(m.windowsRegExe({ SYSTEMROOT: 'E:\\WINDOWS' }), 'E:\\WINDOWS\\System32\\reg.exe');
  assert.equal(m.windowsRegExe({ windir: 'C:\\WINNT' }), 'C:\\WINNT\\System32\\reg.exe');
  assert.equal(m.windowsRegExe({}), 'C:\\Windows\\System32\\reg.exe');
  assert.equal(m.windowsRegExe(null), 'C:\\Windows\\System32\\reg.exe');
  assert.equal(m.windowsRegExe({ SystemRoot: 'C:\\Windows', windir: 'X:\\evil' }), 'C:\\Windows\\System32\\reg.exe');
});

// ---- Linux: pactl + /proc ---------------------------------------------------------------------

test('parsePactl: any source-output line means recording', () => {
  assert.equal(m.parsePactl('42\t1\t67\tprotocol-native.c\tfloat32le 1ch 48000Hz\n'), true);
  assert.equal(m.parsePactl('42\t1\t67\tPipeWire\ts16le 2ch 48000Hz\n57\t3\t71\tPipeWire\tfloat32le 1ch 48000Hz\n'), true);
  assert.equal(m.parsePactl(''), false);
  assert.equal(m.parsePactl('\n  \n'), false);
  assert.equal(m.parsePactl(undefined), false);
});

test('isVideoDeviceLink', () => {
  assert.equal(m.isVideoDeviceLink('/dev/video0'), true);
  assert.equal(m.isVideoDeviceLink('/dev/video12'), true);
  assert.equal(m.isVideoDeviceLink('/dev/video'), false);
  assert.equal(m.isVideoDeviceLink('/dev/video0 (deleted)'), false);
  assert.equal(m.isVideoDeviceLink('/dev/snd/pcmC0D0c'), false);
  assert.equal(m.isVideoDeviceLink('socket:[12345]'), false);
  assert.equal(m.isVideoDeviceLink(null), false);
});

function fakeProc(tree) {
  const eacces = () => Object.assign(new Error('EACCES'), { code: 'EACCES' });
  return {
    async readdir(dir) {
      if (dir === '/proc') return Object.keys(tree).concat(['self', 'cpuinfo']);
      const pid = /^\/proc\/(\d+)\/fd$/.exec(dir);
      if (!pid || !tree[pid[1]]) throw eacces();
      return Object.keys(tree[pid[1]]);
    },
    async readlink(p) {
      const parts = /^\/proc\/(\d+)\/fd\/(\d+)$/.exec(p);
      if (!parts) throw eacces();
      return tree[parts[1]][parts[2]];
    },
  };
}

const onlyExists = (...files) => async (file) => files.includes(file);

test('linux probe: pactl first, then /proc fds → /dev/video*', async () => {
  const quiet = async () => '';
  const noCamera = fakeProc({ 100: { 0: '/dev/null', 1: 'pipe:[1]', 2: '/dev/snd/controlC0' }, 200: null });
  const camera = fakeProc({ 100: { 0: '/dev/null' }, 300: { 0: '/dev/null', 17: '/dev/video0' } });
  const exists = onlyExists('/usr/bin/pactl');

  assert.equal(await m.createPlatformProbe('linux', quiet, { fsp: noCamera, exists })(), false);
  assert.equal(await m.createPlatformProbe('linux', quiet, { fsp: camera, exists })(), true);
  assert.equal(
    await m.createPlatformProbe('linux', async () => '42\t1\t67\tPipeWire\tfloat32le 1ch 48000Hz\n', { fsp: noCamera, exists })(),
    true,
  );

  const failingPactl = async () => {
    throw Object.assign(new Error('Command failed'), { code: 1 });
  };
  assert.equal(await m.createPlatformProbe('linux', failingPactl, { fsp: noCamera, exists })(), false);
  assert.equal(await m.createPlatformProbe('linux', failingPactl, { fsp: camera, exists })(), true);

  const calls = [];
  await m.createPlatformProbe('linux', async (file, args) => {
    calls.push([file, args]);
    return '';
  }, { fsp: noCamera, exists })();
  assert.deepEqual(calls, [['/usr/bin/pactl', ['list', 'short', 'source-outputs']]]);
});

test('linux probe: pactl only from fixed absolute paths, skipped when none exists', async () => {
  const noCamera = fakeProc({ 100: { 0: '/dev/null' } });
  const camera = fakeProc({ 300: { 17: '/dev/video2' } });
  const recording = '42\t1\t67\tPipeWire\tfloat32le 1ch 48000Hz\n';

  const run = (calls) => async (file, args) => {
    calls.push([file, args]);
    return recording;
  };

  let calls = [];
  assert.equal(await m.createPlatformProbe('linux', run(calls), { fsp: noCamera, exists: onlyExists() })(), false);
  assert.deepEqual(calls, [], 'no pactl → no command at all');
  assert.equal(await m.createPlatformProbe('linux', run(calls), { fsp: camera, exists: onlyExists() })(), true, '/proc scan still runs');

  calls = [];
  await m.createPlatformProbe('linux', run(calls), { fsp: noCamera, exists: onlyExists('/usr/local/bin/pactl', '/bin/pactl') })();
  assert.deepEqual(calls.map((c) => c[0]), ['/bin/pactl'], 'first existing candidate wins');

  const throwing = async () => {
    throw new Error('EACCES');
  };
  assert.equal(await m.findLinuxPactl(throwing), null);
  assert.deepEqual([...m.LINUX_PACTL_PATHS], ['/usr/bin/pactl', '/bin/pactl', '/usr/local/bin/pactl']);
  for (const file of m.LINUX_PACTL_PATHS) assert.ok(file.startsWith('/'));
  assert.equal(m.MAC_PMSET_PATH, '/usr/bin/pmset');
});

test('linuxVideoDeviceInUse ignores its own pid and unreadable /proc', async () => {
  const own = fakeProc({ 4242: { 3: '/dev/video0' } });
  assert.equal(await m.linuxVideoDeviceInUse(own, 4242), false);
  assert.equal(await m.linuxVideoDeviceInUse(own, 1), true);
  const broken = { readdir: async () => { throw new Error('ENOENT'); }, readlink: async () => '' };
  assert.equal(await m.linuxVideoDeviceInUse(broken, 1), false);
});

test('linuxVideoDeviceInUse: bounded scan (numeric pids, process cap, stops at first hit)', async () => {
  const tree = {};
  for (let pid = 1; pid <= 50; pid += 1) tree[pid] = { 0: '/dev/null', 1: 'pipe:[9]' };
  tree[40] = { 0: '/dev/null', 5: '/dev/video1' };
  tree[45] = { 0: '/dev/video0' };
  const readdirs = [];
  const readlinks = [];
  const base = fakeProc(tree);
  const fsp = {
    readdir: async (dir) => {
      readdirs.push(dir);
      if (dir === '/proc') return ['self', 'cpuinfo', 'net', ...Object.keys(tree)];
      return base.readdir(dir);
    },
    readlink: async (p) => {
      readlinks.push(p);
      return base.readlink(p);
    },
  };

  assert.equal(await m.linuxVideoDeviceInUse(fsp, 0), true);
  assert.ok(!readdirs.some((d) => /\/proc\/(self|cpuinfo|net)\//.test(d)), 'non-numeric entries skipped');
  assert.ok(!readdirs.includes('/proc/41/fd'), 'stops at the first hit');
  assert.ok(!readlinks.some((p) => p.startsWith('/proc/45/')));

  readdirs.length = 0;
  assert.equal(await m.linuxVideoDeviceInUse(fsp, 0, { maxProcesses: 10 }), false, 'hit beyond the process cap');
  assert.equal(readdirs.filter((d) => d !== '/proc').length, 10);

  // many fds in one process: readlink in batches, capped per process
  const huge = {};
  for (let fd = 0; fd < 300; fd += 1) huge[fd] = 'socket:[1]';
  huge[299] = '/dev/video3';
  const hugeProc = fakeProc({ 7: huge });
  assert.equal(await m.linuxVideoDeviceInUse(hugeProc, 0), true);
  assert.equal(await m.linuxVideoDeviceInUse(hugeProc, 0, { maxFds: 100 }), false);

  // time budget
  let clock = 0;
  const slow = {
    readdir: async (dir) => {
      clock += 1000;
      return base.readdir(dir);
    },
    readlink: base.readlink,
  };
  assert.equal(await m.linuxVideoDeviceInUse(slow, 0, { budgetMs: 2500, now: () => clock }), false);
  assert.equal(m.PROC_MAX_PROCESSES, 4096);
});

// ---- macOS: pmset -g assertions -------------------------------------------------------------

const PMSET_HEADER = [
  '2026-09-17 14:02:11 +0200 ',
  'Assertion status system-wide:',
  '   BackgroundTask                 0',
  '   ApplePushServiceTask           0',
  '   UserIsActive                   1',
  '   PreventUserIdleDisplaySleep    1',
  '   PreventSystemSleep             0',
  '   ExternalMedia                  0',
  '   PreventUserIdleSystemSleep     1',
  '   NetworkClientActive            0',
  'Listed by owning process:',
];
const PMSET_FOOTER = [
  'Kernel Assertions: 0x4=USB',
  '   id=500  level=255 0x4=USB mod=17.09.26, 09:12 description=com.apple.usb.externaldevice.01100000 owner=AppleUSBXHCI',
  'Idle sleep preventers: IODisplayWrangler',
];
const pmset = (...lines) => [...PMSET_HEADER, ...lines, ...PMSET_FOOTER].join('\n');

test('parsePmsetAssertions: known call apps', () => {
  assert.equal(
    m.parsePmsetAssertions(pmset('   pid 812(zoom.us): [0x0000a1b200019c3d] 00:12:31 PreventUserIdleDisplaySleep named: "zoom.us is in a meeting" ')),
    true,
  );
  assert.equal(
    m.parsePmsetAssertions(pmset(
      '   pid 1204(Microsoft Teams (work or school)): [0x0000b2c30001a4e5] 00:40:02 PreventUserIdleDisplaySleep named: "Call in progress" ',
    )),
    true,
  );
  assert.equal(
    m.parsePmsetAssertions(pmset('   pid 977(avconferenced): [0x00000abc00018f2a] 00:03:10 PreventUserIdleSystemSleep named: "FaceTime call" ')),
    true,
  );
  assert.equal(m.parsePmsetAssertions(pmset('   pid 3321(Webex): [0x0000123400017777] 00:01:00 PreventUserIdleDisplaySleep named: "Webex Meeting" ')), true);
  assert.equal(m.parsePmsetAssertions(pmset('   pid 441(Discord): [0x0000123400017778] 00:01:00 PreventUserIdleSystemSleep named: "Electron" ')), true);
  assert.equal(m.parsePmsetAssertions(pmset('   pid 552(Slack): [0x0000123400017779] 00:01:00 PreventUserIdleSystemSleep named: "Electron" ')), true);
});

test('parsePmsetAssertions: WebRTC calls in Chromium browsers', () => {
  assert.equal(
    m.parsePmsetAssertions(pmset(
      '   pid 655(Google Chrome): [0x00001234000189ab] 00:05:00 PreventUserIdleDisplaySleep named: "WebRTC has active PeerConnections" ',
    )),
    true,
  );
});

test('parsePmsetAssertions: ordinary assertions are not meetings', () => {
  const idle = pmset(
    '   pid 102(coreaudiod): [0x000009e700018b1c] 00:10:00 PreventUserIdleSystemSleep named: "com.apple.audio.BuiltInSpeakerDevice.context.preventuseridlesleep" ',
    '\tCreated for PID: 655. ',
    '   pid 655(Google Chrome): [0x0000123400018a01] 00:02:00 PreventUserIdleDisplaySleep named: "Playing video" ',
    '   pid 88(powerd): [0x0000000100000001] 01:00:00 PreventUserIdleSystemSleep named: "Powerd - Prevent sleep while display is on" ',
    '   pid 390(Safari): [0x0000555500018001] 00:00:30 PreventUserIdleDisplaySleep named: "Video Wake Lock" ',
  );
  assert.equal(m.parsePmsetAssertions(idle), false);
  assert.equal(m.parsePmsetAssertions(''), false);
  assert.equal(m.parsePmsetAssertions(null), false);
});

test('darwin probe runs /usr/bin/pmset -g assertions', async () => {
  const calls = [];
  const probe = m.createPlatformProbe('darwin', async (file, args) => {
    calls.push([file, args]);
    return pmset('   pid 812(zoom.us): [0x0000a1b200019c3d] 00:12:31 PreventUserIdleDisplaySleep named: "zoom" ');
  });
  assert.equal(await probe(), true);
  assert.deepEqual(calls, [['/usr/bin/pmset', ['-g', 'assertions']]]);
  assert.equal(await m.createPlatformProbe('darwin', async () => { throw new Error('ETIMEDOUT'); })(), false);
  assert.equal(await m.createPlatformProbe('freebsd', async () => 'x')(), false);
});

// ---- polling policy ----------------------------------------------------------------------------

test('pollIntervalMs: 10 s near/in a break or early in a deferral, 60 s otherwise, null when off', () => {
  const on = { meeting: { autoDetect: true } };
  const work = (remainingMs, deferred = false) => ({ phase: 'work', work: { remainingMs }, meeting: { deferred } });
  assert.equal(m.pollIntervalMs(work(20 * 60000), on), 60000);
  assert.equal(m.pollIntervalMs(work(5 * 60000), on), 10000);
  assert.equal(m.pollIntervalMs(work(30000), on), 10000);
  assert.equal(m.pollIntervalMs(work(0, true), on), 10000);
  assert.equal(m.pollIntervalMs(work(0, true), on, 9 * 60000), 10000);
  assert.equal(m.pollIntervalMs(work(0, true), on, 10 * 60000), 60000, 'long deferral → slow polling despite remainingMs 0');
  assert.equal(m.pollIntervalMs(work(0, true), on, 90 * 60000), 60000);
  assert.equal(m.pollIntervalMs(work(0, true), on, NaN), 10000);
  assert.equal(m.pollIntervalMs({ phase: 'break', meeting: { deferred: true } }, on, 60 * 60000), 10000);
  assert.equal(m.pollIntervalMs({ phase: 'break', work: { remainingMs: 0 } }, on), 10000);
  assert.equal(m.pollIntervalMs({ phase: 'paused', work: { remainingMs: 1000 } }, on), 60000);
  assert.equal(m.pollIntervalMs({ phase: 'off-hours' }, on), 60000);
  assert.equal(m.pollIntervalMs(null, on), 60000);
  assert.equal(m.pollIntervalMs(work(1000), { meeting: { autoDetect: false } }), null);
  assert.equal(m.pollIntervalMs(work(1000), {}), 10000, 'missing group → default autoDetect true');
});

test('pollIntervalMs: a mandatory break keeps polling slow (§11)', () => {
  const on = { meeting: { autoDetect: true } };
  const strict = { meeting: { autoDetect: true }, breaks: { strictMode: true } };
  const inBreak = { phase: 'break', work: { remainingMs: 0 }, break: { remainingMs: 60000 } };
  // a mandatory break is never shortened by a meeting → no need to look every 10 s
  assert.equal(m.pollIntervalMs(inBreak, strict), 60000);
  assert.equal(m.pollIntervalMs(inBreak, strict, 0, true), 60000, 'main\'s flag says strict');
  // ... not even when a deferral is pending
  assert.equal(m.pollIntervalMs({ ...inBreak, meeting: { deferred: true } }, strict), 60000);
  // non-strict breaks keep the §9 behaviour (a meeting releases them → fast polling)
  assert.equal(m.pollIntervalMs(inBreak, on), 10000);
  assert.equal(m.pollIntervalMs(inBreak, strict, 0, false), 10000, 'main\'s flag wins over the setting');
  assert.equal(m.pollIntervalMs(inBreak, on, 0, true), 60000);
  // switched off stays off
  assert.equal(m.pollIntervalMs(inBreak, { meeting: { autoDetect: false }, breaks: { strictMode: true } }, 0, true), null);
});

// ---- detector ------------------------------------------------------------------------------------

function detectorWith(results, settings = { meeting: { autoDetect: true } }) {
  const changes = [];
  let probes = 0;
  const box = { settings };
  const detector = m.createMeetingDetector({
    platform: 'win32',
    getState: () => ({ phase: 'work', work: { remainingMs: 60000 }, meeting: { deferred: false } }),
    getSettings: () => box.settings,
    onChange: (active) => changes.push(active),
    probe: async () => {
      const value = results[Math.min(probes, results.length - 1)];
      probes += 1;
      if (value instanceof Error) throw value;
      return value;
    },
  });
  return { detector, changes, box, probes: () => probes };
}

test('detector reports the initial state once, then changes only, with 2-probe hysteresis for the end', async () => {
  const { detector, changes } = detectorWith([false, true, true, false, true, false, false, false]);
  const seen = [];
  for (let i = 0; i < 8; i += 1) seen.push(await detector.checkNow());
  assert.deepEqual(seen, [false, true, true, true, true, true, false, false]);
  assert.deepEqual(changes, [false, true, false]);
});

test('detector: probe errors count as no meeting', async () => {
  const { detector, changes } = detectorWith([new Error('boom'), true, new Error('boom'), new Error('boom')]);
  assert.equal(await detector.checkNow(), false);
  assert.equal(await detector.checkNow(), true);
  assert.equal(await detector.checkNow(), true);
  assert.equal(await detector.checkNow(), false);
  assert.deepEqual(changes, [false, true, false]);
});

test('detector: autoDetect off → no probes, immediately inactive', async () => {
  const { detector, changes, box, probes } = detectorWith([true]);
  assert.equal(await detector.checkNow(), true);
  box.settings = { meeting: { autoDetect: false } };
  assert.equal(await detector.checkNow(), false);
  assert.equal(await detector.checkNow(), false);
  assert.equal(probes(), 1);
  assert.deepEqual(changes, [true, false]);
});

test('detector: re-enabling autoDetect re-sends the current state even when unchanged', async () => {
  const { detector, changes, box } = detectorWith([false, false, false]);
  assert.equal(await detector.checkNow(), false);
  assert.deepEqual(changes, [false]);
  box.settings = { meeting: { autoDetect: false } };
  await detector.checkNow();
  assert.deepEqual(changes, [false], 'already inactive → no duplicate while off');
  box.settings = { meeting: { autoDetect: true } };
  await detector.checkNow();
  assert.deepEqual(changes, [false, false], 're-enabled → current state sent again');
  await detector.checkNow();
  assert.deepEqual(changes, [false, false]);

  const active = detectorWith([true, true, true]);
  await active.detector.checkNow();
  active.box.settings = { meeting: { autoDetect: false } };
  await active.detector.checkNow();
  active.box.settings = { meeting: { autoDetect: true } };
  await active.detector.checkNow();
  assert.deepEqual(active.changes, [true, false, true]);
});

test('detector: concurrent checkNow calls share one probe', async () => {
  let release;
  let probes = 0;
  const detector = m.createMeetingDetector({
    platform: 'linux',
    getSettings: () => ({}),
    probe: () => {
      probes += 1;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  const a = detector.checkNow();
  const b = detector.checkNow();
  assert.equal(a, b);
  release(true);
  assert.equal(await a, true);
  assert.equal(probes, 1);
  assert.equal(detector.isActive(), true);
});

test('detector: fast polling only for the first 10 minutes of a deferral', () => {
  let clock = 1_000_000;
  const box = { state: { phase: 'work', work: { remainingMs: 20 * 60000 }, meeting: { deferred: false } } };
  const detector = m.createMeetingDetector({
    platform: 'win32',
    getState: () => box.state,
    getSettings: () => ({ meeting: { autoDetect: true } }),
    probe: async () => false,
    now: () => clock,
  });
  assert.equal(detector.nextInterval(), m.SLOW_POLL_MS);
  box.state = { phase: 'work', work: { remainingMs: 0 }, meeting: { deferred: true } };
  assert.equal(detector.nextInterval(), m.FAST_POLL_MS, 'deferral starts');
  clock += 9 * 60000;
  assert.equal(detector.nextInterval(), m.FAST_POLL_MS);
  clock += 60000;
  assert.equal(detector.nextInterval(), m.SLOW_POLL_MS, '10 minutes deferred');
  clock += 60 * 60000;
  assert.equal(detector.nextInterval(), m.SLOW_POLL_MS);
  box.state = { phase: 'work', work: { remainingMs: 60000 }, meeting: { deferred: false } };
  assert.equal(detector.nextInterval(), m.FAST_POLL_MS, 'deferral over, break near');
  box.state = { phase: 'work', work: { remainingMs: 0 }, meeting: { deferred: true } };
  assert.equal(detector.nextInterval(), m.FAST_POLL_MS, 'a new deferral starts fast again');
  assert.equal(m.DEFERRAL_FAST_POLL_MS, 10 * 60000);
});

test('detector start/stop polls without keeping the process alive', async () => {
  const { detector, probes } = detectorWith([false]);
  detector.start();
  detector.start(); // idempotent
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probes(), 1);
  detector.stop();
});
