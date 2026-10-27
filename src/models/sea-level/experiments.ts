// Side effect (main thread only — this file is imported by the experiment
// catalog, never by the worker): run the flood fill in the worker pool, so the
// workspace's prepare() does not compute it on the main thread.
import './background';
import type { ExperimentDef } from '../../experiments/types';
import { ALL_LAND_ICE_SLE, ICE_SLE } from './model';

const COMMON_ASSUMPTIONS = [
  'Present coastlines and heights are from NOAA ETOPO1 sampled every 0.25°; the sea rises uniformly (“bathtub”) and floods only land it can reach (hydrological connectivity).',
  'The rate of rise is a hypothetical, uniform 1 m per century used only for the timeline; the map at a given sea level does not depend on it.',
  'Antarctica (south of 60°S) is excluded from the area totals because the ice-surface grid shows floating ice shelves as low land.',
  'Areas count physical inundation only; consequences for people, ecosystems and economies are not modelled.',
];

export const experiments: ExperimentDef[] = [
  {
    id: 'sea-level-100m',
    title: 'What if sea levels rose by 100 metres?',
    category: 'earth',
    modelId: 'sea-level',
    description:
      'Raise the sea 100 m above today’s level on a global elevation grid and see which land the water can reach — and which low basins stay dry behind higher ground.',
    difficulty: 'intermediate',
    estMinutes: 10,
    params: { target: 100, rate: 1, rule: 'connected' },
    baseline: { target: 0, rate: 1, duration: 10000 },
    baselineLabel: 'Present sea level (0 m)',
    assumptions: [
      ...COMMON_ASSUMPTIONS,
      `A 100 m rise is purely hypothetical: it exceeds the ≈${Math.round(ALL_LAND_ICE_SLE)} m that melting all present land ice could supply.`,
    ],
    tags: ['sea level', 'flooding', 'coast', 'ocean', 'elevation', 'topography', 'climate', 'ice', 'map', 'etopo1', 'delta'],
    featured: 'Which land would the sea reach at +100 m?',
    followUps: ['sea-level-all-ice', 'sea-level-greenland'],
  },
  {
    id: 'sea-level-all-ice',
    title: 'What if all polar ice melted?',
    category: 'earth',
    modelId: 'sea-level',
    description: `Raise the sea by the ≈${Math.round(ALL_LAND_ICE_SLE)} m sea-level equivalent of all land ice — the Antarctic and Greenland ice sheets plus mountain glaciers — and compare the new coastline with today’s.`,
    difficulty: 'intermediate',
    estMinutes: 10,
    params: { target: ALL_LAND_ICE_SLE, rate: 1, rule: 'connected' },
    baseline: { target: 0, rate: 1, duration: Math.round(ALL_LAND_ICE_SLE * 100) },
    baselineLabel: 'Present sea level (0 m)',
    assumptions: [
      `Sea-level equivalents of present land ice: Antarctic ice sheet ≈${ICE_SLE.antarctica} m (Bedmap2, Fretwell et al. 2013), Greenland ice sheet ≈${ICE_SLE.greenland} m (BedMachine v3, Morlighem et al. 2017), other glaciers ≈${ICE_SLE.glaciers} m (Farinotti et al. 2019); total ≈${ALL_LAND_ICE_SLE} m. Published totals range from about 65 to 70 m depending on the ice inventory.`,
      'Floating sea ice and ice shelves are already in the sea and add almost nothing; thermal expansion of a warmer ocean would add more but is not included.',
      'The map still shows the present ice surfaces: the bedrock under the ice sheets (much of West Antarctica lies below sea level) and its slow rebound once unloaded are not modelled.',
      'The rise would not be uniform: near a melting ice sheet sea level would fall (its gravitational pull weakens) and far from it rise by more than the average.',
      ...COMMON_ASSUMPTIONS,
    ],
    tags: ['ice', 'ice sheet', 'antarctica', 'greenland', 'glaciers', 'melting', 'sea level', 'climate', 'flooding', 'coast'],
    featured: 'All the ice on land, turned into sea.',
    followUps: ['sea-level-100m', 'sea-level-greenland'],
  },
  {
    id: 'sea-level-greenland',
    title: 'What if Greenland’s ice sheet melted?',
    category: 'earth',
    modelId: 'sea-level',
    description: `About ${ICE_SLE.greenland} m of sea-level rise is stored in Greenland’s ice. See the low-lying deltas and coasts most exposed — and the limits of a global grid at this scale.`,
    difficulty: 'advanced',
    estMinutes: 8,
    params: { target: ICE_SLE.greenland, rate: 1, rule: 'connected' },
    baseline: { target: 0, rate: 1, duration: Math.round(ICE_SLE.greenland * 100) },
    baselineLabel: 'Present sea level (0 m)',
    assumptions: [
      `Reliability: a ${ICE_SLE.greenland} m rise is below the ≈10 m that this 0.25° point-sampled grid resolves reliably. Elevations are whole metres sampled once per ≈28 km cell and coastal defences are absent, so treat areas as rough indications, not a flood map.`,
      `Greenland’s sea-level equivalent ≈${ICE_SLE.greenland} m (BedMachine v3, Morlighem et al. 2017).`,
      'Real rise from Greenland would be strongly non-uniform: sea level near Greenland would fall, while far-away coasts would see more than the global average.',
      ...COMMON_ASSUMPTIONS,
    ],
    tags: ['greenland', 'ice sheet', 'melting', 'sea level', 'climate', 'coast', 'delta', 'flooding'],
    followUps: ['sea-level-all-ice', 'sea-level-100m'],
  },
];
