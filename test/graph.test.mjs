import test from 'node:test';
import assert from 'node:assert/strict';

import { findCycles } from '../lib/graph.mjs';

function defsFrom(map) {
  const definitions = new Map();

  for (const [name, refs] of Object.entries(map)) {
    definitions.set(name, [
      {
        name,
        text: '',
        empty: false,
        refs: refs.map((ref) => ({ name: ref, fallback: null }))
      }
    ]);
  }

  return definitions;
}

test('findCycles: acyclic graph reports nothing', () => {
  const cycles = findCycles(defsFrom({ '--a': ['--b'], '--b': ['--c'], '--c': [] }));

  assert.equal(cycles.cyclic.size, 0);
});

test('findCycles: two-node cycle', () => {
  const cycles = findCycles(defsFrom({ '--a': ['--b'], '--b': ['--a'] }));

  assert.deepEqual([...cycles.cyclic].sort(), ['--a', '--b']);
  assert.deepEqual(cycles.path('--a'), ['--a', '--b', '--a']);
});

test('findCycles: self reference', () => {
  const cycles = findCycles(defsFrom({ '--a': ['--a'] }));

  assert.deepEqual([...cycles.cyclic], ['--a']);
});

test('findCycles: three-node cycle, path closes', () => {
  const cycles = findCycles(defsFrom({ '--a': ['--b'], '--b': ['--c'], '--c': ['--a'] }));
  const path = cycles.path('--a');

  assert.equal(path[0], '--a');
  assert.equal(path[path.length - 1], '--a');
  assert.equal(new Set(path).size, 3);
});

test('findCycles: references to undefined names are not edges', () => {
  const cycles = findCycles(defsFrom({ '--a': ['--missing'], '--b': ['--a'] }));

  assert.equal(cycles.cyclic.size, 0);
});

test('findCycles: one cycle does not taint unrelated definitions', () => {
  const cycles = findCycles(defsFrom({ '--a': ['--b'], '--b': ['--a'], '--ok': ['--a'] }));

  assert.deepEqual([...cycles.cyclic].sort(), ['--a', '--b']);
  assert.equal(cycles.cyclic.has('--ok'), false);
});

test('findCycles: handles a deep chain without stack overflow', () => {
  const map = {};
  const depth = 20000;

  for (let i = 0; i < depth; i += 1) {
    map[`--v${i}`] = [`--v${i + 1}`];
  }
  map[`--v${depth}`] = [];

  const cycles = findCycles(defsFrom(map));

  assert.equal(cycles.cyclic.size, 0);
});

test('findCycles: deep cycle is still detected', () => {
  const map = {};
  const depth = 5000;

  for (let i = 0; i < depth; i += 1) {
    map[`--v${i}`] = [`--v${i + 1}`];
  }
  map[`--v${depth}`] = ['--v0'];

  const cycles = findCycles(defsFrom(map));

  assert.equal(cycles.cyclic.size, depth + 1);
});

test('findCycles: multiple separate cycles are reported separately', () => {
  const cycles = findCycles(defsFrom({ '--a': ['--b'], '--b': ['--a'], '--x': ['--y'], '--y': ['--x'] }));

  assert.deepEqual([...cycles.cyclic].sort(), ['--a', '--b', '--x', '--y']);
  assert.deepEqual(cycles.members.get('--a').sort(), ['--a', '--b']);
  assert.deepEqual(cycles.members.get('--x').sort(), ['--x', '--y']);
});
