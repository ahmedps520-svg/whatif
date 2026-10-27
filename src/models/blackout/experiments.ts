import type { ExperimentDef } from '../../experiments/types';

export const experiments: ExperimentDef[] = [
  {
    id: 'electricity-disappears',
    title: 'What if electricity disappeared worldwide?',
    category: 'civilization',
    modelId: 'blackout',
    description:
      'A sudden loss of grid power with no outside help: restoration takes months, preparedness is typical and fuel logistics are disrupted. Follow how batteries, stored water, generator fuel and home food run out, and compare with the other branches of the scenario tree.',
    difficulty: 'intermediate',
    estMinutes: 12,
    params: { restoration: 'prolonged', preparedness: 'typical', logistics: 'disrupted', durationDays: 60 },
    baseline: { restoration: 'rapid', preparedness: 'typical', logistics: 'disrupted', durationDays: 60 },
    baselineLabel: 'Same society, power back within days (rapid restoration)',
    assumptions: [
      'A transparent scenario model rather than a prediction of how any country would respond. "Worldwide" is represented by the prolonged-restoration and disrupted-logistics branches: no region can send fuel, crews or equipment to another.',
      'The baseline changes only the restoration branch (rapid: power back within about two days), so the comparison isolates how much the length of the outage matters. A run with the grid never failing would simply stay at 100 %.',
      'Branch numbers (generator coverage, fuel on hand, battery runtimes, delivery capacity) are illustrative assumptions, not measured data. The 4-hour refrigerator and 48-hour full-freezer limits follow USDA food-safety guidance.',
      'Human behaviour, emergency response, cascading failures across borders, cybersecurity and health outcomes are not modelled or are only crudely represented.',
    ],
    tags: ['blackout', 'electricity', 'power outage', 'grid', 'infrastructure', 'resilience', 'backup generators', 'water', 'communications', 'food safety', 'emergency', 'system dynamics', 'scenario'],
    featured: 'Batteries, water towers, fuel tanks: what runs out first?',
    followUps: ['blackout-well-prepared', 'population-resources'],
  },
  {
    id: 'blackout-well-prepared',
    title: 'What if backup power were well prepared?',
    category: 'civilization',
    modelId: 'blackout',
    description:
      'The same weeks-long regional blackout with disrupted fuel deliveries, but with well-prepared backup: more generators, longer batteries, more water storage and four days of fuel on hand. How much time does preparedness buy?',
    difficulty: 'intermediate',
    estMinutes: 8,
    params: { restoration: 'regional', preparedness: 'well', logistics: 'disrupted', durationDays: 30 },
    baseline: { restoration: 'regional', preparedness: 'typical', logistics: 'disrupted', durationDays: 30 },
    baselineLabel: 'Typical preparedness',
    assumptions: [
      'Only the preparedness branch differs from the baseline. "Well-prepared" sets illustrative values (hospitals 98 % with generators, water pumping 60 %, cell sites 60 % with generators and 8 h batteries, 24 h water storage, 96 h of fuel, 30 % of fuel stations with backup, 0.5 %/day generator failures); none is survey data.',
      'With disrupted deliveries even well-stocked generators eventually run dry, so preparedness here mostly shifts when systems fail rather than whether they do.',
    ],
    tags: ['blackout', 'preparedness', 'backup power', 'generators', 'resilience', 'fuel', 'emergency planning'],
    featured: 'Preparedness buys days — does it buy weeks?',
    followUps: ['electricity-disappears'],
  },
];
