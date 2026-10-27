import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ModelViewProps } from './types';

type ViewComponent = LazyExoticComponent<ComponentType<ModelViewProps>>;

/** Model views are code-split so each lab loads only the renderer it needs. */
const VIEWS: Record<string, ViewComponent> = {
  projectile: lazy(() => import('../models/projectile/View')),
  'gravity-compare': lazy(() => import('../models/gravity-compare/View')),
  planet: lazy(() => import('../models/planet/View')),
  atmosphere: lazy(() => import('../models/atmosphere/View')),
  population: lazy(() => import('../models/population/View')),
  blackout: lazy(() => import('../models/blackout/View')),
  'orbit-explorer': lazy(() => import('../models/orbit-explorer/View')),
  moons: lazy(() => import('../models/moons/View')),
  asteroid: lazy(() => import('../models/asteroid/View')),
  'sea-level': lazy(() => import('../models/sea-level/View')),
};

export function getView(modelId: string): ViewComponent | undefined {
  return VIEWS[modelId];
}
