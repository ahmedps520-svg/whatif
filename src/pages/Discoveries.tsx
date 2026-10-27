import { Link } from 'react-router-dom';
import { ACHIEVEMENTS, DISCOVERIES } from '../store/achievements';
import { useActivity } from '../store/activity';
import { useExperiments } from '../store/history';
import { CHALLENGES, weeklyChallenge } from '../experiments/challenges';
import { getExperiment } from '../experiments/catalog';
import { Icon } from '../components/Icon';

export default function Discoveries() {
  const a = useActivity();
  const saved = useExperiments();
  const weekly = weeklyChallenge();
  return (
    <div className="page discoveries">
      <header className="page-head">
        <h1>Discoveries &amp; challenges</h1>
        <p className="muted">Optional milestones for exploring science. Everything here is computed from your own runs on this device — there are no leaderboards.</p>
      </header>

      <section>
        <h2 className="section-title">Weekly challenge</h2>
        <div className="challenge-card panel">
          <div>
            <div className="eyebrow">
              <Icon name="target" size={14} /> This week
            </div>
            <h3>{weekly.title}</h3>
            <p>{weekly.summary}</p>
            <ul className="bullets small">
              {weekly.rules.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </div>
          <Link className="btn primary" to={`/lab/${weekly.experimentId}?challenge=${weekly.id}`}>
            {a.challenges[weekly.id]?.passedAt ? 'Solved — try again' : 'Take the challenge'}
          </Link>
        </div>
        <h3 className="subhead">All challenges</h3>
        <ul className="challenge-list">
          {CHALLENGES.map((c) => {
            const st = a.challenges[c.id];
            return (
              <li key={c.id} className="panel">
                <div>
                  <strong>{c.title}</strong>
                  <p className="small muted">{c.summary}</p>
                  <p className="small">
                    {st?.passedAt ? (
                      <span className="ok-text">
                        <Icon name="check" size={12} /> Solved {new Date(st.passedAt).toLocaleDateString()}
                      </span>
                    ) : st ? (
                      `${st.attempts} attempt${st.attempts === 1 ? '' : 's'}`
                    ) : (
                      'Not attempted'
                    )}{' '}
                    · uses {getExperiment(c.experimentId)?.title}
                  </p>
                </div>
                <Link className="btn secondary small" to={`/lab/${c.experimentId}?challenge=${c.id}`}>
                  Open
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h2 className="section-title">Discoveries</h2>
        <p className="small muted">A discovery unlocks when one of your runs actually shows the principle — the app checks the recorded results.</p>
        <div className="card-grid">
          {DISCOVERIES.map((d) => {
            const at = a.discoveries[d.id];
            return (
              <article key={d.id} className={`ach ${at ? 'unlocked' : 'locked'}`}>
                <Icon name="sparkles" size={20} />
                <h3>{at ? d.title : 'Undiscovered'}</h3>
                <p className="small">{at ? d.insight : `Hint: ${d.hint}`}</p>
                {at && <p className="small muted">Discovered {new Date(at).toLocaleDateString()}</p>}
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <h2 className="section-title">Achievements</h2>
        <div className="card-grid">
          {ACHIEVEMENTS.map((x) => {
            const [cur, target] = x.progress(a, saved.length);
            const at = a.unlocked[x.id];
            return (
              <article key={x.id} className={`ach ${at ? 'unlocked' : 'locked'}`}>
                <Icon name="trophy" size={20} />
                <h3>{x.title}</h3>
                <p className="small">{x.description}</p>
                <div className="meter" role="progressbar" aria-valuemin={0} aria-valuemax={target} aria-valuenow={cur} aria-label={`${x.title} progress`}>
                  <span style={{ width: `${(cur / target) * 100}%` }} />
                </div>
                <p className="small muted">
                  {cur} / {target}
                  {at ? ` · unlocked ${new Date(at).toLocaleDateString()}` : ''}
                </p>
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
