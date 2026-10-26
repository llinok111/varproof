import test from 'node:test';
import assert from 'node:assert/strict';

import { isEmptyValue, scanVarRefs, stripComments, expandText } from '../lib/scanner.mjs';

test('scanVarRefs: plain reference', () => {
  const refs = scanVarRefs('var(--brand)');

  assert.equal(refs.length, 1);
  assert.equal(refs[0].name, '--brand');
  assert.equal(refs[0].fallback, null);
  assert.equal(refs[0].malformed, false);
});

test('scanVarRefs: reference with fallback', () => {
  const refs = scanVarRefs('var(--gap, 4px)');

  assert.equal(refs[0].name, '--gap');
  assert.equal(refs[0].fallback, '4px');
});

test('scanVarRefs: fallback containing a comma stays one fallback', () => {
  const refs = scanVarRefs('var(--font, system-ui, sans-serif)');

  assert.equal(refs[0].name, '--font');
  assert.equal(refs[0].fallback, 'system-ui, sans-serif');
});

test('scanVarRefs: nested reference inside fallback is collected too', () => {
  const refs = scanVarRefs('var(--a, var(--b, 10px))');

  assert.deepEqual(refs.map((ref) => ref.name), ['--a', '--b']);
  assert.equal(refs[1].fallback, '10px');
});

test('scanVarRefs: multiple references in one value', () => {
  const refs = scanVarRefs('var(--a) solid var(--b)');

  assert.deepEqual(refs.map((ref) => ref.name), ['--a', '--b']);
});

test('scanVarRefs: case-insensitive keyword', () => {
  for (const text of ['VAR(--x)', 'Var(--x)', 'var(--x)']) {
    assert.equal(scanVarRefs(text)[0].name, '--x', text);
  }
});

test('scanVarRefs: string literals are not scanned', () => {
  assert.deepEqual(scanVarRefs('"var(--fake)"'), []);
  assert.deepEqual(scanVarRefs("'var(--fake)'"), []);
});

test('scanVarRefs: comments are not scanned', () => {
  assert.deepEqual(scanVarRefs('/* var(--fake) */ 10px'), []);
});

test('scanVarRefs: other functions with var-like names are ignored', () => {
  assert.deepEqual(scanVarRefs('myvar(--x)'), []);
  assert.deepEqual(scanVarRefs('--var(--x)'), []);
});

test('scanVarRefs: malformed first argument', () => {
  assert.equal(scanVarRefs('var(10px)')[0].malformed, true);
  assert.equal(scanVarRefs('var(--ok)')[0].malformed, false);
});

test('scanVarRefs: unbalanced paren does not throw', () => {
  assert.deepEqual(scanVarRefs('var(--x'), []);
});

test('scanVarRefs: escapes and unicode names survive', () => {
  assert.equal(scanVarRefs('var(--ünïcode)')[0].name, '--ünïcode');
});

test('isEmptyValue: empty forms match Edge behaviour', () => {
  for (const text of ['', '   ', '\n\t', '/**/', ' /* a */ ', '/**/ /**/']) {
    assert.equal(isEmptyValue(text), true, JSON.stringify(text));
  }
});

test('isEmptyValue: any token makes it non-empty', () => {
  for (const text of ['0', 'red', 'initial', 'var(--x)', '" "']) {
    assert.equal(isEmptyValue(text), false, JSON.stringify(text));
  }
});

test('stripComments: keeps strings, drops comments', () => {
  assert.equal(stripComments('a /* b */ c'), 'a  c');
  assert.equal(stripComments('"/* not a comment */"'), '"/* not a comment */"');
});

const resolveMap = (map) => (name) => {
  if (!(name in map)) {
    return { status: 'undefined' };
  }

  const value = map[name];

  if (value === '') {
    return { status: 'empty' };
  }
  if (value === 'cycle') {
    return { status: 'cycle' };
  }

  return { status: 'value', candidates: [value] };
};

test('expandText: substitutes a simple value', () => {
  const out = expandText('var(--a)', resolveMap({ '--a': '10px' }));

  assert.equal(out.ok, true);
  assert.deepEqual(out.values, ['10px']);
});

test('expandText: undefined without fallback fails', () => {
  const out = expandText('var(--missing)', resolveMap({}));

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'undefined');
  assert.equal(out.name, '--missing');
});

test('expandText: undefined with fallback uses the fallback', () => {
  const out = expandText('var(--missing, 4px)', resolveMap({}));

  assert.equal(out.ok, true);
  assert.deepEqual(out.values, ['4px']);
});

test('expandText: empty variable ignores its fallback', () => {
  const out = expandText('var(--e, 4px)', resolveMap({ '--e': '' }));

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'empty');
});

test('expandText: cycle uses the usage-site fallback', () => {
  const out = expandText('var(--p, 50px)', resolveMap({ '--p': 'cycle' }));

  assert.equal(out.ok, true);
  assert.deepEqual(out.values, ['50px']);
});

test('expandText: cycle inside a definition is not rescued by that definition\'s fallback', () => {
  const out = expandText('var(--p)', resolveMap({ '--p': 'cycle' }));

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'cycle');
});

test('expandText: multi-token value keeps surrounding text', () => {
  const out = expandText('1px solid var(--c)', resolveMap({ '--c': 'red' }));

  assert.deepEqual(out.values, ['1px solid red']);
});

test('expandText: multiple distinct definitions produce multiple candidates', () => {
  const out = expandText('var(--w)', (name) =>
    name === '--w' ? { status: 'value', candidates: ['10px', '20px'] } : { status: 'undefined' }
  );

  assert.deepEqual(out.values, ['10px', '20px']);
});

test('expandText: candidate explosion is capped and reported', () => {
  const out = expandText('var(--a) var(--a) var(--a) var(--a)', (name) =>
    name === '--a' ? { status: 'value', candidates: ['1px', '2px', '3px'] } : { status: 'undefined' }, { limit: 4 }
  );

  assert.equal(out.ok, true);
  assert.ok(out.values.length <= 4);
  assert.equal(out.truncated, true);
});

test('expandText: deep chain resolves', () => {
  const out = expandText('var(--a)', resolveMap({ '--a': 'var(--b)', '--b': 'var(--c)', '--c': '7px' }));

  assert.deepEqual(out.values, ['7px']);
});

test('expandText: empty fallback is reported separately', () => {
  const out = expandText('var(--missing,   )', resolveMap({}));

  assert.equal(out.ok, false);
  assert.equal(out.reason, 'empty-fallback');
});
