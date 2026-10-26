# WHAT IF LAB — architecture

The application separates **simulation logic** from **rendering** and **UI**.

```
src/
  engine/        model contract, fixed-step core, live runner, headless runner, worker, units, validation
  models/<id>/   one folder per simulation model
     model.ts          pure logic implementing SimulationModel (no DOM, no React)
     model.test.ts     vitest tests against known results
     View.tsx          the model's visualisation (canvas 2D or three.js)
     experiments.ts    ExperimentDef[] presets that use the model
  models/registry.ts   list of models (logic only — imported by the worker)
  views/registry.ts    modelId → lazy View component
  experiments/         catalog (implemented + planned), categories
  components/          shared UI (LineChart, CanvasStage, controls, panels…)
  three/               shared three.js host (ThreeStage)
  data/                dataset loaders (ETOPO1 elevation)
  store/               persisted state (history, collections, prefs, achievements)
  pages/               routed screens
```

## The model contract (`src/engine/types.ts`)

A model is a plain object implementing `SimulationModel<S>`:

* `params` — every adjustable input with unit, range, default and **kind**:
  * `live` — applied from the current simulated time (logged on the timeline);
  * `initial` — initial conditions; changing one restarts the run;
  * `spawn` — settings for objects the user adds later (e.g. the next launch).
  Use `visibleWhen` to hide parameters that have no effect in the current configuration.
* `observables` — values recorded at every sample, each with unit and **provenance**
  (`simulated`, `derived`, `data`, `assumed`).
* `time` — model time unit, fixed step `dt`, recording `sampleInterval`, default/max duration,
  `realtimeRate` (model time per real second at 1×), optional milestone times.
* `init(p)`, `step(s, p, dt)` (mutates in place), `observe(s, p)`, `clone(s)`, `time_of(s)`.
* Optional: `detectEvents`, declarative `thresholds`, `describeMilestone` (milestone text is built
  from the actual state), `finished`, `tracks` (object paths), `derived` (closed-form quantities
  from parameters), `warnings` (validity checks), `actions` + `applyAction` (user actions such
  as "launch", recorded for replay), `summarize` (key results from a recorded run).
* Documentation is part of the contract: `assumptions` (each tagged established /
  simplification / approximation / speculative), `limitations`, `equations`, `education`
  (objectives, beginner/intermediate/advanced background, variables, guided steps, questions),
  and `dataSources` for any external data.

Rules:

1. `init` and `step` must be deterministic for a given parameter set (no `Math.random` without a seeded generator).
2. `step` must not throw for any parameter value inside the declared ranges; the engine stops the run and reports an event if it does, or if an observable becomes ±Infinity. Use `NaN` for "not applicable".
3. Never hardcode outputs: every observable comes from the state the model computed.
4. Numerical safety: choose integrators appropriate to the problem and sub-step inside `step` if needed for stability.

## Engine

* `SimCore` (`engine/core.ts`) steps the model with a fixed `dt`, records samples, tracks, events,
  parameter changes and actions, evaluates thresholds and milestones, and decimates long recordings.
* `LiveRunner` (`engine/runner.ts`) drives a `SimCore` from `requestAnimationFrame`: play, pause,
  reset, step, speed, scrubbing through recorded snapshots and resuming from a past state
  (later recording is discarded). It has a per-frame compute budget, so slow models fall behind
  real time instead of freezing the page.
* `runHeadless` (`engine/headless.ts`) runs a model to completion; `runInBackground`
  (`engine/workerClient.ts`) does the same in a Web Worker with cancellation. Baselines,
  comparisons, branch envelopes and challenge verification all use it.
* Heavy non-model computations (e.g. the sea-level flood fill) are registered as named compute
  tasks in `engine/computeTasks.ts` and run with `computeInBackground`.

## Views

A view is a React component receiving `ModelViewProps` (`src/views/types.ts`). It draws
`runner.viewState` (the live head, or a recorded snapshot while scrubbing) on its own animation
loop via `CanvasStage` (2D) or `ThreeStage` (three.js) and never advances simulation time.
Colours come from `src/lib/palette.ts`.

## Adding a model

1. Create `src/models/<id>/model.ts` implementing `SimulationModel` with full documentation.
2. Add tests in `model.test.ts` comparing against closed-form or published results.
3. Write `View.tsx` and add it to `src/views/registry.ts`.
4. Add the model to `src/models/registry.ts` and its presets to the experiment catalog.
