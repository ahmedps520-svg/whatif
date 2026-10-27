import type { AssumptionKind, Provenance } from '../engine/types';

const PROV: Record<Provenance, { label: string; title: string }> = {
  simulated: { label: 'simulated', title: 'Produced by stepping the model forward in time' },
  derived: { label: 'calculated', title: 'Computed in closed form from the parameters or state' },
  data: { label: 'data', title: 'Read from an external dataset (see Data sources)' },
  assumed: { label: 'assumed', title: 'A stated assumption or input value, not a result' },
};

export function ProvBadge({ kind }: { kind: Provenance }) {
  const p = PROV[kind];
  return (
    <span className={`prov prov-${kind}`} title={p.title}>
      {p.label}
    </span>
  );
}

const KIND: Record<AssumptionKind, { label: string; title: string }> = {
  established: { label: 'established', title: 'Well-established scientific knowledge' },
  simplification: { label: 'simplification', title: 'A deliberate simplification of reality' },
  approximation: { label: 'approximation', title: 'An approximate relation or estimate' },
  speculative: { label: 'speculative', title: 'Speculative — not well constrained by evidence' },
};

export function KindBadge({ kind }: { kind: AssumptionKind }) {
  const k = KIND[kind];
  return (
    <span className={`akind akind-${kind}`} title={k.title}>
      {k.label}
    </span>
  );
}
