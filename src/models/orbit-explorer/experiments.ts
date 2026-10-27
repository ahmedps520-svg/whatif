import type { ExperimentDef } from '../../experiments/types';

export const experiments: ExperimentDef[] = [
  {
    id: 'orbit-explorer',
    title: 'Planetary Orbit Explorer',
    category: 'space',
    modelId: 'orbit-explorer',
    description:
      'A free sandbox: a star and a planet (plus an optional Jupiter-like second planet). Change the star, the starting distance and speed, and see the orbit, sunlight and temperature that follow from Newton’s laws.',
    difficulty: 'beginner',
    estMinutes: 10,
    params: {},
    tags: ['orbit', 'planet', 'star', 'kepler', 'gravity', 'ellipse', 'escape velocity', 'insolation', 'temperature', 'solar system', 'sandbox'],
    featured: 'Set a planet loose around a star — circle, ellipse or escape.',
    followUps: ['earth-closer-to-sun', 'sun-mass-doubled', 'elliptical-earth-orbit'],
  },
  {
    id: 'earth-closer-to-sun',
    title: 'What if Earth moved closer to the Sun?',
    category: 'space',
    modelId: 'orbit-explorer',
    description:
      'Earth on a circular orbit at 0.7 AU — close to Venus’s distance — compared with today’s 1 AU. How much shorter is the year, how much faster the orbit, and how much stronger the sunlight?',
    difficulty: 'beginner',
    estMinutes: 6,
    params: { planetDistance: 0.7, speedFactor: 1, duration: 730.5 },
    baseline: { planetDistance: 1, speedFactor: 1, duration: 730.5 },
    baselineLabel: 'Earth at 1 AU (today)',
    assumptions: [
      '“Moved closer” is interpreted as Earth placed on a circular orbit at the new distance, with the circular speed for that distance; how it got there is not modelled.',
      'The temperature shown is the equilibrium temperature with today’s Bond albedo (0.3) and no greenhouse effect. Real climate would respond strongly (clouds, ice, water vapour), which this model does not include.',
      'The Sun’s luminosity is today’s value; the Moon and the other planets are left out.',
    ],
    tags: ['earth', 'sun', 'distance', 'orbit', 'year length', 'insolation', 'temperature', 'venus', 'habitable zone'],
    featured: 'A shorter year, a faster orbit and much stronger sunlight.',
    followUps: ['elliptical-earth-orbit', 'sun-mass-doubled', 'planet-lab'],
  },
  {
    id: 'sun-mass-doubled',
    title: 'What if the Sun’s mass suddenly doubled?',
    category: 'space',
    modelId: 'orbit-explorer',
    description:
      'At t = 0 the Sun’s mass doubles while Earth keeps the velocity it had. Earth is suddenly too slow for a circular orbit: how close to the Sun does its new orbit swing, and how long is the new year?',
    difficulty: 'intermediate',
    estMinutes: 8,
    params: { massChange: 2, duration: 730.5 },
    baseline: { massChange: 1, duration: 730.5 },
    baselineLabel: 'Sun’s mass unchanged',
    assumptions: [
      'The extra mass appears instantly at the Sun’s position, moving with the Sun. No known process could do this; the scenario isolates the effect of gravity alone.',
      'The Sun’s luminosity and size are kept at today’s values. A real star of two solar masses would be roughly ten to twenty times more luminous; set the luminosity yourself to explore that.',
      'Earth is treated as a point mass on a circular orbit at 1 AU before the change; the Moon and the other planets are left out.',
    ],
    tags: ['sun', 'mass', 'gravity', 'orbit', 'ellipse', 'vis-viva', 'kepler', 'perihelion', 'thought experiment'],
    featured: 'Double the Sun’s gravity and Earth’s orbit collapses into an ellipse.',
    followUps: ['gravity-doubled-moon', 'elliptical-earth-orbit', 'gravity-doubled'],
  },
  {
    id: 'elliptical-earth-orbit',
    title: 'What if Earth’s orbit were highly elliptical?',
    category: 'space',
    modelId: 'orbit-explorer',
    description:
      'Earth starts at 1.5 AU with 1/√2 of the local circular speed, which (by vis-viva) keeps a 1 AU semi-major axis but stretches the orbit into an ellipse. Compare the year length, the distance swing and the sunlight with today’s nearly circular orbit.',
    difficulty: 'intermediate',
    estMinutes: 8,
    params: { planetDistance: 1.5, speedFactor: 0.7071, duration: 730.5 },
    baseline: { planetDistance: 1, speedFactor: 1, duration: 730.5 },
    baselineLabel: 'Earth’s near-circular orbit (modelled as circular at 1 AU)',
    assumptions: [
      'The orbit is chosen to keep Earth’s semi-major axis (1 AU) so the year length stays the same; only the shape changes. Earth’s real eccentricity is about 0.017.',
      'Temperatures are equilibrium values with no greenhouse effect and no thermal inertia, so they overstate the swing between closest and farthest points; oceans and air would smooth it.',
    ],
    tags: ['earth', 'orbit', 'eccentricity', 'ellipse', 'kepler', 'seasons', 'insolation', 'perihelion', 'aphelion'],
    followUps: ['earth-closer-to-sun', 'sun-mass-doubled', 'orbit-explorer'],
  },
];
