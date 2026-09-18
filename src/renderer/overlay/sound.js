// Soft chimes synthesised with the Web Audio API (no audio files).
// Every failure (no AudioContext, autoplay policy, closed context …) is swallowed silently.

let ctx = null;

function getContext() {
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC({ latencyHint: 'playback' });
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  } catch {
    ctx = null;
    return null;
  }
}

/** Master chain: gain → gentle lowpass → destination, plus a short airy echo. */
function createBus(ac, volume) {
  const master = ac.createGain();
  master.gain.value = Math.max(0, Math.min(1, Number(volume) || 0)) ** 1.5 * 0.32;

  const tone = ac.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 5200;
  tone.Q.value = 0.4;

  const echo = ac.createDelay(1);
  echo.delayTime.value = 0.19;
  const feedback = ac.createGain();
  feedback.gain.value = 0.22;
  const wet = ac.createGain();
  wet.gain.value = 0.28;

  master.connect(tone);
  tone.connect(ac.destination);
  tone.connect(echo);
  echo.connect(feedback);
  feedback.connect(echo);
  echo.connect(wet);
  wet.connect(ac.destination);
  return master;
}

/** One bell-like note: sine fundamental + faint octave & fifth partials, soft attack, long exponential release. */
function note(ac, bus, freq, at, { peak = 0.8, release = 1.8, attack = 0.03 } = {}) {
  const partials = [
    { ratio: 1, gain: 1, release },
    { ratio: 2, gain: 0.16, release: release * 0.45 },
    { ratio: 3, gain: 0.05, release: release * 0.3 },
  ];
  for (const p of partials) {
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * p.ratio, at);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * p.gain), at + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, at + p.release);
    osc.connect(g);
    g.connect(bus);
    osc.start(at);
    osc.stop(at + p.release + 0.05);
  }
}

function play(notes, volume, opts) {
  try {
    if (!(volume > 0)) return;
    const ac = getContext();
    if (!ac) return;
    const bus = createBus(ac, volume);
    const t0 = ac.currentTime + 0.06;
    notes.forEach(([freq, offset]) => note(ac, bus, freq, t0 + offset, opts));
  } catch {
    /* audio is optional */
  }
}

/** Break start: calm two-note chime E5 → A5. */
export function playStartChime(volume) {
  play([[659.25, 0], [880.0, 0.3]], volume, { peak: 0.7, release: 2.4, attack: 0.07 });
}

/** Break completed: bright ascending three-note chime (A5 → C#6 → E6), short enough to finish before the overlay closes. */
export function playEndChime(volume) {
  play([[880.0, 0], [1108.73, 0.12], [1318.51, 0.24]], volume, { peak: 0.55, release: 1.05, attack: 0.025 });
}

/** Warm up the context early (primary overlay only) so the end chime starts without delay. */
export function primeAudio() {
  getContext();
}
