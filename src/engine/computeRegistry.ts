/** Named heavy computations that can run in the background worker. */
export type ComputeTask = (payload: any) => Promise<unknown> | unknown;

export const computeTasks: Record<string, ComputeTask> = {};

export function registerComputeTask(name: string, fn: ComputeTask) {
  computeTasks[name] = fn;
}
