import { useState } from 'react';
import { Modal } from '../components/Modal';
import { useCollections } from '../store/history';
import { storageBackend } from '../store/persist';

export interface SaveForm {
  name: string;
  notes: string;
  tags: string[];
  collectionIds: string[];
  includeResults: boolean;
}

export function SaveDialog({ initial, hasResults, onSave, onClose, updating }: { initial: SaveForm; hasResults: boolean; onSave: (f: SaveForm) => void; onClose: () => void; updating?: boolean }) {
  const [f, setF] = useState(initial);
  const [tagText, setTagText] = useState(initial.tags.join(', '));
  const collections = useCollections();
  return (
    <Modal title={updating ? 'Update saved experiment' : 'Save experiment'} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          onSave({ ...f, tags: tagText.split(',').map((t) => t.trim()).filter(Boolean) });
        }}
      >
        <label className="field">
          <span>Name</span>
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required maxLength={120} />
        </label>
        <label className="field">
          <span>Notes</span>
          <textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} rows={4} placeholder="What did you change, and what did you notice?" />
        </label>
        <label className="field">
          <span>Tags (comma separated)</span>
          <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="gravity, homework" />
        </label>
        <fieldset className="field">
          <legend>Collections</legend>
          <div className="check-grid">
            {collections.map((c) => (
              <label key={c.id} className="check">
                <input
                  type="checkbox"
                  checked={f.collectionIds.includes(c.id)}
                  onChange={(e) => setF({ ...f, collectionIds: e.target.checked ? [...f.collectionIds, c.id] : f.collectionIds.filter((x) => x !== c.id) })}
                />
                {c.name}
              </label>
            ))}
          </div>
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={f.includeResults && hasResults} disabled={!hasResults} onChange={(e) => setF({ ...f, includeResults: e.target.checked })} />
          Include the recorded results {hasResults ? '' : '(run the experiment first)'}
        </label>
        <div className="form-actions">
          <button type="button" className="btn secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn primary">
            {updating ? 'Update' : 'Save'}
          </button>
        </div>
        <p className="small muted">{storageBackend() === 'memory' ? 'Storage is unavailable in this browser, so saved experiments last only until you close the tab.' : 'Saved on this device. Export from History to keep a copy elsewhere.'}</p>
      </form>
    </Modal>
  );
}
