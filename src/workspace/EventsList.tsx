import type { SimEvent } from '../engine/types';
import { formatTime, type UnitId } from '../engine/units';
import { Icon } from '../components/Icon';

const ICON: Record<SimEvent['severity'], string> = { info: 'info', milestone: 'target', warning: 'warning', critical: 'warning' };
const LABEL: Record<SimEvent['severity'], string> = { info: 'Event', milestone: 'Milestone', warning: 'Threshold', critical: 'Critical' };

export function EventsList({ events, unit, onSeek, currentT, empty = 'No events yet.' }: { events: SimEvent[]; unit: UnitId; onSeek?: (t: number) => void; currentT?: number; empty?: string }) {
  if (!events.length) return <p className="muted small pad">{empty}</p>;
  return (
    <ol className="events">
      {events.map((e, i) => {
        const future = currentT !== undefined && e.t > currentT + 1e-9;
        return (
          <li key={`${e.id}-${i}`} className={`event sev-${e.severity} ${future ? 'future' : ''}`}>
            <button className="event-btn" onClick={() => onSeek?.(e.t)} disabled={!onSeek} title={onSeek ? 'Jump to this moment' : undefined}>
              <span className="event-icon" aria-label={LABEL[e.severity]}>
                <Icon name={ICON[e.severity]} size={14} />
              </span>
              <span className="event-time mono">{formatTime(e.t, unit)}</span>
              <span className="event-body">
                <span className="event-label">{e.label}</span>
                {e.detail && <span className="event-detail">{e.detail}</span>}
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
