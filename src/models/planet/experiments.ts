import type { ExperimentDef } from '../../experiments/types';
import { REFERENCE } from './model';

const ratio = (v: number, ref: number) => Number((v / ref).toPrecision(3));

/** Mars as configured from the NASA Mars Fact Sheet (rounded). */
const MARS_PARAMS = {
  mass: ratio(REFERENCE.mars.massKg, REFERENCE.earth.massKg),
  radius: ratio(REFERENCE.mars.radiusKm, REFERENCE.earth.radiusKm),
  rotationPeriod: REFERENCE.mars.rotationH,
  tilt: REFERENCE.mars.tiltDeg,
  distance: REFERENCE.mars.aAU,
  albedo: REFERENCE.mars.bondAlbedo,
  tau: 0,
  pressure: REFERENCE.mars.pressureBar,
  molarMass: REFERENCE.mars.molarMass,
  water: 0,
};

export const experiments: ExperimentDef[] = [
  {
    id: 'planet-lab',
    title: 'Planet Lab',
    category: 'space',
    modelId: 'planet',
    description:
      'Build a planet: set its mass, size, spin, tilt, orbit and star, then see what follows from them — gravity, the length of the year and day, seasons, sunlight and an estimated temperature at any point on the globe.',
    difficulty: 'beginner',
    estMinutes: 10,
    params: {},
    tags: ['planet', 'gravity', 'seasons', 'axial tilt', 'day length', 'orbit', 'insolation', 'temperature', 'sandbox', 'globe'],
    featured: 'Design a world, then watch its days and seasons unfold.',
    followUps: ['earth-rotates-twice-as-fast', 'earth-no-axial-tilt', 'living-on-mars', 'gravity-lab', 'orbit-explorer'],
  },
  {
    id: 'earth-rotates-twice-as-fast',
    title: 'What if Earth rotated twice as fast?',
    category: 'space',
    modelId: 'planet',
    description:
      "Halve Earth's rotation period and compare sunrise times, day length and the outward centrifugal effect at the equator with today's Earth.",
    difficulty: 'beginner',
    estMinutes: 5,
    params: { rotationPeriod: REFERENCE.earth.rotationH / 2, duration: 10, observer: 'lat45' },
    baseline: { duration: 10, observer: 'lat45' },
    baselineLabel: "Earth today (23.93 h rotation)",
    assumptions: [
      'Only the rotation period changes; the orbit, tilt, atmosphere and temperature estimate stay the same.',
      "Earth's extra flattening, stronger Coriolis effect, changed weather patterns and tides are not simulated.",
    ],
    tags: ['rotation', 'day length', 'sunrise', 'centrifugal force', 'earth'],
    featured: 'A 12-hour day: how would sunrise, sunset and gravity change?',
    followUps: ['earth-no-axial-tilt', 'gravity-lab', 'planet-lab'],
  },
  {
    id: 'earth-no-axial-tilt',
    title: 'What if Earth had no axial tilt?',
    category: 'space',
    modelId: 'planet',
    description:
      'Stand Earth’s spin axis upright and follow a year at 45°N: compare day length, the star’s noon height and the sunlight received with today’s tilted Earth.',
    difficulty: 'beginner',
    estMinutes: 6,
    params: { tilt: 0, observer: 'lat45' },
    baseline: { observer: 'lat45' },
    baselineLabel: 'Earth today (23.44° tilt)',
    assumptions: [
      'Only the tilt changes. Temperatures shown are global means; the model does not calculate regional climate or how ice and weather would respond.',
    ],
    tags: ['axial tilt', 'obliquity', 'seasons', 'day length', 'insolation', 'earth'],
    featured: 'No tilt, no seasons? Follow a year at 45°N.',
    followUps: ['earth-tilt-60', 'earth-rotates-twice-as-fast', 'planet-lab'],
  },
  {
    id: 'earth-tilt-60',
    title: "What if Earth's tilt were 60°?",
    category: 'space',
    modelId: 'planet',
    description:
      'Tip Earth’s axis to 60°: the tropics and polar circles move, and mid-latitudes get months of near-continuous daylight and darkness. Compare a year at 45°N with today.',
    difficulty: 'intermediate',
    estMinutes: 8,
    params: { tilt: 60, observer: 'lat45' },
    baseline: { observer: 'lat45' },
    baselineLabel: 'Earth today (23.44° tilt)',
    assumptions: [
      'Only the tilt changes; the extreme seasonal temperature swings such a tilt would cause are not modelled (temperature here is a single global mean).',
    ],
    tags: ['axial tilt', 'obliquity', 'seasons', 'polar day', 'polar night', 'uranus'],
    followUps: ['earth-no-axial-tilt', 'planet-lab'],
  },
  {
    id: 'sun-twice-as-bright',
    title: 'What if the Sun became twice as bright?',
    category: 'space',
    modelId: 'planet',
    description:
      "Double the Sun's luminosity and see how the sunlight reaching Earth and its radiative-equilibrium temperature change, with albedo and greenhouse strength held at today's values.",
    difficulty: 'intermediate',
    estMinutes: 5,
    params: { luminosity: 2 },
    baseline: { luminosity: 1 },
    baselineLabel: 'Today’s Sun (1 L☉)',
    assumptions: [
      'Shows the radiative-equilibrium change only: albedo and the greenhouse optical depth are fixed, with no climate feedbacks (water vapour, clouds, ice, ocean loss).',
      "Climate-modelling studies suggest that a much smaller brightening than this would already push Earth toward a runaway or moist greenhouse, so the real outcome would be far hotter than this estimate.",
      'The star’s mass and Earth’s orbit are unchanged; a real Sun this bright would be an older, evolving star.',
    ],
    tags: ['sun', 'luminosity', 'insolation', 'temperature', 'energy balance', 'climate'],
    featured: 'Double the sunlight: what does simple energy balance say?',
    followUps: ['planet-lab', 'orbit-explorer'],
  },
  {
    id: 'planet-strong-gravity',
    title: 'What if a planet had much stronger gravity?',
    category: 'space',
    modelId: 'planet',
    description:
      "A hypothetical rocky world with five times Earth's mass and 1.5 times its radius. See how surface gravity, escape velocity, density and the atmosphere's scale height follow from those two inputs.",
    difficulty: 'intermediate',
    estMinutes: 6,
    params: { mass: 5, radius: 1.5 },
    baseline: {},
    baselineLabel: 'Earth',
    assumptions: [
      'Hypothetical planet. It keeps Earth’s orbit, rotation, atmosphere and greenhouse strength so that only gravity-related quantities change; a real planet this massive would probably hold a different, thicker atmosphere.',
      'Gravity is calculated from mass and radius (g = GM/R²); it is not set directly.',
    ],
    tags: ['gravity', 'super-earth', 'exoplanet', 'escape velocity', 'density', 'atmosphere'],
    featured: 'Five Earth masses, 1.5 Earth radii: how heavy would you feel?',
    followUps: ['gravity-doubled', 'gravity-lab', 'planet-lab'],
  },
  {
    id: 'living-on-mars',
    title: 'What would living on Mars be like?',
    category: 'space',
    modelId: 'planet',
    description:
      'Configure the planet with NASA fact-sheet values for Mars and compare a Martian year at the equator with Earth: gravity, the length of a sol and a year, sunlight, temperature and air.',
    difficulty: 'beginner',
    estMinutes: 8,
    params: { ...MARS_PARAMS, duration: 700, observer: 'equator' },
    baseline: { duration: 700, observer: 'equator' },
    baselineLabel: 'Earth',
    assumptions: [
      'Mars values from the NASA Mars Fact Sheet, rounded; the orbit is treated as circular (Mars’s real orbit is noticeably eccentric, which makes its southern summers hotter).',
      'Greenhouse optical depth τ = 0: Mars’s thin CO₂ atmosphere warms the surface by only a few kelvin, which this model ignores. Its observed mean of about −65 °C is close to the equilibrium value.',
      'Water coverage 0%: Mars has no stable surface liquid water today.',
    ],
    tags: ['mars', 'sol', 'gravity', 'atmosphere', 'temperature', 'seasons', 'planets'],
    featured: 'Gravity, sols, sunlight and thin air on the Red Planet, from NASA fact-sheet values.',
    followUps: ['planet-lab', 'gravity-lab', 'orbit-explorer', 'two-moons'],
  },
  {
    id: 'oceans-cover-90-percent',
    title: 'What if oceans covered 90% of Earth?',
    category: 'earth',
    modelId: 'planet',
    description:
      "Raise the water on Earth's real terrain until 90% of the surface is underwater and read how high sea level would have to rise, computed from the ETOPO1 elevation data.",
    difficulty: 'beginner',
    estMinutes: 4,
    params: { water: 90 },
    baseline: {},
    baselineLabel: 'Earth today',
    assumptions: [
      'Water is added on today’s terrain with no change to climate, ice sheets or the solid Earth; every point below the new level counts as flooded, including inland basins.',
      'Rotation, orbit and temperature are unchanged, so only the water-related values and the globe differ from the baseline.',
    ],
    tags: ['ocean', 'sea level', 'water world', 'topography', 'hypsometry', 'earth'],
    followUps: ['sea-level-100m', 'planet-lab'],
  },
];
