import { num, str } from '../../engine/validation';
import type { ParamValues } from '../../engine/types';
import type { ModelViewProps } from '../../views/types';
import { R_EARTH } from '../orbits/constants';
import { OrbitView3D, type OrbitViewConfig } from '../orbits/OrbitView3D';
import { EARTH_ID, predictMoon1, type MoonsState } from './model';

function distances(p: ParamValues): number[] {
  const d = [num(p, 'moon1Distance')];
  if (str(p, 'moonCount') === '2') d.push(num(p, 'moon2Distance'));
  return d;
}

const config: OrbitViewConfig<MoonsState> = {
  system: (s) => s.sys,
  primaryId: EARTH_ID,
  unitMetres: 1000,
  unitLabel: 'km',
  sceneScale: 10 / 384400,
  kind: (b) => (b.id === EARTH_ID ? 'earth' : 'moon'),
  exaggeration: (p) => {
    // At most ×2, and never so large that Earth's drawn disc reaches the nearest moon's closest approach.
    const rp = Math.max(predictMoon1(p).conic.rp / 1000, 1);
    const dmin = Math.min(...distances(p), rp);
    const f = Math.max(1, Math.min(2, (0.35 * dmin) / (R_EARTH / 1000)));
    const nice = f >= 2 ? 2 : f >= 1.5 ? 1.5 : 1;
    return { earth: nice, moon: nice };
  },
  extent: (p) => {
    const pr = predictMoon1(p).conic;
    const d = Math.max(...distances(p));
    return pr.bound ? Math.max(d, Math.min(pr.ra / 1000, 3 * d)) : 2 * d;
  },
  arrowScale: (p) => (0.3 * num(p, 'moon1Distance')) / Math.max(predictMoon1(p).v0, 1),
  ariaLabel: 'Three-dimensional view of Earth and its moons with their paths around the barycentre',
  frameNote: 'barycentric frame at t = 0',
};

export default function MoonsView(props: ModelViewProps<MoonsState>) {
  return <OrbitView3D {...props} config={config} />;
}
