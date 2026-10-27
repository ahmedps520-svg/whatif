// Turns the "artifact" build's index.html into a page body for the claude.ai
// preview host, which supplies its own <!doctype>, <head> and <body>.
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist-artifact');
const html = readFileSync(join(dir, 'index.html'), 'utf8');
const pick = (re) => [...html.matchAll(re)].map((m) => m[0]);
const tags = [
  ...pick(/<link rel="stylesheet"[^>]*>/g),
  ...pick(/<link rel="modulepreload"[^>]*>/g),
  ...pick(/<script type="module"[^>]*><\/script>/g),
];
const page = `<title>WHAT IF LAB</title>
<meta name="description" content="Change the rules of reality and explore the consequences with documented, working simulation models.">
${tags.join('\n').replace(/ crossorigin/g, '')}
<div id="root"></div>
<noscript>WHAT IF LAB needs JavaScript to run its simulations.</noscript>
`;
writeFileSync(join(dir, 'artifact.html'), page);

// The preview host does not serve binary archives: ship the elevation grid as base64 text.
const meta = JSON.parse(readFileSync(join(dir, 'data', 'etopo1-025.json'), 'utf8'));
const bin = join(dir, 'data', meta.file);
writeFileSync(`${bin}.b64.txt`, readFileSync(bin).toString('base64'));
rmSync(bin);
console.log(`Wrote artifact.html with ${tags.length} asset tags`);
