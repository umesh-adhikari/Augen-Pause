'use strict';

/**
 * Automatic meeting detection (docs/ARCHITECTURE.md §9). Pure Node – no electron.
 *
 *   const detector = createMeetingDetector({ platform, getState, getSettings, onChange(active), log });
 *   detector.start();  detector.stop();  await detector.checkNow();  // → boolean (meeting active)
 *
 * Signals ("camera or microphone in use" / "call app keeps the display awake"):
 *   win32  – %SystemRoot%\System32\reg.exe query HKCU\…\CapabilityAccessManager\ConsentStore\{microphone,webcam}
 *            (recursive, incl. NonPackaged): any LastUsedTimeStop REG_QWORD 0x0 ⇒ an app is using the device right now.
 *   linux  – `pactl list short source-outputs` non-empty (a recording stream exists; pactl only from
 *            /usr/bin, /bin or /usr/local/bin – skipped when none exists) OR any /proc/<pid>/fd/* symlink
 *            pointing to /dev/video* (bounded scan: numeric pids only, ≤ 4096 processes, stops at the first hit).
 *   darwin – /usr/bin/pmset -g assertions: an assertion owned by a known call app, or
 *            "WebRTC has active PeerConnections" (Chromium browsers during Meet / Teams web calls).
 *
 * Commands run with child_process.execFile only: absolute executable paths (no PATH lookup), never a shell,
 * fixed arguments, 5 s timeout, hidden console window. Every failure (missing binary, timeout, non-zero exit)
 * counts as "no meeting".
 *
 * Polling is adaptive: 10 s when (phase work && remainingMs ≤ 5 min) || (non-strict) phase break || during the
 * first 10 minutes of a meeting deferral; otherwise (incl. long deferrals) 60 s. During a mandatory break (§11)
 * a meeting cannot end the break, so polling stays slow (60 s) – the state is only needed for the deferral rules
 * after the break. With meeting.autoDetect = false no command runs at all (the detector only re-reads the
 * setting every 10 s and reports "no meeting").
 * Hysteresis: a meeting starts on the first positive probe but only ends after 2 consecutive negative
 * probes, so a short device re-open (e.g. switching microphones) does not trigger a break warning.
 */

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const EXEC_TIMEOUT_MS = 5000;
const EXEC_MAX_BUFFER = 2 * 1024 * 1024;
const FAST_POLL_MS = 10 * 1000;
const SLOW_POLL_MS = 60 * 1000;
const NEAR_BREAK_MS = 5 * 60 * 1000;
/** Fast polling while deferred only for this long – long meetings are then checked every SLOW_POLL_MS. */
const DEFERRAL_FAST_POLL_MS = 10 * 60 * 1000;
const INACTIVE_CONFIRMATIONS = 2;

const LINUX_PACTL_PATHS = Object.freeze(['/usr/bin/pactl', '/bin/pactl', '/usr/local/bin/pactl']);
const MAC_PMSET_PATH = '/usr/bin/pmset';
/** /proc scan bounds (the scan runs every 10 s near a break). */
const PROC_MAX_PROCESSES = 4096;
const PROC_MAX_FDS_PER_PROCESS = 4096;
const PROC_READLINK_BATCH = 64;
const PROC_SCAN_BUDGET_MS = 2000;

const WINDOWS_CONSENT_KEYS = Object.freeze([
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\microphone',
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam',
]);

/** Lower-case substrings of macOS process names that indicate a call app. */
const MAC_CALL_APPS = Object.freeze([
  'zoom.us',
  'microsoft teams',
  'msteams',
  'teams',
  'webex',
  'facetime',
  'avconferenced',
  'slack',
  'discord',
]);
const WEBRTC_ASSERTION = 'WebRTC has active PeerConnections';

// ---------------------------------------------------------------------------------------------
// Pure parsers

/**
 * `reg query <ConsentStore key> /s /v LastUsedTimeStop` output → true when any value is 0x0.
 * Language independent (only the value lines are inspected).
 */
function parseRegQuery(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return false;
  return stdout.split(/\r?\n/).some((line) => /^\s*LastUsedTimeStop\s+REG_QWORD\s+0x0+\s*$/i.test(line));
}

/** `pactl list short source-outputs` output → true when at least one recording stream exists. */
function parsePactl(stdout) {
  if (typeof stdout !== 'string') return false;
  return stdout.split(/\r?\n/).some((line) => line.trim().length > 0);
}

/**
 * `pmset -g assertions` output → true for an assertion owned by a known call app
 * (only the "Listed by owning process" lines are considered) or an active WebRTC call in a browser.
 */
function parsePmsetAssertions(stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) return false;
  if (stdout.includes(WEBRTC_ASSERTION)) return true;
  for (const line of stdout.split(/\r?\n/)) {
    // e.g. "   pid 812(zoom.us): [0x0000a1b200019c3d] 00:12:31 PreventUserIdleDisplaySleep named: "…""
    const match = /^\s*pid\s+\d+\((.*)\):\s+\[0x[0-9a-f]+\]/i.exec(line);
    if (!match) continue;
    const owner = match[1].toLowerCase();
    if (MAC_CALL_APPS.some((app) => owner.includes(app))) return true;
  }
  return false;
}

/** readlink target of a /proc/<pid>/fd entry → true for a V4L2 video device. */
function isVideoDeviceLink(target) {
  return typeof target === 'string' && /^\/dev\/video\d+$/.test(target);
}

function autoDetectEnabled(settings) {
  return !(settings && settings.meeting && settings.meeting.autoDetect === false);
}

/**
 * Poll interval for the current state, or null when detection is switched off.
 * @param {object|null} state SchedulerState
 * @param {object|null} settings Settings
 * @param {number} [deferredForMs] how long the current meeting deferral has lasted (0 when unknown)
 * @param {boolean} [strictBreak] a mandatory break runs (main's decision); undefined → settings.breaks.strictMode
 */
function pollIntervalMs(state, settings, deferredForMs = 0, strictBreak = undefined) {
  if (!autoDetectEnabled(settings)) return null;
  const s = state || {};
  if (s.phase === 'break') {
    const strict = typeof strictBreak === 'boolean'
      ? strictBreak
      : Boolean(settings && settings.breaks && settings.breaks.strictMode === true);
    return strict ? SLOW_POLL_MS : FAST_POLL_MS;
  }
  if (s.meeting && s.meeting.deferred) {
    // work.remainingMs is 0 while deferred → decide here, before the "near a break" rule.
    const forMs = Number.isFinite(deferredForMs) ? deferredForMs : 0;
    return forMs < DEFERRAL_FAST_POLL_MS ? FAST_POLL_MS : SLOW_POLL_MS;
  }
  const remaining = s.work && s.work.remainingMs;
  if (s.phase === 'work' && typeof remaining === 'number' && Number.isFinite(remaining) && remaining <= NEAR_BREAK_MS) {
    return FAST_POLL_MS;
  }
  return SLOW_POLL_MS;
}

// ---------------------------------------------------------------------------------------------
// Platform probes

/** execFile wrapper → Promise<stdout>. No shell, fixed args, timeout, hidden window. */
function runCommand(file, args) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        shell: false,
        timeout: EXEC_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        maxBuffer: EXEC_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
      },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || ''))),
    );
  });
}

/** Absolute path of reg.exe – never a PATH lookup of "reg" (a planted reg.exe in the cwd/PATH is ignored). */
function windowsRegExe(env = process.env) {
  const e = env || {};
  const root = e.SystemRoot || e.SYSTEMROOT || e.windir || 'C:\\Windows';
  return path.win32.join(root, 'System32', 'reg.exe');
}

/** Default existence check for an executable (async, never throws). */
async function executableExists(file) {
  try {
    await fs.promises.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * First existing pactl of LINUX_PACTL_PATHS, or null.
 * @param {(file: string) => Promise<boolean>} [exists]
 */
async function findLinuxPactl(exists = executableExists) {
  for (const candidate of LINUX_PACTL_PATHS) {
    try {
      if (await exists(candidate)) return candidate;
    } catch {
      // try the next one
    }
  }
  return null;
}

/**
 * true when any other process has /dev/video* open. Bounded: numeric pids only (own pid skipped),
 * at most `maxProcesses` processes and `maxFds` fds per process, readlink in small batches,
 * unreadable processes (other users → EACCES) skipped, stops at the first hit or when the time budget is used up.
 */
async function linuxVideoDeviceInUse(fsp = fs.promises, selfPid = process.pid, limits = {}) {
  const maxProcesses = limits.maxProcesses || PROC_MAX_PROCESSES;
  const maxFds = limits.maxFds || PROC_MAX_FDS_PER_PROCESS;
  const budgetMs = limits.budgetMs || PROC_SCAN_BUDGET_MS;
  const now = typeof limits.now === 'function' ? limits.now : Date.now;
  const deadline = now() + budgetMs;

  let entries;
  try {
    entries = await fsp.readdir('/proc');
  } catch {
    return false;
  }
  let scanned = 0;
  for (const name of entries) {
    if (typeof name !== 'string' || !/^\d+$/.test(name) || Number(name) === selfPid) continue;
    if (scanned >= maxProcesses || now() > deadline) return false;
    scanned += 1;
    let fds;
    try {
      fds = await fsp.readdir(`/proc/${name}/fd`); // other users' processes → EACCES → skipped
    } catch {
      continue;
    }
    const limited = fds.length > maxFds ? fds.slice(0, maxFds) : fds;
    for (let i = 0; i < limited.length; i += PROC_READLINK_BATCH) {
      const batch = limited.slice(i, i + PROC_READLINK_BATCH);
      // eslint-disable-next-line no-await-in-loop
      const targets = await Promise.all(batch.map((fd) => fsp.readlink(`/proc/${name}/fd/${fd}`).catch(() => null)));
      if (targets.some(isVideoDeviceLink)) return true;
    }
  }
  return false;
}

/**
 * @param {string} platform
 * @param {(file: string, args: string[]) => Promise<string>} run
 * @param {{ fsp?: typeof fs.promises, env?: object, exists?: (file: string) => Promise<boolean> }} [extra]
 * @returns {() => Promise<boolean>}
 */
function createPlatformProbe(platform, run = runCommand, extra = {}) {
  const ok = (parser) => (stdout) => parser(stdout);
  const no = () => false;

  if (platform === 'win32') {
    const reg = windowsRegExe(extra.env || process.env);
    return async () => {
      const results = await Promise.all(
        WINDOWS_CONSENT_KEYS.map((key) =>
          run(reg, ['query', key, '/s', '/v', 'LastUsedTimeStop']).then(ok(parseRegQuery), no)),
      );
      return results.some(Boolean);
    };
  }
  if (platform === 'linux') {
    const exists = typeof extra.exists === 'function' ? extra.exists : executableExists;
    return async () => {
      const pactl = await findLinuxPactl(exists);
      const recording = pactl ? await run(pactl, ['list', 'short', 'source-outputs']).then(ok(parsePactl), no) : false;
      if (recording) return true;
      return linuxVideoDeviceInUse(extra.fsp || fs.promises);
    };
  }
  if (platform === 'darwin') {
    return () => run(MAC_PMSET_PATH, ['-g', 'assertions']).then(ok(parsePmsetAssertions), no);
  }
  return async () => false;
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {{
 *   platform?: string,
 *   getState: () => object,
 *   getSettings: () => object,
 *   onChange: (active: boolean) => void,
 *   isStrictBreak?: () => boolean,                                  // main's mandatory-break decision (§11)
 *   log?: (...args: any[]) => void,
 *   execFile?: (file: string, args: string[]) => Promise<string>,   // injectable for tests
 *   probe?: () => Promise<boolean>,                                 // injectable for tests
 *   now?: () => number,                                             // injectable clock for tests
 * }} options
 * @returns {{ start(): void, stop(): void, checkNow(): Promise<boolean>, isActive(): boolean, nextInterval(): number }}
 */
function createMeetingDetector(options = {}) {
  const platform = options.platform || process.platform;
  const getState = typeof options.getState === 'function' ? options.getState : () => null;
  const getSettings = typeof options.getSettings === 'function' ? options.getSettings : () => null;
  const onChange = typeof options.onChange === 'function' ? options.onChange : () => {};
  const log = typeof options.log === 'function' ? options.log : () => {};
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const isStrictBreak = typeof options.isStrictBreak === 'function' ? options.isStrictBreak : null;
  const probe = options.probe || createPlatformProbe(platform, options.execFile || runCommand, options);

  let active = false;
  let negatives = 0;
  let running = false;
  let timer = null;
  let inflight = null;
  /** When the current meeting deferral was first seen (null while not deferred). */
  let deferredSince = null;
  /** Whether detection was enabled at the previous check (null before the first check). */
  let lastEnabled = null;

  const safe = (fn) => {
    try {
      return fn();
    } catch {
      return null;
    }
  };

  /** @param {boolean} next @param {boolean} [force] notify even when unchanged */
  function setActive(next, force = false) {
    if (next === active && !force) return;
    if (next !== active) log(`meeting ${next ? 'detected' : 'ended'}`);
    active = next;
    try {
      onChange(active);
    } catch (err) {
      log('meeting onChange failed:', err && err.message);
    }
  }

  async function detect() {
    try {
      return (await probe()) === true;
    } catch {
      return false;
    }
  }

  function checkNow() {
    if (inflight) return inflight;
    inflight = (async () => {
      if (!autoDetectEnabled(safe(getSettings))) {
        lastEnabled = false;
        negatives = 0;
        setActive(false);
        return false;
      }
      const found = await detect();
      if (!autoDetectEnabled(safe(getSettings))) {
        lastEnabled = false;
        negatives = 0;
        setActive(false);
        return false;
      }
      // First check, or re-enabled after being switched off: the scheduler forgot the meeting state
      // → report the current value even when it did not change.
      const force = lastEnabled !== true;
      lastEnabled = true;
      if (found) {
        negatives = 0;
        setActive(true, force);
      } else if (active) {
        negatives += 1;
        if (negatives >= INACTIVE_CONFIRMATIONS) {
          negatives = 0;
          setActive(false, force);
        } else if (force) {
          setActive(true, true);
        }
      } else {
        setActive(false, force);
      }
      return active;
    })().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  /** Next poll delay; tracks how long the current deferral has lasted. */
  function nextInterval() {
    const state = safe(getState);
    const deferred = Boolean(state && state.meeting && state.meeting.deferred);
    const t = now();
    if (!deferred) deferredSince = null;
    else if (deferredSince === null) deferredSince = t;
    const deferredFor = deferred ? Math.max(0, t - deferredSince) : 0;
    const strict = isStrictBreak ? safe(isStrictBreak) === true : undefined;
    // Off → no commands; just look at the setting again in FAST_POLL_MS.
    return pollIntervalMs(state, safe(getSettings), deferredFor, strict) || FAST_POLL_MS;
  }

  function schedule() {
    if (!running) return;
    const interval = nextInterval();
    timer = setTimeout(tick, interval);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function tick() {
    timer = null;
    if (!running) return;
    try {
      await checkNow();
    } finally {
      schedule();
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    checkNow,
    isActive: () => active,
    /** Delay until the next poll for the current state (exposed for tests). */
    nextInterval,
  };
}

module.exports = {
  createMeetingDetector,
  createPlatformProbe,
  parseRegQuery,
  parsePactl,
  parsePmsetAssertions,
  isVideoDeviceLink,
  pollIntervalMs,
  autoDetectEnabled,
  linuxVideoDeviceInUse,
  findLinuxPactl,
  windowsRegExe,
  WINDOWS_CONSENT_KEYS,
  LINUX_PACTL_PATHS,
  MAC_PMSET_PATH,
  MAC_CALL_APPS,
  FAST_POLL_MS,
  SLOW_POLL_MS,
  DEFERRAL_FAST_POLL_MS,
  PROC_MAX_PROCESSES,
  EXEC_TIMEOUT_MS,
};
