# WHAT IF LAB

**Change the rules. Explore the consequences.**

WHAT IF LAB is an interactive simulation platform for hypothetical scenarios in physics, space, Earth systems, biology, technology and human civilization. You configure a scenario, press RUN, watch the model evolve, inspect the results, and compare against a baseline.

Every number the app shows comes from a documented model calculation or an identified dataset. Each value is labelled as *simulated*, *calculated* (closed form), *data* or *assumed*. Each assumption is tagged as *established*, *simplification*, *approximation* or *speculative*. Scenarios that cannot be modelled reliably yet are listed as **planned**, with a science overview and no RUN button.

## Running it

```bash
npm install
npm run dev        # http://localhost:5173
npm test           # model, engine, catalog and challenge tests (vitest)
npm run build      # typecheck + production build into dist/
```

The build is a static site (hash routing, relative paths), so it can be hosted from any path. It needs no server and no API keys.

## What is implemented

| Model | Experiments | Method |
|---|---|---|
| Gravity & Projectile Lab (2D) | Sandbox; gravity off for 5 s; friction disappears; atmosphere twice as dense; objects twice as heavy | RK4 with quadratic drag; impulse contacts with restitution and Coulomb friction |
| Two-World Gravity Comparison | Earth's gravity doubled; Moon-strength gravity; everything twice as heavy | Two worlds stepped side by side; jump model; vis-viva orbital consequences |
| Planetary Orbit Explorer (3D) | Sandbox; Earth closer to the Sun; Sun's mass doubled; elliptical orbit | Adaptive symplectic leapfrog N-body; energy-error readout |
| Earth and its Moons (3D) | Two moons; Moon disappears; gravity doubled (Moon's orbit) | N-body with Earth wobble, tides, Roche limit |
| Asteroid Approach (3D) | Asteroid approach; impact energy | Hyperbolic N-body; gravitational focusing; Collins et al. (2005) crater scaling (approximate) |
| Planet Lab (3D globe) | Sandbox; faster rotation; axial tilt; brighter Sun; stronger gravity; Mars; more ocean | Derived planetary quantities, energy balance, insolation by latitude and season |
| Sea-Level Rise Mapper | +100 m; all polar ice; Greenland | NOAA ETOPO1 0.25° grid; Priority-Flood hydrological connectivity in a web worker |
| Atmospheric Oxygen Model | Half the oxygen; 30 % oxygen | Dalton's law, alveolar gas equation, ICAO standard atmosphere |
| Population & Resource Simulator | Sandbox; population doubled; fusion power | Stock-and-flow model with explicit feedbacks (RK4) |
| Wide-Area Blackout Scenario | Electricity disappears; well-prepared backup | Branching system-dynamics model with an uncertainty envelope across branches |

Twenty more scenarios from the brief are listed as planned. Examples are a slower speed of light, the magnetic field disappearing, 200-year lifespans and space elevators. Each states what model it would need.

## Features

- **Workspace:** play / pause / reset / step / speed controls and a scrubbable timeline with event and milestone markers. Changing a parameter during a run applies it from that moment (live), restarts the run (initial conditions) or affects the next object (spawn). It also has live readouts, closed-form derived quantities, validity warnings, and a chart against a baseline run computed in a background worker.
- **Results:** key results, parameter and final-state tables against the baseline, a chart for every observable, difference charts, recorded paths, an events list, assumptions and limitations. Export to JSON, CSV, Markdown or print/PDF.
- **Compare:** up to four saved or session runs on shared scales, with difference charts.
- **History:** saved experiments (IndexedDB, falling back to localStorage) with notes, tags, collections, rename, duplicate, delete, import and export.
- **Scenario Builder:** question → domain → compatible model → variables and ranges → duration → run. If no model fits, it says so.
- **Educational mode:** learning objectives, explanations at three levels, guided steps, questions, and exportable lesson summaries.
- **Discoveries & challenges:**
  - Discoveries unlock only when your recorded run actually shows the principle.
  - Each weekly challenge re-runs the model with your settings for a reproducible check. There are no rankings.
- **AI assistant (optional):** uses your own Anthropic API key from the browser. It receives the experiment's documentation, parameters and recorded results with each question. The system prompt tells it not to invent results and to separate established science, simulation output, estimates and speculation. Without a key, a built-in guide generated from the model documentation is available instead, clearly labelled as not AI.
- **Sharing:** links encode the full configuration in the URL.
- **Sound:** optional, subtle, off by default, and never the only signal.
- **Units:** imperial display, with the models still computing in SI.
- **Layout:** works from desktop down to a 360 px phone.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Each model is pure logic (`src/models/<id>/model.ts`) implementing one contract: parameters with units and kinds, observables with provenance, fixed-step `step`, events and thresholds, assumptions, limitations, equations and education content. The same model code runs:

- live in the workspace (`LiveRunner`, with a per-frame compute budget so slow models fall behind instead of freezing the page);
- headless in a Web Worker (baselines, comparisons, branch envelopes, challenge verification);
- in unit tests against closed-form or published results.

## Data sources

- **Elevation:** NOAA ETOPO1 Global Relief Model (Ice Surface) by Amante & Eakins (2009), via NOAA CoastWatch ERDDAP. It is sampled every 0.25° and stored in `public/data/`. Rebuild it with `npm run data:etopo`. It is NOAA data, free to use and redistribute, and not intended for legal use.
- **Reference values:** planetary values follow the NASA Planetary Fact Sheet, and demographic defaults are rounded from UN World Population Prospects. Other reference values are cited in each model's documentation.
