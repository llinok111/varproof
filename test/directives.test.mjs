import test from 'node:test';
import assert from 'node:assert/strict';

import { createDirectives } from '../lib/directives.mjs';

test('directives: no comment disables nothing', () => {
  const directives = createDirectives('.a { color: var(--x); }');

  assert.equal(directives.fileDisabled, false);
  assert.equal(directives.isDisabled('undefined-variable', 1), false);
});

test('directives: file-level disable', () => {
  const directives = createDirectives('/* varproof-disable */\n.a { color: red; }');

  assert.equal(directives.fileDisabled, true);
  assert.equal(directives.isDisabled('anything', 99), true);
});

test('directives: next-line disables the following line only', () => {
  const source = ['a{}', '/* varproof-disable-next-line */', '.b { color: var(--x); }', '.c { color: var(--y); }'].join('\n');
  const directives = createDirectives(source);

  assert.equal(directives.isDisabled('undefined-variable', 3), true);
  assert.equal(directives.isDisabled('undefined-variable', 4), false);
  assert.equal(directives.isDisabled('undefined-variable', 1), false);
});

test('directives: trailing comment disables its own line', () => {
  const source = '.b { color: var(--x); } /* varproof-disable-next-line */';
  const directives = createDirectives(source);

  assert.equal(directives.isDisabled('undefined-variable', 1), true);
});

test('directives: rule-specific suppression', () => {
  const source = '/* varproof-disable-next-line undefined-variable */\n.b { color: var(--x); }';
  const directives = createDirectives(source);

  assert.equal(directives.isDisabled('undefined-variable', 2), true);
  assert.equal(directives.isDisabled('invalid-substitution', 2), false);
});

test('directives: several rules in one comment', () => {
  const source = '/* varproof-disable-next-line undefined-variable, resolution-cycle */\n.b{}';
  const directives = createDirectives(source);

  assert.equal(directives.isDisabled('undefined-variable', 2), true);
  assert.equal(directives.isDisabled('resolution-cycle', 2), true);
  assert.equal(directives.isDisabled('empty-value', 2), false);
});

test('directives: file disable is not confused with next-line', () => {
  const directives = createDirectives('/* varproof-disable-next-line */\n.a{}');

  assert.equal(directives.fileDisabled, false);
});

test('directives: stacked comments do not leak rules onto the target line', () => {
  const source = [
    '/* varproof-disable-next-line undefined-variable */',
    '/* varproof-disable-next-line empty-value */',
    '.a{}'
  ].join('\n');
  const directives = createDirectives(source);

  // The second comment is the one that governs line 3; the first governs line 2.
  assert.equal(directives.isDisabled('empty-value', 3), true);
  assert.equal(directives.isDisabled('undefined-variable', 3), false);
  assert.equal(directives.isDisabled('undefined-variable', 2), true);
});
