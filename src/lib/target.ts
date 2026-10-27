/**
 * Build target. The default build is the full static site (GitHub Pages or
 * any host). The "artifact" build runs as a preview page inside claude.ai,
 * whose sandbox blocks downloads, printing, dialogs, outside API calls and
 * hash-path deep links — those features point to the full site instead.
 */
export const IS_ARTIFACT = import.meta.env.VITE_TARGET === 'artifact';

export const FULL_SITE_URL = 'https://ahmedps520-svg.github.io/whatif/';
