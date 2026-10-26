import test from 'node:test';
import assert from 'node:assert/strict';

import { createResolver } from '../lib/resolve.mjs';

function build(map) {
  const definitions = new Map();

  for (const [name, values] of Object.entries(map)) {
    definitions.set(
      name,
      values.map((text) => ({
        name,
        text,
        empty: text.replace(/\/\*[\s\S]*?\*\//g, '').trim() === '',
        refs: []
      }))
    );
  }

  return definitions;
}

test('resolve: single definition is returned as one candidate', () => {
  const resolver = createResolver(build({ '--a': ['10px'] }));
  const result = resolver.resolveName('--a');

  assert.equal(result.status, 'value');
  assert.deepEqual(result.candidates, ['10px']);
});

test('resolve: undefined name', () => {
  assert.equal(createResolver(build({})).resolveName('--nope').status, 'undefined');
});

test('resolve: all-empty name is empty, not undefined', () => {
  const result = createResolver(build({ '--e': ['', '  ', '/**/'] })).resolveName('--e');

  assert.equal(result.status, 'empty');
});

test('resolve: several distinct definitions produce several candidates', () => {
  const result = createResolver(build({ '--w': ['10px', '20px'] })).resolveName('--w');

  assert.equal(result.status, 'value');
  assert.deepEqual(result.candidates.sort(), ['10px', '20px']);
});

test('resolve: duplicate definitions collapse to one candidate', () => {
  const result = createResolver(build({ '--w': ['10px', '10px', '10 px'.replace(' ', '')] })).resolveName('--w');

  assert.deepEqual(result.candidates, ['10px']);
});

test('resolve: mixed empty and non-empty marks hasEmpty', () => {
  const result = createResolver(build({ '--w': ['10px', ''] })).resolveName('--w');

  assert.equal(result.status, 'value');
  assert.equal(result.hasEmpty, true);
  assert.deepEqual(result.candidates, ['10px']);
});

test('resolve: cycle is reported with its members', () => {
  const definitions = build({ '--a': ['var(--b)'], '--b': ['var(--a)'] });

  // refs are rebuilt here because build() cannot parse them.
  for (const [name, list] of definitions) {
    for (const definition of list) {
      definition.refs = [{ name: name === '--a' ? '--b' : '--a', fallback: null }];
    }
  }

  const resolver = createResolver(definitions);
  const result = resolver.resolveName('--a');

  assert.equal(result.status, 'cycle');
  assert.deepEqual(result.members.sort(), ['--a', '--b']);
});

test('resolve: chain expands through definitions', () => {
  const definitions = build({ '--a': ['var(--b)'], '--b': ['7px'] });

  definitions.get('--a')[0].refs = [{ name: '--b', fallback: null }];

  const resolver = createResolver(definitions);

  assert.deepEqual(resolver.resolveName('--a').candidates, ['7px']);
});

test('resolve: a definition that references a missing name is invalid', () => {
  const definitions = build({ '--a': ['var(--gone)'] });

  definitions.get('--a')[0].refs = [{ name: '--gone', fallback: null }];

  const result = createResolver(definitions).resolveName('--a');

  assert.equal(result.status, 'invalid');
  assert.equal(result.reason, 'undefined');
  assert.equal(result.missing, '--gone');
});

test('resolve: memoises repeated lookups', () => {
  const resolver = createResolver(build({ '--a': ['1px'] }));
  const first = resolver.resolveName('--a');

  assert.equal(resolver.resolveName('--a'), first);
});
