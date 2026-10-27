import { useEffect } from 'react';
import { observable, useObservable } from '../store/observable';
import { useUnlockFeed, unlockFeed } from '../store/achievements';
import { Icon } from './Icon';
import { play } from '../audio/sound';

export interface Toast {
  id: number;
  message: string;
  kind: 'info' | 'success' | 'warning' | 'error';
}

const toasts = observable<Toast[]>([]);
let next = 1;

export function toast(message: string, kind: Toast['kind'] = 'info') {
  const id = next++;
  toasts.set((t) => [...t, { id, message, kind }].slice(-4));
  setTimeout(() => toasts.set((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4200);
}

/** Toasts and unlock notifications; announced to screen readers via aria-live. */
export function ToastLayer() {
  const list = useObservable(toasts);
  const unlocks = useUnlockFeed();
  useEffect(() => {
    if (!unlocks.length) return;
    play('unlock');
    const timer = setTimeout(() => unlockFeed.set((f) => f.slice(1)), 5200);
    return () => clearTimeout(timer);
  }, [unlocks]);
  const u = unlocks[0];
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {u && (
        <div className="toast toast-unlock" role="status">
          <Icon name={u.kind === 'achievement' ? 'trophy' : 'sparkles'} />
          <div>
            <div className="toast-title">{u.kind === 'achievement' ? 'Achievement unlocked' : 'Discovery recorded'}: {u.title}</div>
            <div className="toast-body">{u.description}</div>
          </div>
          <button className="btn-icon tiny" aria-label="Dismiss" onClick={() => unlockFeed.set((f) => f.slice(1))}>
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={t.kind === 'success' ? 'check' : t.kind === 'info' ? 'info' : 'warning'} />
          <span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}
