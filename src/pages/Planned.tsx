import { Link, useParams } from 'react-router-dom';
import { getExperiment, getPlanned } from '../experiments/catalog';
import { category } from '../experiments/categories';
import { Icon } from '../components/Icon';

export default function Planned() {
  const { id } = useParams();
  const p = id ? getPlanned(id) : undefined;
  if (!p)
    return (
      <div className="page narrow empty-state">
        <h1>Scenario not found</h1>
        <Link to="/library" className="btn primary">
          Library
        </Link>
      </div>
    );
  const cat = category(p.category);
  const related = (p.relatedIds ?? []).map((r) => getExperiment(r)).filter(Boolean);
  return (
    <div className="page narrow planned-page">
      <div className="crumbs">
        <Link to="/library">Library</Link> <Icon name="chevron" size={12} /> <Link to={`/library?category=${cat.id}`}>{cat.name}</Link>
      </div>
      <span className="badge-planned">Planned — not simulated yet</span>
      <h1>{p.title}</h1>
      <p className="lead">{p.description}</p>
      <section className="panel">
        <h2 className="subhead">What established science says</h2>
        <p className="prose">{p.overview}</p>
      </section>
      <section className="panel">
        <h2 className="subhead">Why there is no simulation yet</h2>
        <p className="prose">{p.needs}</p>
        <p className="small muted">WHAT IF LAB only offers a RUN button when a documented model actually computes the result. Inventing an answer would be worse than none.</p>
      </section>
      {related.length > 0 && (
        <section>
          <h2 className="subhead">Related experiments you can run</h2>
          <div className="chip-row">
            {related.map((e) => (
              <Link key={e!.id} to={`/lab/${e!.id}`} className="chip link">
                {e!.title}
              </Link>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
