import { Icon } from '../components/Icon';
import { SPEEDS, type LiveRunner } from '../engine/runner';
import { formatTime } from '../engine/units';
import { play as cue } from '../audio/sound';

interface Props {
  runner: LiveRunner;
  version: number;
  timeDependent: boolean;
}

/** PLAY / PAUSE / RESET / STEP / SPEED / time display, plus model actions. */
export function ControlBar({ runner, timeDependent }: Props) {
  const unit = runner.model.time.unit;
  const status = runner.status;
  const scrubbing = runner.viewIndex !== null;
  const running = status === 'running';
  const pct = Math.min(100, (runner.core.time / runner.core.duration) * 100);

  const toggle = () => {
    if (running) {
      runner.pause();
      cue('pause');
    } else {
      runner.play();
      cue('start');
    }
  };

  return (
    <div className="controlbar" role="toolbar" aria-label="Simulation controls">
      <div className="cb-group">
        <button
          className={`btn-icon primary big ${running ? 'is-on' : ''}`}
          onClick={toggle}
          disabled={status === 'finished' && !scrubbing}
          aria-label={running ? 'Pause' : 'Play'}
          title={running ? 'Pause (Space)' : scrubbing ? 'Resume from this point (later recording is replaced)' : 'Play (Space)'}
        >
          <Icon name={running ? 'pause' : 'play'} size={22} />
          <span className="cb-label">{running ? 'PAUSE' : status === 'ready' ? 'RUN' : 'PLAY'}</span>
        </button>
        <button className="btn-icon" onClick={() => { runner.reset(); cue('pause'); }} aria-label="Reset" title="Reset to the initial state (R)">
          <Icon name="reset" />
        </button>
        {timeDependent && (
          <>
            <button className="btn-icon" onClick={() => runner.stepBack()} aria-label="Step back" title="Step back one recorded sample (←)" disabled={runner.core.sampleCount < 2}>
              <Icon name="stepb" />
            </button>
            <button className="btn-icon" onClick={() => { runner.stepForward(); cue('step'); }} aria-label="Step forward" title="Step forward one recording interval (→)" disabled={status === 'finished' && !scrubbing}>
              <Icon name="stepf" />
            </button>
          </>
        )}
      </div>

      {timeDependent && (
        <label className="cb-speed" title="Playback speed">
          <span className="sr-only">Speed</span>
          <Icon name="live" size={16} />
          <select value={runner.speed} onChange={(e) => runner.setSpeed(Number(e.target.value))} aria-label="Playback speed">
            {SPEEDS.map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </label>
      )}

      <div className="cb-time" aria-live="off">
        <div className="cb-time-main">
          <span className="mono">{formatTime(runner.time, unit)}</span>
          <span className="muted"> / {formatTime(runner.core.duration, unit)}</span>
        </div>
        <div className="cb-progress" aria-hidden="true">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      <div className="cb-status">
        {scrubbing ? (
          <button className="chip chip-warn" onClick={() => runner.goLive()} title="Return to the latest simulated state">
            <Icon name="history" size={14} /> Viewing recorded state · back to live
          </button>
        ) : (
          <span className={`chip status-${status}`}>
            <span className="dot" />
            {status === 'ready' ? 'Ready' : status === 'running' ? (runner.lagging ? 'Running (slower than requested)' : 'Running') : status === 'paused' ? 'Paused' : 'Finished'}
          </span>
        )}
        {running && runner.lagging && (
          <button className="btn-text small" onClick={() => runner.stop()} title="Stop this run and keep the results so far">
            <Icon name="stop" size={12} /> Stop
          </button>
        )}
      </div>

      {runner.model.actions && runner.model.actions.length > 0 && (
        <div className="cb-actions">
          {runner.model.actions.map((a) => (
            <button key={a.id} className="btn secondary small" onClick={() => { runner.action(a.id); cue('step'); }} title={a.description}>
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
