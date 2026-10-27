import type { CategoryId } from './types';

export interface Category {
  id: CategoryId;
  name: string;
  short: string;
  description: string;
  /** Icon key (see components/Icon.tsx). */
  icon: string;
}

export const CATEGORIES: Category[] = [
  { id: 'physics', name: 'Physics', short: 'Physics', icon: 'atom', description: 'Gravity, motion, friction, energy and momentum.' },
  { id: 'space', name: 'Space and Astronomy', short: 'Space', icon: 'orbit', description: 'Orbits, moons, planets, stars and impacts.' },
  { id: 'earth', name: 'Earth and Climate', short: 'Earth', icon: 'globe', description: 'Oceans, atmosphere and the planet’s surface.' },
  { id: 'biology', name: 'Biology', short: 'Biology', icon: 'leaf', description: 'Bodies, energy budgets and the scaling of life.' },
  { id: 'civilization', name: 'Human Civilization', short: 'Civilization', icon: 'city', description: 'Populations, resources and infrastructure.' },
  { id: 'technology', name: 'Technology and the Future', short: 'Technology', icon: 'spark', description: 'Energy, engineering and possible futures.' },
];

export function category(id: CategoryId): Category {
  return CATEGORIES.find((c) => c.id === id)!;
}
