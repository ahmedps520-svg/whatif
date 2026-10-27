import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { getModel } from '../models/registry';
import { getView } from '../views/registry';
import { getExperiment } from '../experiments/catalog';
import { category } from '../experiments/categories';
import type { ExperimentDef } from '../experiments/types';
import type { ParamValue, ParamValues, RunRecord, SimEvent, SimulationModel } from '../engine/types';
import { defaultParams, validateParams } from '../engine/validation';
import { runInBackground, CancelledError, type Job } from '../engine/workerClient';
import { useRunner } from '../workspace/useRunner';
import { ControlBar } from '../workspace/ControlBar';
import { Timeline } from '../workspace/Timeline';
import { ParamPanel } from '../workspace/ParamPanel';
import { DerivedList, Readouts } from '../workspace/Readouts';
import { EventsList } from '../workspace/EventsList';
import { LiveCharts } from '../workspace/LiveCharts';
import { LearnTab, ScienceTab } from '../workspace/SciencePanel';
import { SaveDialog, type SaveForm } from '../workspace/SaveDialog';
import { decodeConfig, diffParams, shareUrl } from '../workspace/shareCodec';
import { putSessionRun } from '../workspace/sessionRuns';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toasts';
import { usePrefs, setPrefs } from '../store/prefs';
import { getSaved, saveExperiment } from '../store/history';
import { noteCounter, noteOpened, noteRunCompleted, noteChallenge } from '../store/activity';
import { evaluateUnlocks } from '../store/achievements';
import { getChallenge, type ChallengeResult } from '../experiments/challenges';
import { play as cue } from '../audio/sound';
import { AssistantPanel, type AssistantContext } from '../ai/AssistantPanel';
import { runToMarkdown, download, slug } from '../lib/export';
import { formatTime } from '../engine/units';

interface LabConfig {
  model: SimulationModel;
  experiment: ExperimentDef | null;
  question: string;
  name: string;
  params: ParamValues;
  baseline: ParamValues | null;
  baselineLabel?: string;
  issues: string[];
  savedId?: string;
  locked: string[];
  challengeId?: string;
  ranges?: Record<string, [number, number]>;
  initialTab?: string | null;
}

function resolveConfig(id: string | undefined, search: URLSearchParams): LabConfig | { error: string } {
  const savedId = search.get('saved');
  const cfg = search.get('cfg');
  const challengeId = search.get('challenge');
  if (savedId) {
    const s = getSaved(savedId);
    if (!s) return { error: 'That saved experiment no longer exists on this device.' };
    const model = getModel(s.modelId);
    if (!model) return { error: `The model “${s.modelId}” is not available in this version.` };
    const v = validateParams(model, s.params);
    const b = s.baseline ? validateParams(model, s.baseline).values : null;
    return {
      model,
      experiment: s.experimentId ? getExperiment(s.experimentId) ?? null : null,
      question: s.question,
      name: s.name,
      params: v.values,
      baseline: b,
      baselineLabel: s.baselineLabel,
      issues: v.issues.map((i) => i.message),
      savedId: s.id,
      locked: [],
      ranges: s.custom?.ranges,
    };
  }
  if (cfg) {
    const c = decodeConfig(cfg);
    if (!c) return { error: 'This shared link could not be read. It may be incomplete.' };
    const model = getModel(c.m);
    if (!model) return { error: `The model “${c.m}” is not available in this version.` };
    const exp = c.e ? getExperiment(c.e) ?? null : null;
    const v = validateParams(model, { ...defaultParams(model), ...c.p });
    const base = c.b !== undefined ? c.b : exp?.baseline;
    return {
      model,
      experiment: exp,
      question: c.q ?? exp?.title ?? model.name,
      name: c.n ?? exp?.title ?? model.name,
      params: v.values,
      baseline: base ? validateParams(model, base).values : null,
      baselineLabel: exp?.baselineLabel,
      issues: v.issues.map((i) => i.message),
      locked: [],
    };
  }
  const exp = id ? getExperiment(id) : undefined;
  if (!exp) return { error: 'This experiment does not exist or is not implemented yet.' };
  const model = getModel(exp.modelId)!;
  if (challengeId) {
    const ch = getChallenge(challengeId);
    if (ch && ch.experimentId === exp.id) {
      const v = validateParams(model, { ...exp.params, ...ch.fixed, ...ch.start });
      return {
        model,
        experiment: exp,
        question: ch.title,
        name: ch.title,
        params: v.values,
        baseline: null,
        issues: [],
        locked: model.params.map((p) => p.key).filter((k) => !ch.adjustable.includes(k)),
        challengeId: ch.id,
      };
    }
  }
  const v = validateParams(model, exp.params);
  return {
    model,
    experiment: exp,
    question: exp.title,
    name: exp.title,
    params: v.values,
    baseline: exp.baseline ? validateParams(model, exp.baseline).values : null,
    baselineLabel: exp.baselineLabel,
    issues: v.issues.map((i) => i.message),
    locked: [],
  };
}

type SideTab = 'params' | 'readouts' | 'events' | 'science' | 'learn';

export default function Workspace() {
  const { experimentId } = useParams();
  const [search] = useSearchParams();
  const resolved = useMemo(() => {
    const r = resolveConfig(experimentId, search);
    return 'error' in r ? r : { ...r, initialTab: search.get('tab') };
  }, [experimentId, search]);
  if ('error' in resolved) {
    return (
      <div className="page narrow">
        <div className="empty-state">
          <Icon name="warning" size={28} />
          <h1>Experiment unavailable</h1>
          <p>{resolved.error}</p>
          <Link className="btn primary" to="/library">
            Browse the library
          </Link>
        </div>
      </div>
    );
  }
  return <Prepared key={`${resolved.model.id}-${experimentId}-${search.toString()}`} config={resolved} />;
}

/** Waits for model datasets (if any) before building the runner. */
function Prepared({ config }: { config: LabConfig }) {
  const [state, setState] = useState<'loading' | 'ready' | string>(config.model.prepare ? 'loading' : 'ready');
  useEffect(() => {
    if (!config.model.prepare) return;
    let alive = true;
    config.model
      .prepare()
      .then(() => alive && setState('ready'))
      .catch((err) => alive && setState(err instanceof Error ? err.message : String(err)));
    return () => {
      alive = false;
    };
  }, [config.model]);
  if (state === 'loading')
    return (
      <div className="page narrow">
        <div className="loading-block" role="status">
          <span className="spinner" /> Loading the data this model needs…
        </div>
      </div>
    );
  if (state !== 'ready')
    return (
      <div className="page narrow">
        <div className="empty-state">
          <Icon name="warning" size={28} />
          <h1>Could not load the model’s data</h1>
          <p>{state}</p>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Try again
          </button>
        </div>
      </div>
    );
  return <Lab config={config} />;
}

function Lab({ config }: { config: LabConfig }) {
  const { model, experiment } = config;
  const prefs = usePrefs();
  const navigate = useNavigate();
  const [initial] = useState(config.params);
  const { runner, version } = useRunner(model, initial);
  const [baselineParams, setBaselineParams] = useState<ParamValues | null>(config.baseline);
  const [baselineLabel, setBaselineLabel] = useState(config.baselineLabel);
  const [showBaseline, setShowBaseline] = useState(true);
  const [baseline, setBaseline] = useState<RunRecord | null>(null);
  const [baselineState, setBaselineState] = useState<'idle' | 'running' | 'error'>('idle');
  const [tab, setTab] = useState<SideTab>(() => {
    const t = config.initialTab;
    if (t === 'science' || t === 'learn' || t === 'events' || t === 'readouts' || t === 'params') return t;
    return prefs.educationMode ? 'learn' : 'params';
  });
  const [overlays, setOverlays] = useState({ measurements: true, vectors: false });
  const [cameraResetKey, setCameraResetKey] = useState(0);
  const [saving, setSaving] = useState(false);
  const [savedId, setSavedId] = useState(config.savedId);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(config.issues.length ? config.issues.join(' ') : null);
  const [challengeResult, setChallengeResult] = useState<ChallengeResult | null>(null);
  const [verifying, setVerifying] = useState(false);
  const stageRef = useRef<HTMLDivElement>(null);
  const handledCore = useRef<unknown>(null);
  const lastEventCount = useRef(0);
  const View = getView(model.id);
  const challenge = config.challengeId ? getChallenge(config.challengeId) : undefined;
  const cat = experiment ? category(experiment.category) : null;

  useEffect(() => {
    if (experiment) noteOpened(experiment.id);
  }, [experiment]);

  // Baseline run in a background worker, matched to the current run duration.
  const duration = runner?.core.duration ?? 0;
  useEffect(() => {
    if (!baselineParams || !showBaseline || !runner) {
      setBaseline(null);
      return;
    }
    setBaselineState('running');
    const job: Job<RunRecord> = runInBackground(model.id, baselineParams, { duration, maxSamples: 3000 });
    job.promise
      .then((r) => {
        setBaseline(r);
        setBaselineState('idle');
      })
      .catch((err) => {
        if (err instanceof CancelledError) return;
        setBaselineState('error');
        console.error(err);
      });
    return () => job.cancel();
  }, [model.id, baselineParams, showBaseline, duration, runner]);

  // Completion, sounds for events, unlocks.
  useEffect(() => {
    if (!runner) return;
    const evs = runner.core.events;
    if (evs.length < lastEventCount.current) lastEventCount.current = 0;
    const fresh = evs.slice(lastEventCount.current);
    lastEventCount.current = evs.length;
    if (runner.status === 'running') {
      if (fresh.some((e) => e.severity === 'warning' || e.severity === 'critical')) cue('warning');
      else if (fresh.some((e) => e.severity === 'milestone')) cue('milestone');
    }
    if (runner.status === 'finished' && handledCore.current !== runner.core) {
      handledCore.current = runner.core;
      const record = runner.core.toRecord();
      noteRunCompleted(experiment?.id ?? null, model.id, experiment?.category ?? null);
      evaluateUnlocks(record);
      cue('complete');
    }
  }, [runner, version, experiment, model.id]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!runner) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest('input, textarea, select, [contenteditable], .modal, .assistant')) return;
      if (e.key === ' ') {
        e.preventDefault();
        runner.toggle();
        cue(runner.status === 'running' ? 'start' : 'pause');
      } else if (e.key === 'r' || e.key === 'R') runner.reset();
      else if (e.key === 'ArrowRight' && !el.closest('[role=slider]')) runner.stepForward();
      else if (e.key === 'ArrowLeft' && !el.closest('[role=slider]')) runner.stepBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [runner]);

  const onParam = useCallback(
    (key: string, value: ParamValue) => {
      if (!runner) return;
      const res = runner.setParam(key, value);
      if (res === 'reset' && runner.core.time === 0) setNotice(null);
      if (res === 'reset') {
        const def = model.params.find((p) => p.key === key);
        if (def?.kind === 'initial') toast(`${def.label} is an initial condition — the experiment restarted.`, 'info');
      }
      setChallengeResult(null);
    },
    [runner, model],
  );

  const currentRecord = (): RunRecord | null => (runner && runner.core.sampleCount > 1 ? runner.core.toRecord() : null);

  const openResults = () => {
    const record = currentRecord();
    if (!record || !runner) {
      toast('Run the experiment first — results come from the recorded run.', 'warning');
      return;
    }
    const s = putSessionRun({
      experimentId: experiment?.id ?? null,
      modelId: model.id,
      question: config.question,
      name: config.name,
      record,
      baseline: showBaseline ? baseline : null,
      baselineParams: showBaseline ? baselineParams : null,
      baselineLabel,
      experimentAssumptions: experiment?.assumptions,
      savedId,
    });
    navigate(`/results/${s.id}`);
  };

  const doSave = (f: SaveForm) => {
    if (!runner) return;
    const record = f.includeResults ? currentRecord() : null;
    const existing = savedId ? getSaved(savedId) : undefined;
    const rec = saveExperiment({
      id: existing?.id,
      name: f.name,
      question: config.question,
      experimentId: experiment?.id ?? null,
      modelId: model.id,
      params: runner.core.initialParams,
      baseline: baselineParams,
      baselineLabel,
      notes: f.notes,
      tags: f.tags,
      collectionIds: f.collectionIds,
      result: record,
      custom: existing?.custom,
    });
    setSavedId(rec.id);
    setSaving(false);
    evaluateUnlocks();
    toast('Experiment saved to your history.', 'success');
  };

  const share = async () => {
    if (!runner) return;
    const url = shareUrl({
      e: experiment?.id ?? null,
      m: model.id,
      p: diffParams(runner.core.initialParams, defaultParams(model)),
      b: baselineParams ? diffParams(baselineParams, defaultParams(model)) : null,
      q: config.question,
      n: config.name,
    });
    try {
      await navigator.clipboard.writeText(url);
      toast('Link to this configuration copied. Anyone opening it runs the same model with the same settings.', 'success');
    } catch {
      window.prompt('Copy this link to share the configuration:', url);
    }
  };

  const submitChallenge = async () => {
    if (!challenge || !runner) return;
    setVerifying(true);
    setChallengeResult(null);
    try {
      const params = runner.core.initialParams;
      const job = runInBackground(model.id, params);
      const run = await job.promise;
      const res = await challenge.verify(run, (p) => runInBackground(model.id, p).promise, params);
      setChallengeResult(res);
      noteChallenge(challenge.id, res.pass);
      evaluateUnlocks(run);
      cue(res.pass ? 'complete' : 'warning');
    } catch (err) {
      setChallengeResult({ pass: false, message: `Verification failed to run: ${err instanceof Error ? err.message : String(err)}`, details: [] });
    } finally {
      setVerifying(false);
    }
  };

  const fullscreen = () => {
    const el = stageRef.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.().catch(() => toast('Full-screen mode is not available here.', 'warning'));
  };

  const assistantContext = useCallback((): AssistantContext => {
    return {
      model,
      question: config.question,
      experiment,
      params: runner?.core.initialParams ?? config.params,
      currentParams: runner?.core.params ?? config.params,
      record: currentRecord(),
      baseline: showBaseline ? baseline : null,
      baselineLabel,
      status: runner?.status ?? 'ready',
      time: runner?.time ?? 0,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runner, model, config, experiment, baseline, showBaseline, baselineLabel, version]);

  if (!runner) return null;
  const events: SimEvent[] = runner.core.events;

  return (
    <div className={`lab ${prefs.educationMode ? 'edu' : ''}`}>
      <header className="lab-head">
        <div className="lab-title">
          <div className="crumbs">
            <Link to="/library">Library</Link>
            {cat && (
              <>
                <Icon name="chevron" size={12} />
                <Link to={`/library?category=${cat.id}`}>{cat.name}</Link>
              </>
            )}
          </div>
          <h1>{config.question}</h1>
          <p className="lab-sub">
            <span className="chip">{model.name}</span>
            {experiment && <span className={`chip diff-${experiment.difficulty}`}>{experiment.difficulty}</span>}
            {experiment?.description && <span className="muted">{experiment.description}</span>}
          </p>
        </div>
        <div className="lab-actions">
          <button className="btn secondary" onClick={() => setSaving(true)}>
            <Icon name="save" /> {savedId ? 'Update' : 'Save'}
          </button>
          <button className="btn secondary" onClick={share} title="Copy a link to this configuration">
            <Icon name="share" /> Share
          </button>
          <button className="btn secondary" onClick={openResults} title="Results and analysis of the recorded run">
            <Icon name="chart" /> Results
          </button>
          <button className={`btn secondary ${assistantOpen ? 'on' : ''}`} onClick={() => setAssistantOpen(!assistantOpen)} aria-expanded={assistantOpen}>
            <Icon name="assistant" /> Assistant
          </button>
          <button
            className={`btn-icon ${prefs.educationMode ? 'on' : ''}`}
            onClick={() => {
              setPrefs({ educationMode: !prefs.educationMode });
              if (!prefs.educationMode) setTab('learn');
            }}
            aria-pressed={prefs.educationMode}
            title="Educational mode"
          >
            <Icon name="book" />
          </button>
        </div>
      </header>

      {notice && (
        <div className="notice notice-warning" role="status">
          {notice}
          <button className="btn-icon tiny" onClick={() => setNotice(null)} aria-label="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </div>
      )}

      {challenge && (
        <section className="challenge-banner">
          <div>
            <div className="eyebrow">
              <Icon name="target" size={14} /> Challenge
            </div>
            <strong>{challenge.summary}</strong>
            <ul className="bullets small">
              {challenge.rules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
          <div className="challenge-actions">
            <button className="btn primary" onClick={submitChallenge} disabled={verifying}>
              {verifying ? <span className="spinner small" /> : <Icon name="check" />} Verify my settings
            </button>
            {challengeResult && (
              <p className={`challenge-result ${challengeResult.pass ? 'pass' : 'fail'}`} role="status">
                <Icon name={challengeResult.pass ? 'check' : 'warning'} size={14} /> {challengeResult.message}
                {challengeResult.details.map((d, i) => (
                  <span key={i} className="small muted block">
                    {d}
                  </span>
                ))}
              </p>
            )}
          </div>
        </section>
      )}

      <div className="lab-grid">
        <section className="lab-stage" aria-label="Simulation">
          <div className={`stage-box view-${model.viewKind}`} ref={stageRef}>
            {View ? (
              <Suspense
                fallback={
                  <div className="stage-loading">
                    <span className="spinner" /> Loading view…
                  </div>
                }
              >
                <View runner={runner} baseline={showBaseline ? baseline : null} overlays={overlays} version={version} cameraResetKey={cameraResetKey} />
              </Suspense>
            ) : (
              <div className="stage-loading">No visualisation for this model; see the charts below.</div>
            )}
            <div className="stage-tools" role="toolbar" aria-label="View controls">
              <button className={`btn-icon small ${overlays.measurements ? 'on' : ''}`} aria-pressed={overlays.measurements} onClick={() => setOverlays((o) => ({ ...o, measurements: !o.measurements }))} title="Measurement overlays">
                <Icon name="ruler" size={16} />
              </button>
              <button className={`btn-icon small ${overlays.vectors ? 'on' : ''}`} aria-pressed={overlays.vectors} onClick={() => setOverlays((o) => ({ ...o, vectors: !o.vectors }))} title="Vector overlays">
                <Icon name="vector" size={16} />
              </button>
              <button className="btn-icon small" onClick={() => setCameraResetKey((k) => k + 1)} title="Reset camera">
                <Icon name="camera" size={16} />
              </button>
              <button className="btn-icon small" onClick={fullscreen} title="Full screen">
                <Icon name="fullscreen" size={16} />
              </button>
            </div>
            {runner.viewIndex !== null && <div className="stage-badge">Recorded state · {formatTime(runner.time, model.time.unit)}</div>}
          </div>
          <ControlBar runner={runner} version={version} timeDependent />
          <Timeline runner={runner} version={version} baseline={showBaseline ? baseline : null} />
          <div className="baseline-bar">
            {baselineParams ? (
              <>
                <label className="check">
                  <input type="checkbox" checked={showBaseline} onChange={(e) => setShowBaseline(e.target.checked)} /> Compare with baseline: <strong>{baselineLabel ?? 'baseline settings'}</strong>
                </label>
                {baselineState === 'running' && (
                  <span className="muted small">
                    <span className="spinner small" /> computing baseline in the background…
                  </span>
                )}
                {baselineState === 'error' && <span className="small warn-text">Baseline run failed.</span>}
              </>
            ) : experiment?.baselineInternal ? (
              <span className="muted small">This experiment compares conditions inside the simulation itself.</span>
            ) : (
              <span className="muted small">No baseline for this experiment.</span>
            )}
            <button
              className="btn-text small"
              onClick={() => {
                setBaselineParams({ ...runner.core.initialParams });
                setBaselineLabel('Your settings at ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
                setShowBaseline(true);
                toast('Current settings stored as the baseline. Change parameters and run again to compare.', 'info');
              }}
              title="Use the current settings as the comparison baseline"
            >
              Set current settings as baseline
            </button>
          </div>
        </section>

        <aside className="lab-side" aria-label="Experiment panels">
          <div className="tabs" role="tablist">
            {(
              [
                ['params', 'Variables', 'sliders'],
                ['readouts', 'Readouts', 'chart'],
                ['events', `Events${events.length ? ` (${events.length})` : ''}`, 'target'],
                ['science', 'Science', 'info'],
                ['learn', 'Learn', 'book'],
              ] as [SideTab, string, string][]
            ).map(([id, label, icon]) => (
              <button
                key={id}
                role="tab"
                aria-selected={tab === id}
                className={tab === id ? 'on' : ''}
                onClick={() => {
                  setTab(id);
                  if (id === 'science') noteCounter('scienceViews');
                }}
              >
                <Icon name={icon} size={14} /> {label}
              </button>
            ))}
          </div>
          <div className="tab-body" role="tabpanel">
            {tab === 'params' && (
              <>
                <ParamPanel params={model.params} values={runner.params} baseline={showBaseline ? baselineParams : null} units={prefs.units} onChange={onParam} locked={config.locked} ranges={config.ranges} />
                <DerivedList runner={runner} version={version} units={prefs.units} />
              </>
            )}
            {tab === 'readouts' && (
              <>
                <Readouts runner={runner} version={version} units={prefs.units} baseline={showBaseline ? baseline : null} />
                <DerivedList runner={runner} version={version} units={prefs.units} />
              </>
            )}
            {tab === 'events' && <EventsList events={events} unit={model.time.unit} onSeek={(t) => runner.seekTime(t)} empty="Events appear here as the simulation reaches them." />}
            {tab === 'science' && <ScienceTab model={model} experiment={experiment} />}
            {tab === 'learn' && (
              <>
                <LearnTab model={model} experimentId={experiment?.id ?? model.id} />
                <button
                  className="btn secondary small"
                  onClick={() =>
                    download(
                      `${slug(config.question)}-summary.md`,
                      runToMarkdown({ model, question: config.question, run: currentRecord(), baseline: showBaseline ? baseline : null, baselineLabel, experimentAssumptions: experiment?.assumptions, includeEducation: true, level: prefs.level }),
                      'text/markdown',
                    )
                  }
                >
                  <Icon name="download" /> Export lesson summary
                </button>
              </>
            )}
          </div>
        </aside>

        <section className="lab-charts" aria-label="Live chart">
          <LiveCharts runner={runner} version={version} baseline={showBaseline ? baseline : null} baselineLabel={baselineLabel} units={prefs.units} />
        </section>
      </div>

      {experiment?.followUps && experiment.followUps.length > 0 && (
        <section className="followups">
          <h2 className="section-title">Try next</h2>
          <div className="chip-row">
            {experiment.followUps
              .map((id) => getExperiment(id))
              .filter((e): e is ExperimentDef => !!e)
              .map((e) => (
                <Link key={e.id} to={`/lab/${e.id}`} className="chip link">
                  {e.title}
                </Link>
              ))}
          </div>
        </section>
      )}

      {saving && (
        <SaveDialog
          initial={{ name: (savedId && getSaved(savedId)?.name) || config.name, notes: (savedId && getSaved(savedId)?.notes) || '', tags: (savedId && getSaved(savedId)?.tags) || [], collectionIds: (savedId && getSaved(savedId)?.collectionIds) || [], includeResults: true }}
          hasResults={runner.core.sampleCount > 1}
          updating={!!savedId}
          onSave={doSave}
          onClose={() => setSaving(false)}
        />
      )}
      {assistantOpen && <AssistantPanel getContext={assistantContext} onClose={() => setAssistantOpen(false)} />}
    </div>
  );
}
