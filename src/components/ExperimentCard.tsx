import { Link } from 'react-router-dom';
import type { ExperimentDef, PlannedExperiment } from '../experiments/types';
import { category } from '../experiments/categories';
import { getModel } from '../models/registry';
import { Icon } from './Icon';

export function ExperimentCard({ exp, runs, note }: { exp: ExperimentDef; runs?: number; note?: string }) {
  const cat = category(exp.category);
  const model = getModel(exp.modelId);
  return (
    <Link to={`/lab/${exp.id}`} className="xcard">
      <div className="xcard-top">
        <span className={`cat-chip cat-${exp.category}`}>
          <Icon name={cat.icon} size={13} /> {cat.short}
        </span>
        <span className={`diff diff-${exp.difficulty}`}>{exp.difficulty}</span>
      </div>
      <h3 className="xcard-title">{exp.title}</h3>
      <p className="xcard-desc">{exp.description}</p>
      <div className="xcard-meta">
        <span title="Simulation model">
          <Icon name="flask" size={13} /> {model?.shortName ?? model?.name}
        </span>
        <span title="Estimated time to explore">≈ {exp.estMinutes} min</span>
        {runs !== undefined && runs > 0 && <span title="Completed runs on this device">{runs} run{runs === 1 ? '' : 's'}</span>}
      </div>
      {note && <div className="xcard-note">{note}</div>}
    </Link>
  );
}

export function PlannedCard({ exp }: { exp: PlannedExperiment }) {
  const cat = category(exp.category);
  return (
    <Link to={`/planned/${exp.id}`} className="xcard planned">
      <div className="xcard-top">
        <span className={`cat-chip cat-${exp.category}`}>
          <Icon name={cat.icon} size={13} /> {cat.short}
        </span>
        <span className="badge-planned">Planned</span>
      </div>
      <h3 className="xcard-title">{exp.title}</h3>
      <p className="xcard-desc">{exp.description}</p>
      <div className="xcard-meta">
        <span>Not simulated yet · science overview available</span>
      </div>
    </Link>
  );
}
