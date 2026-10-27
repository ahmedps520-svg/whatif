import { bool, num } from '../../engine/validation';
import type { ModelViewProps } from '../../views/types';
import { AU } from '../orbits/constants';
import { OrbitView3D, type OrbitViewConfig } from '../orbits/OrbitView3D';
import { STAR_ID, predict, starRadius, type OrbitExplorerState } from './model';

const NICE = [1, 2, 5, 10, 20];

const config: OrbitViewConfig<OrbitExplorerState> = {
  system: (s) => s.sys,
  primaryId: STAR_ID,
  unitMetres: AU,
  unitLabel: 'AU',
  sceneScale: 10,
  kind: (b) => (b.id === STAR_ID ? 'star' : 'planet'),
  exaggeration: (p) => {
    // Keep the drawn star well inside the planet's closest approach.
    const pr = predict(p);
    let dmin = Math.min(num(p, 'planetDistance') * AU, pr.conic.rp);
    if (bool(p, 'secondPlanet')) dmin = Math.min(dmin, num(p, 'secondDistance') * AU);
    const limit = (0.25 * dmin) / starRadius(num(p, 'starMass'));
    const star = NICE.filter((n) => n <= limit).pop() ?? 1;
    return { star, planet: 200 };
  },
  extent: (p) => {
    const d = num(p, 'planetDistance');
    const pr = predict(p);
    let e = pr.conic.bound ? Math.min(pr.conic.ra / AU, 4 * d) : 2 * d;
    e = Math.max(e, d);
    if (bool(p, 'secondPlanet')) e = Math.max(e, num(p, 'secondDistance'));
    return e;
  },
  arrowScale: (p) => (0.3 * num(p, 'planetDistance')) / Math.max(predict(p).v0, 1),
  ariaLabel: 'Three-dimensional view of the star and planets with their orbital paths',
  frameNote: 'barycentric frame at t = 0',
};

export default function OrbitExplorerView(props: ModelViewProps<OrbitExplorerState>) {
  return <OrbitView3D {...props} config={config} />;
}
