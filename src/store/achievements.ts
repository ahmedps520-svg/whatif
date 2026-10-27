import type { Activity } from './activity';
import { getActivity, markUnlocked } from './activity';
import { getExperiments } from './history';
import type { RunRecord } from '../engine/types';
import { observable, useObservable } from './observable';

export interface Achievement {
  id: string;
  title: string;
  description: string;
  /** Progress as [current, target]. */
  progress: (a: Activity, saved: number) => [number, number];
}

const sum = (r: Record<string, number>, keys?: string[]) =>
  Object.entries(r).reduce((s, [k, v]) => (keys && !keys.includes(k) ? s : s + v), 0);

export const ACHIEVEMENTS: Achievement[] = [
  { id: 'first-experiment', title: 'First Experiment', description: 'Run any experiment to completion.', progress: (a) => [Math.min(1, sum(a.modelRuns)), 1] },
  { id: 'physics-investigator', title: 'Physics Investigator', description: 'Complete 5 physics experiments.', progress: (a) => [Math.min(5, a.categoryRuns.physics ?? 0), 5] },
  {
    id: 'orbital-explorer',
    title: 'Orbital Explorer',
    description: 'Complete runs with 3 different space models.',
    progress: (a) => [Math.min(3, ['orbit-explorer', 'moons', 'asteroid', 'planet'].filter((m) => (a.modelRuns[m] ?? 0) > 0).length), 3],
  },
  {
    id: 'climate-researcher',
    title: 'Climate Researcher',
    description: 'Complete 3 Earth-systems experiments.',
    progress: (a) => [Math.min(3, a.categoryRuns.earth ?? 0), 3],
  },
  {
    id: 'civilization-analyst',
    title: 'Systems Thinker',
    description: 'Complete a civilization or technology scenario.',
    progress: (a) => [Math.min(1, (a.categoryRuns.civilization ?? 0) + (a.categoryRuns.technology ?? 0)), 1],
  },
  { id: 'scenario-builder', title: 'Scenario Builder', description: 'Create a scenario in the Scenario Builder.', progress: (a) => [Math.min(1, a.builderScenarios), 1] },
  { id: 'master-of-comparisons', title: 'Master of Comparisons', description: 'Compare runs 5 times.', progress: (a) => [Math.min(5, a.comparisons), 5] },
  { id: 'archivist', title: 'Lab Archivist', description: 'Save 5 experiments to your history.', progress: (_a, saved) => [Math.min(5, saved), 5] },
  { id: 'challenger', title: 'Challenge Solver', description: 'Pass a weekly challenge.', progress: (a) => [Math.min(1, Object.values(a.challenges).filter((c) => c.passedAt).length), 1] },
  { id: 'polymath', title: 'Polymath', description: 'Complete experiments in 4 different categories.', progress: (a) => [Math.min(4, Object.keys(a.categoryRuns).length), 4] },
];

/**
 * Discoveries are unlocked by what the user's own runs actually showed —
 * each check reads the recorded results, never just the fact that a run happened.
 */
export interface Discovery {
  id: string;
  title: string;
  insight: string;
  modelId: string;
  hint: string;
  check: (run: RunRecord) => boolean;
}

const landTime = (run: RunRecord, body: string) => run.events.find((e) => e.id === `${body}-land`)?.t;

export const DISCOVERIES: Discovery[] = [
  {
    id: 'equal-fall',
    title: 'Mass does not matter in a vacuum',
    insight: 'Two objects of different mass, dropped together without air, hit the ground at the same moment.',
    modelId: 'projectile',
    hint: 'Physics Lab → “Two masses dropped” with air density 0.',
    check: (run) => {
      if (run.params.setup !== 'compare-mass' || Number(run.params.airDensity) !== 0) return false;
      const a = landTime(run, 'body-0');
      const b = landTime(run, 'body-1');
      return a !== undefined && b !== undefined && Math.abs(a - b) < 0.005;
    },
  },
  {
    id: 'drag-favors-heavy',
    title: 'Air resistance favours heavy objects',
    insight: 'With air, the heavier of two same-sized objects lands first: drag decelerates it less because it has more inertia.',
    modelId: 'projectile',
    hint: 'Physics Lab → “Two masses dropped” with air.',
    check: (run) => {
      if (run.params.setup !== 'compare-mass' || Number(run.params.airDensity) <= 0) return false;
      const a = landTime(run, 'body-0');
      const b = landTime(run, 'body-1');
      return a !== undefined && b !== undefined && b < a - 0.001;
    },
  },
  {
    id: 'independent-motion',
    title: 'Horizontal and vertical motion are independent',
    insight: 'A ball launched horizontally lands at the same time as one dropped from the same height (in a vacuum).',
    modelId: 'projectile',
    hint: 'Physics Lab → “Drop vs horizontal launch” in a vacuum.',
    check: (run) => {
      if (run.params.setup !== 'drop-vs-launch' || Number(run.params.airDensity) !== 0) return false;
      const a = landTime(run, 'body-0');
      const b = landTime(run, 'body-1');
      return a !== undefined && b !== undefined && Math.abs(a - b) < 0.005;
    },
  },
  {
    id: 'momentum-conservation',
    title: 'Momentum survives collisions',
    insight: 'In a collision the objects exchange momentum, but the total stays the same while no outside force acts horizontally.',
    modelId: 'projectile',
    hint: 'Physics Lab → “Head-on collision”, watch horizontal momentum.',
    check: (run) => {
      if (run.params.setup !== 'collision' || !run.events.some((e) => e.label.includes('collided'))) return false;
      const px = run.samples.obs.px;
      const i = run.samples.t.findIndex((t) => t >= (run.events.find((e) => e.label.includes('collided'))?.t ?? 0));
      if (i < 1) return false;
      const before = px[i - 1];
      const after = px[Math.min(px.length - 1, i + 1)];
      return Number(run.params.airDensity) === 0 && Math.abs(after - before) <= 1e-6 * Math.max(1, Math.abs(before));
    },
  },
  {
    id: 'frictionless-slide',
    title: 'Without friction, motion continues',
    insight: 'With no friction or air, a sliding object never stops — Newton’s first law in action.',
    modelId: 'projectile',
    hint: 'Physics Lab → “Sliding blocks” with friction 0 and air density 0.',
    check: (run) =>
      run.params.setup === 'sliding' && Number(run.params.friction) === 0 && Number(run.params.airDensity) === 0 && !run.events.some((e) => e.id.includes('-rest')),
  },
];

export interface Unlock {
  kind: 'achievement' | 'discovery';
  id: string;
  title: string;
  description: string;
}

/** Unlock notifications for the toast layer. */
export const unlockFeed = observable<Unlock[]>([]);
export function useUnlockFeed() {
  return useObservable(unlockFeed);
}

export function extraDiscoveries(list: Discovery[]) {
  for (const d of list) if (!DISCOVERIES.some((x) => x.id === d.id)) DISCOVERIES.push(d);
}

/** Evaluate achievements (and discoveries for a finished run); returns newly unlocked items. */
export function evaluateUnlocks(run?: RunRecord): Unlock[] {
  const a = getActivity();
  const saved = getExperiments().length;
  const out: Unlock[] = [];
  for (const ach of ACHIEVEMENTS) {
    const [cur, target] = ach.progress(a, saved);
    if (cur >= target && markUnlocked('unlocked', ach.id)) out.push({ kind: 'achievement', id: ach.id, title: ach.title, description: ach.description });
  }
  if (run) {
    for (const d of DISCOVERIES) {
      if (d.modelId !== run.modelId) continue;
      let ok = false;
      try {
        ok = d.check(run);
      } catch {
        ok = false;
      }
      if (ok && markUnlocked('discoveries', d.id)) out.push({ kind: 'discovery', id: d.id, title: d.title, description: d.insight });
    }
  }
  if (out.length) unlockFeed.set((f) => [...f, ...out]);
  return out;
}
