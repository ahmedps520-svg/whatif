/**
 * Model-specific discoveries and challenges. Each discovery checks the
 * recorded results of the user's own run; each challenge re-runs the model
 * headless with the submitted settings, so outcomes are reproducible.
 */
import type { RunRecord } from '../engine/types';
import { extraDiscoveries } from '../store/achievements';
import { registerChallenges, type Challenge } from './challenges';

const has = (run: RunRecord, id: string) => run.events.some((e) => e.id === id);
const at = (run: RunRecord, id: string) => run.events.find((e) => e.id === id)?.t;
const minOf = (a: number[] | undefined) => (a ?? []).reduce((m, v) => (Number.isFinite(v) && v < m ? v : m), Infinity);

extraDiscoveries([
  {
    id: 'sqrt-g-fall',
    title: 'Falls scale with the square root of gravity',
    insight: 'Doubling gravity does not halve the fall time — it divides it by √2, because distance grows with g·t².',
    modelId: 'gravity-compare',
    hint: 'Gravity comparison → any factor other than 1, without drag.',
    check: (run) => {
      const k = Number(run.params.factor);
      const tb = at(run, 'base-drop-land');
      const te = at(run, 'exp-drop-land');
      if (!tb || !te || k <= 0 || Math.abs(k - 1) < 0.05) return false;
      return Math.abs(te / tb - 1 / Math.sqrt(k)) < 0.01 * (1 / Math.sqrt(k));
    },
  },
  {
    id: 'escape-orbit',
    title: 'There is a speed beyond which orbits open up',
    insight: 'A planet moving fast enough for its distance — √2 times the circular speed — is no longer bound and leaves on an open path.',
    modelId: 'orbit-explorer',
    hint: 'Orbit Explorer → raise the starting speed, or suddenly reduce the star’s mass.',
    check: (run) => has(run, 'planet-escape') || (Number.isFinite(run.final.ecc) && run.final.ecc > 1.01),
  },
  {
    id: 'barycentre-drift',
    title: 'Earth and the Moon orbit a shared centre',
    insight: 'Earth circles the Earth–Moon centre of mass about 4,700 km from its own centre. When the Moon vanishes, Earth keeps that ~12 m/s and drifts away.',
    modelId: 'moons',
    hint: '“What if the Moon disappeared?” — watch Earth’s distance from the starting barycentre.',
    check: (run) => {
      const d = run.samples.obs.earthDrift ?? [];
      return has(run, 'moon1-vanished') && d.length > 2 && d[d.length - 1] > 3 * d[0];
    },
  },
  {
    id: 'overshoot',
    title: 'Populations can overshoot their resources',
    insight: 'Growth can carry demand past what the resource regenerates; the decline comes later, after the stock has been drawn down.',
    modelId: 'population',
    hint: 'Population Simulator with default settings — look for the overshoot and the peak.',
    check: (run) => has(run, 'overshoot') && run.events.some((e) => e.id.startsWith('peak-')),
  },
  {
    id: 'half-not-half',
    title: 'Half the oxygen is not half the share',
    insight: 'Removing half the oxygen outright leaves about 11.7 % O₂, not 10.5 %, because the total pressure falls too — yet the oxygen partial pressure does halve.',
    modelId: 'atmosphere',
    hint: '“What if the atmosphere lost half its oxygen?” in “removed outright” mode.',
    check: (run) => run.params.mode === 'remove' && Number(run.params.o2Amount) === 50 && run.final.o2Fraction > 11 && run.final.o2Fraction < 12.5,
  },
  {
    id: 'cascade',
    title: 'Infrastructure fails in a cascade',
    insight: 'Cell sites and water pumping outlast the grid only as long as batteries, storage and generator fuel do — each runs out on its own clock.',
    modelId: 'blackout',
    hint: '“What if electricity disappeared worldwide?” — read the order of the events.',
    check: (run) => has(run, 'cell-batteries') && has(run, 'water-storage') && (at(run, 'cell-batteries') ?? 0) <= (at(run, 'water-storage') ?? 0),
  },
]);

const extra: Challenge[] = [
  {
    id: 'bound-by-a-thread',
    title: 'Bound by a thread',
    summary: 'The star suddenly loses mass. Find the smallest mass factor that still keeps the planet bound for ten years.',
    rules: [
      'Orbit Explorer, star 1 M☉, planet on a circular orbit at 1 AU, no second planet, 10-year run.',
      'You may change only the sudden star-mass change factor.',
      'Pass: the planet stays bound (final osculating eccentricity below 0.999), and a factor 0.02 smaller lets it escape.',
    ],
    experimentId: 'orbit-explorer',
    modelId: 'orbit-explorer',
    fixed: { starMass: 1, planetDistance: 1, speedFactor: 1, secondPlanet: false, duration: 3652.5 },
    adjustable: ['massChange'],
    start: { massChange: 0.8 },
    async verify(run, rerun, params) {
      const m = Number(params.massChange);
      const e = run.final.ecc;
      if (!(e < 0.999)) return { pass: false, message: `With a factor of ${m} the planet ends on an open path (e = ${e.toFixed(3)}).`, details: [] };
      const lower = await rerun({ ...params, massChange: Math.max(0.1, m - 0.02) });
      if (lower.final.ecc < 0.999) return { pass: false, message: `Still bound at ${(m - 0.02).toFixed(2)} too (e = ${lower.final.ecc.toFixed(3)}). Push closer to the limit.`, details: [`Your run: e = ${e.toFixed(3)}.`] };
      return { pass: true, message: `Solved: at ${m} the planet stays bound (e = ${e.toFixed(3)}); at ${(m - 0.02).toFixed(2)} it escapes (e = ${lower.final.ecc.toFixed(3)}).`, details: ['Vis-viva predicts the limit exactly at one half: the planet then has exactly the escape speed.'] };
    },
  },
  {
    id: 'grounded',
    title: 'Grounded',
    summary: 'Find the gravity factor at which the jumper can no longer leave the ground, to within 0.02.',
    rules: [
      'Gravity comparison with the default jumper (0.5 m jump on Earth, 0.4 m push-off).',
      'You may change only the gravity factor k.',
      'Pass: at your k the jumper cannot take off, and at k − 0.02 they still can.',
    ],
    experimentId: 'gravity-doubled',
    modelId: 'gravity-compare',
    fixed: { jumpHeight0: 0.5, pushDistance: 0.4, g0: 9.81 },
    adjustable: ['factor'],
    start: { factor: 2 },
    async verify(run, rerun, params) {
      const k = Number(params.factor);
      if (!has(run, 'exp-cannot-jump')) return { pass: false, message: `At k = ${k} the jumper still leaves the ground.`, details: [] };
      const lower = await rerun({ ...params, factor: Math.max(0, k - 0.02) });
      if (has(lower, 'exp-cannot-jump')) return { pass: false, message: `The jumper is grounded at ${(k - 0.02).toFixed(3)} too — find the threshold more precisely.`, details: [] };
      return { pass: true, message: `Solved: grounded at k = ${k}, but able to jump at k = ${(k - 0.02).toFixed(3)}.`, details: ['In the constant-force model the threshold is k = 1 + h₀/d.'] };
    },
  },
  {
    id: 'sustainable-growth',
    title: 'Grow without overshoot',
    summary: 'Find the highest birth rate that keeps needs fully met for 150 years.',
    rules: [
      'Population Simulator with all other settings at their defaults, 150-year run.',
      'You may change only the crude birth rate (steps of 0.5‰).',
      'Pass: needs met never drops below 99.5 % during the run, and a birth rate 0.5‰ higher does drop below it.',
    ],
    experimentId: 'population-resources',
    modelId: 'population',
    fixed: { duration: 150 },
    adjustable: ['birthRate'],
    start: { birthRate: 17 },
    async verify(run, rerun, params) {
      const b = Number(params.birthRate);
      const low = minOf(run.samples.obs.needsMet);
      if (low < 99.5) return { pass: false, message: `At ${b}‰ needs met falls to ${low.toFixed(1)} %.`, details: [] };
      const higher = await rerun({ ...params, birthRate: b + 0.5 });
      const low2 = minOf(higher.samples.obs.needsMet);
      if (low2 >= 99.5) return { pass: false, message: `${b + 0.5}‰ also keeps needs met (minimum ${low2.toFixed(1)} %). You can go higher.`, details: [] };
      return { pass: true, message: `Solved: ${b}‰ keeps needs met (minimum ${low.toFixed(1)} %), while ${b + 0.5}‰ drops to ${low2.toFixed(1)} %.`, details: ['This is a property of the model’s hypothetical capacities, not a statement about the real world.'] };
    },
  },
];

registerChallenges(extra);
