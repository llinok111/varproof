/**
 * Browser oracle generator.
 *
 * The analyzer's rules are only worth anything if they match what a browser
 * actually does. This script measures every case in a real Edge/Chromium and
 * writes the verdicts to test/fixtures/browser-oracle.json, which the test suite
 * then replays offline. Regenerate with `npm run oracle`.
 *
 * Verdict method: each case gets a probe element carrying the tested declaration
 * and a control element with no declaration of that property. If the two compute
 * identically, the declaration was dropped (invalid at computed-value time).
 * Comparing against a control rather than hard-coding a default keeps the oracle
 * correct across browser versions and default-style changes.
 */

import { writeFile } from 'node:fs/promises';

/**
 * playwright-core is intentionally not a declared dependency: it is only needed to
 * regenerate the oracle, and the recorded measurements in
 * test/fixtures/browser-oracle.json let the test suite run without a browser. The
 * import is therefore dynamic, so a missing package produces an instruction rather
 * than a module-resolution stack trace.
 */
async function loadChromium() {
  try {
    const { chromium } = await import('playwright-core');

    return chromium;
  } catch (error) {
    console.error('Regenerating the oracle needs playwright-core:\n');
    console.error('  npm install --no-save playwright-core\n');
    console.error('It also needs a Chromium-based browser installed locally');
    console.error('(Microsoft Edge or Chrome). The recorded measurements are committed,');
    console.error('so this step is only required when you want to re-measure.\n');
    console.error(`Underlying error: ${error.code ?? error.message}`);
    process.exit(2);
  }
}

const chromium = await loadChromium();

/**
 * `defs` are declarations placed on :root, `decl` is the tested declaration,
 * `property` is the computed property read back.
 */
export const CASES = [
  { id: 'undefined-no-fallback', property: 'width', defs: '', decl: 'width: var(--nope);' },
  { id: 'undefined-valid-fallback', property: 'width', defs: '', decl: 'width: var(--nope, 42px);' },
  { id: 'undefined-invalid-fallback', property: 'width', defs: '', decl: 'width: var(--nope, red);' },
  { id: 'empty-no-fallback', property: 'width', defs: '--e: ;', decl: 'width: var(--e);' },
  { id: 'empty-with-fallback', property: 'width', defs: '--e: ;', decl: 'width: var(--e, 50px);' },
  { id: 'empty-comment-only', property: 'width', defs: '--w: /**/;', decl: 'width: var(--w);' },
  { id: 'empty-whitespace-only', property: 'width', defs: '--w:   ;', decl: 'width: var(--w);' },
  { id: 'cycle-hard', property: 'width', defs: '--p: var(--q); --q: var(--p);', decl: 'width: var(--p);' },
  { id: 'cycle-with-usage-fallback', property: 'width', defs: '--p: var(--q); --q: var(--p);', decl: 'width: var(--p, 50px);' },
  { id: 'self-cycle-with-fallback', property: 'width', defs: '--s: var(--s, 10px);', decl: 'width: var(--s);' },
  { id: 'fallback-self-cycle', property: 'width', defs: '--f: var(--nope, var(--f));', decl: 'width: var(--f);' },
  { id: 'defined-wrong-type', property: 'width', defs: '--bad: red;', decl: 'width: var(--bad);' },
  { id: 'defined-wrong-type-with-fallback', property: 'width', defs: '--bad: red;', decl: 'width: var(--bad, 50px);' },
  { id: 'defined-right-type', property: 'width', defs: '--ok: 10px;', decl: 'width: var(--ok);' },
  { id: 'defined-two-tokens', property: 'width', defs: '--two: 12px 13px;', decl: 'width: var(--two);' },
  { id: 'chain-ok', property: 'width', defs: '--x: 5px; --y: var(--x);', decl: 'width: var(--y);' },
  { id: 'chain-broken', property: 'width', defs: '--x: var(--gone); --y: var(--x);', decl: 'width: var(--y);' },
  { id: 'chain-broken-with-fallback', property: 'width', defs: '--x: var(--gone); --y: var(--x, 33px);', decl: 'width: var(--y);' },
  { id: 'important-definition', property: 'width', defs: '--i: 70px !important;', decl: 'width: var(--i);' },
  { id: 'color-ok', property: 'color', defs: '--c: red;', decl: 'color: var(--c);' },
  { id: 'color-wrong-type', property: 'color', defs: '--n: 10px;', decl: 'color: var(--n);' },
  { id: 'keyword-var-uppercase', property: 'width', defs: '--u: 9px;', decl: 'width: VAR(--u);' },
  { id: 'empty-in-chain', property: 'width', defs: '--e: ; --f: var(--e, 9px);', decl: 'width: var(--f);' },
  { id: 'padding-multi', property: 'padding-top', defs: '--pad: 1px 2px;', decl: 'padding: var(--pad);' }
];

const html = (caseDef) => `<!doctype html><html><head><style>
:root { ${caseDef.defs} }
#probe { ${caseDef.decl} }
</style></head><body>
<div id="control">x</div>
<div id="probe">x</div>
</body></html>`;

async function measure(page, caseDef) {
  await page.setContent(html(caseDef));

  return page.evaluate((property) => {
    const read = (id) => getComputedStyle(document.getElementById(id))[property];

    return { probe: read('probe'), control: read('control') };
  }, caseDef.property);
}

async function main() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  const results = [];

  for (const caseDef of CASES) {
    const { probe, control } = await measure(page, caseDef);

    results.push({
      id: caseDef.id,
      property: caseDef.property,
      defs: caseDef.defs,
      decl: caseDef.decl,
      probe,
      control,
      invalid: probe === control
    });
  }

  await browser.close();

  const payload = {
    measuredWith: `Edge ${browser.version?.() ?? ''}`.trim(),
    generatedAt: new Date().toISOString(),
    note: 'invalid === true means the declaration was dropped at computed-value time',
    cases: results
  };

  await writeFile(new URL('../test/fixtures/browser-oracle.json', import.meta.url), `${JSON.stringify(payload, null, 2)}\n`);

  for (const row of results) {
    console.log(`${row.id.padEnd(34)} ${row.invalid ? 'INVALID' : 'valid  '}  probe=${row.probe}  control=${row.control}`);
  }
  console.log(`\n${results.length} cases written to test/fixtures/browser-oracle.json`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
