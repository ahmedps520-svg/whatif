import type { ParamValues, RunRecord } from '../engine/types';

export interface ChallengeResult {
  pass: boolean;
  message: string;
  details: string[];
}

/**
 * An educational challenge: fixed rules (locked parameters), a set of
 * parameters the user may adjust, and a verification that re-runs the model
 * headless with exactly those settings. Outcomes are deterministic and
 * reproducible; there are no rankings.
 */
export interface Challenge {
  id: string;
  title: string;
  summary: string;
  rules: string[];
  experimentId: string;
  modelId: string;
  fixed: ParamValues;
  adjustable: string[];
  /** Starting values for adjustable params. */
  start: ParamValues;
  verify: (run: RunRecord, rerun: (p: ParamValues) => Promise<RunRecord>, params: ParamValues) => Promise<ChallengeResult>;
}

function firstLanding(run: RunRecord, body = 'body-0'): { t: number; x: number } | null {
  const e = run.events.find((ev) => ev.id === `${body}-land`);
  const tr = run.tracks[body];
  if (!e || !tr) return null;
  let i = tr.t.findIndex((t) => t >= e.t - 1e-9);
  if (i < 0) i = tr.t.length - 1;
  return { t: e.t, x: tr.x[i] };
}

const maxOf = (arr: number[] | undefined) => (arr ?? []).reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), -Infinity);

export const CHALLENGES: Challenge[] = [
  {
    id: 'min-speed-20m',
    title: 'Reach 20 metres with the least effort',
    summary: 'Find the minimum launch speed that lifts object A to at least 20 m when launched at 60° in a vacuum.',
    rules: [
      'Gravity 9.81 m/s², no air, launch angle fixed at 60°, launched from the ground.',
      'You may change only the launch speed.',
      'Pass: A reaches at least 20 m (within 1 cm), and a launch 0.5 m/s slower does not.',
    ],
    experimentId: 'gravity-lab',
    modelId: 'projectile',
    fixed: { setup: 'projectile', gravity: 9.81, airDensity: 0, launchAngle: 60, launchHeight: 0, gravityPause: false, restitution: 0, duration: 10, dt: 0.001 },
    adjustable: ['launchSpeed'],
    start: { launchSpeed: 15 },
    async verify(run, rerun, params) {
      const peak = maxOf(run.samples.obs.h_A);
      const v = Number(params.launchSpeed);
      if (peak < 19.99) return { pass: false, message: `Object A peaked at ${peak.toFixed(2)} m — not high enough yet.`, details: [`Launch speed ${v} m/s.`] };
      const slower = await rerun({ ...params, launchSpeed: Math.max(0, v - 0.5) });
      const peak2 = maxOf(slower.samples.obs.h_A);
      if (peak2 >= 19.99) return { pass: false, message: `It works — but ${(v - 0.5).toFixed(1)} m/s also reaches ${peak2.toFixed(2)} m. Try a lower speed.`, details: [`Your peak: ${peak.toFixed(2)} m.`] };
      return { pass: true, message: `Solved: ${v} m/s reaches ${peak.toFixed(2)} m, while ${(v - 0.5).toFixed(1)} m/s peaks at ${peak2.toFixed(2)} m.`, details: ['Both runs were simulated with identical settings except the launch speed.'] };
    },
  },
  {
    id: 'stop-at-10m',
    title: 'Stop on the line',
    summary: 'Choose the ground friction so a block pushed at 10 m/s comes to rest between 9.5 and 10.5 m.',
    rules: ['Sliding blocks setup, no air, gravity 9.81 m/s², push speed fixed at 10 m/s.', 'You may change only the friction coefficient.', 'Pass: object A comes to rest with its centre between 9.5 m and 10.5 m.'],
    experimentId: 'friction-disappears',
    modelId: 'projectile',
    fixed: { setup: 'sliding', gravity: 9.81, airDensity: 0, launchSpeed: 10, duration: 30 },
    adjustable: ['friction'],
    start: { friction: 0.2 },
    async verify(run) {
      const rest = run.events.find((e) => e.id.startsWith('body-0-rest'));
      const x = run.tracks['body-0']?.x.at(-1);
      if (!rest || x === undefined) return { pass: false, message: 'Object A never came to rest within the run.', details: [] };
      const ok = x >= 9.5 && x <= 10.5;
      return { pass: ok, message: ok ? `Solved: A stopped at ${x.toFixed(2)} m after ${rest.t.toFixed(2)} s.` : `A stopped at ${x.toFixed(2)} m — ${x < 9.5 ? 'too short' : 'too far'}.`, details: [] };
    },
  },
  {
    id: 'hang-time',
    title: 'Five seconds of hang time',
    summary: 'Adjust gravity so a ball thrown straight up at 15 m/s lands between 5.0 and 5.2 seconds later.',
    rules: ['No air, launch angle 90°, launch speed fixed at 15 m/s.', 'You may change only the gravitational acceleration.', 'Pass: the first impact of A happens between 5.0 s and 5.2 s.'],
    experimentId: 'gravity-lab',
    modelId: 'projectile',
    fixed: { setup: 'projectile', airDensity: 0, launchSpeed: 15, launchAngle: 90, launchHeight: 0, gravityPause: false, restitution: 0, duration: 30, dt: 0.001 },
    adjustable: ['gravity'],
    start: { gravity: 9.81 },
    async verify(run) {
      const land = firstLanding(run);
      if (!land) return { pass: false, message: 'Object A did not land within the run.', details: [] };
      const ok = land.t >= 5 && land.t <= 5.2;
      return { pass: ok, message: ok ? `Solved: A landed after ${land.t.toFixed(3)} s.` : `A landed after ${land.t.toFixed(3)} s — ${land.t < 5 ? 'gravity is too strong' : 'gravity is too weak'}.`, details: [] };
    },
  },
];

export function registerChallenges(list: Challenge[]) {
  for (const c of list) if (!CHALLENGES.some((x) => x.id === c.id)) CHALLENGES.push(c);
}

/** ISO-8601 week number, used to rotate the weekly challenge deterministically. */
export function isoWeek(d = new Date()): { year: number; week: number } {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return { year: t.getUTCFullYear(), week: Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7) };
}

export function weeklyChallenge(d = new Date()): Challenge {
  const { year, week } = isoWeek(d);
  return CHALLENGES[(year * 53 + week) % CHALLENGES.length];
}

export function getChallenge(id: string) {
  return CHALLENGES.find((c) => c.id === id);
}
