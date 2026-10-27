import { Modal } from './Modal';
import { observable, useObservable } from '../store/observable';

interface Request {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}

const current = observable<Request | null>(null);

/** In-page confirmation (browser confirm() dialogs are blocked in some hosts). */
export function confirmAction(opts: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  return new Promise((resolve) => {
    current.get()?.resolve(false);
    current.set({ confirmLabel: 'Confirm', ...opts, resolve });
  });
}

export function ConfirmLayer() {
  const req = useObservable(current);
  if (!req) return null;
  const done = (ok: boolean) => {
    current.set(null);
    req.resolve(ok);
  };
  return (
    <Modal title={req.title} onClose={() => done(false)}>
      <p>{req.message}</p>
      <div className="form-actions">
        <button className="btn secondary" onClick={() => done(false)}>
          Cancel
        </button>
        <button className={`btn ${req.danger ? 'secondary danger' : 'primary'}`} onClick={() => done(true)}>
          {req.confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
