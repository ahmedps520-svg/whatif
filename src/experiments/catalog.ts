import type { CategoryId, ExperimentDef, PlannedExperiment } from './types';
import { PLANNED } from './planned';
import { CATEGORIES } from './categories';
import { getModel } from '../models/registry';
import { experiments as projectile } from '../models/projectile/experiments';
import { experiments as gravityCompare } from '../models/gravity-compare/experiments';
import { experiments as orbitExplorer } from '../models/orbit-explorer/experiments';
import { experiments as moons } from '../models/moons/experiments';
import { experiments as asteroid } from '../models/asteroid/experiments';
import { experiments as planet } from '../models/planet/experiments';
import { experiments as seaLevel } from '../models/sea-level/experiments';
import { experiments as atmosphere } from '../models/atmosphere/experiments';
import { experiments as population } from '../models/population/experiments';
import { experiments as blackout } from '../models/blackout/experiments';
import { experiments as photosynthesis } from '../models/photosynthesis/experiments';

/** Implemented experiments, in library order. Only experiments whose model is registered are listed. */
export const EXPERIMENTS: ExperimentDef[] = [
  ...gravityCompare,
  ...projectile,
  ...orbitExplorer,
  ...moons,
  ...asteroid,
  ...planet,
  ...seaLevel,
  ...atmosphere,
  ...photosynthesis,
  ...population,
  ...blackout,
].filter((e) => !!getModel(e.modelId));

export { PLANNED };

const byId = new Map(EXPERIMENTS.map((e) => [e.id, e]));
const plannedById = new Map(PLANNED.map((p) => [p.id, p]));

export function getExperiment(id: string): ExperimentDef | undefined {
  return byId.get(id);
}

export function getPlanned(id: string): PlannedExperiment | undefined {
  return plannedById.get(id);
}

export function experimentsForModel(modelId: string): ExperimentDef[] {
  return EXPERIMENTS.filter((e) => e.modelId === modelId);
}

export type CatalogItem = { kind: 'implemented'; exp: ExperimentDef } | { kind: 'planned'; exp: PlannedExperiment };

function normalize(s: string) {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9.]+/g, ' ')
    .trim();
}

const STOP = new Set(['what', 'if', 'the', 'a', 'an', 'of', 'to', 'would', 'happen', 'could', 'were', 'was', 'is', 'and', 'in', 'on', 'by', 'for', 'had', 'did', 'does', 'do', 'be']);

function haystack(item: CatalogItem): { text: string; title: string } {
  const e = item.exp;
  const cat = CATEGORIES.find((c) => c.id === e.category)?.name ?? '';
  const model = item.kind === 'implemented' ? getModel(item.exp.modelId) : undefined;
  const extra = item.kind === 'planned' ? item.exp.overview : `${model?.name ?? ''} ${model?.summary ?? ''}`;
  return { title: normalize(e.title), text: normalize(`${e.title} ${e.description} ${e.tags.join(' ')} ${cat} ${extra}`) };
}

/**
 * Keyword search over titles, descriptions, subjects and model names.
 * Title matches rank above body matches; implemented experiments rank above planned ones.
 */
export function searchCatalog(query: string, opts: { includePlanned?: boolean; category?: CategoryId | 'all' } = {}): CatalogItem[] {
  const items: CatalogItem[] = [
    ...EXPERIMENTS.map((exp) => ({ kind: 'implemented' as const, exp })),
    ...(opts.includePlanned === false ? [] : PLANNED.map((exp) => ({ kind: 'planned' as const, exp }))),
  ].filter((i) => !opts.category || opts.category === 'all' || i.exp.category === opts.category);
  const terms = normalize(query)
    .split(' ')
    .filter((t) => t && !STOP.has(t));
  if (!terms.length) return items;
  const scored = items
    .map((item) => {
      const h = haystack(item);
      let score = 0;
      for (const t of terms) {
        const stem = t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t;
        if (h.title.includes(stem)) score += 3;
        else if (h.text.includes(stem)) score += 1;
        else return { item, score: -1 };
      }
      if (item.kind === 'implemented') score += 0.5;
      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}

/** Looser search: rank by number of matching terms (used when the strict search finds nothing). */
export function suggestCatalog(query: string, limit = 5): CatalogItem[] {
  const items: CatalogItem[] = [
    ...EXPERIMENTS.map((exp) => ({ kind: 'implemented' as const, exp })),
    ...PLANNED.map((exp) => ({ kind: 'planned' as const, exp })),
  ];
  const terms = normalize(query)
    .split(' ')
    .filter((t) => t.length > 2 && !STOP.has(t));
  return items
    .map((item) => {
      const h = haystack(item);
      const score = terms.reduce((s, t) => s + (h.text.includes(t.length > 4 ? t.replace(/(ing|ed|es|s)$/, '') : t) ? 1 : 0), 0);
      return { item, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.item.kind === 'implemented' ? -1 : 1))
    .slice(0, limit)
    .map((x) => x.item);
}
