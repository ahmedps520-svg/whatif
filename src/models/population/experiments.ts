import type { ExperimentDef } from '../../experiments/types';

export const experiments: ExperimentDef[] = [
  {
    id: 'population-resources',
    title: 'Population and Resource Simulator',
    category: 'civilization',
    modelId: 'population',
    description:
      'A sandbox stock-and-flow model: a population draws on a regenerating resource, an energy supply and infrastructure, and explicit feedbacks change birth and death rates when needs go unmet. Adjust every rate, capacity and feedback strength.',
    difficulty: 'intermediate',
    estMinutes: 12,
    params: {},
    baseline: {},
    baselineLabel: 'Default settings',
    assumptions: [
      'Defaults start from rounded present-day world values (≈8.1 billion people, birth rate ≈17‰, death rate ≈8‰; UN World Population Prospects). Resource, energy and infrastructure capacities are hypothetical model quantities.',
      'There is no demographic transition: birth rates change only when needs go unmet, so this is a way to explore feedbacks and delays, not a population projection.',
    ],
    tags: ['population', 'resources', 'carrying capacity', 'overshoot', 'stock and flow', 'system dynamics', 'feedback', 'birth rate', 'death rate', 'sustainability', 'logistic growth', 'sandbox'],
    featured: 'Stocks, flows and feedbacks: why growth can overshoot.',
    followUps: ['population-doubled', 'fusion-power'],
  },
  {
    id: 'population-doubled',
    title: 'What if the world’s population doubled?',
    category: 'civilization',
    modelId: 'population',
    description:
      'Start with ≈16.2 billion people instead of ≈8.1 billion while resources, energy supply and infrastructure stay at their present-like (hypothetical) levels. Which constraint bites first, and how does the population respond?',
    difficulty: 'intermediate',
    estMinutes: 10,
    params: { P0: 16.2 },
    baseline: { P0: 8.1 },
    baselineLabel: 'Present-like population (≈8.1 billion)',
    assumptions: [
      'The doubling is instantaneous at t = 0: the energy supply and infrastructure capacity stay at the default levels, so each person starts with half the energy and many people cannot be served.',
      'The extra people have the same average birth and death rates (rounded present world values); the model has no age structure, so a sudden doubling of mostly children or of mostly adults would really behave differently.',
      'Resource, energy and infrastructure capacities are hypothetical model quantities; the outcome’s timing scales with them. The feedback strengths are illustrative, not calibrated.',
    ],
    tags: ['population', 'doubling', 'overpopulation', 'carrying capacity', 'resources', 'energy', 'infrastructure', 'crowding', 'overshoot'],
    featured: 'Twice the people, the same planet: which limit bites first?',
    followUps: ['population-resources', 'fusion-power'],
  },
  {
    id: 'fusion-power',
    title: 'What if commercial fusion power became widely available?',
    category: 'technology',
    modelId: 'population',
    description:
      'Represent abundant fusion energy as an energy supply ten times present demand, growing 3 % per year, and see which limits it removes in this stock-and-flow model — and which it does not.',
    difficulty: 'advanced',
    estMinutes: 10,
    params: { energySupply: 10, energyGrowth: 3 },
    baseline: { energySupply: 1, energyGrowth: 1 },
    baselineLabel: 'Present-like energy supply (1×, +1 %/yr)',
    assumptions: [
      'Speculative: fusion is represented only as a much larger energy supply capacity (10× present demand, +3 %/yr). In this model energy is purely a capacity constraint — it removes energy-shortage mortality and lets infrastructure be built and maintained, nothing more.',
      'Not modelled: how fusion would be developed and deployed (technology diffusion), its costs and prices, emissions and climate effects, or any substitution of energy for resources (desalination, recycling, synthetic food).',
      'The renewable resource and its regeneration are unchanged, so if resources were the binding limit in the baseline, extra energy changes little — which is itself the lesson of this experiment.',
    ],
    tags: ['fusion', 'energy', 'abundant energy', 'technology', 'population', 'resources', 'limits to growth', 'speculative'],
    featured: 'Unlimited energy — does it remove every limit?',
    followUps: ['population-resources', 'population-doubled'],
  },
];
