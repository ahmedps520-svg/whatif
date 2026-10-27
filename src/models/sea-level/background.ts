// Main-thread only: route the sea-level flood fill through the shared worker
// pool. Kept out of model.ts/store.ts because the worker bundle imports those,
// and a worker bundle that references the worker client would reference itself
// (Vite: "Circular worker imports detected"). Imported for its side effect by
// View.tsx; app code may also import it at startup so prepare() never falls
// back to computing on the main thread.
import { computeInBackground } from '../../engine/workerClient';
import { SEA_LEVEL_FLOOD_TASK } from './computeTask';
import type { SeaLevelProducts } from './products';
import { setFloodRunner } from './store';

setFloodRunner((payload) => computeInBackground<SeaLevelProducts>(SEA_LEVEL_FLOOD_TASK, payload).promise);
