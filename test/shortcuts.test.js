'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const shortcuts = require('../src/main/shortcuts');

const { SHORTCUTS, shortcutKeys, shortcutLabel, acceleratorFor, createHandlers, registerShortcuts, unregisterShortcuts } = shortcuts;

const RENDERER_SOURCE = fs.readFileSync(path.join(__dirname, '../src/renderer/shared/shortcuts.js'), 'utf8');

/** Parses `const KEYS = { win32: { snooze: ['Ctrl', 'Alt', 'F9'], … }, … };` from the renderer copy (text only). */
function rendererKeys() {
  const block = /const KEYS = \{([\s\S]*?)\n\};/.exec(RENDERER_SOURCE);
  assert.ok(block, 'src/renderer/shared/shortcuts.js must define const KEYS = { … };');
  const out = {};
  for (const platform of block[1].matchAll(/(\w+):\s*\{([^}]*)\}/g)) {
    const actions = {};
    for (const action of platform[2].matchAll(/(\w+):\s*\[([^\]]*)\]/g)) {
      actions[action[1]] = [...action[2].matchAll(/'([^']*)'/g)].map((m) => m[1]);
    }
    out[platform[1]] = actions;
  }
  return out;
}

/** Parses `const DE_KEYS = { Ctrl: 'Strg', … };`. */
function rendererDeKeys() {
  const block = /const DE_KEYS = \{([^}]*)\}/.exec(RENDERER_SOURCE);
  assert.ok(block, 'src/renderer/shared/shortcuts.js must define const DE_KEYS');
  return Object.fromEntries([...block[1].matchAll(/(\w+):\s*'([^']*)'/g)].map((m) => [m[1], m[2]]));
}

test('renderer copy has exactly the same platforms, actions and keys as SHORTCUTS', () => {
  const renderer = rendererKeys();
  assert.deepEqual(Object.keys(renderer).sort(), Object.keys(SHORTCUTS).sort(), 'platforms');
  const deKeys = rendererDeKeys();
  for (const platform of Object.keys(SHORTCUTS)) {
    assert.deepEqual(Object.keys(renderer[platform]).sort(), Object.keys(SHORTCUTS[platform]).sort(), `actions of ${platform}`);
    for (const action of Object.keys(SHORTCUTS[platform])) {
      const tokens = renderer[platform][action];
      assert.deepEqual(shortcutKeys(action, platform, 'en'), tokens, `${platform} ${action} (en)`);
      const de = tokens.map((k) => deKeys[k] || k);
      assert.deepEqual(shortcutKeys(action, platform, 'de'), de, `${platform} ${action} (de)`);
    }
  }
});

test('§10 accelerator table', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(SHORTCUTS)), {
    win32: { snooze: 'Control+Alt+F9', pauseToggle: 'Control+Alt+F10', dashboard: 'Control+Alt+F11' },
    darwin: {
      snooze: 'Control+Alt+Command+S', pauseToggle: 'Control+Alt+Command+P', dashboard: 'Control+Alt+Command+D',
    },
    linux: { snooze: 'Control+Shift+Alt+S', pauseToggle: 'Control+Shift+Alt+P', dashboard: 'Control+Shift+Alt+D' },
  });
  assert.ok(Object.isFrozen(SHORTCUTS));
  for (const table of Object.values(SHORTCUTS)) {
    assert.ok(Object.isFrozen(table));
    const values = Object.values(table);
    assert.equal(new Set(values).size, values.length, 'no duplicate accelerators');
  }
  // Windows: no Ctrl+Alt+<letter> (= AltGr); Linux: no Ctrl+Alt+F<n> (VT switch); nowhere CommandOrControl
  for (const accelerator of Object.values(SHORTCUTS.win32)) assert.match(accelerator, /^Control\+Alt\+F\d+$/);
  for (const accelerator of Object.values(SHORTCUTS.linux)) assert.doesNotMatch(accelerator, /\+F\d+$/);
  for (const table of Object.values(SHORTCUTS)) {
    for (const accelerator of Object.values(table)) assert.doesNotMatch(accelerator, /CommandOrControl|CmdOrCtrl/);
  }
});

test('shortcutLabel per platform and language', () => {
  assert.equal(shortcutLabel('snooze', 'win32', 'de'), 'Strg+Alt+F9');
  assert.equal(shortcutLabel('snooze', 'win32', 'en'), 'Ctrl+Alt+F9');
  assert.equal(shortcutLabel('pauseToggle', 'win32', 'de'), 'Strg+Alt+F10');
  assert.equal(shortcutLabel('dashboard', 'win32', 'en'), 'Ctrl+Alt+F11');
  assert.equal(shortcutLabel('snooze', 'linux', 'de'), 'Strg+Umschalt+Alt+S');
  assert.equal(shortcutLabel('snooze', 'linux', 'en'), 'Ctrl+Shift+Alt+S');
  assert.equal(shortcutLabel('dashboard', 'linux', 'de'), 'Strg+Umschalt+Alt+D');
  assert.equal(shortcutLabel('snooze', 'darwin', 'de'), '⌃⌥⌘S');
  assert.equal(shortcutLabel('pauseToggle', 'darwin', 'en'), '⌃⌥⌘P');
  assert.equal(shortcutLabel('dashboard', 'darwin', 'en'), '⌃⌥⌘D');
  // action names as aliases, unknown platform → Linux, unknown language → English key names
  assert.equal(shortcutLabel('pause', 'win32', 'de'), 'Strg+Alt+F10');
  assert.equal(shortcutLabel('resume', 'darwin', 'de'), '⌃⌥⌘P');
  assert.equal(shortcutLabel('toggle-dashboard', 'linux', 'en'), 'Ctrl+Shift+Alt+D');
  assert.equal(shortcutLabel('snooze', 'freebsd', 'en'), 'Ctrl+Shift+Alt+S');
  assert.equal(shortcutLabel('snooze', 'win32', 'fr'), 'Ctrl+Alt+F9');
  // break-now and drink are no global shortcuts any more
  assert.equal(shortcutLabel('break-now', 'win32', 'de'), '');
  assert.equal(shortcutLabel('drink', 'darwin', 'de'), '');
  assert.equal(shortcutLabel('__proto__', 'win32', 'de'), '');
  assert.equal(acceleratorFor('drink', 'linux'), null);
  assert.equal(acceleratorFor('snooze', 'darwin'), 'Control+Alt+Command+S');
});

test('handlers dispatch snooze / pause-or-resume / toggle-dashboard with source "shortcut"', async () => {
  const calls = [];
  let phase = 'work';
  const handlers = createHandlers({
    onAction: (...args) => calls.push(args),
    getState: () => ({ phase }),
  });
  assert.deepEqual(Object.keys(handlers).sort(), ['dashboard', 'pauseToggle', 'snooze']);
  handlers.snooze();
  handlers.pauseToggle();
  phase = 'paused';
  handlers.pauseToggle();
  handlers.dashboard();
  assert.deepEqual(calls, [
    ['snooze', undefined, 'shortcut'],
    ['pause', null, 'shortcut'],
    ['resume', undefined, 'shortcut'],
    ['toggle-dashboard', undefined, 'shortcut'],
  ]);

  // broken state getter / throwing or rejecting onAction never throw
  const warnings = [];
  const warn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const broken = createHandlers({
      onAction: () => {
        throw new Error('boom');
      },
      getState: () => {
        throw new Error('boom');
      },
    });
    assert.doesNotThrow(() => broken.pauseToggle());
    const rejecting = createHandlers({ onAction: () => Promise.reject(new Error('nope')) });
    assert.doesNotThrow(() => rejecting.snooze());
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    console.warn = warn;
  }
  assert.equal(warnings.length, 2);
});

test('during a mandatory break every shortcut handler is a no-op (§11)', () => {
  const calls = [];
  let strict = true;
  const handlers = createHandlers({
    onAction: (...args) => calls.push(args),
    getState: () => ({ phase: 'break' }),
    isStrictBreak: () => strict,
  });
  handlers.snooze();
  handlers.pauseToggle();
  handlers.dashboard();
  assert.deepEqual(calls, [], 'nothing is dispatched while the mandatory break runs');

  strict = false; // break over
  handlers.snooze();
  handlers.dashboard();
  assert.deepEqual(calls, [['snooze', undefined, 'shortcut'], ['toggle-dashboard', undefined, 'shortcut']]);

  // a missing or throwing isStrictBreak must not break the shortcuts (main's performAction still guards)
  const noGuard = createHandlers({ onAction: (...args) => calls.push(args) });
  noGuard.snooze();
  const throwing = createHandlers({
    onAction: (...args) => calls.push(args),
    isStrictBreak: () => {
      throw new Error('boom');
    },
  });
  assert.doesNotThrow(() => throwing.snooze());
  assert.equal(calls.length, 4);
  // a non-boolean answer is not "strict"
  const fuzzy = createHandlers({ onAction: (...args) => calls.push(args), isStrictBreak: () => 'yes' });
  fuzzy.snooze();
  assert.equal(calls.length, 5);
});

/** Temporarily replaces require('electron') with a fake globalShortcut. */
function withFakeElectron(globalShortcut, fn) {
  const id = require.resolve('electron');
  const previous = require.cache[id];
  require.cache[id] = { id, filename: id, loaded: true, exports: { globalShortcut } };
  try {
    return fn();
  } finally {
    if (previous) require.cache[id] = previous;
    else delete require.cache[id];
  }
}

test('registerShortcuts registers exactly the platform accelerators and unregisters only its own', () => {
  const registered = new Map();
  const unregistered = [];
  const fake = {
    register(accelerator, callback) {
      if (accelerator === 'Control+Shift+Alt+P') return false; // taken by another app
      registered.set(accelerator, callback);
      return true;
    },
    unregister(accelerator) {
      unregistered.push(accelerator);
      registered.delete(accelerator);
    },
    unregisterAll() {
      throw new Error('must never be called');
    },
  };
  const calls = [];
  withFakeElectron(fake, () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      const result = registerShortcuts({
        enabled: true,
        onAction: (...args) => calls.push(args),
        getState: () => ({ phase: 'work' }),
        platform: 'linux',
      });
      assert.deepEqual(result, {
        registered: ['Control+Shift+Alt+S', 'Control+Shift+Alt+D'],
        failed: ['Control+Shift+Alt+P'],
      });

      registered.get('Control+Shift+Alt+S')();
      registered.get('Control+Shift+Alt+S')(); // auto-repeat within 500 ms is ignored
      registered.get('Control+Shift+Alt+D')();
      assert.deepEqual(calls, [['snooze', undefined, 'shortcut'], ['toggle-dashboard', undefined, 'shortcut']]);

      const win = registerShortcuts({ enabled: true, onAction: () => {}, getState: () => null, platform: 'win32' });
      assert.deepEqual(unregistered, ['Control+Shift+Alt+S', 'Control+Shift+Alt+D'], 're-register drops the previous set');
      assert.deepEqual(win.registered, ['Control+Alt+F9', 'Control+Alt+F10', 'Control+Alt+F11']);

      const off = registerShortcuts({ enabled: false, onAction: () => {}, platform: 'win32' });
      assert.deepEqual(off, { registered: [], failed: [] });
      assert.equal(registered.size, 0, 'disabled → nothing stays registered');
      assert.doesNotThrow(() => unregisterShortcuts());
    } finally {
      console.warn = warn;
    }
  });
});
