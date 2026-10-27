import type { ExperimentDef } from '../../experiments/types';

export const experiments: ExperimentDef[] = [
  {
    id: 'photosynthesizing-humans',
    title: 'What if humans could photosynthesize?',
    category: 'biology',
    modelId: 'photosynthesis',
    description: 'Give skin the photosynthetic efficiency of the best plants and add up what a sunny summer day would supply, compared with a 2,000 kcal diet.',
    difficulty: 'beginner',
    estMinutes: 6,
    params: { latitude: 35, dayOfYear: 172, posture: 'standing', exposedFraction: 50, efficiency: 4.6, duration: 3 },
    assumptions: [
      'Interpreted as skin converting sunlight to stored chemical energy as efficiently as the theoretical maximum for C3 plants — a generous assumption.',
      'A cloudless midsummer day at 35° N, standing or walking, half the skin uncovered.',
      'How a body would actually host photosynthesis is not modelled; the question is only how much energy the light could provide.',
    ],
    tags: ['photosynthesis', 'sunlight', 'energy', 'biology', 'food', 'calories', 'plants', 'solar'],
    featured: 'Sunlight is plentiful — but how much lands on you?',
    followUps: ['photosynthesis-best-case', 'planet-lab'],
  },
  {
    id: 'photosynthesis-best-case',
    title: 'Photosynthetic humans: the best possible case',
    category: 'biology',
    modelId: 'photosynthesis',
    description: 'Fully exposed, always facing the sun at the equator with C4-plant efficiency. Even the upper bound is instructive.',
    difficulty: 'intermediate',
    estMinutes: 5,
    params: { latitude: 0, dayOfYear: 80, posture: 'facing', exposedFraction: 100, efficiency: 6, duration: 3 },
    baseline: { latitude: 35, dayOfYear: 172, posture: 'standing', exposedFraction: 50, efficiency: 4.6, duration: 3 },
    baselineLabel: 'Standing, half exposed, C3 efficiency, 35° N midsummer',
    assumptions: ['Every choice is pushed to its most favourable value; no real organism or person could keep it up.'],
    tags: ['photosynthesis', 'best case', 'upper bound', 'energy budget'],
    followUps: ['photosynthesizing-humans'],
  },
];
