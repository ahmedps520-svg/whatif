import { num } from '../../engine/validation';
import type { ModelViewProps } from '../../views/types';
import { R_EARTH } from '../orbits/constants';
import { OrbitView3D, type OrbitViewConfig } from '../orbits/OrbitView3D';
import { ATMOSPHERE_TOP, EARTH_ID, predictFlyby, type AsteroidState } from './model';

const config: OrbitViewConfig<AsteroidState> = {
  system: (s) => s.sys,
  primaryId: EARTH_ID,
  unitMetres: R_EARTH,
  unitLabel: 'R⊕',
  sceneScale: 1,
  kind: (b) => (b.id === EARTH_ID ? 'earth' : 'asteroid'),
  exaggeration: (p) => {
    // A power of ten that makes the asteroid a few hundredths of an Earth radius across.
    const r = num(p, 'diameter') / 2;
    const f = Math.pow(10, Math.max(0, Math.floor(Math.log10((0.03 * R_EARTH) / r))));
    return { earth: 1, asteroid: f };
  },
  extent: (p) => {
    const pr = predictFlyby(p);
    return Math.min(num(p, 'startDistance'), Math.max(8, (4 * Math.max(pr.b, pr.rp)) / R_EARTH));
  },
  arrowScale: (p) => 2 / Math.max(predictFlyby(p).vp, 1),
  shell: { bodyId: EARTH_ID, altitudeMetres: ATMOSPHERE_TOP, label: '100 km altitude' },
  ariaLabel: 'Three-dimensional view of Earth and the approaching asteroid’s path',
  frameNote: 'Earth’s starting rest frame; faint shell at 100 km altitude',
};

export default function AsteroidView(props: ModelViewProps<AsteroidState>) {
  return <OrbitView3D {...props} config={config} />;
}
