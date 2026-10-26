import type { SimulationModel } from '../engine/types';
import { projectileModel } from './projectile/model';

/**
 * Every implemented simulation model. Logic only — no views — so this module
 * can be imported by the background worker and by tests.
 */
export const MODELS: SimulationModel[] = [projectileModel];

const byId = new Map(MODELS.map((m) => [m.id, m]));

export function getModel(id: string): SimulationModel | undefined {
  return byId.get(id);
}
