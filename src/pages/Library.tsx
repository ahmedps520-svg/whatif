import { useEffect, useMemo, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { searchCatalog, suggestCatalog, type CatalogItem } from '../experiments/catalog';
import { CATEGORIES } from '../experiments/categories';
import type { CategoryId, Difficulty } from '../experiments/types';
import { ExperimentCard, PlannedCard } from '../components/ExperimentCard';
import { Icon } from '../components/Icon';
import { useActivity } from '../store/activity';

type Sort = 'relevance' | 'popular' | 'quick' | 'title';

export default function Library() {
  const [sp, setSp] = useSearchParams();
  const q = sp.get('q') ?? '';
  const cat = (sp.get('category') ?? 'all') as CategoryId | 'all';
  const diff = (sp.get('difficulty') ?? 'all') as Difficulty | 'all';
  const time = sp.get('time') ?? 'any';
  const sort = (sp.get('sort') ?? 'relevance') as Sort;
  const showPlanned = sp.get('planned') !== '0';
  const activity = useActivity();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (sp.get('focus')) inputRef.current?.focus();
  }, [sp]);

  const set = (k: string, v: string | null) => {
    const next = new URLSearchParams(sp);
    if (v === null || v === '' || v === 'all' || (k === 'time' && v === 'any') || (k === 'sort' && v === 'relevance')) next.delete(k);
    else next.set(k, v);
    next.delete('focus');
    setSp(next, { replace: true });
  };

  const items = useMemo(() => {
    let list = searchCatalog(q, { includePlanned: showPlanned, category: cat });
    if (diff !== 'all') list = list.filter((i) => i.kind === 'implemented' && i.exp.difficulty === diff);
    if (time !== 'any') {
      const max = Number(time);
      list = list.filter((i) => i.kind === 'implemented' && i.exp.estMinutes <= max);
    }
    const runs = (i: CatalogItem) => (i.kind === 'implemented' ? activity.runs[i.exp.id] ?? 0 : -1);
    if (sort === 'popular') list = [...list].sort((a, b) => runs(b) - runs(a));
    else if (sort === 'quick') list = [...list].sort((a, b) => (a.kind === 'implemented' ? a.exp.estMinutes : 999) - (b.kind === 'implemented' ? b.exp.estMinutes : 999));
    else if (sort === 'title') list = [...list].sort((a, b) => a.exp.title.localeCompare(b.exp.title));
    return list;
  }, [q, cat, diff, time, sort, showPlanned, activity.runs]);

  const implemented = items.filter((i) => i.kind === 'implemented');
  const planned = items.filter((i) => i.kind === 'planned');
  const suggestions = !items.length && q ? suggestCatalog(q) : [];

  return (
    <div className="page library">
      <header className="page-head">
        <h1>Experiment Library</h1>
        <p className="muted">Every experiment here runs a documented model. Planned scenarios are labelled and offer a science overview instead of a simulation.</p>
      </header>
      <div className="filters">
        <div className="search-box">
          <Icon name="search" />
          <input ref={inputRef} value={q} onChange={(e) => set('q', e.target.value)} placeholder="Search by question, subject or idea…" aria-label="Search experiments" type="search" />
        </div>
        <div className="chip-row" role="radiogroup" aria-label="Category">
          <button role="radio" aria-checked={cat === 'all'} className={`chip ${cat === 'all' ? 'on' : ''}`} onClick={() => set('category', 'all')}>
            All
          </button>
          {CATEGORIES.map((c) => (
            <button key={c.id} role="radio" aria-checked={cat === c.id} className={`chip ${cat === c.id ? 'on' : ''}`} onClick={() => set('category', c.id)}>
              <Icon name={c.icon} size={13} /> {c.short}
            </button>
          ))}
        </div>
        <div className="filter-row">
          <label>
            Difficulty
            <select className="select" value={diff} onChange={(e) => set('difficulty', e.target.value)}>
              <option value="all">Any</option>
              <option value="beginner">Beginner</option>
              <option value="intermediate">Intermediate</option>
              <option value="advanced">Advanced</option>
            </select>
          </label>
          <label>
            Time to explore
            <select className="select" value={time} onChange={(e) => set('time', e.target.value)}>
              <option value="any">Any</option>
              <option value="5">≤ 5 min</option>
              <option value="10">≤ 10 min</option>
              <option value="15">≤ 15 min</option>
            </select>
          </label>
          <label>
            Sort
            <select className="select" value={sort} onChange={(e) => set('sort', e.target.value)}>
              <option value="relevance">Relevance</option>
              <option value="popular">Most run on this device</option>
              <option value="quick">Quickest first</option>
              <option value="title">A–Z</option>
            </select>
          </label>
          <label className="check">
            <input type="checkbox" checked={showPlanned} onChange={(e) => set('planned', e.target.checked ? null : '0')} /> Show planned scenarios
          </label>
        </div>
      </div>

      {implemented.length > 0 && (
        <section>
          <h2 className="section-title">
            Simulations <span className="count">{implemented.length}</span>
          </h2>
          <div className="card-grid">
            {implemented.map((i) => i.kind === 'implemented' && <ExperimentCard key={i.exp.id} exp={i.exp} runs={activity.runs[i.exp.id]} />)}
          </div>
        </section>
      )}
      {planned.length > 0 && (
        <section>
          <h2 className="section-title">
            Planned scenarios <span className="count">{planned.length}</span>
          </h2>
          <p className="muted small">Not simulated yet. Each explains the established science and what model it would need.</p>
          <div className="card-grid">
            {planned.map((i) => i.kind === 'planned' && <PlannedCard key={i.exp.id} exp={i.exp} />)}
          </div>
        </section>
      )}
      {!items.length && (
        <div className="empty-state">
          <h2>No experiment matches “{q}”</h2>
          {suggestions.length > 0 && (
            <>
              <p>Closest matches:</p>
              <div className="card-grid">{suggestions.map((i) => (i.kind === 'implemented' ? <ExperimentCard key={i.exp.id} exp={i.exp} /> : <PlannedCard key={i.exp.id} exp={i.exp} />))}</div>
            </>
          )}
          <p>
            You can also check whether an existing model can answer it in the <Link to={`/builder?q=${encodeURIComponent(q)}`}>Scenario Builder</Link>.
          </p>
        </div>
      )}
    </div>
  );
}
