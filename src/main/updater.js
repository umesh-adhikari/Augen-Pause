'use strict';

/**
 * Update check against the GitHub releases of `umesh-adhikari/Augen-Pause` – docs/ARCHITECTURE.md §12.
 * This is the ONLY outgoing network request of the whole app, and it is switchable
 * (`settings.updates.autoCheck`).
 *
 *   const updater = createUpdater({ app, settings, getState, onState, notifier, shellOpen, net, log });
 *   updater.start()                     // schedule the periodic check (no-op without updates.autoCheck)
 *   updater.stop()
 *   await updater.check({ manual })      // → { ok, error? }
 *   await updater.download()             // 'auto': electron-updater; 'manual': open the asset URL
 *   updater.install()                    // 'auto': quitAndInstall; refused while a break runs
 *   updater.openReleasePage()            // shell.openExternal, allowlisted URL only
 *   updater.getUpdateState()             // the §12 update state (fresh object)
 *   updater.onSettingsChanged(next, prev)
 *
 * All decisions (version compare, release / asset picking, capability, URL allowlist) live in the pure,
 * electron-free update-util.js; this module only does I/O, state and scheduling.
 *
 * Rules implemented here (§12):
 *  - HTTPS only, 10 s timeout, 256 KB response cap, `User-Agent: AugenPause/<version>`,
 *    `Accept: application/vnd.github+json`, no credentials, no cookies, strict JSON validation.
 *  - The request runs on its OWN in-memory session partition: the default session is hardened with a
 *    webRequest filter that cancels everything but `app://` (security.js), which would also cancel a
 *    main-process request.
 *  - First check ~30 s after start (never inside the first 20 s), then every `updates.intervalHours`.
 *    A mandatory break postpones a scheduled check (retry in 5 min). At most one check in flight.
 *    Manual checks are always allowed – also when `autoCheck` is off (main still refuses them during a
 *    mandatory break, like every other action).
 *  - Failures never open a dialog and never leak a stack: the state carries a short code.
 *  - capability 'auto' (Windows NSIS, Linux AppImage) lazily requires electron-updater. The dependency
 *    is optional: when it is not installed the capability falls back to 'manual' (logged, never fatal).
 *
 * Dev-only environment variables (ignored in a packaged build – `app.isPackaged` must be false):
 *   AUGENPAUSE_UPDATE_FEED=<file|https URL>   use this releases feed instead of api.github.com
 *   AUGENPAUSE_UPDATE_DEV_CHECKS=1            enable the scheduled checks in a dev run
 *   AUGENPAUSE_UPDATE_FIRST_DELAY_MS=<ms>     first-check delay (default 30000)
 */

const {
  RELEASES_API_URL,
  LATEST_RELEASE_URL,
  GITHUB_ACCEPT,
  GITHUB_API_VERSION,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  detectCapability,
  parseReleases,
  selectNewestRelease,
  selectAsset,
  isNewer,
  isAllowedUpdateUrl,
  readUpdateSettings,
} = require('./update-util');

/** Own session partition (in memory – no "persist:" prefix), see the note above. */
const UPDATE_PARTITION = 'augenpause-update';
/** §12: no check in the first 20 s after start; the first scheduled one runs at ~30 s. */
const FIRST_CHECK_DELAY_MS = 30000;
const MIN_CHECK_DELAY_MS = 20000;
/** A mandatory break postpones a scheduled check by this much. */
const BREAK_RETRY_DELAY_MS = 5 * 60 * 1000;
const MIN_TIMER_MS = 1000;

const STATUSES = Object.freeze(['idle', 'checking', 'up-to-date', 'available', 'downloading', 'ready', 'error']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Short, stack-free error code for the update state. */
function errorCode(err, fallback = 'failed') {
  const message = err && typeof err.message === 'string' ? err.message : '';
  const code = err && typeof err.code === 'string' ? err.code : '';
  const text = (code || message).split('\n')[0].trim();
  if (text.length === 0) return fallback;
  return text.slice(0, 60);
}

/**
 * @param {{
 *   app?: { getVersion?: () => string, isPackaged?: boolean },
 *   settings: { get: () => object } | (() => object) | object,
 *   getState?: () => object|null,
 *   onState?: (update: object) => void,
 *   notifier?: { updateAvailable?: (info: { version: string }) => any },
 *   shellOpen?: (url: string) => any,
 *   net?: { request: (options: object) => any },
 *   log?: (...args: any[]) => void,
 *   isStrictBreak?: () => boolean,
 *   isBreakRunning?: () => boolean,
 *   prepareQuit?: () => void,
 *   requireAutoUpdater?: () => any,
 *   runtime?: { platform?: string, arch?: string, env?: object, electronVersion?: string,
 *               linuxPackage?: 'deb'|'rpm'|null, packaged?: boolean },
 *   now?: () => number,
 *   setTimer?: (fn: Function, ms: number) => any,
 *   clearTimer?: (handle: any) => void,
 * }} deps
 */
function createUpdater(deps = {}) {
  const {
    app = null,
    settings = null,
    getState = () => null,
    onState = () => {},
    notifier = null,
    shellOpen = null,
    net = null,
    isStrictBreak = null,
    isBreakRunning = null,
    prepareQuit = null,
  } = deps;

  const log = typeof deps.log === 'function' ? deps.log : () => {};
  const now = typeof deps.now === 'function' ? deps.now : Date.now;
  const setTimer = typeof deps.setTimer === 'function' ? deps.setTimer : setTimeout;
  const clearTimer = typeof deps.clearTimer === 'function' ? deps.clearTimer : clearTimeout;
  const requireAutoUpdater =
    typeof deps.requireAutoUpdater === 'function'
      ? deps.requireAutoUpdater
      // eslint-disable-next-line global-require, import/no-unresolved
      : () => require('electron-updater');

  const runtime = isPlainObject(deps.runtime) ? deps.runtime : {};
  const env = isPlainObject(runtime.env) ? runtime.env : process.env;
  const platform = typeof runtime.platform === 'string' ? runtime.platform : process.platform;
  const arch = typeof runtime.arch === 'string' ? runtime.arch : process.arch;
  const electronVersion =
    typeof runtime.electronVersion === 'string' ? runtime.electronVersion : (process.versions || {}).electron;
  const packaged = typeof runtime.packaged === 'boolean' ? runtime.packaged : Boolean(app && app.isPackaged);

  const currentVersion = (() => {
    try {
      const version = app && typeof app.getVersion === 'function' ? app.getVersion() : null;
      return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
    } catch {
      return '0.0.0';
    }
  })();

  const installation = detectCapability({
    platform,
    arch,
    portable: typeof env.PORTABLE_EXECUTABLE_FILE === 'string' && env.PORTABLE_EXECUTABLE_FILE.length > 0,
    appImage: typeof env.APPIMAGE === 'string' && env.APPIMAGE.length > 0,
    electronVersion,
    packaged,
    linuxPackage: runtime.linuxPackage === 'deb' || runtime.linuxPackage === 'rpm' ? runtime.linuxPackage : null,
  });

  // ---- dev-only overrides ------------------------------------------------------------------
  const dev = packaged === false;
  const feed = dev && typeof env.AUGENPAUSE_UPDATE_FEED === 'string' && env.AUGENPAUSE_UPDATE_FEED.length > 0
    ? env.AUGENPAUSE_UPDATE_FEED
    : null;
  const devChecks = dev && env.AUGENPAUSE_UPDATE_DEV_CHECKS === '1';
  const firstDelayMs = (() => {
    const raw = dev ? Number(env.AUGENPAUSE_UPDATE_FIRST_DELAY_MS) : NaN;
    return Number.isFinite(raw) && raw >= 0 ? raw : FIRST_CHECK_DELAY_MS;
  })();
  /** The §12 "nothing in the first 20 s" floor – only the dev delay override may go below it. */
  const startupFloorMs = firstDelayMs < FIRST_CHECK_DELAY_MS ? 0 : MIN_CHECK_DELAY_MS;
  const minTimerMs = firstDelayMs < MIN_TIMER_MS ? 0 : MIN_TIMER_MS;

  // ---- state -------------------------------------------------------------------------------

  /** §12 update state – exactly these keys are pushed on `ap:update` / returned in the snapshot. */
  const state = {
    capability: installation.capability,
    status: 'idle',
    currentVersion,
    latestVersion: null,
    releaseUrl: null,
    assetUrl: null,
    assetName: null,
    progress: 0,
    lastCheckAt: null,
    error: null,
    legacyBuild: installation.legacyBuild === true,
    notes: null,
  };

  let timer = null;
  let started = false;
  let startedAt = null;
  let inFlight = false;
  let notifiedVersion = null;
  /** undefined = not tried yet, null = unavailable (→ manual), object = electron-updater's autoUpdater */
  let autoUpdater;

  const snapshot = () => ({ ...state });

  function emit() {
    try {
      onState(snapshot());
    } catch (err) {
      log(`update state listener failed: ${errorCode(err)}`);
    }
  }

  /** Applies a patch and emits when something really changed. */
  function setState(patch) {
    let changed = false;
    for (const key of Object.keys(patch)) {
      if (!Object.prototype.hasOwnProperty.call(state, key)) continue;
      const value = patch[key];
      if (state[key] === value) continue;
      state[key] = value;
      changed = true;
    }
    if (changed) emit();
    return changed;
  }

  function config() {
    let raw = null;
    try {
      if (typeof settings === 'function') raw = settings();
      else if (settings && typeof settings.get === 'function') raw = settings.get();
      else raw = settings;
    } catch {
      raw = null;
    }
    return readUpdateSettings(raw);
  }

  function ask(fn) {
    try {
      return typeof fn === 'function' && fn() === true;
    } catch {
      return false;
    }
  }

  function strictBreak() {
    if (typeof isStrictBreak === 'function') return ask(isStrictBreak);
    // fallback: derive it from the scheduler state (fail-closed like strict-guard.js)
    try {
      const st = getState();
      if (!st || st.phase !== 'break') return false;
      const brk = st.break || {};
      return brk.strict === true || brk.canSkip === false;
    } catch {
      return false;
    }
  }

  function breakRunning() {
    if (typeof isBreakRunning === 'function') return ask(isBreakRunning);
    try {
      const st = getState();
      return Boolean(st && st.phase === 'break');
    } catch {
      return false;
    }
  }

  // ---- electron-updater (capability 'auto') -------------------------------------------------

  /** Falls back to 'manual' when electron-updater is not (yet) installed – never throws. */
  function ensureAutoUpdater() {
    if (state.capability !== 'auto') return null;
    if (autoUpdater !== undefined) return autoUpdater;
    autoUpdater = null;
    let module_;
    try {
      module_ = requireAutoUpdater();
    } catch (err) {
      log(`electron-updater is not available (${errorCode(err, 'missing')}) – falling back to manual updates`);
      setState({ capability: 'manual' });
      return null;
    }
    try {
      const au = module_ && (module_.autoUpdater || (module_.default && module_.default.autoUpdater));
      if (!au || typeof au.on !== 'function') throw new Error('autoUpdater export missing');
      au.autoDownload = false; // the app decides (§12)
      au.allowDowngrade = false;
      au.allowPrerelease = config().includePrerelease;
      au.autoInstallOnAppQuit = true;
      au.logger = null; // no file logging, no extra dependency
      au.on('download-progress', (info) => {
        const percent = info && Number.isFinite(info.percent) ? info.percent : 0;
        setState({ status: 'downloading', progress: Math.min(1, Math.max(0, percent / 100)), error: null });
      });
      au.on('update-downloaded', () => {
        setState({ status: 'ready', progress: 1, error: null });
      });
      au.on('error', (err) => {
        log(`electron-updater error: ${errorCode(err)}`);
        setState({ status: 'error', error: errorCode(err, 'updater-error'), progress: 0 });
      });
      autoUpdater = au;
    } catch (err) {
      log(`electron-updater could not be configured (${errorCode(err)}) – falling back to manual updates`);
      setState({ capability: 'manual' });
      autoUpdater = null;
    }
    return autoUpdater;
  }

  // ---- HTTP --------------------------------------------------------------------------------

  function userAgent() {
    return `AugenPause/${currentVersion}`;
  }

  /** GET <url> → { ok: true, payload } | { ok: false, error } (never rejects). */
  function requestJson(url) {
    return new Promise((resolve) => {
      if (!/^https:\/\//i.test(url)) {
        resolve({ ok: false, error: 'bad-url' });
        return;
      }
      if (!net || typeof net.request !== 'function') {
        resolve({ ok: false, error: 'net-unavailable' });
        return;
      }
      let request = null;
      let settled = false;
      let timeout = null;
      let bytes = 0;
      const chunks = [];

      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timeout !== null) clearTimer(timeout);
        timeout = null;
        try {
          if (request && typeof request.abort === 'function') request.abort();
        } catch {
          /* already gone */
        }
        resolve(result);
      };

      try {
        request = net.request({
          method: 'GET',
          url,
          redirect: 'follow',
          credentials: 'omit', // no cookies, no auth (§12)
          useSessionCookies: false,
          partition: UPDATE_PARTITION,
        });
      } catch (err) {
        resolve({ ok: false, error: errorCode(err, 'net-unavailable') });
        return;
      }

      try {
        request.setHeader('User-Agent', userAgent());
        request.setHeader('Accept', GITHUB_ACCEPT);
        request.setHeader('X-GitHub-Api-Version', GITHUB_API_VERSION);
      } catch {
        /* a stub without headers is fine */
      }

      timeout = setTimer(() => finish({ ok: false, error: 'timeout' }), REQUEST_TIMEOUT_MS);

      request.on('response', (response) => {
        const status = Number(response && response.statusCode);
        if (status !== 200) {
          finish({ ok: false, error: `http-${Number.isFinite(status) ? status : 0}` });
          return;
        }
        response.on('data', (chunk) => {
          if (settled) return;
          bytes += chunk && chunk.length ? chunk.length : 0;
          if (bytes > MAX_RESPONSE_BYTES) {
            finish({ ok: false, error: 'too-large' });
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          if (settled) return;
          let payload;
          try {
            payload = JSON.parse(Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8'));
          } catch {
            finish({ ok: false, error: 'bad-json' });
            return;
          }
          finish({ ok: true, payload });
        });
        response.on('error', () => finish({ ok: false, error: 'network' }));
        response.on('aborted', () => finish({ ok: false, error: 'aborted' }));
      });
      request.on('error', (err) => finish({ ok: false, error: errorCode(err, 'network') }));
      request.on('abort', () => finish({ ok: false, error: 'aborted' }));
      try {
        request.end();
      } catch (err) {
        finish({ ok: false, error: errorCode(err, 'network') });
      }
    });
  }

  /** Dev only: a local JSON file as the releases feed. */
  function readFeedFile(file) {
    try {
      // eslint-disable-next-line global-require
      const fs = require('node:fs');
      const text = fs.readFileSync(file, 'utf8');
      if (text.length > MAX_RESPONSE_BYTES) return { ok: false, error: 'too-large' };
      return { ok: true, payload: JSON.parse(text) };
    } catch (err) {
      return { ok: false, error: errorCode(err, 'feed-failed') };
    }
  }

  async function loadReleases() {
    if (feed !== null) {
      log(`[dev] update feed override: ${feed}`);
      const result = /^https:\/\//i.test(feed) ? await requestJson(feed) : readFeedFile(feed);
      if (!result.ok) return result;
      const releases = parseReleases(result.payload);
      return releases === null ? { ok: false, error: 'bad-json' } : { ok: true, releases };
    }
    const result = await requestJson(RELEASES_API_URL);
    if (!result.ok) return result;
    const releases = parseReleases(result.payload);
    return releases === null ? { ok: false, error: 'bad-json' } : { ok: true, releases };
  }

  // ---- notification -------------------------------------------------------------------------

  /** At most one notification per version, and only when general.notifications is on (§12/§6). */
  function maybeNotify(version) {
    if (notifiedVersion === version) return;
    if (!config().notifications) return;
    if (!notifier || typeof notifier.updateAvailable !== 'function') return;
    notifiedVersion = version;
    log(`update notification for ${version}`);
    try {
      notifier.updateAvailable({ version });
    } catch (err) {
      log(`update notification failed: ${errorCode(err)}`);
    }
  }

  // ---- scheduling ---------------------------------------------------------------------------

  function clearScheduled() {
    if (timer === null) return;
    try {
      clearTimer(timer);
    } catch {
      /* ignore */
    }
    timer = null;
  }

  /** A dev run does not check automatically (§12) unless AUGENPAUSE_UPDATE_DEV_CHECKS=1. */
  function schedulingAllowed() {
    return started && (!dev || devChecks);
  }

  function schedule(delayMs) {
    clearScheduled();
    const floor = startedAt === null ? 0 : Math.max(0, startedAt + startupFloorMs - now());
    const delay = Math.max(minTimerMs, delayMs, floor);
    timer = setTimer(() => {
      timer = null;
      void runScheduled();
    }, delay);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  async function runScheduled() {
    const cfg = config();
    if (!cfg.autoCheck || !schedulingAllowed()) return;
    if (strictBreak()) {
      // §12: never check while a mandatory break runs – try again later.
      schedule(BREAK_RETRY_DELAY_MS);
      return;
    }
    await check({ manual: false });
    const next = config();
    if (next.autoCheck && schedulingAllowed()) schedule(next.intervalMs);
  }

  /** (Re)arms the timer from the current settings and the last check. */
  function rearm() {
    const cfg = config();
    if (!cfg.autoCheck || !schedulingAllowed()) {
      clearScheduled();
      return;
    }
    const base = state.lastCheckAt === null ? now() + firstDelayMs : state.lastCheckAt + cfg.intervalMs;
    schedule(base - now());
  }

  // ---- public API ---------------------------------------------------------------------------

  /**
   * @param {{ manual?: boolean }} [options] manual checks are allowed with autoCheck off
   * @returns {Promise<{ ok: boolean, error?: string }>}
   */
  async function check({ manual = false } = {}) {
    if (inFlight) return { ok: false, error: 'busy' };
    if (state.status === 'downloading') return { ok: false, error: 'busy' };
    if (state.status === 'ready') return { ok: true }; // an update is downloaded – nothing to check
    const cfg = config();
    if (!manual && cfg.autoCheck !== true) return { ok: false, error: 'disabled' };
    if (strictBreak()) return { ok: false, error: 'strict-mode' };

    inFlight = true;
    setState({ status: 'checking', error: null });
    try {
      const result = await loadReleases();
      const checkedAt = now();
      if (!result.ok) {
        log(`update check failed: ${result.error}`);
        setState({ status: 'error', error: result.error, lastCheckAt: checkedAt });
        return { ok: false, error: result.error };
      }
      const release = selectNewestRelease(result.releases, { includePrerelease: cfg.includePrerelease });
      if (release === null) {
        setState({
          status: 'up-to-date',
          latestVersion: null,
          releaseUrl: null,
          assetUrl: null,
          assetName: null,
          notes: null,
          progress: 0,
          error: null,
          lastCheckAt: checkedAt,
        });
        return { ok: true };
      }
      if (!isNewer(release.version, currentVersion)) {
        setState({
          status: 'up-to-date',
          latestVersion: release.version,
          releaseUrl: release.url,
          assetUrl: null,
          assetName: null,
          notes: null,
          progress: 0,
          error: null,
          lastCheckAt: checkedAt,
        });
        return { ok: true };
      }
      const asset = selectAsset({
        assets: release.assets,
        variant: installation.variant,
        arch: installation.arch,
        legacyBuild: installation.legacyBuild,
        version: release.version,
      });
      setState({
        status: 'available',
        latestVersion: release.version,
        releaseUrl: release.url,
        assetUrl: asset ? asset.url : null,
        assetName: asset ? asset.name : null,
        notes: release.notes,
        progress: 0,
        error: null,
        lastCheckAt: checkedAt,
      });
      log(`update available: ${release.version} (capability ${state.capability}, asset ${asset ? asset.name : 'none'})`);
      maybeNotify(release.version);
      if (cfg.autoDownload && state.capability === 'auto') {
        // fire and forget – the state reports progress / errors
        void download();
      }
      return { ok: true };
    } catch (err) {
      const code = errorCode(err, 'check-failed');
      log(`update check crashed: ${code}`);
      setState({ status: 'error', error: code, lastCheckAt: now() });
      return { ok: false, error: code };
    } finally {
      inFlight = false;
    }
  }

  /** shell.openExternal behind the §12 allowlist. */
  function openUrl(url) {
    if (!isAllowedUpdateUrl(url)) {
      log(`refused to open a non-allowlisted update URL: ${String(url).slice(0, 120)}`);
      return { ok: false, error: 'bad-url' };
    }
    if (typeof shellOpen !== 'function') return { ok: false, error: 'not-supported' };
    try {
      const result = shellOpen(url);
      if (result && typeof result.catch === 'function') {
        result.catch((err) => log(`openExternal failed: ${errorCode(err)}`));
      }
    } catch (err) {
      log(`openExternal failed: ${errorCode(err)}`);
      return { ok: false, error: 'open-failed' };
    }
    return { ok: true };
  }

  function openReleasePage() {
    if (strictBreak()) return { ok: false, error: 'strict-mode' };
    return openUrl(state.releaseUrl || LATEST_RELEASE_URL);
  }

  /**
   * capability 'auto': start the electron-updater download.
   * capability 'manual': open the matching asset (or the release page) in the browser – the app never
   * downloads or runs an installer itself there (§12).
   */
  async function download() {
    if (strictBreak()) return { ok: false, error: 'strict-mode' };
    if (state.status !== 'available' && state.status !== 'error') return { ok: false, error: 'no-update' };
    if (state.latestVersion === null) return { ok: false, error: 'no-update' };

    if (state.capability !== 'auto') {
      return openUrl(state.assetUrl || state.releaseUrl || LATEST_RELEASE_URL);
    }
    const au = ensureAutoUpdater();
    if (!au) return openUrl(state.assetUrl || state.releaseUrl || LATEST_RELEASE_URL);

    setState({ status: 'downloading', progress: 0, error: null });
    try {
      au.allowPrerelease = config().includePrerelease;
      // electron-updater needs its own check first: downloadUpdate() uses the update info it cached.
      const result = await au.checkForUpdates();
      const info = result && result.updateInfo;
      const version = info && typeof info.version === 'string' ? info.version : null;
      if (version === null || !isNewer(version, currentVersion)) {
        setState({ status: 'available', progress: 0, error: 'no-feed' });
        return { ok: false, error: 'no-feed' };
      }
      await au.downloadUpdate(result && result.cancellationToken ? result.cancellationToken : undefined);
      // 'update-downloaded' flips the state to 'ready'
      return { ok: true };
    } catch (err) {
      const code = errorCode(err, 'download-failed');
      log(`update download failed: ${code}`);
      setState({ status: 'error', error: code, progress: 0 });
      return { ok: false, error: code };
    }
  }

  /** Quit and install (capability 'auto' only). Refused while a break runs; stats are flushed first. */
  function install() {
    if (strictBreak()) return { ok: false, error: 'strict-mode' };
    if (breakRunning()) return { ok: false, error: 'break-running' };
    if (state.capability !== 'auto') return { ok: false, error: 'not-supported' };
    if (state.status !== 'ready') return { ok: false, error: 'not-ready' };
    const au = ensureAutoUpdater();
    if (!au || typeof au.quitAndInstall !== 'function') return { ok: false, error: 'not-supported' };
    try {
      if (typeof prepareQuit === 'function') prepareQuit(); // flush stats, mark the app as quitting
    } catch (err) {
      log(`prepareQuit failed: ${errorCode(err)}`);
    }
    try {
      au.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      const code = errorCode(err, 'install-failed');
      log(`quitAndInstall failed: ${code}`);
      setState({ status: 'error', error: code });
      return { ok: false, error: code };
    }
  }

  function start() {
    if (started) return;
    started = true;
    startedAt = now();
    ensureAutoUpdater(); // makes the capability honest before the first check
    const cfg = config();
    if (!cfg.autoCheck) {
      log('automatic update checks are switched off (updates.autoCheck)');
      return;
    }
    if (!schedulingAllowed()) {
      log('dev run – no scheduled update checks (AUGENPAUSE_UPDATE_DEV_CHECKS=1 enables them)');
      return;
    }
    schedule(firstDelayMs);
  }

  function stop() {
    started = false;
    clearScheduled();
  }

  /** Re-configure + reschedule after a settings change. */
  function onSettingsChanged() {
    const cfg = config();
    if (autoUpdater) {
      try {
        autoUpdater.allowPrerelease = cfg.includePrerelease;
        autoUpdater.autoDownload = false;
        autoUpdater.allowDowngrade = false;
      } catch (err) {
        log(`electron-updater reconfigure failed: ${errorCode(err)}`);
      }
    }
    rearm();
  }

  return {
    start,
    stop,
    check,
    download,
    install,
    openReleasePage,
    getUpdateState: snapshot,
    onSettingsChanged,
  };
}

module.exports = {
  createUpdater,
  UPDATE_PARTITION,
  FIRST_CHECK_DELAY_MS,
  MIN_CHECK_DELAY_MS,
  BREAK_RETRY_DELAY_MS,
  STATUSES,
  RELEASES_API_URL,
};
