import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  createCollection,
  deleteCollection,
  deleteExperiment,
  duplicateExperiment,
  importExperiments,
  toggleInCollection,
  toggleLibraryInCollection,
  updateCollection,
  updateExperiment,
  useCollections,
  useExperiments,
  type SavedExperiment,
} from '../store/history';
import { getModel } from '../models/registry';
import { EXPERIMENTS, getExperiment } from '../experiments/catalog';
import { Icon } from '../components/Icon';
import { toast } from '../components/Toasts';
import { download, runToMarkdown, slug } from '../lib/export';
import { usePrefs } from '../store/prefs';
import { confirmAction } from '../components/Confirm';
import { IS_ARTIFACT } from '../lib/target';
import { FullSiteNote } from '../components/FullSiteNote';

function exportOne(s: SavedExperiment) {
  download(`${slug(s.name)}.whatif.json`, JSON.stringify({ format: 'what-if-lab/experiment@1', ...s }, null, 1));
}

function Row({ s, selected, onSelect }: { s: SavedExperiment; selected: boolean; onSelect: () => void }) {
  const model = getModel(s.modelId);
  const collections = useCollections();
  const prefs = usePrefs();
  const navigate = useNavigate();
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(s.name);
  const [open, setOpen] = useState(false);
  const [notes, setNotes] = useState(s.notes);
  const [tags, setTags] = useState(s.tags.join(', '));
  const lab = `/lab/${s.experimentId ?? 'custom'}?saved=${s.id}`;
  return (
    <li className={`hist-row ${selected ? 'selected' : ''}`}>
      <div className="hist-main">
        <label className="check" title="Select for comparison">
          <input type="checkbox" checked={selected} onChange={onSelect} disabled={!s.result} />
          <span className="sr-only">Select {s.name}</span>
        </label>
        <div className="hist-text">
          {renaming ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                updateExperiment(s.id, { name: name.trim() || s.name });
                setRenaming(false);
              }}
            >
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus onBlur={() => setRenaming(false)} aria-label="New name" />
            </form>
          ) : (
            <Link to={lab} className="hist-name">
              {s.name}
            </Link>
          )}
          <div className="small muted">
            {s.question !== s.name && <>{s.question} · </>}
            {model?.name ?? s.modelId} · created {new Date(s.createdAt).toLocaleString()} · modified {new Date(s.updatedAt).toLocaleString()}
          </div>
          <div className="chip-row tight">
            {s.result ? <span className="chip small ok">results saved</span> : <span className="chip small">configuration only</span>}
            {s.tags.map((t) => (
              <span key={t} className="chip small">
                #{t}
              </span>
            ))}
            {s.collectionIds.map((c) => {
              const col = collections.find((x) => x.id === c);
              return col ? (
                <span key={c} className="chip small">
                  <Icon name="folder" size={11} /> {col.name}
                </span>
              ) : null;
            })}
          </div>
        </div>
        <div className="hist-actions">
          <Link className="btn-icon" to={lab} title="Resume / change parameters">
            <Icon name="play" size={16} />
          </Link>
          {s.result && (
            <Link className="btn-icon" to={`/results/${s.id}`} title="Results">
              <Icon name="chart" size={16} />
            </Link>
          )}
          <button className="btn-icon" title="Rename" onClick={() => setRenaming(true)}>
            <Icon name="edit" size={16} />
          </button>
          <button
            className="btn-icon"
            title="Duplicate"
            onClick={() => {
              const d = duplicateExperiment(s.id);
              if (d) toast(`Duplicated as “${d.name}”.`, 'success');
            }}
          >
            <Icon name="copy" size={16} />
          </button>
          <button className="btn-icon" title="Notes, tags and collections" aria-expanded={open} onClick={() => setOpen(!open)}>
            <Icon name="book" size={16} />
          </button>
          {!IS_ARTIFACT && (
            <button className="btn-icon" title="Export" onClick={() => exportOne(s)}>
              <Icon name="download" size={16} />
            </button>
          )}
          <button
            className="btn-icon danger"
            title="Delete"
            onClick={async () => {
              if (await confirmAction({ title: 'Delete experiment', message: `Delete “${s.name}”? This cannot be undone.`, confirmLabel: 'Delete', danger: true })) {
                deleteExperiment(s.id);
                toast('Deleted.', 'info');
              }
            }}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </div>
      {open && (
        <div className="hist-details">
          <label className="field">
            <span>Notes</span>
            <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => updateExperiment(s.id, { notes })} />
          </label>
          <label className="field">
            <span>Tags</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => updateExperiment(s.id, { tags: tags.split(',').map((t) => t.trim()).filter(Boolean) })} />
          </label>
          <div className="field">
            <span>Collections</span>
            <div className="check-grid">
              {collections.map((c) => (
                <label key={c.id} className="check">
                  <input type="checkbox" checked={s.collectionIds.includes(c.id)} onChange={() => toggleInCollection(s.id, c.id)} /> {c.name}
                </label>
              ))}
            </div>
          </div>
          {model && !IS_ARTIFACT && (
            <button className="btn secondary small" onClick={() => download(`${slug(s.name)}.md`, runToMarkdown({ model, question: s.question, run: s.result, notes: s.notes, includeEducation: prefs.educationMode, level: prefs.level }), 'text/markdown')}>
              <Icon name="download" /> Export summary (.md)
            </button>
          )}
          <button className="btn-text small" onClick={() => navigate(lab)}>
            Open in the workspace to change parameters →
          </button>
        </div>
      )}
    </li>
  );
}

export default function History() {
  const experiments = useExperiments();
  const collections = useCollections();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [col, setCol] = useState<string>('all');
  const [sel, setSel] = useState<string[]>([]);
  const [newCol, setNewCol] = useState('');
  const [addExp, setAddExp] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const current = collections.find((c) => c.id === col);

  const list = useMemo(() => {
    const term = q.toLowerCase();
    return experiments.filter((e) => (col === 'all' || e.collectionIds.includes(col)) && (!term || `${e.name} ${e.question} ${e.tags.join(' ')} ${e.notes}`.toLowerCase().includes(term)));
  }, [experiments, q, col]);

  return (
    <div className="page history">
      <header className="page-head">
        <h1>Experiment history</h1>
        <p className="muted">Your saved experiments and collections, stored in this browser.</p>
        {IS_ARTIFACT && <FullSiteNote text="Exports are available" />}
        <div className="toolbar">
          <button className="btn secondary" disabled={sel.length < 2} onClick={() => navigate(`/compare?runs=${sel.join(',')}`)}>
            <Icon name="compare" /> Compare selected ({sel.length})
          </button>
          <button className="btn secondary" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" /> Import
          </button>
          {!IS_ARTIFACT && (
            <button className="btn secondary" disabled={!experiments.length} onClick={() => download('what-if-lab-history.json', JSON.stringify({ format: 'what-if-lab/history@1', experiments, collections }, null, 1))}>
              <Icon name="download" /> Export all
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={async (e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              try {
                const data = JSON.parse(await f.text());
                const n = importExperiments(Array.isArray(data?.experiments) ? data.experiments : data);
                toast(n ? `Imported ${n} experiment${n === 1 ? '' : 's'}.` : 'No experiments found in that file.', n ? 'success' : 'warning');
              } catch {
                toast('That file is not a WHAT IF LAB export.', 'error');
              }
            }}
          />
        </div>
      </header>

      <div className="history-layout">
        <aside className="panel collections">
          <h2 className="subhead">Collections</h2>
          <ul className="col-list">
            <li>
              <button className={col === 'all' ? 'on' : ''} onClick={() => setCol('all')}>
                All experiments <span className="count">{experiments.length}</span>
              </button>
            </li>
            {collections.map((c) => (
              <li key={c.id}>
                <button className={col === c.id ? 'on' : ''} onClick={() => setCol(c.id)}>
                  <Icon name="folder" size={14} /> {c.name} <span className="count">{experiments.filter((e) => e.collectionIds.includes(c.id)).length + c.experimentIds.length}</span>
                </button>
              </li>
            ))}
          </ul>
          <form
            className="inline-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (!newCol.trim()) return;
              const c = createCollection(newCol);
              setNewCol('');
              setCol(c.id);
            }}
          >
            <input value={newCol} onChange={(e) => setNewCol(e.target.value)} placeholder="New collection" aria-label="New collection name" />
            <button className="btn-icon" type="submit" aria-label="Create collection">
              <Icon name="plus" />
            </button>
          </form>
        </aside>

        <section className="history-main">
          {current && (
            <div className="panel collection-head">
              <input className="title-input" value={current.name} onChange={(e) => updateCollection(current.id, { name: e.target.value })} aria-label="Collection name" />
              <textarea rows={2} value={current.description} onChange={(e) => updateCollection(current.id, { description: e.target.value })} placeholder="Description (e.g. lesson plan)" aria-label="Collection description" />
              <div className="small">
                <strong>Library experiments in this collection</strong> (for lessons and projects):
                <div className="chip-row">
                  {current.experimentIds.map((id) => {
                    const e = getExperiment(id);
                    return e ? (
                      <span key={id} className="chip">
                        <Link to={`/lab/${id}`}>{e.title}</Link>
                        <button className="btn-icon tiny" aria-label="Remove" onClick={() => toggleLibraryInCollection(id, current.id)}>
                          <Icon name="close" size={11} />
                        </button>
                      </span>
                    ) : null;
                  })}
                </div>
                <div className="inline-form">
                  <select className="select" value={addExp} onChange={(e) => setAddExp(e.target.value)} aria-label="Add a library experiment">
                    <option value="">Add a library experiment…</option>
                    {EXPERIMENTS.filter((e) => !current.experimentIds.includes(e.id)).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.title}
                      </option>
                    ))}
                  </select>
                  <button
                    className="btn secondary small"
                    disabled={!addExp}
                    onClick={() => {
                      toggleLibraryInCollection(addExp, current.id);
                      setAddExp('');
                    }}
                  >
                    Add
                  </button>
                </div>
              </div>
              <button
                className="btn-text small danger"
                onClick={async () => {
                  if (await confirmAction({ title: 'Delete collection', message: `Delete the collection “${current.name}”? Experiments in it are kept.`, confirmLabel: 'Delete', danger: true })) {
                    deleteCollection(current.id);
                    setCol('all');
                  }
                }}
              >
                Delete collection
              </button>
            </div>
          )}
          <div className="search-box">
            <Icon name="search" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter by name, question, tag or note" aria-label="Filter history" />
          </div>
          {list.length ? (
            <ul className="hist-list">
              {list.map((s) => (
                <Row key={s.id} s={s} selected={sel.includes(s.id)} onSelect={() => setSel((x) => (x.includes(s.id) ? x.filter((i) => i !== s.id) : [...x, s.id].slice(-4)))} />
              ))}
            </ul>
          ) : (
            <div className="empty-state">
              <p>{experiments.length ? 'No saved experiments match.' : 'No saved experiments yet. Use Save in any experiment.'}</p>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
