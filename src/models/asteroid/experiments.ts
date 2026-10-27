import type { ExperimentDef } from '../../experiments/types';

export const experiments: ExperimentDef[] = [
  {
    id: 'asteroid-approach',
    title: 'What if an asteroid approached Earth?',
    category: 'space',
    modelId: 'asteroid',
    description:
      'A 300 m stony asteroid approaching at 6 km/s, aimed to miss Earth’s centre by 3 Earth radii. Earth’s gravity speeds it up and bends its path. How close does it really come, and how much is it deflected?',
    difficulty: 'beginner',
    estMinutes: 6,
    params: { diameter: 300, density: 3000, vInf: 6, impactParam: 3, earthMassFactor: 1, startDistance: 60, duration: 48 },
    baseline: { diameter: 300, density: 3000, vInf: 6, impactParam: 3, earthMassFactor: 0, startDistance: 60, duration: 48 },
    baselineLabel: 'Same asteroid if Earth had no gravity (straight line)',
    assumptions: [
      'The asteroid, its speed and its aim are illustrative, not a real object. Only Earth’s gravity acts; the Sun and the Moon are left out over the two-day encounter.',
      'The baseline switches Earth’s gravity off to show the straight path the asteroid would otherwise follow; it is a comparison, not a possible situation.',
    ],
    tags: ['asteroid', 'near-earth object', 'flyby', 'gravitational focusing', 'hyperbola', 'deflection', 'planetary defence', 'impact'],
    featured: 'Earth’s gravity bends a passing asteroid — and enlarges the target.',
    followUps: ['asteroid-impact-energy', 'gravity-doubled-moon', 'orbit-explorer'],
  },
  {
    id: 'asteroid-impact-energy',
    title: 'How much energy would an asteroid impact release?',
    category: 'space',
    modelId: 'asteroid',
    description:
      'A 1 km stony asteroid hits Earth after approaching at 17 km/s. Compare its impact speed, energy in megatonnes of TNT and approximate crater with a 100 m asteroid on the same path.',
    difficulty: 'intermediate',
    estMinutes: 7,
    params: { diameter: 1000, density: 3000, vInf: 17, impactParam: 0.5, earthMassFactor: 1, startDistance: 60, duration: 24 },
    baseline: { diameter: 100, density: 3000, vInf: 17, impactParam: 0.5, earthMassFactor: 1, startDistance: 60, duration: 24 },
    baselineLabel: '100 m asteroid on the same path',
    assumptions: [
      'The impactor is treated as reaching the ground intact at full speed; the atmosphere is not modelled. That is a reasonable approximation for a 1 km body but not for the 100 m baseline, which would lose a significant part of its energy in the atmosphere and might break up.',
      'The crater is an approximate transient crater from the Collins, Melosh & Marcus (2005) scaling for a rock target; blast, ejecta, tsunami and climate effects are not modelled.',
      'The approach speed of 17 km/s is an illustrative choice within the range of observed Earth-approaching asteroids.',
    ],
    tags: ['asteroid', 'impact', 'energy', 'megatonnes', 'tnt', 'crater', 'kinetic energy', 'extinction', 'planetary defence'],
    featured: 'Size cubed, speed squared: what an impact really carries.',
    followUps: ['asteroid-approach', 'orbit-explorer'],
  },
];
