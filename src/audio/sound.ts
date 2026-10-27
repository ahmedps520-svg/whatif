import { getPrefs } from '../store/prefs';

/**
 * Subtle synthesized interface sounds (no audio files). Sounds are off by
 * default, follow the mute/volume preference, and never carry information
 * that is not also shown on screen.
 */
export type Cue = 'start' | 'pause' | 'step' | 'milestone' | 'event' | 'warning' | 'complete' | 'unlock';

let ctx: AudioContext | null = null;
let lastAt = 0;

function audio(): AudioContext | null {
  if (typeof window === 'undefined' || !('AudioContext' in window)) return null;
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

const CUES: Record<Cue, { f: number[]; dur: number; type: OscillatorType; gain: number }> = {
  start: { f: [440, 660], dur: 0.09, type: 'sine', gain: 0.18 },
  pause: { f: [520, 390], dur: 0.08, type: 'sine', gain: 0.14 },
  step: { f: [700], dur: 0.04, type: 'triangle', gain: 0.08 },
  milestone: { f: [660, 880], dur: 0.11, type: 'sine', gain: 0.14 },
  event: { f: [600], dur: 0.06, type: 'sine', gain: 0.08 },
  warning: { f: [330, 300], dur: 0.14, type: 'triangle', gain: 0.14 },
  complete: { f: [523, 659, 784], dur: 0.12, type: 'sine', gain: 0.16 },
  unlock: { f: [784, 988, 1175], dur: 0.1, type: 'sine', gain: 0.14 },
};

export function play(cue: Cue) {
  const prefs = getPrefs();
  if (!prefs.sound || prefs.volume <= 0) return;
  const now = performance.now();
  if (now - lastAt < 60) return; // never machine-gun cues
  lastAt = now;
  const ac = audio();
  if (!ac) return;
  const spec = CUES[cue];
  let t = ac.currentTime;
  for (const f of spec.f) {
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = spec.type;
    osc.frequency.value = f;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(spec.gain * prefs.volume, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
    osc.connect(g).connect(ac.destination);
    osc.start(t);
    osc.stop(t + spec.dur + 0.02);
    t += spec.dur * 0.8;
  }
}
