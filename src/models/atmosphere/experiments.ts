import type { ExperimentDef } from '../../experiments/types';

export const experiments: ExperimentDef[] = [
  {
    id: 'oxygen-halved',
    title: 'What if the atmosphere lost half its oxygen?',
    category: 'earth',
    modelId: 'atmosphere',
    description: 'Remove half of the air’s oxygen over ten years and compute what a person at sea level would breathe — expressed as an equivalent mountain altitude.',
    difficulty: 'intermediate',
    estMinutes: 8,
    params: { o2Amount: 50, mode: 'remove', transitionYears: 10, duration: 20 },
    baseline: { o2Amount: 100 },
    baselineLabel: 'Today’s atmosphere',
    assumptions: [
      'Interpreted as removing half of the oxygen molecules while leaving every other gas in place, so total pressure falls too. Switch the mode to “replaced by nitrogen” to see the alternative interpretation.',
      'The ten-year linear transition is hypothetical; no process that could remove that much oxygen is implied.',
      'Only immediate physical quantities are computed. What would happen to people, ecosystems and fire is not predicted — the events mark established reference points for comparison.',
    ],
    tags: ['oxygen', 'atmosphere', 'air', 'breathing', 'altitude', 'hypoxia', 'pressure', 'composition'],
    featured: 'Sea level would feel like a high mountain. Which one?',
    followUps: ['atmosphere-double', 'oxygen-30', 'sea-level-100m'],
  },
  {
    id: 'oxygen-30',
    title: 'What if oxygen made up 30% of the air?',
    category: 'earth',
    modelId: 'atmosphere',
    description: 'Raise the oxygen share to about 30 % at constant pressure and see how the air changes for breathing and burning.',
    difficulty: 'intermediate',
    estMinutes: 6,
    params: { o2Amount: 143, mode: 'replace', transitionYears: 0, duration: 5 },
    baseline: { o2Amount: 100, mode: 'replace', transitionYears: 0, duration: 5 },
    baselineLabel: 'Today’s atmosphere',
    assumptions: [
      'Interpreted as oxygen displacing nitrogen at today’s total pressure (143 % of today’s oxygen gives about 30 % O₂).',
      'Fire and biological consequences are not computed; the OSHA “oxygen-enriched” threshold is shown as a reference point.',
    ],
    tags: ['oxygen', 'enriched air', 'fire', 'atmosphere', 'breathing'],
    followUps: ['oxygen-halved'],
  },
];
