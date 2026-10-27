import { useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { MODELS, getModel } from '../models/registry';
import { searchCatalog, suggestCatalog, experimentsForModel } from '../experiments/catalog';
import type { Domain, NumberParamDef, ParamValue, ParamValues, SimulationModel } from '../engine/types';
import { defaultParams, validateParams } from '../engine/validation';
import { ParamPanel } from '../workspace/ParamPanel';
import { Icon } from '../components/Icon';
import { saveExperiment } from '../store/history';
import { noteCounter } from '../store/activity';
import { evaluateUnlocks } from '../store/achievements';
import { usePrefs } from '../store/prefs';
import { unitSymbol } from '../engine/units';

const DOMAINS: { id: Domain; label: string; icon: string; hint: string }[] = [
  { id: 'physics', label: 'Physics', icon: 'atom', hint: 'Motion, forces, gravity, energy' },
  { id: 'astronomy', label: 'Astronomy', icon: 'orbit', hint: 'Orbits, planets, moons, impacts' },
  { id: 'earth', label: 'Earth systems', icon: 'globe', hint: 'Oceans, atmosphere, climate' },
  { id: 'biology', label: 'Biology', icon: 'leaf', hint: 'Organisms and their energy budgets' },
  { id: 'population', label: 'Population', icon: 'city', hint: 'People, resources, infrastructure' },
  { id: 'economics', label: 'Economics', icon: 'chart', hint: 'Markets, prices, labour' },
  { id: 'technology', label: 'Technology', icon: 'spark', hint: 'Engineering and future technology' },
];

const STEPS = ['Question', 'Domain', 'Model', 'Variables', 'Duration', 'Run'];

export default function Builder() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const prefs = usePrefs();
  const [step, setStep] = useState(0);
  const [question, setQuestion] = useState(sp.get('q') ?? '');
  const [domain, setDomain] = useState<Domain | null>(null);
  const [modelId, setModelId] = useState<string | null>(null);
  const [params, setParams] = useState<ParamValues>({});
  const [useBaseline, setUseBaseline] = useState(true);
  const [baseline, setBaseline] = useState<ParamValues>({});
  const [ranges, setRanges] = useState<Record<string, [number, number]>>({});
  const model: SimulationModel | undefined = modelId ? getModel(modelId) : undefined;

  const matches = useMemo(() => {
    const scores = new Map<string, number>();
    for (const item of searchCatalog(question, { includePlanned: false })) {
      if (item.kind === 'implemented') scores.set(item.exp.modelId, (scores.get(item.exp.modelId) ?? 0) + 2);
    }
    for (const item of suggestCatalog(question, 8)) if (item.kind === 'implemented') scores.set(item.exp.modelId, (scores.get(item.exp.modelId) ?? 0) + 1);
    const inDomain = MODELS.filter((m) => m.domain === domain);
    const ranked = MODELS.map((m) => ({ m, score: (scores.get(m.id) ?? 0) + (m.domain === domain ? 3 : 0) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return { ranked, inDomain };
  }, [question, domain]);

  const plannedHints = useMemo(() => suggestCatalog(question, 6).filter((i) => i.kind === 'planned'), [question]);

  const chooseModel = (m: SimulationModel) => {
    setModelId(m.id);
    const d = defaultParams(m);
    setParams(d);
    setBaseline(d);
    setRanges({});
    setStep(3);
  };

  const timeParams = model ? model.params.filter((p) => p.numerics || p.key === model.time.durationParam) : [];
  const physicalParams = model ? model.params.filter((p) => !timeParams.includes(p)) : [];

  const run = () => {
    if (!model) return;
    const v = validateParams(model, params).values;
    const rec = saveExperiment({
      name: question.trim() || `Custom ${model.name} scenario`,
      question: question.trim() || `Custom ${model.name} scenario`,
      experimentId: null,
      modelId: model.id,
      params: v,
      baseline: useBaseline ? validateParams(model, baseline).values : null,
      baselineLabel: useBaseline ? 'Your baseline settings' : undefined,
      notes: '',
      tags: ['custom'],
      collectionIds: [],
      result: null,
      custom: { domain: domain ?? model.domain, ranges },
    });
    noteCounter('builderScenarios');
    evaluateUnlocks();
    navigate(`/lab/custom?saved=${rec.id}`);
  };

  const canNext = [question.trim().length > 3, !!domain, !!model, !!model, !!model, !!model][step];

  return (
    <div className="page builder">
      <header className="page-head">
        <h1>Scenario Builder</h1>
        <p className="muted">Turn your own question into an experiment by configuring an existing, documented model. If no model fits, the builder says so instead of pretending.</p>
      </header>
      <ol className="stepper" aria-label="Steps">
        {STEPS.map((s, i) => (
          <li key={s} className={i === step ? 'on' : i < step ? 'done' : ''}>
            <button onClick={() => (i <= step || (i === step + 1 && canNext) ? setStep(i) : undefined)} disabled={i > step && !(i === step + 1 && canNext)}>
              <span className="step-n">{i < step ? <Icon name="check" size={12} /> : i + 1}</span> {s}
            </button>
          </li>
        ))}
      </ol>

      <section className="panel builder-step">
        {step === 0 && (
          <>
            <h2>1 · Define the question</h2>
            <label className="field">
              <span>What if…</span>
              <input value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="What if Earth rotated twice as fast?" autoFocus />
            </label>
            <p className="small muted">Be specific about what changes. The builder will look for models whose variables can represent the change.</p>
          </>
        )}
        {step === 1 && (
          <>
            <h2>2 · Select the simulation domain</h2>
            <div className="domain-grid">
              {DOMAINS.map((d) => {
                const n = MODELS.filter((m) => m.domain === d.id).length;
                return (
                  <button key={d.id} className={`domain ${domain === d.id ? 'on' : ''}`} onClick={() => setDomain(d.id)} aria-pressed={domain === d.id}>
                    <Icon name={d.icon} size={22} />
                    <strong>{d.label}</strong>
                    <span className="small muted">{d.hint}</span>
                    <span className="small">{n ? `${n} model${n > 1 ? 's' : ''}` : 'no models yet'}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {step === 2 && (
          <>
            <h2>3 · Choose a compatible model</h2>
            {matches.ranked.length === 0 ? (
              <div className="notice notice-warning">
                <strong>This scenario needs a new model.</strong> None of the implemented models can represent “{question}” in the {DOMAINS.find((d) => d.id === domain)?.label} domain. WHAT IF LAB will not invent a simulation for it.
              </div>
            ) : (
              <p className="small muted">Ranked by how well each model matches your question and domain. Check that its variables can actually express the change you have in mind.</p>
            )}
            <div className="model-list">
              {matches.ranked.map(({ m }) => (
                <article key={m.id} className={`model-card ${modelId === m.id ? 'on' : ''}`}>
                  <h3>{m.name}</h3>
                  <p className="small">{m.summary}</p>
                  <p className="small muted">
                    Variables: {m.params.filter((p) => !p.numerics).map((p) => p.label).slice(0, 10).join(', ')}
                    {m.params.length > 10 ? '…' : ''}
                  </p>
                  <p className="small muted">Used by: {experimentsForModel(m.id).map((e) => e.title).slice(0, 3).join(' · ')}</p>
                  <button className="btn primary small" onClick={() => chooseModel(m)}>
                    Configure this model
                  </button>
                </article>
              ))}
            </div>
            {matches.ranked.length > 0 && matches.inDomain.length === 0 && <p className="small muted">No model belongs to this domain yet; the matches above come from other domains.</p>}
            {plannedHints.length > 0 && (
              <div className="panel inset">
                <h3 className="subhead">Related planned scenarios (science overview only)</h3>
                <ul className="bullets small">
                  {plannedHints.map((p) => (
                    <li key={p.exp.id}>
                      <Link to={`/planned/${p.exp.id}`}>{p.exp.title}</Link>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
        {step === 3 && model && (
          <>
            <h2>4 · Configure variables</h2>
            <p className="small muted">Set the experimental values. Optionally narrow a slider’s range for your scenario, and define the baseline you want to compare against.</p>
            <div className="two-col">
              <div>
                <h3 className="subhead">Experimental conditions</h3>
                <ParamPanel params={physicalParams} values={{ ...defaultParams(model), ...params }} units={prefs.units} onChange={(k: string, v: ParamValue) => setParams((p) => ({ ...p, [k]: v }))} ranges={ranges} />
                <details className="panel inset">
                  <summary>Variable ranges (optional)</summary>
                  <table className="kv-table small">
                    <tbody>
                      {physicalParams
                        .filter((p): p is NumberParamDef => p.type === 'number')
                        .map((p) => (
                          <tr key={p.key}>
                            <th>
                              {p.label} {unitSymbol(p.unit) && <span className="muted">({unitSymbol(p.unit)})</span>}
                            </th>
                            <td>
                              <input
                                type="number"
                                step="any"
                                aria-label={`${p.label} minimum`}
                                value={ranges[p.key]?.[0] ?? p.min}
                                min={p.min}
                                max={p.max}
                                onChange={(e) => setRanges((r) => ({ ...r, [p.key]: [Math.max(p.min, Number(e.target.value)), r[p.key]?.[1] ?? p.max] }))}
                              />
                            </td>
                            <td>
                              <input
                                type="number"
                                step="any"
                                aria-label={`${p.label} maximum`}
                                value={ranges[p.key]?.[1] ?? p.max}
                                min={p.min}
                                max={p.max}
                                onChange={(e) => setRanges((r) => ({ ...r, [p.key]: [r[p.key]?.[0] ?? p.min, Math.min(p.max, Number(e.target.value))] }))}
                              />
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </details>
              </div>
              <div>
                <label className="check">
                  <input type="checkbox" checked={useBaseline} onChange={(e) => setUseBaseline(e.target.checked)} /> Compare against a baseline
                </label>
                {useBaseline && (
                  <>
                    <h3 className="subhead">Baseline conditions</h3>
                    <ParamPanel params={physicalParams} values={{ ...defaultParams(model), ...baseline }} units={prefs.units} onChange={(k: string, v: ParamValue) => setBaseline((p) => ({ ...p, [k]: v }))} compact />
                  </>
                )}
              </div>
            </div>
          </>
        )}
        {step === 4 && model && (
          <>
            <h2>5 · Define the duration</h2>
            {timeParams.length ? (
              <ParamPanel params={timeParams.map((p) => ({ ...p, numerics: false }))} values={{ ...defaultParams(model), ...params }} units={prefs.units} onChange={(k: string, v: ParamValue) => setParams((p) => ({ ...p, [k]: v }))} />
            ) : (
              <p>This model runs for its default span of simulated time.</p>
            )}
            <p className="small muted">Smaller time steps are more accurate but slower. The engine stops runs that would take too long and lets you stop them yourself.</p>
          </>
        )}
        {step === 5 && model && (
          <>
            <h2>6 · Run the experiment</h2>
            <p>
              <strong>{question || 'Custom scenario'}</strong> — using the <strong>{model.name}</strong>.
            </p>
            <p className="small muted">The scenario is saved to your history so you can revisit it. The workspace will show the model’s results, graphs and assumptions.</p>
            <ul className="bullets small">
              {model.assumptions.slice(0, 4).map((a, i) => (
                <li key={i}>
                  ({a.kind}) {a.text}
                </li>
              ))}
            </ul>
            <button className="btn primary big" onClick={run}>
              <Icon name="play" /> Save &amp; run
            </button>
          </>
        )}
      </section>

      <div className="builder-nav">
        <button className="btn secondary" disabled={step === 0} onClick={() => setStep(step - 1)}>
          Back
        </button>
        {step < 5 && step !== 2 && (
          <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
      </div>
    </div>
  );
}
