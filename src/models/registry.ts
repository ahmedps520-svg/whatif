import type { SimulationModel } from '../engine/types';
import { projectileModel } from './projectile/model';
import { gravityCompareModel } from './gravity-compare/model';
import { orbitExplorerModel } from './orbit-explorer/model';
import { moonsModel } from './moons/model';
import { asteroidModel } from './asteroid/model';
import { planetModel } from './planet/model';
import { seaLevelModel } from './sea-level/model';
import { atmosphereModel } from './atmosphere/model';
import { populationModel } from './population/model';
import { blackoutModel } from './blackout/model';
import { photosynthesisModel } from './photosynthesis/model';

/**
 * Every implemented simulation model. Logic only — no views — so this module
 * can be imported by the background worker and by tests.
 */
export const MODELS: SimulationModel[] = [
  projectileModel,
  gravityCompareModel,
  orbitExplorerModel,
  moonsModel,
  asteroidModel,
  planetModel,
  seaLevelModel,
  atmosphereModel,
  populationModel,
  blackoutModel,
  photosynthesisModel,
];

const byId = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id: string): SimulationModel | undefined {
  return byId.get(id);
}
