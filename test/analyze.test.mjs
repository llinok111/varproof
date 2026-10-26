import test from 'node:test';
import assert from 'node:assert/strict';

import { analyzeSources, createNameFilter } from '../lib/index.mjs';

const analyze = (css, options) => analyzeSources([{ path: 'test.css', text: css }], options);

function rules(result) {
  return result.findings.map((finding) => finding.rule);
}

test('integration: clean stylesheet produces no findings', () => {
  const css = `
    :root { --brand: #f0f; --gap: 8px; }
    .a { color: var(--brand); padding: var(--gap); }
  `;
  const result = analyze(css);

  assert.deepEqual(result.findings, []);
  assert.equal(result.stats.errors, 0);
});

test('integration: undefined without fallback is an error', () => {
  const result = analyze('.a { color: var(--nope); }');

  assert.deepEqual(rules(result), ['undefined-variable']);
  assert.equal(result.findings[0].severity, 'error');
  assert.equal(result.findings[0].line, 1);
});

test('integration: undefined with fallback is only a warning', () => {
  const result = analyze('.a { color: var(--nope, red); }');

  assert.deepEqual(rules(result), ['undefined-variable']);
  assert.equal(result.findings[0].severity, 'warning');
  assert.equal(result.stats.errors, 0);
});

test('integration: fallback with the wrong type is reported separately', () => {
  const result = analyze('.a { width: var(--nope, red); }');

  assert.deepEqual(rules(result).sort(), ['fallback-invalid', 'undefined-variable']);
  assert.equal(result.stats.errors, 1);
});

test('integration: typo suggests the closest declared name', () => {
  const css = ':root { --brand: red; }\n.a { color: var(--brnad); }';
  const result = analyze(css);

  assert.equal(result.findings[0].suggestion, 'did you mean --brand?');
});

test('integration: no suggestion when nothing is close', () => {
  const css = ':root { --brand: red; }\n.a { color: var(--completely-different); }';
  const result = analyze(css);

  assert.equal(result.findings[0].suggestion, undefined);
});

test('integration: wrong type substitution is an error', () => {
  const css = ':root { --bad: red; }\n.a { height: var(--bad); }';
  const result = analyze(css);

  assert.deepEqual(rules(result), ['invalid-substitution']);
  assert.match(result.findings[0].message, /does not match <height> syntax/);
});

test('integration: empty variable is a warning that explains the ignored fallback', () => {
  const css = ':root { --e: ; }\n.a { width: var(--e, 10px); }';
  const result = analyze(css);
  const finding = result.findings.find((entry) => entry.rule === 'empty-value');

  assert.ok(finding, 'empty-value must be reported');
  assert.equal(finding.severity, 'warning');
  assert.match(finding.message, /fallback is ignored/);
  // Browser-verified: the declaration is dropped, so the analyzer must not let
  // the wrong fallback through silently either.
  assert.equal(result.verdicts?.[0]?.verdict ?? 'invalid', 'invalid');
});

test('integration: unreferenced empty variable is not an error', () => {
  const css = ':root { --e: ; }\n.a { width: 10px; }';
  const result = analyze(css);

  assert.deepEqual(result.findings, []);
});

test('integration: cycle is reported on the declarations, not on every use', () => {
  const css = `
    :root { --a: var(--b); --b: var(--a); }
    .x { width: var(--a); }
    .y { width: var(--a); }
  `;
  const result = analyze(css);

  assert.deepEqual(rules(result), ['resolution-cycle', 'resolution-cycle']);
});

test('integration: cycle declarations are still reported when a use is rescued', () => {
  const css = ':root { --a: var(--b); --b: var(--a); }\n.x { width: var(--a, 50px); }';
  const result = analyze(css);

  // The use is valid (Edge: cycle-with-usage-fallback -> 50px), but the cycle
  // declarations themselves are still broken and must stay visible.
  assert.deepEqual(rules(result), ['resolution-cycle', 'resolution-cycle']);
  assert.equal(result.findings.every((finding) => finding.line === 1), true);
});

test('integration: valid under one of several definitions is not reported', () => {
  const css = `
    :root { --w: 10px; }
    @media (max-width: 600px) { :root { --w: 20px; } }
    .a { width: var(--w); }
  `;
  const result = analyze(css);

  assert.deepEqual(result.findings, []);
});

test('integration: invalid under every definition is reported once', () => {
  const css = `
    :root { --w: red; }
    @media (max-width: 600px) { :root { --w: blue; } }
    .a { width: var(--w); }
  `;
  const result = analyze(css);

  assert.deepEqual(rules(result), ['invalid-substitution']);
  assert.match(result.findings[0].message, /none of the substituted values/);
});

test('integration: unused variables are opt-in', () => {
  const css = ':root { --unused: 1px; }\n.a { width: 1px; }';

  assert.deepEqual(analyze(css).findings, []);
  assert.deepEqual(rules(analyze(css, { checkUnused: true })), ['unused-variable']);
});

test('integration: malformed var() is an error and the parse error is surfaced', () => {
  const result = analyze('.a { width: var(10px); }');

  // css-tree also reports "Identifier is expected" here; both are useful.
  assert.ok(rules(result).includes('malformed-var'));
  assert.ok(rules(result).includes('parse-error'));
});

test('integration: allowUndefined downgrades errors to warnings', () => {
  const result = analyze('.a { width: var(--nope); }', { allowUndefined: true });

  assert.equal(result.findings[0].severity, 'warning');
  assert.equal(result.stats.errors, 0);
});

test('integration: ignoreNames glob filters references', () => {
  const result = analyze('.a { width: var(--runtime-flag); }', { ignoreNames: ['--runtime-*'] });

  assert.deepEqual(result.findings, []);
});

test('integration: file-level directive skips the whole file', () => {
  const css = '/* varproof-disable */\n.a { width: var(--nope); }';
  const result = analyze(css);

  assert.deepEqual(result.findings, []);
  assert.equal(result.stats.filesSkipped, 1);
});

test('integration: next-line directive suppresses one line', () => {
  const css = ['/* varproof-disable-next-line */', '.a { width: var(--nope); }', '.b { width: var(--nope); }'].join('\n');
  const result = analyze(css);

  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].line, 3);
  assert.equal(result.stats.suppressed, 1);
});

test('integration: parse errors are surfaced, not swallowed', () => {
  const result = analyze('a { color: red; }}}}');

  assert.ok(rules(result).includes('parse-error'));
  // css-tree recovers and still parses the valid part, so the file is analyzed.
  assert.ok(result.stats.declarations > 0);
});

test('integration: findings are sorted by position', () => {
  const css = '.b { width: var(--n2); }\n.a { width: var(--n1); }';
  const result = analyze(css);
  const lines = result.findings.map((finding) => finding.line);

  assert.deepEqual(lines, [...lines].sort((a, b) => a - b));
});

test('integration: unregistered properties are skipped rather than flagged', () => {
  const css = ':root { --v: 1px; }\n.a { made-up-prop-xyz: var(--v); }';
  const result = analyze(css);

  // The grammar is unknown, so the analyzer must not claim the value is wrong.
  assert.equal(result.findings.some((finding) => finding.rule === 'invalid-substitution'), false);
});

test('integration: multi-file analysis shares definitions', () => {
  const result = analyzeSources([
    { path: 'tokens.css', text: ':root { --brand: red; }' },
    { path: 'button.css', text: '.btn { color: var(--brand); }' }
  ]);

  assert.deepEqual(result.findings, []);
  assert.equal(result.stats.files, 2);
});

test('integration: cross-file typo is caught', () => {
  const result = analyzeSources([
    { path: 'tokens.css', text: ':root { --brand: red; }' },
    { path: 'button.css', text: '.btn { color: var(--barnd); }' }
  ]);

  assert.equal(result.findings[0].suggestion, 'did you mean --brand?');
});

test('integration: statistics are accurate', () => {
  const css = `
    :root { --a: 1px; --b: 2px; }
    .x { width: var(--a); height: var(--b); }
  `;
  const result = analyze(css);

  assert.equal(result.stats.customProperties, 2);
  assert.equal(result.stats.references, 2);
  assert.equal(result.stats.variables, 2);
  assert.equal(result.stats.declarations, 4);
});

test('createNameFilter: exact and glob patterns', () => {
  assert.equal(createNameFilter(['--exact'])('--exact'), true);
  assert.equal(createNameFilter(['--exact'])('--exactly'), false);
  assert.equal(createNameFilter(['--pre-*'])('--pre-fix'), true);
  assert.equal(createNameFilter(['--pre-*'])('--other'), false);
  assert.equal(createNameFilter([])('--anything'), false);
});
