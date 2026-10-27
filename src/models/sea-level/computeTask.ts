// Registers the sea-level flood fill as a background compute task. Imported by
// src/engine/computeTasks.ts so the worker bundle includes it. Must stay free
// of DOM and worker-client imports.
import { registerComputeTask } from '../../engine/computeRegistry';
import { buildSeaLevelProducts, type FloodPayload } from './products';

export const SEA_LEVEL_FLOOD_TASK = 'sea-level-flood';

registerComputeTask(SEA_LEVEL_FLOOD_TASK, (payload: FloodPayload) => buildSeaLevelProducts(payload));
