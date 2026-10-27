import type { ExperimentDef } from '../../experiments/types';

export const experiments: ExperimentDef[] = [
  {
    id: 'two-moons',
    title: 'What if Earth had two moons?',
    category: 'space',
    modelId: 'moons',
    description:
      'Today’s Moon plus a hypothetical second moon, a quarter of the Moon’s mass, on a circular orbit at 200,000 km. Watch both orbits, Earth’s wobble, the moons’ close approaches and the combined tidal pull.',
    difficulty: 'intermediate',
    estMinutes: 8,
    params: { moonCount: '2', moon2Distance: 200000, moon2Mass: 0.25, moon2Phase: 120, duration: 90 },
    baseline: { moonCount: '1', duration: 90 },
    baselineLabel: 'Earth with only today’s Moon',
    assumptions: [
      'The second moon is entirely hypothetical: there is no evidence Earth has had a second large moon in its recent history. Its mass (0.25 Moon) and distance (200,000 km) were chosen so the pair satisfies the two-body Hill-stability criterion (spacing above 2√3 mutual Hill radii, Gladman 1993), i.e. the moons can coexist for the simulated span.',
      'The Sun is not included in the dynamics, and stability over thousands to millions of years is not assessed.',
      'Both moons start on circular orbits in the same plane; tides are tide-raising accelerations, not ocean heights.',
    ],
    tags: ['moon', 'two moons', 'second moon', 'tides', 'barycentre', 'orbit', 'hill stability', 'earth'],
    featured: 'A second moon: double orbits and stronger tides.',
    followUps: ['moon-disappears', 'gravity-doubled-moon', 'orbit-explorer'],
  },
  {
    id: 'moon-disappears',
    title: 'What if the Moon disappeared?',
    category: 'space',
    modelId: 'moons',
    description:
      'The Moon vanishes on day 7. Earth stops circling the old Earth–Moon barycentre and coasts away in a straight line, and only the Sun’s tides remain.',
    difficulty: 'beginner',
    estMinutes: 6,
    params: { moonVanish: true, vanishTime: 7, duration: 60 },
    baseline: { moonVanish: false, duration: 60 },
    baselineLabel: 'The Moon stays',
    assumptions: [
      'The Moon is removed instantly with no other effect (no explosion, no debris). There is no physical mechanism for this; it isolates the role of the Moon’s gravity.',
      'Only Earth’s motion and tide-raising forces are modelled. Effects on Earth’s axial tilt stability, day length, ocean tides in detail, and life are outside this model.',
      'The Sun is not simulated; Earth’s straight-line drift is relative to its orbit around the Sun, which would continue essentially unchanged.',
    ],
    tags: ['moon', 'moon disappears', 'no moon', 'tides', 'barycentre', 'momentum', 'inertia', 'earth'],
    featured: 'No Moon: Earth stops wobbling and drifts off its old centre.',
    followUps: ['two-moons', 'gravity-doubled-moon', 'gravity-off-5s'],
  },
  {
    id: 'gravity-doubled-moon',
    title: 'What if Earth’s gravity doubled? The Moon’s orbit',
    category: 'space',
    modelId: 'moons',
    description:
      'Earth’s mass doubles instantly at t = 0 while the Moon keeps its velocity. The Moon is suddenly too slow for a circle and dives toward Earth on a new elliptical orbit. How close does it come, and how strong do the tides get?',
    difficulty: 'intermediate',
    estMinutes: 8,
    params: { earthMassFactor: 2, duration: 60 },
    baseline: { earthMassFactor: 1, duration: 60 },
    baselineLabel: 'Earth’s gravity unchanged',
    assumptions: [
      '“Gravity doubled” is interpreted as Earth’s mass doubling instantly, with Earth’s radius unchanged (so surface gravity also doubles). No known process could do this.',
      'The Moon starts on a circular orbit for today’s Earth mass and keeps its velocity; tidal breakup, tidal heating and orbital decay are not modelled.',
      'The Sun is not included in the dynamics.',
    ],
    tags: ['gravity', 'gravity doubled', 'moon', 'orbit', 'ellipse', 'vis-viva', 'tides', 'perigee'],
    featured: 'Double Earth’s gravity and watch the Moon’s orbit collapse into an ellipse.',
    followUps: ['gravity-doubled', 'sun-mass-doubled', 'moon-disappears'],
  },
];
