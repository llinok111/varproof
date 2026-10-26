import test from 'node:test';
import assert from 'node:assert/strict';

import { parse, generate } from 'css-tree';
import { createCollector } from '../lib/collect.mjs';

function collect(source) {
  const collector = createCollector();

  collector.collect(parse(source, { positions: true }), 'test.css', source);

  return collector.result();
}

/**
 * Upstream defect pinned as a regression test.
 *
 * css-tree 3.2.1 `generate()` drops the whitespace after a Function node, which
 * turns `0 var(--r) var(--r) 0` into `0 var(--r) var(--r)0`. The collector must
 * therefore slice value text out of the source; this test fails loudly if anyone
 * "simplifies" it back to generate().
 */
test('collect: generate() loses whitespace after a function (upstream defect)', () => {
  const source = '.a { border-radius: 0 var(--r) var(--r) 0; }';
  const ast = parse(source, { positions: true });
  let generated;

  ast.children.first.block.children.first.value;
  generated = generate(ast.children.first.block.children.first.value);

  assert.equal(generated, '0 var(--r) var(--r)0', 'upstream behaviour changed; revisit the slicing workaround');

  const { usages } = collect(source);

  assert.equal(usages[0].value, '0 var(--r) var(--r) 0');
});

test('collect: value text is taken from the source verbatim', () => {
  const source = '.a { padding: 1px   2px ; }';
  const { usages, stats } = collect(source);

  // No var() here, so nothing is collected as a usage, but the slicing path ran.
  assert.equal(usages.length, 0);
  assert.ok(stats.slicedFromSource > 0);
  assert.equal(stats.generated, 0);
});

test('collect: selector prelude is sliced too', () => {
  const source = '.a > .b:not(.c) { width: var(--w); }';
  const { usages } = collect(source);

  assert.equal(usages[0].selector, '.a > .b:not(.c)');
});

test('collect: custom property value keeps its formatting', () => {
  const source = ':root { --shadow: 0  0  2px  rgba(0,0,0,.2); }';
  const { definitions } = collect(source);
  const definition = definitions.get('--shadow')[0];

  // Sliced verbatim, including the leading space after the colon. Internal
  // whitespace is preserved so token boundaries cannot be glued together.
  assert.equal(definition.text, ' 0  0  2px  rgba(0,0,0,.2)');
  assert.equal(definition.text.trim(), '0  0  2px  rgba(0,0,0,.2)');
  assert.equal(definition.empty, false);
});

test('collect: empty custom property is marked empty', () => {
  const source = ':root { --e: ; --w: /**/; }';
  const { definitions } = collect(source);

  assert.equal(definitions.get('--e')[0].empty, true);
  assert.equal(definitions.get('--w')[0].empty, true);
});

test('collect: at-rule context is recorded', () => {
  const source = '@media (min-width: 600px) { .a { width: var(--w); } }';
  const { usages } = collect(source);

  assert.deepEqual(usages[0].atRules, ['@media (min-width: 600px)']);
});

test('collect: nested at-rules are recorded outermost first', () => {
  const source = '@supports (display: grid) { @media print { .a { width: var(--w); } } }';
  const { usages } = collect(source);

  assert.deepEqual(usages[0].atRules, ['@supports (display: grid)', '@media print']);
});

test('collect: positions are 1-based line/column', () => {
  const source = 'a { color: red; }\n.b { width: var(--w); }';
  const { usages } = collect(source);

  assert.equal(usages[0].line, 2);
  assert.ok(usages[0].column > 1);
});

test('collect: declarations without var() are not collected as usages', () => {
  const source = '.a { width: 10px; color: red; }';
  const { usages, stats } = collect(source);

  assert.equal(usages.length, 0);
  assert.equal(stats.declarations, 2);
});

test('collect: a declaration with two references is one usage', () => {
  const source = '.a { border: var(--w) solid var(--c); }';
  const { usages } = collect(source);

  assert.equal(usages.length, 1);
  assert.deepEqual(usages[0].refs.map((ref) => ref.name), ['--w', '--c']);
});

test('collect: multiple definitions of one name are all kept', () => {
  const source = ':root { --w: 1px; }\n@media print { :root { --w: 2px; } }';
  const { definitions } = collect(source);

  assert.equal(definitions.get('--w').length, 2);
});
