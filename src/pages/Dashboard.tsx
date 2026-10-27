import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { EXPERIMENTS, PLANNED, getExperiment } from '../experiments/catalog';
import { CATEGORIES } from '../experiments/categories';
import type { ExperimentDef } from '../experiments/types';
import { ExperimentCard } from '../components/ExperimentCard';
import { FeaturedPreview } from '../components/FeaturedPreview';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { useActivity } from '../store/activity';
import { useExperiments } from '../store/history';
import { usePrefs } from '../store/prefs';
import { ACHIEVEMENTS, DISCOVERIES } from '../store/achievements';
import { weeklyChallenge } from '../experiments/challenges';
import { getModel } from '../models/registry';

function useFeatured(): ExperimentDef[] {
  return useMemo(() => {
    const list = EXPERIMENTS.filter((e) => e.featured);
    // Rotate the starting point daily so the dashboard changes over time.
    const day = Math.floor(Date.now() / 86400000);
    const k = list.length ? day % list.length : 0;
    return [...list.slice(k), ...list.slice(0, k)];
  }, []);
}

function Featured() {
  const featured = useFeatured();
  const prefs = usePrefs();
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused || prefs.reduceMotion || featured.length < 2) return;
    const t = setTimeout(() => setI((x) => (x + 1) % featured.length), 11000);
    return () => clearTimeout(t);
  }, [i, paused, featured.length, prefs.reduceMotion]);
  if (!featured.length) return null;
  const exp = featured[i];
  const model = getModel(exp.modelId)!;
  return (
    <section className="featured" aria-roledescription="carousel" aria-label="Featured experiments" onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)} onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div className="featured-text">
        <div className="eyebrow">
          <span className="pulse" /> Featured experiment
        </div>
        <h2 className="featured-title">{exp.title}</h2>
        <p className="featured-desc">{exp.description}</p>
        <p className="featured-model">
          <Icon name="flask" size={14} /> {model.name}
        </p>
        <div className="featured-actions">
          <Link to={`/lab/${exp.id}`} className="btn primary big">
            <Icon name="play" /> RUN SIMULATION
          </Link>
          <Link to={`/lab/${exp.id}?tab=science`} className="btn secondary big">
            <Icon name="book" /> EXPLORE THE SCIENCE
          </Link>
        </div>
        <div className="carousel-dots" role="tablist" aria-label="Choose featured experiment">
          {featured.map((f, k) => (
            <button key={f.id} role="tab" aria-selected={k === i} aria-label={f.title} className={k === i ? 'on' : ''} onClick={() => setI(k)} />
          ))}
        </div>
      </div>
      <div className="featured-visual">
        <FeaturedPreview key={exp.id} exp={exp} reduceMotion={prefs.reduceMotion} />
      </div>
    </section>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const activity = useActivity();
  const saved = useExperiments();
  const challenge = weeklyChallenge();

  const recent = activity.recent
    .map((r) => getExperiment(r.experimentId))
    .filter((e): e is ExperimentDef => !!e)
    .slice(0, 4);
  const trending = Object.entries(activity.runs)
    .sort((a, b) => b[1] - a[1])
    .map(([id, n]) => ({ exp: getExperiment(id), n }))
    .filter((x): x is { exp: ExperimentDef; n: number } => !!x.exp)
    .slice(0, 4);

  const recommended = useMemo(() => {
    const seen = new Set(activity.recent.map((r) => r.experimentId));
    const out: { exp: ExperimentDef; why: string }[] = [];
    for (const r of activity.recent.slice(0, 6)) {
      const e = getExperiment(r.experimentId);
      for (const f of e?.followUps ?? []) {
        const fe = getExperiment(f);
        if (fe && !seen.has(fe.id) && !out.some((o) => o.exp.id === fe.id)) out.push({ exp: fe, why: `Because you explored “${e!.title}”` });
      }
    }
    const explored = new Set(Object.keys(activity.categoryRuns));
    for (const c of CATEGORIES) {
      if (explored.has(c.id)) continue;
      const e = EXPERIMENTS.find((x) => x.category === c.id && !seen.has(x.id) && !out.some((o) => o.exp.id === x.id));
      if (e) out.push({ exp: e, why: `You haven’t tried ${c.name} yet` });
    }
    for (const e of EXPERIMENTS) if (out.length < 4 && !seen.has(e.id) && !out.some((o) => o.exp.id === e.id) && e.difficulty === 'beginner') out.push({ exp: e, why: 'A good starting point' });
    return out.slice(0, 4);
  }, [activity]);

  const unlocked = [
    ...Object.entries(activity.discoveries).map(([id, at]) => ({ at, kind: 'discovery' as const, item: DISCOVERIES.find((d) => d.id === id) })),
    ...Object.entries(activity.unlocked).map(([id, at]) => ({ at, kind: 'achievement' as const, item: ACHIEVEMENTS.find((a) => a.id === id) })),
  ]
    .filter((x) => x.item)
    .sort((a, b) => b.at - a.at)
    .slice(0, 4);

  return (
    <div className="page dashboard">
      <section className="hero">
        <div className="hero-brand">
          <Logo size={56} />
          <div>
            <h1 className="hero-title">
              WHAT IF <span>LAB</span>
            </h1>
            <p className="hero-tag">Change the rules. Explore the consequences.</p>
          </div>
        </div>
        <form
          className="hero-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(`/library?q=${encodeURIComponent(q)}`);
          }}
        >
          <Icon name="search" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="What if… the Moon disappeared? gravity doubled? the seas rose 100 m?" aria-label="Search for a hypothetical question" />
          <button className="btn primary" type="submit">
            Search
          </button>
        </form>
        <div className="hero-actions">
          <Link to="/builder" className="btn accent">
            <Icon name="plus" /> Create Experiment
          </Link>
          <span className="muted small">
            {EXPERIMENTS.length} working simulations · {PLANNED.length} planned scenarios with science overviews
          </span>
        </div>
      </section>

      <Featured />

      <div className="dash-grid">
        <section className="panel">
          <header className="panel-head">
            <h2>
              <Icon name="history" /> Recently explored
            </h2>
            <Link to="/history" className="small">
              History
            </Link>
          </header>
          {recent.length ? (
            <ul className="mini-list">
              {recent.map((e) => (
                <li key={e.id}>
                  <Link to={`/lab/${e.id}`}>{e.title}</Link>
                  <span className="muted small">{getModel(e.modelId)?.shortName}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Nothing yet — open any experiment to start.</p>
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>
              <Icon name="chart" /> Trending on this device
            </h2>
          </header>
          {trending.length ? (
            <ul className="mini-list">
              {trending.map(({ exp, n }) => (
                <li key={exp.id}>
                  <Link to={`/lab/${exp.id}`}>{exp.title}</Link>
                  <span className="muted small mono">{n}×</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Your most-run experiments appear here. WHAT IF LAB has no server, so popularity is measured on this device only.</p>
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>
              <Icon name="save" /> Saved experiments
            </h2>
            <Link to="/history" className="small">
              All
            </Link>
          </header>
          {saved.length ? (
            <ul className="mini-list">
              {saved.slice(0, 4).map((s) => (
                <li key={s.id}>
                  <Link to={`/lab/${s.experimentId ?? 'custom'}?saved=${s.id}`}>{s.name}</Link>
                  <span className="muted small">{new Date(s.updatedAt).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Save a run from any experiment to build your personal library.</p>
          )}
        </section>

        <section className="panel">
          <header className="panel-head">
            <h2>
              <Icon name="sparkles" /> Recently unlocked
            </h2>
            <Link to="/discoveries" className="small">
              Discoveries
            </Link>
          </header>
          {unlocked.length ? (
            <ul className="mini-list">
              {unlocked.map((u) => (
                <li key={u.item!.id}>
                  <span>
                    <Icon name={u.kind === 'discovery' ? 'sparkles' : 'trophy'} size={13} /> {u.item!.title}
                  </span>
                  <span className="muted small">{new Date(u.at).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted small">Discoveries unlock when your own runs reveal a principle — for example two masses landing together in a vacuum.</p>
          )}
        </section>
      </div>

      <section>
        <h2 className="section-title">Recommended for you</h2>
        <div className="card-grid">
          {recommended.map((r) => (
            <ExperimentCard key={r.exp.id} exp={r.exp} note={r.why} />
          ))}
        </div>
      </section>

      <section className="challenge-card panel">
        <div>
          <div className="eyebrow">
            <Icon name="target" size={14} /> Weekly challenge
          </div>
          <h2>{challenge.title}</h2>
          <p>{challenge.summary}</p>
          <p className="small muted">An educational challenge with fixed rules and a reproducible check — not a competition.</p>
        </div>
        <Link to={`/lab/${challenge.experimentId}?challenge=${challenge.id}`} className="btn primary">
          Take the challenge
        </Link>
      </section>

      <section>
        <h2 className="section-title">Categories</h2>
        <div className="cat-grid">
          {CATEGORIES.map((c) => {
            const n = EXPERIMENTS.filter((e) => e.category === c.id).length;
            const p = PLANNED.filter((e) => e.category === c.id).length;
            return (
              <Link key={c.id} to={`/library?category=${c.id}`} className={`cat-tile cat-${c.id}`}>
                <Icon name={c.icon} size={22} />
                <div>
                  <h3>{c.name}</h3>
                  <p className="small muted">{c.description}</p>
                  <p className="small">
                    {n} simulated{p ? ` · ${p} planned` : ''}
                  </p>
                </div>
              </Link>
            );
          })}
        </div>
      </section>
    </div>
  );
}
