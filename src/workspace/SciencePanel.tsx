import { useState } from 'react';
import type { ExplanationLevel, SimulationModel } from '../engine/types';
import type { ExperimentDef } from '../experiments/types';
import { KindBadge } from '../components/Provenance';
import { setPrefs, usePrefs } from '../store/prefs';

export function ScienceTab({ model, experiment }: { model: SimulationModel; experiment?: ExperimentDef | null }) {
  return (
    <div className="science">
      {experiment?.assumptions && experiment.assumptions.length > 0 && (
        <section>
          <h4 className="subhead">How this question is interpreted</h4>
          <ul className="bullets">
            {experiment.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      )}
      <section>
        <h4 className="subhead">Model assumptions</h4>
        <ul className="assumptions">
          {model.assumptions.map((a, i) => (
            <li key={i}>
              <KindBadge kind={a.kind} /> {a.text}
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="subhead">Equations used</h4>
        <dl className="equations">
          {model.equations.map((e, i) => (
            <div key={i} className="equation">
              <dt>{e.label}</dt>
              <dd className="formula">{e.formula}</dd>
              <dd>{e.explanation}</dd>
            </div>
          ))}
        </dl>
      </section>
      <section>
        <h4 className="subhead">Limitations</h4>
        <ul className="bullets">
          {model.limitations.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      </section>
      {model.dataSources && model.dataSources.length > 0 && (
        <section>
          <h4 className="subhead">Data sources</h4>
          {model.dataSources.map((d) => (
            <div key={d.name} className="source">
              <strong>{d.name}</strong> — {d.provider}
              <div className="small">{d.citation}</div>
              <div className="small muted">{d.license}</div>
              {d.notes && <div className="small muted">{d.notes}</div>}
              <a href={d.url} target="_blank" rel="noreferrer" className="small">
                {d.url}
              </a>
            </div>
          ))}
        </section>
      )}
      <p className="small muted">
        A simplified model is a tool for reasoning, not a complete picture of reality. Realistic graphics do not make a model accurate; its assumptions do.
      </p>
    </div>
  );
}

const LEVELS: ExplanationLevel[] = ['beginner', 'intermediate', 'advanced'];

export function LearnTab({ model, experimentId }: { model: SimulationModel; experimentId: string }) {
  const prefs = usePrefs();
  const ed = model.education;
  const storageKey = `whatif:steps:${experimentId}`;
  const [done, setDone] = useState<number[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '[]');
    } catch {
      return [];
    }
  });
  const toggle = (i: number) => {
    const next = done.includes(i) ? done.filter((x) => x !== i) : [...done, i];
    setDone(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* per-viewer convenience only */
    }
  };
  return (
    <div className="learn">
      <div className="segmented small" role="radiogroup" aria-label="Explanation level">
        {LEVELS.map((l) => (
          <button key={l} role="radio" aria-checked={prefs.level === l} className={prefs.level === l ? 'on' : ''} onClick={() => setPrefs({ level: l })}>
            {l[0].toUpperCase() + l.slice(1)}
          </button>
        ))}
      </div>
      <section>
        <h4 className="subhead">Learning objectives</h4>
        <ul className="bullets">
          {ed.objectives.map((o, i) => (
            <li key={i}>{o}</li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="subhead">Background</h4>
        <p className="prose">{ed.background[prefs.level]}</p>
      </section>
      <section>
        <h4 className="subhead">Guided steps</h4>
        <ol className="steps">
          {ed.guidedSteps.map((s, i) => (
            <li key={i} className={done.includes(i) ? 'done' : ''}>
              <label>
                <input type="checkbox" checked={done.includes(i)} onChange={() => toggle(i)} /> {s}
              </label>
            </li>
          ))}
        </ol>
      </section>
      <section>
        <h4 className="subhead">Questions to consider</h4>
        <ul className="bullets">
          {ed.questions.map((q, i) => (
            <li key={i}>{q}</li>
          ))}
        </ul>
      </section>
      <section>
        <h4 className="subhead">Variables</h4>
        <dl className="variables">
          {ed.variables.map((v) => (
            <div key={v.symbol}>
              <dt className="mono">{v.symbol}</dt>
              <dd>
                {v.meaning}
                {v.unit && <span className="muted"> ({v.unit})</span>}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </div>
  );
}
