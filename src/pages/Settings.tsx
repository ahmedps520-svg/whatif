import { useState } from 'react';
import { getApiKey, setApiKey, setPrefs, usePrefs } from '../store/prefs';
import { storageBackend, storageError } from '../store/persist';
import { resetActivity } from '../store/activity';
import { deleteExperiment, getExperiments } from '../store/history';
import { toast } from '../components/Toasts';
import { play } from '../audio/sound';
import { confirmAction } from '../components/Confirm';
import { IS_ARTIFACT } from '../lib/target';
import { FullSiteNote } from '../components/FullSiteNote';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (default)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
];

export default function Settings() {
  const prefs = usePrefs();
  const [key, setKey] = useState('');
  const hasKey = !!getApiKey();
  return (
    <div className="page narrow settings">
      <header className="page-head">
        <h1>Settings</h1>
      </header>

      <section className="panel">
        <h2 className="subhead">Sound</h2>
        <label className="toggle">
          <input type="checkbox" checked={prefs.sound} onChange={(e) => setPrefs({ sound: e.target.checked })} />
          <span className="toggle-track" />
          <span>Interface sounds (start, pause, milestones, completion)</span>
        </label>
        <label className="field">
          <span>Volume</span>
          <input type="range" min={0} max={1} step={0.05} value={prefs.volume} onChange={(e) => setPrefs({ volume: Number(e.target.value) })} onPointerUp={() => play('milestone')} disabled={!prefs.sound} />
        </label>
        <p className="small muted">Sounds are subtle and never the only way an event is shown.</p>
      </section>

      <section className="panel">
        <h2 className="subhead">Display</h2>
        <label className="field">
          <span>Units</span>
          <select className="select" value={prefs.units} onChange={(e) => setPrefs({ units: e.target.value as 'metric' | 'imperial' })}>
            <option value="metric">Metric (SI)</option>
            <option value="imperial">Imperial where available (models still compute in SI)</option>
          </select>
        </label>
        <label className="field">
          <span>Explanation level</span>
          <select className="select" value={prefs.level} onChange={(e) => setPrefs({ level: e.target.value as typeof prefs.level })}>
            <option value="beginner">Beginner</option>
            <option value="intermediate">Intermediate</option>
            <option value="advanced">Advanced</option>
          </select>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={prefs.educationMode} onChange={(e) => setPrefs({ educationMode: e.target.checked })} />
          <span className="toggle-track" />
          <span>Educational mode (opens experiments on the Learn panel with guided steps)</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={prefs.reduceMotion} onChange={(e) => setPrefs({ reduceMotion: e.target.checked })} />
          <span className="toggle-track" />
          <span>Reduce motion (no automatic carousel or preview animation)</span>
        </label>
      </section>

      <section className="panel">
        <h2 className="subhead">AI assistant (optional)</h2>
        {IS_ARTIFACT && <FullSiteNote text="The AI assistant is available" />}
        <p className="small">
          The assistant calls the Anthropic API directly from your browser with your own key. It receives the current experiment’s documentation, parameters and recorded results when you ask a question. The rest of WHAT IF LAB works without it.
        </p>
        <label className="toggle">
          <input type="checkbox" checked={prefs.aiEnabled} onChange={(e) => setPrefs({ aiEnabled: e.target.checked })} />
          <span className="toggle-track" />
          <span>Enable the AI assistant</span>
        </label>
        <label className="field">
          <span>Model</span>
          <select className="select" value={prefs.aiModel} onChange={(e) => setPrefs({ aiModel: e.target.value })}>
            {MODELS.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <form
          className="inline-form"
          onSubmit={(e) => {
            e.preventDefault();
            setApiKey(key.trim(), prefs.rememberKey);
            setKey('');
            setPrefs({ aiEnabled: true });
            toast('API key stored.', 'success');
          }}
        >
          <input type="password" autoComplete="off" placeholder={hasKey ? 'A key is set — enter a new one to replace it' : 'Anthropic API key (sk-ant-…)'} value={key} onChange={(e) => setKey(e.target.value)} aria-label="Anthropic API key" />
          <button className="btn secondary" type="submit" disabled={!key.trim()}>
            Save key
          </button>
        </form>
        <label className="check">
          <input
            type="checkbox"
            checked={prefs.rememberKey}
            onChange={(e) => {
              setPrefs({ rememberKey: e.target.checked });
              const k = getApiKey();
              if (k) setApiKey(k, e.target.checked);
            }}
          />
          Remember the key on this device (otherwise only for this tab session)
        </label>
        {hasKey && (
          <button
            className="btn-text small danger"
            onClick={() => {
              setApiKey('', false);
              toast('API key removed.', 'info');
            }}
          >
            Remove stored key
          </button>
        )}
      </section>

      <section className="panel">
        <h2 className="subhead">Storage</h2>
        <p className="small">
          Saved experiments are stored in this browser using <strong>{storageBackend() === 'indexeddb' ? 'IndexedDB' : storageBackend() === 'localstorage' ? 'localStorage' : 'memory only (not persistent)'}</strong>.
          {storageError() && <span className="warn-text"> Last storage error: {storageError()}</span>}
        </p>
        <div className="toolbar">
          <button
            className="btn secondary"
            onClick={async () => {
              if (await confirmAction({ title: 'Reset activity', message: 'Reset achievements, discoveries, recent items and run counts?', confirmLabel: 'Reset', danger: true })) {
                resetActivity();
                toast('Activity reset.', 'info');
              }
            }}
          >
            Reset activity
          </button>
          <button
            className="btn secondary danger"
            onClick={async () => {
              if (await confirmAction({ title: 'Delete all saved experiments', message: 'Delete every saved experiment on this device? Export them from History first if you want to keep them.', confirmLabel: 'Delete all', danger: true })) {
                for (const e of getExperiments()) deleteExperiment(e.id);
                toast('All saved experiments deleted.', 'info');
              }
            }}
          >
            Delete all saved experiments
          </button>
        </div>
      </section>
    </div>
  );
}
