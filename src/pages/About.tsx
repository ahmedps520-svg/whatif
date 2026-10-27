import { Link } from 'react-router-dom';
import { MODELS } from '../models/registry';
import { experimentsForModel } from '../experiments/catalog';
import { KindBadge, ProvBadge } from '../components/Provenance';

export default function About() {
  return (
    <div className="page narrow about">
      <header className="page-head">
        <h1>Models, data &amp; methods</h1>
        <p className="lead">WHAT IF LAB respects the difference between a calculation, an approximation and speculation. This page documents how.</p>
      </header>

      <section className="panel">
        <h2 className="subhead">How a simulation runs</h2>
        <ul className="bullets">
          <li>Each model is pure logic — initial conditions, parameters, rules and observables — separate from its visualisation. The same code runs live in the workspace, headless in a background worker (baselines, comparisons, challenge checks), and in automated tests.</li>
          <li>Time advances in fixed steps chosen for the model’s numerics, independent of the screen’s frame rate. If a frame’s compute budget runs out the run falls behind real time instead of freezing the page, and you can stop it.</li>
          <li>Every sample is recorded with a snapshot of the state. Scrubbing the timeline restores recorded states; nothing is integrated backwards. Resuming from the past discards the later recording.</li>
          <li>Parameters are validated and clamped to supported ranges; non-finite results stop the run with a visible event rather than producing garbage.</li>
        </ul>
        <h3 className="subhead">Labels you will see</h3>
        <p className="small">
          <ProvBadge kind="simulated" /> produced by stepping the model · <ProvBadge kind="derived" /> computed in closed form · <ProvBadge kind="data" /> read from a dataset · <ProvBadge kind="assumed" /> an input or stated assumption
        </p>
        <p className="small">
          <KindBadge kind="established" /> <KindBadge kind="simplification" /> <KindBadge kind="approximation" /> <KindBadge kind="speculative" /> tag every assumption.
        </p>
      </section>

      <section>
        <h2 className="section-title">Implemented models</h2>
        {MODELS.map((m) => (
          <article key={m.id} className="panel model-doc">
            <h3>{m.name}</h3>
            <p>{m.summary}</p>
            <p className="small muted">
              {m.params.length} parameters · {m.observables.length} observables · {m.assumptions.length} documented assumptions · {m.limitations.length} limitations
            </p>
            {m.dataSources?.map((d) => (
              <p key={d.name} className="small">
                Data: {d.name} — {d.provider}.{' '}
                <a href={d.url} target="_blank" rel="noreferrer">
                  Source
                </a>
              </p>
            ))}
            <div className="chip-row">
              {experimentsForModel(m.id).map((e) => (
                <Link key={e.id} to={`/lab/${e.id}`} className="chip link">
                  {e.title}
                </Link>
              ))}
            </div>
          </article>
        ))}
      </section>

      <section className="panel">
        <h2 className="subhead">Keyboard shortcuts in experiments</h2>
        <ul className="bullets small">
          <li>
            <kbd>Space</kbd> play / pause · <kbd>R</kbd> reset · <kbd>←</kbd> <kbd>→</kbd> step through recorded samples
          </li>
          <li>Drag on a chart or the timeline to inspect a recorded moment.</li>
        </ul>
      </section>
    </div>
  );
}
