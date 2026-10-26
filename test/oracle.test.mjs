/**
 * Replays the recorded browser oracle against the analyzer.
 *
 * Each case is a single declaration placed in a stylesheet, measured in Edge by
 * scripts/browser-oracle.mjs. The analyzer must reach the same verdict from static
 * analysis alone. This is the test that keeps the rule set honest: if a rule is
 * wrong in either direction (false positive or false negative), the browser
 * measurement disagrees and this file fails.
 *
 * `unknown` verdicts are allowed only where the grammar genuinely is not modelled
 * (vendor-prefixed or unregistered properties); every case here is a standard
 * property, so the suite requires a definite verdict for all of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { analyzeSources } from '../lib/index.mjs';

const oracle = JSON.parse(await readFile(new URL('./fixtures/browser-oracle.json', import.meta.url), 'utf8'));

for (const testCase of oracle.cases) {
  test(`oracle: ${testCase.id}`, () => {
    const css = `:root { ${testCase.defs} }\n#probe { ${testCase.decl} }\n`;
    const result = analyzeSources([{ path: 'case.css', text: css }], { includeVerdicts: true });
    const verdict = result.verdicts[0];

    assert.ok(verdict, 'the declaration should be collected as a var() usage');

    const expected = testCase.invalid ? 'invalid' : 'valid';

    assert.equal(
      verdict.verdict,
      expected,
      `browser says ${expected} (probe=${testCase.probe}, control=${testCase.control}) but analyzer says ` +
        `${verdict.verdict} (${verdict.reason}${verdict.detail ? ': ' + verdict.detail : ''})`
    );
  });
}

test('oracle: every case carries a measurement', () => {
  assert.ok(oracle.cases.length >= 20, 'oracle should cover the documented semantics');
  assert.ok(oracle.measuredWith.startsWith('Edge'), 'oracle must record which engine produced it');

  for (const testCase of oracle.cases) {
    assert.equal(typeof testCase.invalid, 'boolean', `${testCase.id} needs a boolean verdict`);
    assert.ok(testCase.probe, `${testCase.id} needs the measured value`);
  }
});
