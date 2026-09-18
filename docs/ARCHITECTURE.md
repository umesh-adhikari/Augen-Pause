# AugenPause – Architecture & Interface Contract

This document is the **binding contract** between all modules. Every module MUST
implement exactly these shapes/names. If you need something that is not in here,
add it in a backwards-compatible way inside *your own* files and mention it in
your final report — never change another owner's files.

- Runtime: **Electron 44** (Chromium + Node 24), no runtime npm dependencies.
- Language: plain modern JavaScript. Main process = CommonJS. Renderer = native ES modules.
- UI languages: German (`de`) and English (`en`).
- Platforms: Windows, macOS, Linux.
- Tests: `node --test test/` (pure Node, no Electron).

---------------------------------------------------------------------------------

## 1. Directory layout & ownership

```
package.json                      (lead)
electron-builder.yml              [MAIN-UX]
scripts/build-icons.js            [MAIN-UX]  generates assets/icons/*.png (no deps)
assets/icons/                     [MAIN-UX]  icon.png (1024), tray*.png
docs/ARCHITECTURE.md              (lead)
README.md                         [MAIN-UX]

src/main/constants.js             (lead)  IPC channel names, phases, widget sizes, actions
src/main/store.js                 [CORE]  atomic JSON file persistence
src/main/settings.js              [CORE]  defaults, presets, validation, settings store
src/main/stats.js                 [CORE]  daily statistics store
src/main/scheduler.js             [CORE]  timer state machine (pure, testable)

src/main/main.js                  [MAIN-SHELL] entry: lifecycle, wiring, action dispatcher
src/main/security.js              [MAIN-SHELL] hardening (sandbox, navigation, permissions)
src/main/protocol.js              [MAIN-SHELL] app:// protocol serving src/renderer
src/main/windows.js               [MAIN-SHELL] widget / dashboard / overlay windows
src/main/ipc.js                   [MAIN-SHELL] ipcMain handlers + payload validation
src/preload/preload.js            [MAIN-SHELL] contextBridge API (window.augenpause)

src/main/i18n.js                  [MAIN-UX]  main-process strings (menus, notifications, tray)
src/main/menu.js                  [MAIN-UX]  shared context-menu builder (tray + widget right-click)
src/main/tray.js                  [MAIN-UX]  tray icon, tooltip, macOS title
src/main/notifications.js         [MAIN-UX]  native notifications
src/main/autostart.js             [MAIN-UX]  login item (win/mac API, linux .desktop file)
src/main/shortcuts.js             [MAIN-UX]  global shortcuts

src/renderer/shared/tokens.css    (lead)  design tokens (colors, radii, shadows, fonts)
src/renderer/shared/base.css      (lead)  reset + base components (buttons, switches, cards)
src/renderer/shared/theme.js      (lead)  applyAppearance(settings)
src/renderer/shared/i18n.js       (lead)  resolveLang(), createT()
src/renderer/shared/format.js     (lead)  formatClock(), formatDuration(), formatMinutes()
src/renderer/shared/api.js        (lead)  getApi() → window.augenpause (with safe no-op fallback)

src/renderer/widget/*             [WIDGET]    index.html, widget.js, widget.css, strings.js
src/renderer/dashboard/*          [DASHBOARD] index.html, dashboard.js, dashboard.css, strings.js (+ more modules ok)
src/renderer/overlay/*            [OVERLAY]   index.html, overlay.js, overlay.css, strings.js (+ more modules ok)

test/*.test.js                    [CORE] scheduler/settings/stats tests; [MAIN-SHELL] may add protocol/ipc-validation tests
```

Modules owned by [CORE] MUST NOT `require('electron')` (so they are unit-testable).

---------------------------------------------------------------------------------

## 2. Settings (owned by [CORE], consumed by everybody)

`settings.json` in `app.getPath('userData')`. Full shape with defaults and valid ranges:

```js
{
  version: 1,
  language: 'system',            // 'system' | 'de' | 'en'
  timer: {
    preset: 'halfhour',          // 'halfhour' | 'hourly' | '20-20-20' | 'pomodoro' | 'custom'
    workMinutes: 30,             // int 1..240
    shortBreakSeconds: 120,      // int 20..1800
    longBreakEnabled: true,      // bool
    longBreakSeconds: 600,       // int 60..3600
    longBreakEvery: 4,           // int 2..12  → every Nth break is a long break
    warnBeforeSeconds: 60,       // int 0..600 (0 = no warning)
    snoozeMinutes: 5,            // int 1..30
    maxSnoozes: 2                // int 0..10 per upcoming break
  },
  breaks: {
    lockScreen: true,            // bool  fullscreen overlay during breaks (false = notification + widget only)
    strictMode: false,           // bool  no skip / no snooze while in a break
    skipHoldSeconds: 3,          // int 0..10  hold-to-skip duration on the overlay (0 = simple click)
    allDisplays: true,           // bool  overlay on every monitor
    showExercises: true,         // bool  eye exercise guidance on the overlay
    soundEnabled: true,          // bool  chime at break start / end
    soundVolume: 0.5             // number 0..1
  },
  idle: {
    enabled: true,               // bool  detect user absence
    resetAfterMinutes: 5,        // int 1..60  away at least this long → natural break → work timer resets
  },
  hydration: {
    enabled: true,               // bool
    intervalMinutes: 45,         // int 10..240
    dailyGoalGlasses: 8,         // int 1..30
    glassMl: 250                 // int 50..1000
  },
  schedule: {
    workingHoursEnabled: false,  // bool  only remind inside working hours
    days: [1, 2, 3, 4, 5],       // unique ints 0..6 (0 = Sunday), sorted
    start: '08:00',              // 'HH:MM'
    end: '18:00'                 // 'HH:MM' (must be > start, otherwise reject change)
  },
  widget: {
    visible: true,               // bool
    alwaysOnTop: true,           // bool
    size: 'medium',              // 'small' | 'medium' | 'large'
    opacity: 0.95,               // number 0.3..1 (applied by the renderer via CSS)
    showSeconds: true,           // bool  seconds hand
    position: null               // null | { x: int, y: int }  (top-left of widget window, screen DIP)
  },
  appearance: {
    theme: 'system',             // 'system' | 'dark' | 'light'
    accent: 'teal'               // 'teal' | 'violet' | 'blue' | 'green' | 'orange' | 'pink'
  },
  general: {
    autostart: false,            // bool  start at login
    globalShortcuts: true,       // bool
    notifications: true          // bool  native notifications
  }
}
```

Presets (`PRESETS` export). Selecting a non-custom preset overwrites these timer fields;
changing any of these fields manually while a preset is active switches `preset` to `'custom'`:

| preset     | workMinutes | shortBreakSeconds | longBreakSeconds | longBreakEvery |
|------------|-------------|-------------------|------------------|----------------|
| halfhour   | 30          | 120               | 600              | 4              |
| hourly     | 60          | 300               | 900              | 3              |
| 20-20-20   | 20          | 20                | 300              | 6              |
| pomodoro   | 25          | 300               | 900              | 4              |

### settings.js API

```js
const { DEFAULT_SETTINGS, PRESETS, sanitizeSettings, createSettingsStore } = require('./settings');

sanitizeSettings(input) → Settings
  // full sanitize of an untrusted full object (e.g. from disk); missing/invalid → defaults

const store = createSettingsStore({ filePath });   // loads (corrupt file → backup to *.corrupt-<ts>.json + defaults)
store.get()            → Settings (deep copy)
store.update(patch)    → { ok: boolean, settings: Settings, errors: string[] }
   // patch = deep partial object from an UNTRUSTED renderer.
   // Unknown keys ignored, wrong types rejected (error message, previous value kept),
   // numbers rounded (ints) and clamped into range, preset logic applied, then persisted atomically.
   // ok=false only if nothing could be applied AND errors exist.
store.reset()          → Settings (defaults, persisted)
store.on('change', (settings, prevSettings) => {})   // EventEmitter
```

---------------------------------------------------------------------------------

## 3. Stats (owned by [CORE])

`stats.json` in userData, keeps the last 400 days.

```js
DayStats = {
  date: 'YYYY-MM-DD',       // local date
  breaksCompleted: 0,       // breaks that ran to the end
  breaksSkipped: 0,
  breaksSnoozed: 0,         // number of snooze actions
  shortBreaks: 0,           // completed short breaks
  longBreaks: 0,            // completed long breaks
  naturalBreaks: 0,         // user away ≥ idle.resetAfterMinutes
  breakSeconds: 0,          // seconds spent in breaks (completed or partial)
  workSeconds: 0,           // active screen time counted in phase 'work'
  glasses: 0                // water glasses logged
}
```

```js
const { createStatsStore } = require('./stats');
const stats = createStatsStore({ filePath, now = Date.now });
stats.recordBreak({ type: 'short'|'long', completed: boolean, seconds: number })
stats.recordSnooze()
stats.recordNaturalBreak()
stats.addWorkSeconds(seconds)
stats.addGlass()             → DayStats (today)
stats.removeGlass()          → DayStats (never below 0)
stats.getToday()             → DayStats
stats.getRange(days)         → DayStats[]  oldest → newest, exactly `days` entries ending today, gaps zero-filled (days clamped 1..400)
stats.reset()
stats.flush()                // write pending changes now (writes are debounced ~5s, flush on quit)
stats.on('change', (today) => {})
```

---------------------------------------------------------------------------------

## 4. Scheduler (owned by [CORE])

```js
const { Scheduler } = require('./scheduler');
const scheduler = new Scheduler({
  getSettings,                 // () => Settings
  stats,                       // stats store
  now = Date.now,              // injectable clock
  getIdleSeconds = () => 0,    // injectable (main passes powerMonitor.getSystemIdleTime)
});
scheduler.start()              // starts internal 1s setInterval → tick()
scheduler.stop()
scheduler.tick()               // advance state machine using now(); public for tests
scheduler.getState()           → SchedulerState (JSON-serializable, fresh object)

// commands – all return { ok: boolean, error?: string }
scheduler.startBreak(type?)    // 'short' | 'long' | undefined (undefined = type the next break would have)
scheduler.skipBreak()          // phase work (skips the upcoming break → new work period, counts as skipped)
                               // or phase break (ends it early, recorded as not completed). Rejected in strict mode while in break.
scheduler.snooze(minutes?)     // postpone upcoming/current break by minutes (default timer.snoozeMinutes)
                               // allowed when snooze.count < snooze.max; rejected in strict mode while in break.
                               // During a break: ends the break (not recorded as completed) and schedules it again in N minutes.
scheduler.pause(arg)           // number minutes | 'tomorrow' (next local midnight or next working-hours start) | null (indefinitely)
scheduler.resume()             // leave pause → fresh work period
scheduler.resetWorkTimer()     // fresh work period
scheduler.drinkWater()         // stats.addGlass(), hydration timer restarts, due=false
scheduler.undoDrink()          // stats.removeGlass()
scheduler.onSettingsChanged(newSettings, prevSettings)  // recompute sensibly (keep elapsed work time, clamp)
scheduler.onLock() / onUnlock() / onSuspend() / onResume()   // system events → away handling

// events (EventEmitter)
'state'               (SchedulerState)                 // on every tick and after every command
'warning'             ({ type, inMs })                 // once per upcoming break when remaining ≤ warnBeforeSeconds
'break-start'         ({ type, durationMs, endsAt })
'break-end'           ({ type, completed: boolean, skipped: boolean, snoozed: boolean })
'hydration-reminder'  ({ glassesToday, goal })
'natural-break'       ({ awayMs })
```

### Phases & rules

- `work`: counting down to next break. `warning=true` in the last `warnBeforeSeconds`.
- `break`: short or long break running. Ends automatically at `endsAt` → `break-end{completed:true}` → new `work` period.
  After a completed/skipped break the cycle index advances: when `longBreakEnabled` every `longBreakEvery`-th break is `long`.
- `paused`: user pause (until timestamp or indefinitely). When `until` passes → `resume()` automatically.
- `away`: user absent. Entered when (a) in `work` and `getIdleSeconds() ≥ idle.resetAfterMinutes*60` (only if `idle.enabled`),
  (b) `onLock()` / `onSuspend()` while in `work`. Leaving: idle < 5 s (or `onUnlock` / `onResume`).
  If absence lasted ≥ `resetAfterMinutes` → `natural-break` event, stats.recordNaturalBreak(), fresh work period (cycle index advances like a short break).
  Otherwise resume with the remaining work time from the moment absence started. Absence time is never counted as workSeconds.
  A lock/suspend during a `break` does not interrupt the break.
- `off-hours`: `schedule.workingHoursEnabled` and now outside the configured days/time. No breaks, no hydration reminders.
  Entering working hours → fresh work period.
- Hydration runs independently of work/break while phase is `work` or `break`; frozen while `paused`/`away`/`off-hours`.
- Wall-clock based (timestamps), robust against timer drift. A tick gap > 60 s (sleep without events) is handled like an absence of that length.
- Pause breaks do not count as work time; `workSeconds` only accumulates in `work` phase.

### SchedulerState shape (pushed to renderers every second)

```js
{
  now: 1758100000000,
  phase: 'work',                 // 'work' | 'break' | 'paused' | 'away' | 'off-hours'
  warning: false,
  work: {
    startedAt: 1758099000000,    // null unless phase work
    endsAt: 1758100800000,       // null unless phase work
    durationMs: 1800000,         // configured work duration (+ snooze extensions)
    remainingMs: 800000,         // when paused/away: frozen remaining time
    progress: 0.55               // 0..1 elapsed fraction
  },
  break: {
    type: 'short',               // current break (phase break) or the NEXT break (other phases)
    startedAt: null,             // number while phase break
    endsAt: null,                // number while phase break
    durationMs: 120000,
    remainingMs: 120000,
    progress: 0,                 // 0..1
    canSkip: true,               // false in strict mode while in break
    canSnooze: true,             // snooze.count < snooze.max && !(strict && phase break)
    skipHoldSeconds: 3,
    lockScreen: true
  },
  cycle: { index: 1, longEvery: 4, longEnabled: true },   // index = breaks since last long break
  pause: { until: null, reason: null },                   // until: number|null; reason: 'user'|null
  away: { since: null },                                   // number while phase away
  snooze: { count: 0, max: 2 },
  hydration: {
    enabled: true,
    nextAt: 1758101500000,       // null when disabled / frozen
    intervalMs: 2700000,
    remainingMs: 1500000,
    progress: 0.44,
    due: false,                  // reminder fired and not yet acknowledged via drinkWater()
    glassesToday: 3,
    goal: 8
  },
  today: { breaksCompleted: 4, breaksSkipped: 0, glasses: 3, workSeconds: 7200 }   // convenience subset of stats
}
```

---------------------------------------------------------------------------------

## 5. Renderer API – `window.augenpause` (preload, owned by [MAIN-SHELL])

All renderers use `getApi()` from `src/renderer/shared/api.js` which returns this object.

```js
window.augenpause = {
  platform: 'win32' | 'darwin' | 'linux',
  view: 'widget' | 'dashboard' | 'overlay',             // derived from location

  getSnapshot(): Promise<{ state, settings, stats: DayStats[] /* last 7 days */, update /* §12 */, version, locale }>,
  updateSettings(patch): Promise<{ ok, settings, errors }>,
  resetSettings(): Promise<Settings>,
  getStats(days): Promise<DayStats[]>,
  resetStats(): Promise<{ ok: true }>,
  action(name, arg?): Promise<{ ok: boolean, error?: string }>,   // see ACTIONS below

  showContextMenu(): void,                               // main pops the shared native context menu at the cursor
  widgetDrag(phase): void,                               // 'start' | 'move' | 'end' – main moves the widget window using the cursor position
  setWidgetInteractive(interactive: boolean): void,      // widget: false → clicks pass through transparent areas (win/mac)

  onState(cb): () => void,                               // SchedulerState, every second + on change
  onSettings(cb): () => void,                            // Settings, on change
  onStats(cb): () => void,                               // DayStats (today), on change
  onNavigate(cb): () => void,                            // dashboard only: tab name 'overview'|'settings'|'stats'|'exercises'|'about'
  onUpdate(cb): () => void                               // update state (§12), dashboard only
}
```

### ACTIONS (`action(name, arg)`)

| name              | arg                                   | effect |
|-------------------|---------------------------------------|--------|
| `break-now`       | `'short'` \| `'long'` \| undefined    | scheduler.startBreak |
| `skip-break`      | –                                     | scheduler.skipBreak |
| `snooze`          | minutes int 1..60 \| undefined        | scheduler.snooze |
| `pause`           | minutes int 1..1440 \| `'tomorrow'` \| null | scheduler.pause |
| `resume`          | –                                     | scheduler.resume |
| `reset-timer`     | –                                     | scheduler.resetWorkTimer |
| `drink`           | –                                     | scheduler.drinkWater |
| `undo-drink`      | –                                     | scheduler.undoDrink |
| `open-dashboard`  | tab name \| undefined                 | show + focus dashboard (and navigate) |
| `toggle-dashboard`| –                                     | show/hide dashboard |
| `show-widget`     | –                                     | settings.widget.visible = true |
| `hide-widget`     | –                                     | settings.widget.visible = false |
| `reset-widget-position` | –                               | settings.widget.position = null → default corner |
| `quit`            | –                                     | quit app (not during a strict-mode break) |

### IPC channels (`src/main/constants.js`)

Invoke (renderer → main, `ipcRenderer.invoke`): `ap:get-snapshot`, `ap:update-settings`, `ap:reset-settings`,
`ap:get-stats`, `ap:reset-stats`, `ap:action`.
Send (renderer → main, `ipcRenderer.send`): `ap:context-menu`, `ap:widget-drag`, `ap:widget-interactive`.
Push (main → renderer): `ap:state`, `ap:settings`, `ap:stats`, `ap:navigate`.

Every ipcMain handler validates `event.senderFrame.url` starts with `app://augenpause/` and validates the payload.

---------------------------------------------------------------------------------

## 6. Windows (owned by [MAIN-SHELL])

URLs are served by the custom protocol: `app://augenpause/<view>/index.html`.

### Widget
- frameless, transparent, `resizable:false`, `skipTaskbar:true`, `hasShadow:false`, `focusable:true`,
  `alwaysOnTop` per settings (level `'floating'`), `visibleOnAllWorkspaces`.
- Clock diameter `S` from `WIDGET_SIZES` (constants.js): small 120, medium 160, large 210.
- Window size: `width = max(S, 176) + 24`, `height = S + 24 + 52`.
  Renderer layout: clock circle of diameter S centred horizontally, 12 px from the top; the bottom 52 px are the
  hover/warning action-pill area. Everything else transparent.
- Default position: top-right of the primary display work area, 24 px margin.
- Dragging: renderer calls `widgetDrag('start')` on pointerdown, `widgetDrag('move')` on pointermove (while captured),
  `widgetDrag('end')` on pointerup. Main computes position from `screen.getCursorScreenPoint()`, clamps into the
  nearest display work area and persists `widget.position` on end. Movement < 4 px = click (renderer decides).
- Right-click → renderer calls `showContextMenu()`.

### Dashboard
- 1040×720, min 860×600, hidden on close (not destroyed), `titleBarStyle:'hidden'`;
  win/linux: `titleBarOverlay` (height 44, colors follow theme), mac: `trafficLightPosition {x:16,y:14}`.
- Renderer must reserve a 44 px drag region at the top (`-webkit-app-region: drag`, interactive elements `no-drag`),
  with 80 px left padding on mac (`platform==='darwin'`) and 150 px right padding on win/linux.

### Overlay (break screen)
- One per display (or primary only), bounds = display bounds, frameless, opaque background `#0b1020`,
  `alwaysOnTop` level `'screen-saver'`, `skipTaskbar`, not movable/resizable/minimizable, `visibleOnAllWorkspaces`
  (`visibleOnFullScreen:true`), `autoplayPolicy:'no-user-gesture-required'`.
- URL `app://augenpause/overlay/index.html?primary=1` for the primary display (`primary=0` otherwise).
- Close is prevented while the break runs; re-focus on blur; Alt+F4 / Cmd+W / Cmd+Q blocked during the break
  (quitting is allowed on OS shutdown/logout).
- On `break-end` main waits 1500 ms (renderer shows a "done" animation because `state.phase !== 'break'`) then destroys overlays.
- Displays added during a break get an overlay too.
- OS security shortcuts (Ctrl+Alt+Del, Win+L, Cmd+Ctrl+Q) are intentionally NOT blocked.

---------------------------------------------------------------------------------

## 7. Security baseline (owned by [MAIN-SHELL], respected by all)

- `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`, `webSecurity:true`, `app.enableSandbox()`.
- Only `app://augenpause/` content; no remote URLs, no CDNs, no web fonts, no inline `<script>`, no inline event handlers,
  no `eval`/`new Function`, no `innerHTML` with untrusted data (use `textContent` / DOM APIs; static SVG templates are ok).
- CSP (header + meta): `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; media-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`.
  → inline `style="..."` attributes are NOT allowed; set styles via `element.style.setProperty()` (allowed by CSP) or classes.
- Deny: new windows, navigation away, webviews, permission requests, downloads.
- Protocol handler: normalised paths, no traversal, only files under `src/renderer`, strict MIME map.
- IPC: sender URL check + payload validation (types, ranges, whitelists).
- Settings file: atomic write (tmp + rename), corrupt file backed up.
- electron-builder fuses: runAsNode off, NODE_OPTIONS off, inspect args off, onlyLoadAppFromAsar on, asar integrity on.

---------------------------------------------------------------------------------

## 8. Design system (lead, `src/renderer/shared`)

- `tokens.css`: CSS custom properties – see file. Theme via `html[data-theme="dark"|"light"]`, accent via `html[data-accent="…"]`.
- `base.css`: reset, typography, `.btn` (`.btn-primary`, `.btn-ghost`, `.btn-danger`, `.btn-icon`), `.card`, `.switch`,
  `.segmented`, `.slider`, `.chip`, focus rings, `prefers-reduced-motion` handling.
- `theme.js`: `applyAppearance(settings)` sets `data-theme`/`data-accent`/`lang` and follows the OS scheme when theme = system.
- `i18n.js`: `resolveLang(settingLanguage)` → 'de'|'en'; `createT(dict, lang)` → `t(key, vars)` with `{name}` placeholders.
- `format.js`: `formatClock(ms)` → "12:34" / "1:02:03"; `formatDuration(ms, lang)` → "12 Min" / "1 Std 5 Min"; `formatMinutes(min, lang)`.
- Visual language: dark glassmorphism, soft gradients, large rounded radii, subtle depth, smooth 60fps CSS transitions,
  SVG rings with rounded caps. Colors: work = accent, warning = amber, break = green/mint, paused/away = slate, hydration = sky blue.

---------------------------------------------------------------------------------

## 9. Meeting safety (ADDENDUM – binding, overrides earlier sections where they differ)

A break must NEVER surprise the user in a meeting. Layers:

1. **Pre-break warning** (`timer.warnBeforeSeconds`, default 60) with one-click snooze. If the widget is hidden and
   `widget.showOnWarning` is true, main shows the widget (inactive, no focus steal) during the warning and hides it again afterwards.
2. **Grace period** at the start of every break (`breaks.graceSeconds`, default 15): while `state.break.inGrace` is true,
   snoozing is ALWAYS allowed – even in strict mode and even when `snooze.count >= snooze.max`. The overlay shows big
   snooze buttons during grace and **Esc** = snooze by `timer.snoozeMinutes`.
3. **Global shortcut** for snooze (see §10 for the per-platform key), works any time incl. during a break
   (subject to the same canSnooze rules).
4. **Automatic meeting detection** (`meeting.autoDetect`, default true) – `src/main/meeting.js` [MAIN-SHELL]:
   - Windows: camera/microphone in use → registry `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\{microphone,webcam}`
     (recursive, incl. `NonPackaged`): any `LastUsedTimeStop` value `0x0` ⇒ in use. Use `execFile('reg', ['query', key, '/s', '/v', 'LastUsedTimeStop'])`.
   - Linux: `execFile('pactl', ['list', 'short', 'source-outputs'])` non-empty (ignore errors/missing binary) OR any `/proc/<pid>/fd/*` symlink → `/dev/video*`.
   - macOS: `execFile('pmset', ['-g', 'assertions'])` contains an assertion from a known call app (zoom.us, Microsoft Teams, Webex, FaceTime, Slack huddle, Discord)
     or the text `WebRTC has active PeerConnections` (Chromium browsers during Meet/Teams-web calls).
   - Never use a shell, fixed args only, 5 s timeout, failures ⇒ "not in meeting". Adaptive polling: every 10 s when
     (phase work && remainingMs ≤ 5 min) || phase break || meeting.deferred; otherwise every 60 s; not at all when autoDetect is off.
   - Main calls `scheduler.setMeetingActive(bool)` on changes.
5. **Meeting mode** (manual): menu/dashboard "Meeting-Modus" = `pause` action with 30/60/120 minutes or null.

### Settings additions (§2)
```js
breaks.graceSeconds: 15        // int 0..120
widget.showOnWarning: true     // bool
meeting: { autoDetect: true }  // new group
```

### Scheduler additions (§4)
```js
scheduler.setMeetingActive(active: boolean)   // ignored (treated as false) when settings.meeting.autoDetect is false
scheduler.snooze(minutes?)                    // minutes int 1..60 (default timer.snoozeMinutes)
// new event:
'meeting-deferred'  ({ type })                // a due break was postponed because a meeting is active (emitted once per deferral)
```
Rules:
- Work period reaches its end while meeting active ⇒ no break; `meeting.deferred = true`, phase stays `work`, `work.remainingMs = 0`,
  `warning = false`, emit `meeting-deferred` once.
- Meeting ends while deferred ⇒ `work.endsAt = now + max(60 s, warnBeforeSeconds)`, `deferred = false` (warning fires again normally).
- No `warning` event while a meeting is active.
- Meeting starts during a break ⇒ break ends immediately: `break-end { completed:false, skipped:false, snoozed:true, reason:'meeting' }`
  (NOT counted as skipped, does not increase snooze.count, partial seconds may be added to breakSeconds), then work with `deferred = true`.
- `canSnooze = phase==='break' && inGrace ? true : (snooze.count < snooze.max && !(strictMode && phase==='break'))`.
  Snoozes during grace still increment `snooze.count` but are never blocked by it.
- `skipBreak` rules unchanged (strict mode still blocks skipping, also during grace).

### SchedulerState additions (§4)
```js
break: { …, inGrace: false, graceUntil: null /* number while phase break and grace active */ },
snooze: { count: 0, max: 2, options: [5, 10, 15, 30] },
meeting: { active: false, deferred: false, since: null /* number while active */ }
```

### Action changes (§5)
- `snooze` arg: minutes int 1..60 | undefined.
- Overlay allowlist unchanged (`skip-break`, `snooze`, `drink`, `undo-drink`).

---------------------------------------------------------------------------------

## 10. Review fixes (ADDENDUM – binding)

### Global shortcuts (replaces earlier shortcut definitions)
Ctrl+Alt+<letter> is AltGr on Windows (breaks typing `{`, `|`, `ś` …) and collides with IDE shortcuts; Ctrl+Alt+F<n> switches VTs on Linux.
Only three shortcuts are registered (break-now and drink are NOT global shortcuts any more):

| action                      | Windows          | macOS                         | Linux                    |
|-----------------------------|------------------|-------------------------------|--------------------------|
| snooze (default minutes)    | `Control+Alt+F9` | `Control+Alt+Command+S` (⌃⌥⌘S) | `Control+Shift+Alt+S`    |
| pause (null) / resume       | `Control+Alt+F10`| `Control+Alt+Command+P` (⌃⌥⌘P) | `Control+Shift+Alt+P`    |
| toggle-dashboard            | `Control+Alt+F11`| `Control+Alt+Command+D` (⌃⌥⌘D) | `Control+Shift+Alt+D`    |

Display labels: de "Strg+Alt+F9" / "Strg+Umschalt+Alt+S", en "Ctrl+Alt+F9" / "Ctrl+Shift+Alt+S", mac "⌃⌥⌘S".
`src/main/shortcuts.js` exports `SHORTCUTS` (per platform) + `shortcutLabel(action, platform, lang)`; renderers keep an identical copy
in `src/renderer/shared/shortcuts.js` (lead) → `getShortcutRows(platform, lang)`.

### Break screen fail-open
- main handles Escape in the overlay's `before-input-event` → `performAction('snooze', undefined, 'overlay-esc')` (scheduler rules still apply),
  so Esc works even if the overlay page is broken.
- The overlay is "ready" when its `ap:get-snapshot` arrives. If the PRIMARY overlay is not ready 10 s after `openOverlays()`, or on
  `did-fail-load` / render-process-gone after reload budget → close all overlays immediately, restore the widget, log an error.
- Safety net (see §11 for the final form): main tracks its own monotonic deadline; `state.break.endsAt` must NOT be used for it.
- Overlays close immediately (0 ms) when the break did NOT complete (skip / snooze / meeting); 1500 ms only for completed breaks.

### IPC
- `ap:update-settings`, `ap:reset-settings`, `ap:get-stats`, `ap:reset-stats`: overlay is NOT allowed (widget+dashboard for update/get-stats, dashboard only for resets).
- `performAction(name, arg, source)` logs the source in --dev ('ipc:widget', 'tray', 'menu', 'shortcut', 'notification', 'overlay-esc').

### Scheduler / settings / stats
- Max meeting deferral 2 h: after a break has been deferred for ≥ 2 h the meeting signal is ignored until it reports false once;
  the break then follows the normal warning path (endsAt = now + max(60 s, warnBeforeSeconds)); event `'meeting-defer-expired'`.
- Settings: if `breaks.strictMode` is true, `breaks.graceSeconds` is clamped to ≥ 5. `store.update` reports a failed persist in `errors` (`'persist: …'`).
- Scheduler rejects `pause` in strict mode during a break even in grace (menu disables it accordingly).
- Stats: `workSeconds`-only changes are persisted at most every 60 s and do NOT emit `'change'`; real events (breaks, glasses, snoozes,
  natural breaks) emit + persist debounced 5 s; compact JSON; stats writes skip fsync; always flush on quit/suspend/session-end.

---------------------------------------------------------------------------------

## 11. Mandatory transparent break lock (ADDENDUM – binding, overrides §6/§9/§10 where they differ)

User decision: a locked break ends ONLY by timeout. Meeting protection happens only BEFORE the break
(warning + snooze limited by maxSnoozes + automatic deferral while camera/mic is active). The mandatory mode is a
setting ("Pflicht-Pause"), default ON, changeable only while no break is running.

### Settings (§2 changes) – SETTINGS_VERSION 2
```js
breaks.strictMode: true          // "Pflicht-Pause" – DEFAULT TRUE now
breaks.overlayOpacity: 0.6       // number 0.2..1 – opacity of the dark tint of the transparent break screen
```
- Migration v1 → v2: `strictMode = true`, add `overlayOpacity` default, `version = 2`.
- Remove the "graceSeconds ≥ 5 when strict" clamp (grace does not exist in strict mode). graceSeconds stays for non-strict mode.

### Scheduler when `breaks.strictMode === true` and phase === 'break'
- `break.inGrace = false`, `graceUntil = null`, `canSkip = false`, `canSnooze = false`.
- Rejected with `'strict-mode'`: skipBreak, snooze, pause, resume, resetWorkTimer, startBreak (already in break).
- `setMeetingActive(true)` does NOT end or shorten the break (state.meeting.active reflects the signal; after the break the normal deferral rules apply).
- Lock/suspend/idle do not interrupt the break (unchanged).
- Non-strict mode keeps the §9/§10 behaviour (grace, snooze, skip, meeting release).

### Tamper-resistant break timing (all breaks)
- Inject `monotonicNow` (default `() => performance.now()` from `node:perf_hooks`). The break keeps `elapsedMs`; per tick
  `delta = |wallDelta − monoDelta| ≤ 2000 && wallDelta ≥ 0 ? wallDelta : monoDelta` → wall-clock changes cannot shorten a break.
- Suspend during a break: the wall-clock time between onSuspend and onResume is credited, capped at
  `min(remaining + CLOCK_TOLERANCE_MS, MAX_SUSPEND_CREDIT_MS = 2 h)`. If the wall delta exceeds that cap it is
  indistinguishable from an RTC change, so only the observed time counts and the break ends as PARTIAL
  (`break-end { completed: false, reason: 'clock-jump' }`, stats not credited as completed).
- Break ends when `elapsedMs ≥ durationMs`. `state.break.endsAt = now + remaining` (recomputed every tick), `remainingMs`, `progress` accordingly.

### Break persistence (app killed during a break)
- Scheduler option `breakStore = { load() → object|null, save(obj), clear() }` (main passes a JSON file `session.json` in userData,
  written with `{ fsync:false }`). Saved at break start, every 5 s during the break, and on suspend; cleared at break end.
  Saved object: `{ type, durationMs, elapsedMs, strict, savedAt, interrupted: null | 'system' }`.
- `scheduler.onSystemShutdown(realSessionEnd = true)`: `true` (real OS shutdown / logoff / Windows session-end) saves with
  `interrupted: 'system'`; `false` (bare SIGTERM, a Windows logoff QUERY, anything a user can trigger) saves with
  `interrupted: null` so the 8 h kill-resume window applies. A 'system' mark is dropped again when the break keeps
  progressing for SHUTDOWN_MARK_TTL_MS = 60 s (cancelled logoff). Saved records older than 8 h are rejected as stale.
- On `start()`: if a saved STRICT break exists and remaining > 0:
  - `interrupted === 'system'` → resume only if `now − savedAt < idle.resetAfterMinutes` (otherwise it counts as a natural break → clear).
  - otherwise (killed/crashed) → resume if `now − savedAt < 8 h`.
  - Resume = phase break with remaining = `durationMs − elapsedMs` (time the app was not running is NOT credited),
    emit `'break-start' { type, durationMs, endsAt, resumed: true }`.
  Non-strict saved breaks are just cleared.

### Main process
- Overlay windows are TRANSPARENT: `transparent:true`, `backgroundColor:'#00000000'`, `hasShadow:false` (rest of §6 unchanged).
  Pixels are never fully transparent (renderer tint alpha ≥ 0.2) so the window still captures all mouse input.
- Strict break guard (single helper `isStrictBreakActive()`):
  - Esc in overlay `before-input-event` → preventDefault, NO snooze. (Non-strict: §10 behaviour.)
  - Global shortcuts, tray/menu actions and IPC actions other than `drink`/`undo-drink` → rejected `'strict-mode'` (no-op).
    `toggle-dashboard` / `open-dashboard` also rejected during a strict break.
  - Settings patches from ANY source (menu, IPC) → only `language` and `appearance.*` are applied; everything else rejected `'strict-break'`.
    `ap:reset-settings`, `ap:reset-stats` rejected.
  - Quit blocked unless OS shutdown/logoff/SIGTERM (then `scheduler.onSystemShutdown(realSessionEnd)` first, see above).
  - macOS: the application menu is replaced by `[{ label: appName, submenu: [{ role: 'about' }] }]` for the duration of a strict
    break (AppKit handles ⌘H/⌘M/⌘W/⌘Q before `before-input-event`), and restored on break-end / language change.
  - Fail-open (§10) is DISABLED: a broken overlay page is reloaded (budget 3); if still broken the tinted window stays until the break ends.
    Main always closes overlays on break-end regardless of the renderer.
  - OVERDUE SAFETY NET (must not depend on scheduler state, because `state.break.endsAt` is re-projected on every
    `getState()` and can never fall behind `state.now`): main tracks its own `breakDeadline = Date.now() + durationMs + 10 s`
    at break start (on the MONOTONIC clock, so moving the system clock cannot pop the lock) AND detects
    `state.break.remainingMs === 0` persisting > 10 s. On either: log an error, release the strict lock via a latch that
    `isStrictBreakActive()` short-circuits (clearing the captured flag alone is not enough – the check is fail-closed and would
    still see `state.break.strict`), close overlays, restore the widget, restore the app menu and CLEAR `session.json`
    (otherwise the abandoned break resumes on the next start). The deadline is re-armed on resume/unlock. Backstop for a stalled tick loop.
- Focus watchdog while overlays are open (every 400 ms, and immediately on overlay `blur`, max 10 refocus/s):
  recreate destroyed overlays for connected displays, `show()` hidden ones, re-assert `setAlwaysOnTop(true,'screen-saver')`, `moveTop()`,
  and if no overlay is focused → focus the primary overlay (`app.focus({ steal: true })` on macOS). Counters Alt+Tab, Win+D,
  virtual-desktop switches and Start menu. OS secure shortcuts (Ctrl+Alt+Del, Win+L, power button) stay untouched by design.
- On startup, if the scheduler resumes a break (`resumed:true`) → open overlays immediately.

### Renderers
- Overlay: page background `rgba(11,16,32, overlayOpacity)` (CSS variable set from settings, live), aurora blobs subtle; the centre
  content (ring, texts, exercise card) sits on a legible glass panel (≈ rgba(11,16,32,0.72) + border) independent of the tint.
  Strict: NO snooze/skip buttons, NO grace card, NO Esc hint; show a calm chip "Pflicht-Pause · endet automatisch um HH:MM".
  "Getrunken" (drink) stays. Non-strict: existing UI.
  The tint must be visible from the FIRST PAINT and must never depend on JS: it lives on `body`
  (`rgba(11,16,32, max(0.2, var(--overlay-alpha, 0.6)))`, CSS floor 0.2 so the window always captures input) and only the
  content (ring, panel, chips) fades in. A static fallback chip outside the animated container explains the lock even if
  the page's script throws or never runs; `is-ready` is set in a `finally` plus a 1 s timeout, and window `error` /
  `unhandledrejection` handlers force it. A broken overlay page must still LOOK like a lock screen.
- Dashboard: "Strenger Modus" → "Pflicht-Pause" (default on) with explanation; switch disabled while phase is break;
  new slider "Transparenz des Sperrbildschirms" (overlayOpacity shown as Deckkraft 20–100 %); grace + skip-hold controls are
  disabled/folded with a note when Pflicht-Pause is on.
- Menu/tray/i18n: "Strenger Modus" → "Pflicht-Pause"; during a strict break every actionable item is disabled; status line
  "Pflicht-Pause – noch 1:23"; quit disabled.

---------------------------------------------------------------------------------

## 12. Updates (ADDENDUM – binding)

The app checks GitHub releases for a newer version. This is the ONLY network access in the app; it is
configurable and must be documented wherever the "no network connections" claim appears
(README, SECURITY.md, dashboard About page).

### Capability per installation (detected at runtime, never guessed)
| installation | detection | capability |
|---|---|---|
| Windows NSIS setup | `process.platform === 'win32'` && not portable | `auto` – electron-updater, differential (blockmap) download, install on quit |
| Windows portable | `process.env.PORTABLE_EXECUTABLE_FILE` set | `manual` |
| Linux AppImage | `process.env.APPIMAGE` set | `auto` – electron-updater |
| Linux deb/rpm/tar.gz | linux without APPIMAGE | `manual` (package manager owns the files) |
| macOS | always | `manual` (Squirrel.Mac requires a signed app; builds are unsigned) |
| macOS legacy build | `major(process.versions.electron) < 40` | `manual` + only `*legacy*` assets may be offered |
| dev run | `!app.isPackaged` | `manual`, checks disabled by default |

`manual` = the app tells the user and opens the matching asset URL (or the release page) in the browser
via `shell.openExternal`. The app never downloads or executes an installer itself in that mode.

### Settings additions (§2)
```js
updates: {
  autoCheck: true,          // bool  – check ~30 s after start and then every intervalHours
  intervalHours: 24,        // int 6..168
  autoDownload: false,      // bool  – only honoured where capability === 'auto'
  includePrerelease: false, // bool
}
```

### Update state (own push channel `ap:update`, also part of `ap:get-snapshot` as `update`)
```js
{
  capability: 'auto' | 'manual',
  status: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error',
  currentVersion: '1.1.0',
  latestVersion: null,        // string when known
  releaseUrl: null,           // https://github.com/<owner>/<repo>/releases/tag/vX.Y.Z
  assetUrl: null,             // best matching asset for this platform/arch/variant
  assetName: null,
  progress: 0,                // 0..1 while downloading
  lastCheckAt: null,          // ms epoch
  error: null,                // short code/message, never a stack
  legacyBuild: false,
  notes: null,                // release name/body trimmed to ≤ 2000 chars, rendered as TEXT only
}
```

### Actions (§5 additions, dashboard only; widget/overlay must NOT get them)
`check-updates`, `download-update`, `install-update` (quit + install; refused during a break),
`open-release-page`.

### Security rules
- HTTPS only. Release info from `https://api.github.com/repos/<owner>/<repo>/releases` with a 10 s timeout,
  `User-Agent: AugenPause/<version>`, no credentials, no cookies, response size cap (256 KB), strict JSON validation.
- Tags must match `^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$`; versions compared with a small semver comparator (own code, tested).
  A "newer" version must be strictly greater than the running one; downgrades are never offered.
- `shell.openExternal` only for URLs that match `^https://github\.com/<owner>/<repo>/releases/` or the exact asset
  download host `^https://github\.com/<owner>/<repo>/releases/download/`. Everything else is rejected and logged.
- Release notes are inserted with `textContent` only (never HTML/markdown rendering).
- electron-updater is configured with `autoDownload = false` (the app decides), `allowDowngrade = false`,
  `allowPrerelease` from settings; it is only imported/used when capability === 'auto'.
- No check while a mandatory break is running, none in the first 20 s after start, none when `autoCheck` is off,
  at most one in-flight check, failures are silent (state only) and never open a dialog.
- The legacy macOS build must never be offered a non-legacy asset (asset name must contain `legacy`).

### Build/publish requirements
- `electron-builder.yml` gets a `publish` block (`provider: github`, owner/repo) so `latest.yml`,
  `latest-linux.yml` and `latest-mac.yml` are generated; uploads still only happen through the release job.
- NSIS: `differentialPackage: true` (blockmap) so Windows gets small patch downloads.
- The `macos-legacy` CI job builds with `-c.publish=null` so it cannot overwrite `latest-mac.yml`.
- The release must carry `latest*.yml` next to the installers.
