import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { ModelViewProps } from './types';

type ViewComponent = LazyExoticComponent<ComponentType<ModelViewProps>>;

/** Model views are code-split so each lab loads only the renderer it needs. */
const VIEWS: Record<string, ViewComponent> = {
  projectile: lazy(() => import('../models/projectile/View')),
};

export function getView(modelId: string): ViewComponent | undefined {
  return VIEWS[modelId];
}
