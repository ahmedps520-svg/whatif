import type { DerivedQuantity, KeyResult, ObservableDef, ParamValues, RunRecord, SimEvent, SimulationModel, Warning } from '../../engine/types';
import { num, str } from '../../engine/validation';
import { formatNumber } from '../../engine/units';
import { ETOPO_SOURCE } from '../../data/elevation';
import { getSeaLevelData, prepareSeaLevelData } from './store';
import { ANTARCTIC_CUTOFF_LAT, REGIONS, inundatedArea, regionInundatedArea, type ConnectivityRule } from './products';
import { crossingLevel } from './flood';

/**
 * Sea-level rise on NOAA ETOPO1 (0.25° point samples): which present-day land
 * lies below a raised sea surface and can be reached by the sea.
 *
 * The heavy work (flood levels by Priority-Flood, cumulative area curves) is
 * done once in prepare(); stepping only moves the sea level along a
 * hypothetical uniform timeline, and every observable is a binary search in a
 * precomputed curve.
 */

export interface SeaLevelState {
  /** Model time (years). */
  t: number;
  /** Sea-level change relative to present mean sea level (m). */
  level: number;
}

/**
 * Published sea-level equivalents of present land ice (m). They already
 * account for ice grounded below sea level, which displaces sea water today.
 */
export const ICE_SLE = {
  /** Antarctic ice sheet, Bedmap2 (Fretwell et al. 2013). */
  antarctica: 58,
  /** Greenland ice sheet, BedMachine v3 (Morlighem et al. 2017). */
  greenland: 7.42,
  /** Glaciers outside the ice sheets (Farinotti et al. 2019). */
  glaciers: 0.32,
};
/** Sum of the three, rounded to 0.1 m. */
export const ALL_LAND_ICE_SLE = Math.round((ICE_SLE.antarctica + ICE_SLE.greenland + ICE_SLE.glaciers) * 10) / 10;

/** Below this rise the 0.25° point-sampled grid cannot resolve coastlines reliably. */
export const RESOLUTION_LIMIT_M = 10;

const GLOBAL_PCT_EVENTS = [1, 5, 10, 20];
const REGION_PCT_EVENTS = [10, 50];

function rule(p: ParamValues): ConnectivityRule {
  return str(p, 'rule') === 'any' ? 'any' : 'connected';
}

/** Rise rate in metres per year. */
function rateMPerYr(p: ParamValues): number {
  return Math.max(num(p, 'rate'), 1e-6) / 100;
}

/** Years until the target is reached at the configured rate. */
export function timeToTarget(p: ParamValues): number {
  const target = Math.max(0, num(p, 'target'));
  return target / rateMPerYr(p);
}

function runLength(p: ParamValues): number {
  const d = num(p, 'duration');
  if (d > 0) return d;
  const T = timeToTarget(p);
  return T > 0 ? T : 1000;
}

/** L(t) = min(target, rate · t), snapped to the target within rounding error. */
export function levelAt(t: number, p: ParamValues): number {
  const target = Math.max(0, num(p, 'target'));
  const L = rateMPerYr(p) * Math.max(0, t);
  return L >= target * (1 - 1e-9) ? target : L;
}

const fmt = (v: number, sig = 3) => formatNumber(v, sig);

function ruleText(r: ConnectivityRule) {
  return r === 'any' ? 'any land below the level counts' : 'only land the sea can reach counts';
}

const regionObservables: ObservableDef[] = REGIONS.flatMap((r) => [
  {
    key: `km2_${r.id}`,
    label: `${r.short}: inundated land`,
    unit: 'km2' as const,
    provenance: 'derived' as const,
    chartGroup: 'region-area',
    sig: 2,
    description: `Present land inside the approximate rectangle ${r.south}° to ${r.north}° latitude, ${r.west}° to ${r.east}° longitude that lies below the new sea level.`,
  },
  {
    key: `pct_${r.id}`,
    label: `${r.short}: share of land inundated`,
    unit: '%' as const,
    provenance: 'derived' as const,
    chartGroup: 'region-pct',
    readout: false,
    sig: 2,
    description: `Inundated share of the present land inside the ${r.short} rectangle (not a political boundary).`,
  },
]);

export const seaLevelModel: SimulationModel<SeaLevelState> = {
  id: 'sea-level',
  name: 'Sea-Level Rise Mapper',
  shortName: 'Sea level',
  domain: 'earth',
  viewKind: 'map',
  summary:
    'Raise the sea on NOAA’s ETOPO1 global elevation grid. A priority-flood calculation finds, for every place on land, the lowest sea level at which ocean water could actually flow there, so low inland basins stay dry until the sea spills over their rim.',
  params: [
    {
      key: 'target',
      label: 'Sea-level rise',
      type: 'number',
      unit: 'm',
      kind: 'initial',
      group: 'Scenario',
      min: 0,
      max: 200,
      step: 0.1,
      default: 100,
      description:
        'Rise of the global mean sea surface above today’s level. Rises below about 10 m are finer than this 0.25° grid can resolve reliably.',
      marks: [
        { value: 1, label: '1 m' },
        { value: 10, label: '10 m' },
        { value: ALL_LAND_ICE_SLE, label: `All land ice ≈${Math.round(ALL_LAND_ICE_SLE)} m` },
        { value: 100, label: '100 m' },
      ],
    },
    {
      key: 'rate',
      label: 'Rate of rise',
      type: 'number',
      unit: 'm/century',
      kind: 'initial',
      group: 'Timeline',
      min: 0.1,
      max: 20,
      step: 0.1,
      default: 1,
      scale: 'log',
      description:
        'A purely hypothetical, uniform rate used only to lay the rise out on a timeline. It does not change the map at a given sea level, and it is not a prediction of how fast the sea would rise.',
      marks: [
        { value: 0.37, label: 'Observed 2006–2018 (IPCC AR6)' },
        { value: 4.6, label: 'Meltwater Pulse 1A, ~14,600 yr ago' },
      ],
    },
    {
      key: 'rule',
      label: 'Which land floods',
      type: 'choice',
      kind: 'initial',
      group: 'Method',
      default: 'connected',
      description: 'Whether sea water must be able to flow to a place, or any land below the new level counts.',
      options: [
        { value: 'connected', label: 'Connected to the ocean', description: 'A place floods only if a path from the sea to it stays below the new sea level (hydrological connectivity).' },
        { value: 'any', label: 'Any land below the level', description: 'Every land cell lower than the new sea level counts, including inland basins the sea cannot reach. Compare with the connected rule to see why connectivity matters.' },
      ],
    },
    {
      key: 'duration',
      label: 'Run length',
      type: 'number',
      unit: 'yr',
      kind: 'initial',
      group: 'Timeline',
      numerics: true,
      min: 0,
      max: 200000,
      step: 100,
      default: 0,
      description: 'Simulated years to run. 0 runs until the target rise is reached.',
    },
  ],
  observables: [
    { key: 'seaLevel', label: 'Sea-level change', unit: 'm', provenance: 'simulated', chart: true, chartGroup: 'level', sig: 3, description: 'Rise of the sea surface above present mean sea level on the hypothetical timeline.' },
    { key: 'area', label: 'Newly inundated land', unit: 'Mkm2', provenance: 'derived', chart: true, chartGroup: 'area', sig: 3, description: 'Present land outside Antarctica (lakes masked as water) that lies below the new sea level under the chosen rule, summed from ETOPO1 node areas.' },
    { key: 'pctLand', label: 'Share of present land inundated', unit: '%', provenance: 'derived', chart: true, chartGroup: 'pct', sig: 2, description: 'Newly inundated area divided by present land area outside Antarctica.' },
    ...regionObservables,
  ],
  primaryObservables: ['area', 'pctLand'],
  time: {
    unit: 'yr',
    dt: (p) => runLength(p) / 2000,
    sampleInterval: (p) => runLength(p) / 500,
    defaultDuration: (p) => runLength(p),
    maxDuration: 200000,
    realtimeRate: (p) => runLength(p) / 20,
    milestones: (p) => {
      const T = timeToTarget(p);
      return T > 0 ? [0.25, 0.5, 0.75].map((f) => f * T) : [];
    },
  },

  prepare: async () => {
    await prepareSeaLevelData();
  },

  init(p) {
    return { t: 0, level: levelAt(0, p) };
  },

  step(s, p, dt) {
    s.t += dt;
    s.level = levelAt(s.t, p);
  },

  observe(s, p) {
    const out: Record<string, number> = { seaLevel: s.level, area: NaN, pctLand: NaN };
    const d = getSeaLevelData();
    const r = rule(p);
    if (d) {
      const a = inundatedArea(d.products, s.level, r);
      out.area = a / 1e6;
      out.pctLand = (100 * a) / d.products.totals.land;
    }
    for (const reg of REGIONS) {
      const rp = d?.products.regions.find((x) => x.id === reg.id);
      if (rp && rp.landArea > 0) {
        const a = regionInundatedArea(rp, s.level, r);
        out[`km2_${reg.id}`] = a;
        out[`pct_${reg.id}`] = (100 * a) / rp.landArea;
      } else {
        out[`km2_${reg.id}`] = NaN;
        out[`pct_${reg.id}`] = NaN;
      }
    }
    return out;
  },

  clone: (s) => ({ ...s }),
  time_of: (s) => s.t,

  detectEvents(prev, cur, s, p) {
    const events: SimEvent[] = [];
    const r = rule(p);
    const target = num(p, 'target');
    const rate = rateMPerYr(p);
    // The sea reaches level L at t = L / rate; levels at or below today's are reached at t = 0.
    const timeOf = (L: number) => (L > 0 ? Math.min(L / rate, s.t) : 0);
    const crossed = (key: string, v: number) => {
      const c = cur[key];
      if (!Number.isFinite(c) || !(c > v)) return false;
      const b = prev?.[key];
      return !(b !== undefined && Number.isFinite(b) && b > v);
    };
    const verb = r === 'any' ? 'lies below the sea surface' : 'is under water';
    const d = getSeaLevelData();
    if (d) {
      const pr = d.products;
      const curve = r === 'any' ? pr.curves.any : pr.curves.connected;
      for (const v of GLOBAL_PCT_EVENTS) {
        if (!crossed('pctLand', v)) continue;
        const x = crossingLevel(curve, (v / 100) * pr.totals.land);
        const now = x.level < 0;
        events.push({
          t: timeOf(x.level),
          id: `global-${v}`,
          label: now ? `${v} % of present land is already below sea level` : `${v} % of present land ${verb}`,
          detail: now
            ? `Under the “any land below the level” rule, land below 0 m that the sea cannot reach already counts.`
            : `Once the sea rises above +${fmt(x.level)} m, ${fmt(x.area / 1e6)} million km² of land outside Antarctica ${verb} (${ruleText(r)}).`,
          severity: v >= 10 ? 'warning' : 'info',
          source: 'model',
        });
      }
      for (const reg of REGIONS) {
        const rp = pr.regions.find((q) => q.id === reg.id);
        if (!rp || rp.landArea <= 0) continue;
        for (const v of REGION_PCT_EVENTS) {
          if (!crossed(`pct_${reg.id}`, v)) continue;
          const x = crossingLevel(r === 'any' ? rp.any : rp.connected, (v / 100) * rp.landArea);
          const now = x.level < 0;
          events.push({
            t: timeOf(x.level),
            id: `${reg.id}-${v}`,
            label: `${reg.short}: ${v} % of its land ${now ? 'is already below sea level' : verb}`,
            detail: `${now ? 'At present sea level' : `Once the sea rises above +${fmt(x.level)} m`}: ${fmt(x.area, 2)} km² of the ${fmt(rp.landArea, 2)} km² of land inside the approximate rectangle.`,
            severity: v >= 50 ? 'warning' : 'info',
            source: 'model',
          });
        }
      }
    }
    if (target > 0 && cur.seaLevel >= target && !(prev && prev.seaLevel >= target)) {
      events.push({
        t: Math.min(target / rate, s.t),
        id: 'target-reached',
        label: `Sea level reached +${fmt(target)} m`,
        detail: Number.isFinite(cur.area)
          ? `${fmt(cur.area)} million km² of present land is below the new level (${fmt(cur.pctLand, 2)} % of land outside Antarctica; ${ruleText(r)}).`
          : 'The elevation dataset is not loaded, so areas are unavailable.',
        severity: 'milestone',
        source: 'model',
      });
    }
    return events;
  },

  describeMilestone(t, obs) {
    const label = `+${fmt(obs.seaLevel)} m after ${fmt(t)} years`;
    if (!Number.isFinite(obs.area)) return { label, detail: 'Elevation data not loaded.' };
    return { label, detail: `${fmt(obs.area)} million km² of present land newly below sea level (${fmt(obs.pctLand, 2)} % of land outside Antarctica).` };
  },

  derived(p) {
    const out: DerivedQuantity[] = [];
    const T = timeToTarget(p);
    out.push({ key: 'timeToTarget', label: 'Time to reach the target', value: T, unit: 'yr', formula: 't = ΔL / r', provenance: 'derived', sig: 3, note: 'At the hypothetical uniform rate; not a forecast.' });
    const d = getSeaLevelData();
    if (d) {
      const target = num(p, 'target');
      const r = rule(p);
      const a = inundatedArea(d.products, target, r);
      out.push(
        { key: 'areaAtTarget', label: 'Newly inundated land at the target', value: a / 1e6, unit: 'Mkm2', formula: 'A(L) = Σ node areas with F < L', provenance: 'derived', sig: 3, note: ruleText(r) },
        { key: 'pctAtTarget', label: 'Share of present land at the target', value: (100 * a) / d.products.totals.land, unit: '%', provenance: 'derived', sig: 2 },
        { key: 'landArea', label: 'Present land area assessed', value: d.products.totals.land / 1e6, unit: 'Mkm2', provenance: 'data', sig: 3, note: `ETOPO1 nodes above present sea level or cut off from it, north of ${-ANTARCTIC_CUTOFF_LAT}°S, excluding masked lakes.` },
        { key: 'landBelowSea', label: 'Land already below sea level, cut off from it', value: d.products.totals.landBelowSeaLevel, unit: 'km2', provenance: 'data', sig: 2, note: 'E.g. the Caspian lowland, the Qattara Depression and the Dead Sea basin. These flood only once the sea overtops their rim.' },
      );
    }
    return out;
  },

  warnings(p) {
    const w: Warning[] = [];
    const target = num(p, 'target');
    if (target > 0 && target < RESOLUTION_LIMIT_M) {
      w.push({
        id: 'resolution',
        severity: 'warning',
        message: `A rise of ${fmt(target)} m is below what this 0.25° (≈28 km) point-sampled grid can resolve reliably: elevations are whole metres sampled once per cell, coastal defences are absent, and local heights vary far more than ${fmt(target)} m within a cell. Treat the result as a rough indication only, not a flood map.`,
      });
    }
    if (target > ALL_LAND_ICE_SLE) {
      w.push({
        id: 'beyond-ice',
        severity: 'info',
        message: `${fmt(target)} m is more than the ≈${fmt(ALL_LAND_ICE_SLE, 2)} m sea-level equivalent of all present land ice (Antarctica ≈${ICE_SLE.antarctica} m, Greenland ≈${ICE_SLE.greenland} m, glaciers ≈${ICE_SLE.glaciers} m). It is a purely hypothetical level, useful for exploring topography.`,
      });
    }
    if (rule(p) === 'any') {
      w.push({ id: 'any-rule', severity: 'info', message: 'The “any land below the level” rule floods inland basins the sea could not reach (for example the Caspian lowland or the Qattara Depression) and overstates the area. Switch to “connected to the ocean” for the physically consistent answer.' });
    }
    if (!getSeaLevelData()) {
      w.push({ id: 'no-data', severity: 'warning', message: 'The elevation dataset is not loaded yet, so areas are unavailable.' });
    }
    return w;
  },

  summarize(run: RunRecord): KeyResult[] {
    const f = run.final;
    const r = rule(run.params);
    const out: KeyResult[] = [
      { label: 'Final sea-level change', value: f.seaLevel, unit: 'm', provenance: 'simulated', sig: 3 },
      { label: 'Newly inundated land', value: f.area, unit: 'Mkm2', provenance: 'derived', sig: 3, note: `Outside Antarctica; ${ruleText(r)}.` },
      { label: 'Share of present land', value: f.pctLand, unit: '%', provenance: 'derived', sig: 2 },
    ];
    const reached = run.events.find((e) => e.id === 'target-reached');
    if (reached) out.push({ label: 'Target reached after', value: reached.t, unit: 'yr', provenance: 'simulated', sig: 3, note: 'On the hypothetical uniform timeline.' });
    for (const reg of REGIONS) {
      const pct = f[`pct_${reg.id}`];
      if (!Number.isFinite(pct)) continue;
      out.push({ label: `${reg.short} (approximate rectangle)`, value: pct, unit: '%', provenance: 'derived', sig: 2, note: `${fmt(f[`km2_${reg.id}`], 2)} km² of its land below the new level.` });
    }
    out.push({ label: 'Flooding rule', value: r === 'any' ? 'Any land below the level' : 'Connected to the ocean', provenance: 'assumed' });
    return out;
  },

  assumptions: [
    { kind: 'established', text: 'Land and sea-floor heights come from NOAA’s ETOPO1 global relief model, relative to present mean sea level.' },
    { kind: 'simplification', text: '“Bathtub” sea: the sea surface rises by the same amount everywhere and stays flat. Real sea-level change varies regionally (ocean dynamics and the gravitational “fingerprints” of melting ice).' },
    { kind: 'simplification', text: 'Hydrological connectivity: a place floods only if it is joined to the ocean by a chain of neighbouring grid cells (including diagonals) that all lie below the new sea level. Its flood level is the lowest such “spill” level, computed with the Priority-Flood algorithm (Barnes et al. 2014). A cell exactly at its spill level stays dry: the water must rise above it.' },
    { kind: 'approximation', text: 'Each grid node is a point sample of the 1-arc-minute ETOPO1 grid every 0.25° (≈28 km at the equator) and stands for the area of its cell on a sphere of radius 6,371 km. It is not an average of the cell.' },
    { kind: 'simplification', text: 'Present ocean = cells below 0 m connected to the deepest grid node, plus documented seas joined to it only by straits narrower than the grid spacing (the Black Sea with the Seas of Marmara and Azov, Lake Maracaibo, the Salish Sea channels, the Strait of Magellan, the Gulf of Corinth and the Seto Inland Sea).' },
    { kind: 'approximation', text: 'ETOPO1 stores lake-bed depths for the Caspian Sea and the Great Lakes. They are treated as inland water, not land, using documented lat/lon boxes, a seed point in each lake and an elevation threshold just below the water surface: Caspian ≤ −29 m (surface ≈ −28 m) plus the Kara-Bogaz-Gol lagoon (−28 m); Superior ≤ 182 m (≈183 m); Michigan–Huron ≤ 175 m (≈176 m); Erie ≤ 173 m (≈174 m); Ontario ≤ 74 m (≈75 m). In the flood calculation each lake sits at its surface elevation.' },
    { kind: 'simplification', text: 'This is the ice-surface version of ETOPO1: ice sheets are not removed, so even the “all ice melted” scenario floods the present ice-covered landscape, not the bedrock beneath it.' },
    { kind: 'simplification', text: `Land south of ${-ANTARCTIC_CUTOFF_LAT}°S is excluded from all totals: the ice-surface grid records floating ice shelves (such as the Ross and Ronne–Filchner shelves) as land a few metres to about 100 m high, which this grid cannot tell apart from grounded ice.` },
    { kind: 'simplification', text: 'Ignored: the solid Earth’s response to the changing load (isostasy), erosion and sedimentation, coastal defences, tides, storm surges, waves and ocean dynamics.' },
    { kind: 'speculative', text: 'The rate of rise is hypothetical and uniform. It only spreads the rise over a timeline; the model makes no prediction of how fast the sea would actually rise.' },
  ],
  limitations: [
    'At 0.25° point sampling, rises below about 10 m are not resolved reliably; local coastal flooding at that scale needs high-resolution elevation data and defence information.',
    'Narrow valleys, straits and river channels can be missed between grid nodes, so the spill level of some basins is overestimated (or a basin appears cut off when it is not). Small fjords and inlets joined to the sea by such channels still appear as isolated basins below sea level and count as land.',
    'Protected land below sea level next to the coast (for example Dutch polders) and some coastal depressions are classified as present ocean at this resolution, so they never count as newly flooded.',
    'Lakes other than the Caspian Sea and the Great Lakes are stored as their water surface and therefore count as land; where the sea reaches them (for example Lake Ladoga) their area is included in the inundated total.',
    'Inspection regions are rough rectangles around well-known low-lying areas, not national or geological boundaries; their percentages depend on where the rectangle is drawn.',
    'The map shows where the sea would stand, not a flood forecast. Effects on people, ecosystems, agriculture and economies are complex and are not modelled.',
  ],
  equations: [
    { label: 'Present ocean', formula: 'O = { cells with z < 0 connected to the open ocean }', explanation: 'Flood fill (8 neighbours, longitude wraps) from the deepest grid node and from documented narrow-strait seas, never entering masked lakes.' },
    { label: 'Flood (spill) level', formula: 'F(c) = min over paths π from O to c of max_{k ∈ π} z_k   (so F(c) ≥ z(c))', explanation: 'The lowest sea level at which water can flow from the ocean to cell c. Computed for all ~1 million cells at once with a priority queue (Priority-Flood).' },
    { label: 'Inundation rule', formula: 'flooded(c, L) ⟺ F(c) < L   (any-land rule: z(c) < L)', explanation: 'With connectivity a cell floods only once the sea rises above its spill level; the any-land rule uses the cell’s own elevation and ignores barriers.' },
    { label: 'Cell area', formula: 'A = R² Δλ (sin φ_top − sin φ_bottom),  R = 6,371 km', explanation: 'Area on a sphere of the band of latitude a node represents. Cells shrink toward the poles; all nodes together cover 4πR² ≈ 510 million km².' },
    { label: 'Inundated area', formula: 'A(L) = Σ_{land c, F(c) < L} A(c)', explanation: 'Precomputed as a cumulative curve, so any sea level is a binary search.' },
    { label: 'Timeline', formula: 'L(t) = min(ΔL, r · t)', explanation: 'A hypothetical uniform rise at rate r until the target ΔL is reached.' },
  ],
  education: {
    objectives: [
      'Read a global elevation dataset and connect elevation with exposure to sea-level rise.',
      'Explain why connectivity matters: land below the sea surface stays dry if higher ground blocks the water.',
      'Compare how much land different low-lying regions would lose for the same rise.',
      'Recognise what a coarse global grid can and cannot tell us (resolution, ice surfaces, defences).',
    ],
    background: {
      beginner:
        'Imagine filling a bathtub-shaped Earth: as the sea rises, the water spreads over the lowest land along the coasts first. But some land is low and far from the sea, like the shores of the Caspian Sea. Water cannot jump over hills, so those places stay dry until the sea is high enough to pour over the hills around them. This model shows both: where the land is low, and where the sea can actually get to.',
      intermediate:
        'The grid holds an elevation every quarter of a degree. Present ocean is every cell below 0 m joined to the open sea. For each land cell the model finds its “spill level”: the lowest sea level at which there is a route from the sea to the cell that never climbs above the water. A cell floods only when the sea rises above that level. Adding up the areas of flooded cells gives the hypsometric curve: newly flooded area as a function of sea-level rise. The steep parts of the curve are broad lowlands such as the Amazon or West Siberia.',
      advanced:
        'Spill levels are the minimax path costs from the ocean, F(c) = min_π max_{k∈π} z_k, which is exactly the depression-filled surface produced by Priority-Flood (Barnes, Lehman & Mulla 2014): cells are popped from a min-heap in order of their fill level, and neighbours inherit max(own elevation, parent level); cells inside depressions are handled by a FIFO queue. The run is O(n log n) for ~10⁶ cells and is done once in a background worker. The area of each node follows from spherical geometry. Results are limited by point sampling (narrow straits and valleys are missed), the ice-surface heights, and the static “bathtub” assumption, which ignores gravitational fingerprints, glacial isostatic adjustment and ocean dynamics.',
    },
    variables: [
      { symbol: 'ΔL', meaning: 'sea-level rise above present mean sea level', unit: 'm' },
      { symbol: 'z(c)', meaning: 'elevation of grid cell c (ETOPO1)', unit: 'm' },
      { symbol: 'F(c)', meaning: 'flood (spill) level of cell c', unit: 'm' },
      { symbol: 'A(c)', meaning: 'area represented by cell c', unit: 'km²' },
      { symbol: 'A(L)', meaning: 'newly inundated land area at sea level L', unit: 'km²' },
      { symbol: 'r', meaning: 'hypothetical rate of rise', unit: 'm per century' },
    ],
    guidedSteps: [
      'Run the 100 m rise and watch the hypsometric curve: where does the area grow fastest?',
      'Use the before/after swipe to compare today’s coastline with the raised sea.',
      'Hover over the Caspian lowland and read its flood level. Why is it higher than its elevation?',
      'Switch the rule to “any land below the level” and compare the area at the same rise.',
      'Open the regional comparison: which rectangle loses the largest share of its land at 10 m, and which at 100 m?',
      'Set the rise to 1 m and read the resolution warning. What would you need to map that properly?',
    ],
    questions: [
      'Why can land that is already below sea level stay dry when the sea rises?',
      'The Netherlands has land below sea level today. Why does this grid not show most of it as newly flooded?',
      'Melting all land ice would raise the sea by about 66 m. Why would the real map still differ from this one?',
      'Why does the same rise flood a larger share of a delta than of a mountainous coast?',
    ],
  },
  dataSources: [ETOPO_SOURCE],
};
