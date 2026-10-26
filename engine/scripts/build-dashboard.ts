// Builds dashboard/index.html: inlines the pure engine modules (types stripped, so the browser
// runs the exact same routing / fair-value code as the server) plus the simulation and
// on-chain run outputs. Run `npm run demo` (and optionally `npm run e2e`) first.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripTypeScriptTypes } from 'node:module';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENGINE = join(HERE, '..', 'src');
const DASH = join(HERE, '..', '..', 'dashboard');
const OUT = join(HERE, '..', 'out');

const MODULES = ['market/session.ts', 'safety/fairValue.ts', 'execution/venues.ts', 'execution/router.ts'];
let code = '';
for (const m of MODULES) {
  const js = stripTypeScriptTypes(readFileSync(join(ENGINE, m), 'utf8'), { mode: 'strip' });
  code += `\n// ── ${m} ──\n` + js
    .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];?\s*$/gm, '')
    .replace(/^export\s+/gm, '');
}
const engine = `(function(){\n${code}\nwindow.FletcheryEngine = { Session, SESSION_NAME, sessionAt, computeFairValue, defaultVenues, poolPrice, route, execute };\n})();`;

const scenario = JSON.parse(readFileSync(join(OUT, 'scenario.json'), 'utf8'));
delete scenario.highlights;
delete scenario.orders; // not displayed; keeps the page light
const onchainPath = join(OUT, 'onchain_run.json');
const onchain = existsSync(onchainPath)
  ? (({ chainTime, results, auditHead }) => ({ chainTime, results, auditHead }))(JSON.parse(readFileSync(onchainPath, 'utf8')))
  : { chainTime: 0, results: [], auditHead: 'run npm run e2e to populate' };

const playground = {
  prices: { AAPL: 260, NVDA: 185, TSLA: 430, AMC: 3.2 },
  vol: { AAPL: 0.24, NVDA: 0.45, TSLA: 0.6, AMC: 0.9 },
  beta: { AAPL: 1.1, NVDA: 1.7, TSLA: 2.0, AMC: 1.4 },
  adv: { AAPL: 50_000_000, NVDA: 180_000_000, TSLA: 90_000_000, AMC: 25_000_000 },
  capUsed: { AAPL: 0.55, NVDA: 0.9965, TSLA: 0.6, AMC: 0.2 },
};

const html = readFileSync(join(DASH, 'template.html'), 'utf8')
  .replace('/*__ENGINE__*/', () => engine)
  .replace('/*__DATA__*/', () => JSON.stringify({ scenario, onchain, playground }).replace(/</g, '\\u003c'));
writeFileSync(join(DASH, 'index.html'), html);
console.log(`dashboard/index.html written (${(html.length / 1024).toFixed(0)} KB)`);
