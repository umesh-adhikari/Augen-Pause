'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STRINGS,
  createMainI18n,
  resolveLanguage,
  formatDurationMs,
  formatDurationLong,
  formatClock,
  formatTimeOfDay,
  translate,
} = require('../src/main/i18n');

const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('de and en have exactly the same keys', () => {
  const de = Object.keys(STRINGS.de).sort();
  const en = Object.keys(STRINGS.en).sort();
  assert.deepEqual(de.filter((k) => !en.includes(k)), [], 'keys missing in en');
  assert.deepEqual(en.filter((k) => !de.includes(k)), [], 'keys missing in de');
  assert.deepEqual(de, en);
});

test('every string is non-empty and uses the same placeholders in both languages', () => {
  for (const key of Object.keys(STRINGS.de)) {
    assert.equal(typeof STRINGS.de[key], 'string');
    assert.equal(typeof STRINGS.en[key], 'string');
    assert.ok(STRINGS.de[key].trim().length > 0, `de ${key} empty`);
    assert.ok(STRINGS.en[key].trim().length > 0, `en ${key} empty`);
    assert.deepEqual(placeholders(STRINGS.de[key]), placeholders(STRINGS.en[key]), `placeholders of ${key}`);
  }
});

test('language resolution', () => {
  assert.equal(resolveLanguage('de', 'en-US'), 'de');
  assert.equal(resolveLanguage('en', 'de-DE'), 'en');
  assert.equal(resolveLanguage('system', 'de-AT'), 'de');
  assert.equal(resolveLanguage('system', 'DE'), 'de');
  assert.equal(resolveLanguage('system', 'en-GB'), 'en');
  assert.equal(resolveLanguage('system', 'fr-FR'), 'en');
  assert.equal(resolveLanguage('system', ''), 'en');
  assert.equal(resolveLanguage(undefined, undefined), 'en');
  assert.equal(resolveLanguage('xx', 'de'), 'de');
});

test('createMainI18n follows the live language setting', () => {
  let setting = 'system';
  let locale = 'de-DE';
  const i18n = createMainI18n(() => setting, () => locale);
  assert.equal(i18n.lang(), 'de');
  assert.equal(i18n.t('menu.quit'), 'Beenden');
  locale = 'en-US';
  assert.equal(i18n.lang(), 'en');
  assert.equal(i18n.t('menu.quit'), 'Quit');
  setting = 'de';
  assert.equal(i18n.t('menu.quit'), 'Beenden');

  const broken = createMainI18n(() => { throw new Error('boom'); }, () => { throw new Error('boom'); });
  assert.equal(broken.lang(), 'en');

  // t works unbound (main.js may pass i18n.t around)
  const { t } = createMainI18n(() => 'de', () => '');
  assert.equal(t('menu.resume'), 'Fortsetzen');
});

test('placeholder replacement', () => {
  const { t } = createMainI18n(() => 'de', () => '');
  assert.equal(t('menu.drink', { glasses: 3, goal: 8 }), 'Wasser getrunken (3/8)');
  assert.equal(t('status.nextBreak', { time: '12 Min', type: 'kurz' }), 'Nächste Pause in 12 Min (kurz)');
  assert.equal(t('notify.hydration.body', { glasses: 0, goal: 8 }), 'Heute: 0 von 8 Gläsern');
  // missing vars stay visible instead of printing "undefined"
  assert.equal(t('menu.drink', { glasses: 3 }), 'Wasser getrunken (3/{goal})');
  assert.equal(t('menu.drink'), 'Wasser getrunken ({glasses}/{goal})');
  // unknown keys fall back to the key itself
  assert.equal(t('does.not.exist'), 'does.not.exist');
  assert.equal(translate('fr', 'menu.quit'), 'Quit');
  const en = createMainI18n(() => 'en', () => '');
  assert.equal(en.t('tray.tooltip', { status: 'Next break in 12 min' }), 'AugenPause – Next break in 12 min');
});

test('meeting safety and notification strings', () => {
  const de = createMainI18n(() => 'de', () => '').t;
  const en = createMainI18n(() => 'en', () => '').t;
  assert.equal(de('status.warning', { time: '0:42' }), 'Pause in 0:42');
  assert.equal(de('status.meetingDeferred'), 'Meeting erkannt – Pause wird danach nachgeholt');
  assert.equal(de('menu.meetingMode'), 'Meeting-Modus / Pausieren');
  assert.equal(de('menu.meetingAutoDetect'), 'Meetings automatisch erkennen');
  assert.equal(de('notify.warning.title', { time: formatDurationLong(de, 60000, 90) }), 'Augenpause in 60 Sekunden');
  assert.equal(de('notify.warning.body', { minutes: 5 }), 'Klicken zum Verschieben um 5 Min');
  assert.equal(de('notify.warning.snooze', { minutes: 5 }), '+5 Min');
  assert.equal(de('notify.meeting.title'), 'Meeting erkannt');
  assert.equal(de('notify.meeting.body'), 'Deine Augenpause wird nach dem Meeting nachgeholt.');
  assert.equal(de('notify.meetingExpired.title'), 'Pause wird jetzt nachgeholt');
  assert.equal(de('notify.meetingExpired.body'), 'Das Meeting dauert schon über 2 Stunden – Zeit für deine Augen.');
  assert.equal(en('notify.meetingExpired.body'), 'The meeting has been running for over 2 hours – time for your eyes.');
  assert.equal(de('notify.breakStart.body', { duration: formatDurationLong(de, 120000) }),
    'Schau 2 Minuten in die Ferne – blinzle bewusst.');
  assert.equal(en('notify.warning.title', { time: formatDurationLong(en, 59400, 90) }), 'Eye break in 59 seconds');
  assert.equal(en('notify.warning.body', { minutes: 10 }), 'Click to snooze for 10 min');

  // no emojis anywhere in main-process strings (clean native menus / notifications)
  for (const lang of ['de', 'en']) {
    for (const [key, text] of Object.entries(STRINGS[lang])) {
      assert.ok(!/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(text), `emoji in ${lang} ${key}`);
    }
  }
});

test('formatDurationMs', () => {
  assert.equal(formatDurationMs(120000, 'de'), '2 Min');
  assert.equal(formatDurationMs(5400000, 'de'), '1 Std 30 Min');
  assert.equal(formatDurationMs(3600000, 'de'), '1 Std');
  assert.equal(formatDurationMs(45000, 'de'), '45 s');
  assert.equal(formatDurationMs(120000, 'en'), '2 min');
  assert.equal(formatDurationMs(5400000, 'en'), '1 h 30 min');
  assert.equal(formatDurationMs(0, 'en'), '0 s');
  assert.equal(formatDurationMs(-5, 'de'), '0 s');
  assert.equal(formatDurationMs(NaN, 'de'), '0 s');
  // modes
  assert.equal(formatDurationMs(11 * 60000 + 1, 'de', 'countdown'), '12 Min');
  assert.equal(formatDurationMs(59001, 'de', 'countdown'), '1 Min');
  assert.equal(formatDurationMs(58001, 'de', 'countdown'), '59 s');
  assert.equal(formatDurationMs(30000, 'de', 'countdown-minutes'), '< 1 Min');
  assert.equal(formatDurationMs(90000, 'de', 'exact'), '1 Min 30 s');
  assert.equal(formatDurationMs(20000, 'en', 'exact'), '20 s');
  assert.equal(formatDurationMs(3900000, 'en', 'exact'), '1 h 5 min');
});

test('long durations, clock and time of day', () => {
  const de = createMainI18n(() => 'de', () => '').t;
  const en = createMainI18n(() => 'en', () => '').t;
  assert.equal(formatDurationLong(de, 120000), '2 Minuten');
  assert.equal(formatDurationLong(de, 60000), '1 Minute');
  assert.equal(formatDurationLong(de, 20000), '20 Sekunden');
  assert.equal(formatDurationLong(de, 90000), '90 Sekunden');
  assert.equal(formatDurationLong(de, 3600000), '1 Stunde');
  assert.equal(formatDurationLong(en, 600000), '10 minutes');
  assert.equal(formatClock(83000), '1:23');
  assert.equal(formatClock(82001), '1:23');
  assert.equal(formatClock(3723000), '1:02:03');
  assert.equal(formatClock(0), '0:00');
  assert.equal(formatTimeOfDay(new Date(2026, 0, 1, 7, 5).getTime()), '07:05');
});

test('§12: update strings in both languages', () => {
  const de = createMainI18n(() => 'de', () => '').t;
  const en = createMainI18n(() => 'en', () => '').t;
  assert.equal(de('menu.checkUpdates'), 'Nach Updates suchen');
  assert.equal(en('menu.checkUpdates'), 'Check for updates');
  assert.equal(de('menu.updateAvailable', { version: '1.2.0' }), 'Update verfügbar: 1.2.0');
  assert.equal(en('menu.updateAvailable', { version: '1.2.0' }), 'Update available: 1.2.0');
  assert.equal(de('notify.update.title'), 'Neue Version verfügbar');
  assert.equal(de('notify.update.body', { version: '1.2.0' }), 'AugenPause 1.2.0 steht bereit.');
  assert.equal(en('notify.update.title'), 'New version available');
  assert.equal(en('notify.update.body', { version: '1.2.0' }), 'AugenPause 1.2.0 is ready.');
  for (const key of ['menu.updateAvailable', 'notify.update.body']) {
    assert.deepEqual(placeholders(STRINGS.de[key]), ['version'], key);
    assert.deepEqual(placeholders(STRINGS.en[key]), ['version'], key);
  }
  // no URLs, e-mail addresses or repository paths in user-facing strings
  for (const lang of ['de', 'en']) {
    for (const [key, text] of Object.entries(STRINGS[lang])) {
      assert.ok(!/https?:\/\/|@|github/i.test(text), `${lang} ${key} must not carry a link`);
    }
  }
});

test('mandatory break wording (§11) in both languages', () => {
  const de = createMainI18n(() => 'de', () => '').t;
  const en = createMainI18n(() => 'en', () => '').t;
  // "Strenger Modus" became "Pflicht-Pause"
  assert.equal(de('menu.strictMode'), 'Pflicht-Pause');
  assert.equal(en('menu.strictMode'), 'Mandatory break');
  for (const lang of ['de', 'en']) {
    assert.ok(!/streng/i.test(STRINGS[lang]['menu.strictMode']), `${lang} still says "streng"`);
    assert.ok(!/strict/i.test(STRINGS[lang]['menu.strictMode']), `${lang} still says "strict"`);
  }
  // status line of a running mandatory break
  assert.equal(de('status.strictBreakRunning', { time: '1:23' }), 'Pflicht-Pause – noch 1:23');
  assert.equal(en('status.strictBreakRunning', { time: '1:23' }), 'Mandatory break – 1:23 left');
  assert.deepEqual(placeholders(STRINGS.de['status.strictBreakRunning']), ['time']);
  // the non-strict status lines are still there (§9/§10 behaviour is unchanged)
  assert.equal(de('status.breakRunning', { type: 'Kurze Pause', time: '1:23' }), 'Kurze Pause läuft – noch 1:23');
  assert.equal(de('status.breakRunningCompact', { time: '2 Min' }), 'Pause läuft – noch 2 Min');
});
