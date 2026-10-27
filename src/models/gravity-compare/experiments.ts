import type { ExperimentDef } from '../../experiments/types';

export const experiments: ExperimentDef[] = [
  {
    id: 'gravity-doubled',
    title: 'What if Earth’s gravity doubled?',
    category: 'physics',
    modelId: 'gravity-compare',
    description:
      'Drop a ball, throw it and jump in two worlds side by side, one with today’s gravity and one with twice as much, then see what a heavier Earth would do to the orbits of a satellite and the Moon.',
    difficulty: 'beginner',
    estMinutes: 8,
    params: { factor: 2, interpretation: 'mass' },
    baselineInternal: true,
    baselineLabel: 'Today’s gravity (g₀ = 9.81 m/s²)',
    assumptions: [
      '“Gravity doubled” means the gravitational acceleration at the ground becomes 2 × 9.81 m/s². For the orbits it is interpreted as Earth’s mass doubling at the same radius; switch “What changes (orbits)” to compare with G doubling or with a change of the surface field only.',
      'Both worlds contain the same ball, the same throw and the same person with the same leg strength; only g differs.',
      'The change is instantaneous, so the Moon and satellites keep the speed they had on their old orbits.',
    ],
    tags: ['gravity', 'double gravity', '2g', 'free fall', 'projectile', 'jump', 'weight', 'scale', 'orbit', 'moon', 'satellite', 'vis-viva', 'escape velocity'],
    featured: 'Fall faster, throw shorter, barely jump — and watch the Moon’s orbit stretch into an ellipse.',
    followUps: ['gravity-doubled-moon', 'everything-twice-as-heavy', 'moon-strength-gravity', 'gravity-lab', 'planet-lab'],
  },
  {
    id: 'moon-strength-gravity',
    title: 'What if gravity were as weak as the Moon’s?',
    category: 'physics',
    modelId: 'gravity-compare',
    description:
      'Gravity at the ground drops to the Moon’s value (k = 0.165): slow, floating falls, much longer throws and far higher jumps. Then check whether such an Earth could still hold on to its Moon.',
    difficulty: 'beginner',
    estMinutes: 8,
    params: { factor: 0.165, interpretation: 'mass' },
    baselineInternal: true,
    baselineLabel: 'Today’s gravity (g₀ = 9.81 m/s²)',
    assumptions: [
      'The surface gravity becomes 0.165 × 9.81 ≈ 1.62 m/s², the Moon’s value. For the orbits this is interpreted as Earth’s mass shrinking to 16.5 % at the same radius; choose “Surface field only” to keep today’s orbits and look only at surface mechanics.',
      'The person’s legs are as strong as today, calibrated on a 0.5 m jump at Earth gravity.',
      'The air is unchanged. A real low-gravity Earth would likely hold on to less atmosphere over geological time; that is not modelled.',
    ],
    tags: ['gravity', 'moon gravity', 'low gravity', 'weak gravity', 'free fall', 'projectile', 'jump', 'weight', 'escape velocity', 'orbit'],
    followUps: ['gravity-doubled', 'gravity-lab', 'planet-lab', 'gravity-doubled-moon'],
  },
  {
    id: 'everything-twice-as-heavy',
    title: 'What if everything suddenly weighed twice as much?',
    category: 'physics',
    modelId: 'gravity-compare',
    description:
      'Every object’s weight doubles while its mass stays the same. Watch the scale reading, the falls and the jumps change. Doubling weight is the same as doubling g, and it is not the same as doubling mass.',
    difficulty: 'beginner',
    estMinutes: 6,
    params: { factor: 2, interpretation: 'local' },
    baselineInternal: true,
    baselineLabel: 'Today’s weights (g₀ = 9.81 m/s²)',
    assumptions: [
      '“Twice as heavy” is interpreted as twice the weight (W = m·g) for the same mass, i.e. the gravitational field at the ground doubles. Masses, sizes and muscles stay the same.',
      'Doubling only an object’s mass (both its inertia and its weight) changes nothing in a vacuum: a = F/m = 2mg/2m = g. That reading of the question is explored in the Gravity & Projectile Lab experiment “objects-twice-as-heavy”.',
      'To focus on everyday mechanics, the orbits are left unchanged here (“surface field only”). That is not physically consistent — switch the interpretation to see what a doubled Earth mass or G would do to the Moon and satellites.',
    ],
    tags: ['weight', 'mass', 'heavy', 'twice as heavy', 'scale', 'gravity', 'free fall', 'jump', 'galileo'],
    followUps: ['objects-twice-as-heavy', 'gravity-doubled', 'gravity-lab'],
  },
];
