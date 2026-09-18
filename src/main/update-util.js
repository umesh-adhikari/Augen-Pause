'use strict';

/**
 * Update helpers – PURE (no electron, no fs, no network), so everything the update check decides is
 * unit-testable: docs/ARCHITECTURE.md §12.
 *
 * Contents
 *   version comparison   parseVersion / compareVersions / isNewer          (own mini semver, tested)
 *   tag validation       isValidTag  →  /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/
 *   release picking      parseReleases / pickRelease                       (newest valid, no drafts,
 *                                                                          prereleases only when allowed)
 *   asset selection      selectAsset                                       (platform / arch / variant / legacy)
 *   capability detection detectCapability                                  (§12 table, all inputs injected)
 *   URL allowlist        isAllowedUpdateUrl                                (shell.openExternal gate)
 *
 * Nothing in here trusts its input: everything that comes back from api.github.com is treated as
 * hostile JSON (unknown keys ignored, strings length-capped, URLs re-validated against the allowlist).
 */

// ---------------------------------------------------------------------------------------------
// Repository / endpoint constants

const REPO_OWNER = 'umesh-adhikari';
const REPO_NAME = 'Augen-Pause';
const REPO_SLUG = `${REPO_OWNER}/${REPO_NAME}`;
const RELEASES_API_URL = `https://api.github.com/repos/${REPO_SLUG}/releases`;
const RELEASES_PAGE_URL = `https://github.com/${REPO_SLUG}/releases`;
/** Fallback target of `open-release-page` when no release is known yet (inside the allowlist). */
const LATEST_RELEASE_URL = `${RELEASES_PAGE_URL}/latest`;
/** Prefix every URL handed to shell.openExternal must start with (§12 security rules). */
const ALLOWED_URL_PREFIX = `https://github.com/${REPO_SLUG}/releases/`;

const GITHUB_ACCEPT = 'application/vnd.github+json';
const GITHUB_API_VERSION = '2022-11-28';

/** Budgets for the (untrusted) HTTP response and the strings taken from it. */
const REQUEST_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_NOTES_CHARS = 2000;
const MAX_RELEASES = 100;
const MAX_ASSETS_PER_RELEASE = 60;
const MAX_TAG_CHARS = 64;
const MAX_ASSET_NAME_CHARS = 200;
const MAX_URL_CHARS = 2048;

/** Electron majors below this only exist in the unsigned macOS "legacy" builds (§12). */
const LEGACY_ELECTRON_MAJOR = 40;

const TAG_RE = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const ASSET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const NUMERIC_RE = /^\d+$/;

// ---------------------------------------------------------------------------------------------
// Small guards

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function own(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/** Own string property of an untrusted object, or '' (throwing getters / wrong types included). */
function str(obj, key, maxChars = MAX_NOTES_CHARS) {
  try {
    if (!isPlainObject(obj) || !own(obj, key)) return '';
    const value = obj[key];
    return typeof value === 'string' ? value.slice(0, maxChars) : '';
  } catch {
    return '';
  }
}

function flag(obj, key) {
  try {
    return isPlainObject(obj) && own(obj, key) && obj[key] === true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Versions

/** @returns {boolean} true for `1.2.3`, `v1.2.3`, `1.2.3-beta.1` */
function isValidTag(tag) {
  return typeof tag === 'string' && tag.length > 0 && tag.length <= MAX_TAG_CHARS && TAG_RE.test(tag);
}

/** `v1.2.3-beta.1` → `1.2.3-beta.1` (null for anything invalid). */
function normalizeVersion(tag) {
  if (!isValidTag(tag)) return null;
  return tag[0] === 'v' ? tag.slice(1) : tag;
}

/**
 * @param {unknown} value `1.2.3`, `v1.2.3`, `1.2.3-rc.2`
 * @returns {{ major: number, minor: number, patch: number, prerelease: string[] }|null}
 */
function parseVersion(value) {
  const version = normalizeVersion(value);
  if (version === null) return null;
  const dash = version.indexOf('-');
  const core = dash === -1 ? version : version.slice(0, dash);
  const pre = dash === -1 ? '' : version.slice(dash + 1);
  const parts = core.split('.');
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isSafeInteger(n) || n < 0)) return null;
  const prerelease = pre.length === 0 ? [] : pre.split('.');
  // an empty identifier ("1.0.0-alpha..1") is not a valid prerelease
  if (prerelease.some((id) => id.length === 0)) return null;
  return { major: nums[0], minor: nums[1], patch: nums[2], prerelease };
}

/** semver rule: a numeric identifier is lower than an alphanumeric one, numbers compare numerically. */
function compareIdentifiers(a, b) {
  const aNum = NUMERIC_RE.test(a);
  const bNum = NUMERIC_RE.test(b);
  if (aNum && bNum) {
    const x = Number(a);
    const y = Number(b);
    return x === y ? 0 : x < y ? -1 : 1;
  }
  if (aNum !== bNum) return aNum ? -1 : 1;
  return a === b ? 0 : a < b ? -1 : 1;
}

function comparePrerelease(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // 1.0.0 > 1.0.0-rc.1
  if (b.length === 0) return -1;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    const cmp = compareIdentifiers(a[i], b[i]);
    if (cmp !== 0) return cmp;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

/**
 * @returns {-1|0|1|null} null when either side is not a valid version (never throws)
 */
function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/**
 * Is `latest` strictly newer than `current`? Malformed input → false (never offer an update we
 * cannot reason about, never offer a downgrade).
 */
function isNewer(latest, current) {
  return compareVersions(latest, current) === 1;
}

/** true when the version carries a prerelease part (`1.2.0-beta.1`). */
function isPrereleaseVersion(value) {
  const parsed = parseVersion(value);
  return Boolean(parsed && parsed.prerelease.length > 0);
}

// ---------------------------------------------------------------------------------------------
// URLs

/**
 * The single gate in front of `shell.openExternal` (§12): https, host exactly github.com, path inside
 * `/<owner>/<repo>/releases/` (which also covers `/releases/download/…`). No credentials, no port,
 * no traversal, no whitespace or quoting characters.
 * @param {unknown} url
 * @returns {boolean}
 */
function isAllowedUpdateUrl(url) {
  if (typeof url !== 'string' || url.length === 0 || url.length > MAX_URL_CHARS) return false;
  if (/[\s<>"'`\\]/.test(url)) return false;
  if (/%2e/i.test(url) || url.includes('..')) return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (parsed.hostname.toLowerCase() !== 'github.com') return false;
  if (parsed.port !== '') return false;
  if (parsed.username !== '' || parsed.password !== '') return false;
  // owner/repo are compared case-sensitively – github.com/UMESH-ADHIKARI/… is a different (redirecting) path
  return parsed.pathname.startsWith(`/${REPO_SLUG}/releases/`);
}

/** `https://github.com/<owner>/<repo>/releases/tag/<tag>` for a valid tag, else null. */
function releasePageUrl(tag) {
  if (!isValidTag(tag)) return null;
  return `${RELEASES_PAGE_URL}/tag/${tag}`;
}

// ---------------------------------------------------------------------------------------------
// Releases

/** Release name + body as plain text, control characters stripped, ≤ 2000 chars (§12: TEXT only). */
function trimNotes(name, body) {
  const clean = (value) =>
    (typeof value === 'string' ? value : '')
      // keep newlines and tabs, drop every other control character
      .replace(/[ --]/g, '')
      .replace(/\r\n?/g, '\n')
      .trim();
  const title = clean(name).slice(0, MAX_NOTES_CHARS);
  const text = clean(body).slice(0, MAX_NOTES_CHARS);
  let notes = title && text && !text.startsWith(title) ? `${title}\n\n${text}` : text || title;
  notes = notes.slice(0, MAX_NOTES_CHARS).trim();
  return notes.length > 0 ? notes : null;
}

/** One asset of an untrusted release object → `{ name, url, size }` or null. */
function normalizeAsset(entry) {
  const name = str(entry, 'name', MAX_ASSET_NAME_CHARS + 1);
  if (name.length === 0 || name.length > MAX_ASSET_NAME_CHARS || !ASSET_NAME_RE.test(name)) return null;
  const url = str(entry, 'browser_download_url', MAX_URL_CHARS + 1);
  if (!isAllowedUpdateUrl(url)) return null;
  let size = 0;
  try {
    const raw = isPlainObject(entry) && own(entry, 'size') ? entry.size : 0;
    size = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
  } catch {
    size = 0;
  }
  return { name, url, size };
}

/**
 * One untrusted release object from the GitHub API → a plain, validated release.
 * @returns {{ tag: string, version: string, prerelease: boolean, draft: boolean, url: string,
 *             notes: string|null, assets: Array<{name: string, url: string, size: number}> }|null}
 */
function normalizeRelease(entry) {
  const tag = str(entry, 'tag_name', MAX_TAG_CHARS + 1);
  const version = normalizeVersion(tag);
  if (version === null) return null;
  const htmlUrl = str(entry, 'html_url', MAX_URL_CHARS + 1);
  const url = isAllowedUpdateUrl(htmlUrl) ? htmlUrl : releasePageUrl(tag);
  const assets = [];
  try {
    const raw = isPlainObject(entry) && Array.isArray(entry.assets) ? entry.assets : [];
    for (const item of raw.slice(0, MAX_ASSETS_PER_RELEASE)) {
      const asset = normalizeAsset(item);
      if (asset) assets.push(asset);
    }
  } catch {
    // a hostile assets array – the release stays usable without assets
  }
  return {
    tag,
    version,
    // a tag like 1.2.0-beta.1 counts as a prerelease even when GitHub does not say so
    prerelease: flag(entry, 'prerelease') || isPrereleaseVersion(version),
    draft: flag(entry, 'draft'),
    url,
    notes: trimNotes(str(entry, 'name'), str(entry, 'body')),
    assets,
  };
}

/**
 * Validates the whole `/releases` payload. The endpoint always answers with an ARRAY – an object
 * (GitHub's `{"message":"Not Found"}` error shape) is a failure, never "no releases".
 * @param {unknown} payload parsed JSON
 * @returns {Array<object>|null} normalized releases (may be empty), null when the payload is not a list
 */
function parseReleases(payload) {
  if (!Array.isArray(payload)) return null;
  const out = [];
  for (const entry of payload.slice(0, MAX_RELEASES)) {
    const release = normalizeRelease(entry);
    if (release) out.push(release);
  }
  return out;
}

/**
 * Newest usable release out of ALREADY NORMALIZED releases (parseReleases output):
 * drafts are always skipped, prereleases only when allowed.
 * @param {Array<object>} releases
 * @param {{ includePrerelease?: boolean }} [options]
 * @returns {object|null}
 */
function selectNewestRelease(releases, { includePrerelease = false } = {}) {
  if (!Array.isArray(releases) || releases.length === 0) return null;
  let best = null;
  for (const release of releases) {
    if (!isPlainObject(release) || !isValidTag(release.tag)) continue;
    if (release.draft === true) continue;
    if (release.prerelease === true && includePrerelease !== true) continue;
    if (best === null || compareVersions(release.version, best.version) === 1) best = release;
  }
  return best;
}

/**
 * Newest usable release straight from an untrusted payload (parse + select in one step).
 * @param {unknown} payload raw JSON of `/releases`
 * @param {{ includePrerelease?: boolean }} [options]
 * @returns {object|null}
 */
function pickRelease(payload, options) {
  const releases = parseReleases(payload);
  return releases === null ? null : selectNewestRelease(releases, options);
}

// ---------------------------------------------------------------------------------------------
// Capability (§12 table)

/** Build variants and their file names (see selectAsset). */
const VARIANTS = Object.freeze({
  nsis: Object.freeze({
    ext: 'exe',
    require: Object.freeze(['setup']),
    forbid: Object.freeze(['portable']),
    arch: Object.freeze({ x64: ['x64'], arm64: ['arm64'], ia32: ['ia32', 'x86'] }),
  }),
  portable: Object.freeze({
    ext: 'exe',
    require: Object.freeze(['portable']),
    forbid: Object.freeze(['setup']),
    arch: null, // AugenPause-Portable-<v>.exe carries no arch token
  }),
  dmg: Object.freeze({
    ext: 'dmg',
    require: Object.freeze([]),
    forbid: Object.freeze([]),
    arch: Object.freeze({ x64: ['x64'], arm64: ['arm64'] }),
  }),
  AppImage: Object.freeze({
    ext: 'appimage',
    require: Object.freeze([]),
    forbid: Object.freeze([]),
    arch: Object.freeze({ x64: ['x86_64'], arm64: ['arm64', 'aarch64'] }),
  }),
  deb: Object.freeze({
    ext: 'deb',
    require: Object.freeze([]),
    forbid: Object.freeze([]),
    arch: Object.freeze({ x64: ['amd64'], arm64: ['arm64'] }),
  }),
  rpm: Object.freeze({
    ext: 'rpm',
    require: Object.freeze([]),
    forbid: Object.freeze([]),
    arch: Object.freeze({ x64: ['x86_64'], arm64: ['aarch64'] }),
  }),
});

function electronMajorOf(version) {
  const major = Number.parseInt(String(version || '').split('.')[0], 10);
  return Number.isFinite(major) ? major : null;
}

/**
 * Which update capability this very installation has – detected, never guessed (§12 table).
 *
 * | installation            | detection                                  | capability |
 * | Windows NSIS setup      | win32 && !portable                         | auto       |
 * | Windows portable        | PORTABLE_EXECUTABLE_FILE set               | manual     |
 * | Linux AppImage          | APPIMAGE set                               | auto       |
 * | Linux deb/rpm/tar.gz    | linux && !APPIMAGE                         | manual     |
 * | macOS                   | always (unsigned builds, no Squirrel.Mac)  | manual     |
 * | macOS legacy build      | major(process.versions.electron) < 40      | manual + only *legacy* assets |
 * | dev run                 | !app.isPackaged                            | manual, no scheduled checks   |
 *
 * @param {{ platform?: string, arch?: string, portable?: boolean, appImage?: boolean,
 *           electronVersion?: string, electronMajor?: number, packaged?: boolean,
 *           linuxPackage?: 'deb'|'rpm'|null }} [input]
 * @returns {{ capability: 'auto'|'manual', variant: string|null, legacyBuild: boolean, dev: boolean,
 *             platform: string, arch: string }}
 */
function detectCapability(input = {}) {
  const platform = typeof input.platform === 'string' && input.platform ? input.platform : 'linux';
  const arch = typeof input.arch === 'string' && input.arch ? input.arch : 'x64';
  const portable = input.portable === true;
  const appImage = input.appImage === true;
  const dev = input.packaged === false;
  const major = Number.isFinite(input.electronMajor) ? input.electronMajor : electronMajorOf(input.electronVersion);
  const legacyBuild = major !== null && major < LEGACY_ELECTRON_MAJOR;

  let variant = null;
  if (platform === 'win32') variant = portable ? 'portable' : 'nsis';
  else if (platform === 'darwin') variant = 'dmg';
  else if (appImage) variant = 'AppImage';
  else if (input.linuxPackage === 'deb' || input.linuxPackage === 'rpm') variant = input.linuxPackage;

  let capability = 'manual';
  if (!dev) {
    // electron-updater can only replace the files it owns: an NSIS install and an AppImage.
    if (platform === 'win32' && !portable) capability = 'auto';
    else if (platform !== 'win32' && platform !== 'darwin' && appImage) capability = 'auto';
  }
  // A legacy macOS build is unsigned and old – never let electron-updater near it (§12).
  if (legacyBuild && platform === 'darwin') capability = 'manual';

  return { capability, variant, legacyBuild, dev, platform, arch };
}

// ---------------------------------------------------------------------------------------------
// Asset selection

/** `AugenPause-1.2.0-x86_64.AppImage` → ['augenpause','1','2','0','x86_64','appimage'] */
function nameTokens(name) {
  return String(name).toLowerCase().split(/[-.]/).filter((part) => part.length > 0);
}

/**
 * Best matching asset for this installation, or null when the release has none
 * (then the caller only offers the release page).
 *
 * Expected names (electron-builder artifactName, see docs/PACKAGING.md):
 *   AugenPause-Setup-<v>-x64.exe      AugenPause-Portable-<v>.exe
 *   AugenPause-<v>-x64.dmg            AugenPause-<v>-legacy-x64.dmg
 *   AugenPause-<v>-x86_64.AppImage    AugenPause-<v>-amd64.deb    AugenPause-<v>-x86_64.rpm
 *
 * @param {{ assets?: Array<{name: string, url: string}>, variant?: string|null, arch?: string,
 *           legacyBuild?: boolean, version?: string }} input
 * @returns {{ name: string, url: string, size?: number }|null}
 */
function selectAsset({ assets, variant, arch = 'x64', legacyBuild = false, version } = {}) {
  if (!Array.isArray(assets) || assets.length === 0) return null;
  const spec = typeof variant === 'string' && own(VARIANTS, variant) ? VARIANTS[variant] : null;
  if (!spec) return null;
  const archTokens = spec.arch ? spec.arch[arch] : null;
  if (spec.arch && !Array.isArray(archTokens)) return null; // unknown architecture → no asset
  const wantLegacy = legacyBuild === true;

  const candidates = [];
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string' || !isAllowedUpdateUrl(asset.url)) continue;
    const tokens = nameTokens(asset.name);
    if (tokens.length < 2) continue;
    if (tokens[0] !== 'augenpause') continue;
    if (tokens[tokens.length - 1] !== spec.ext) continue;
    if (spec.require.some((token) => !tokens.includes(token))) continue;
    if (spec.forbid.some((token) => tokens.includes(token))) continue;
    // §12: a legacy build may ONLY be offered legacy assets – and a current build never a legacy one.
    if (tokens.includes('legacy') !== wantLegacy) continue;
    if (archTokens && !archTokens.some((token) => tokens.includes(token))) continue;
    candidates.push(asset);
  }
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  const versionText = normalizeVersion(version);
  const scored = candidates.map((asset) => ({
    asset,
    // prefer the asset that carries the release version, then the shortest (most specific) name
    exact: versionText !== null && asset.name.includes(versionText) ? 0 : 1,
    length: asset.name.length,
  }));
  scored.sort((a, b) => a.exact - b.exact || a.length - b.length || a.asset.name.localeCompare(b.asset.name));
  return scored[0].asset;
}

// ---------------------------------------------------------------------------------------------
// Settings helpers

const MIN_INTERVAL_HOURS = 6;
const MAX_INTERVAL_HOURS = 168;
const DEFAULT_INTERVAL_HOURS = 24;

/** `updates` group of an untrusted settings object → the values the updater works with. */
function readUpdateSettings(settings) {
  const updates = isPlainObject(settings) && isPlainObject(settings.updates) ? settings.updates : {};
  const general = isPlainObject(settings) && isPlainObject(settings.general) ? settings.general : {};
  const hours = Number(updates.intervalHours);
  const clamped = Number.isFinite(hours)
    ? Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(hours)))
    : DEFAULT_INTERVAL_HOURS;
  return {
    autoCheck: updates.autoCheck !== false,
    intervalHours: clamped,
    intervalMs: clamped * 60 * 60 * 1000,
    autoDownload: updates.autoDownload === true,
    includePrerelease: updates.includePrerelease === true,
    notifications: general.notifications !== false,
  };
}

module.exports = {
  // constants
  REPO_OWNER,
  REPO_NAME,
  REPO_SLUG,
  RELEASES_API_URL,
  RELEASES_PAGE_URL,
  LATEST_RELEASE_URL,
  ALLOWED_URL_PREFIX,
  GITHUB_ACCEPT,
  GITHUB_API_VERSION,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_NOTES_CHARS,
  MAX_RELEASES,
  LEGACY_ELECTRON_MAJOR,
  TAG_RE,
  VARIANTS,
  MIN_INTERVAL_HOURS,
  MAX_INTERVAL_HOURS,
  DEFAULT_INTERVAL_HOURS,
  // versions
  isValidTag,
  normalizeVersion,
  parseVersion,
  compareVersions,
  isNewer,
  isPrereleaseVersion,
  // urls
  isAllowedUpdateUrl,
  releasePageUrl,
  // releases
  trimNotes,
  normalizeAsset,
  normalizeRelease,
  parseReleases,
  selectNewestRelease,
  pickRelease,
  // installation
  detectCapability,
  electronMajorOf,
  nameTokens,
  selectAsset,
  // settings
  readUpdateSettings,
};
