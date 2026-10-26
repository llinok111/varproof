import test from 'node:test';
import assert from 'node:assert/strict';

import { createParser } from '../lib/parser.mjs';

const SELECTOR = '.a > .b:not(.c)';

function perParse(parseFn, count = 800) {
  for (let i = 0; i < 100; i += 1) {
    parseFn();
  }

  const start = performance.now();

  for (let i = 0; i < count; i += 1) {
    parseFn();
  }

  return (performance.now() - start) / count;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[sorted.length >> 1];
}

function measure(fn, rounds = 3) {
  return median(Array.from({ length: rounds }, () => perParse(fn)));
}

test('parser: parses selectors and stylesheets', () => {
  const parser = createParser();

  assert.equal(parser.parse(SELECTOR, { context: 'selectorList' }).type, 'SelectorList');
  assert.equal(parser.parse('.a{color:red}').type, 'StyleSheet');
});

test('parser: isolated instances do not share tokenizer state', () => {
  const first = createParser();
  const second = createParser();

  first.parse('.a{color:red}');

  // Both work independently; the second instance was never fed anything.
  assert.equal(second.parse('.b{color:blue}').type, 'StyleSheet');
  assert.equal(second.stats().totalChars, '.b{color:blue}'.length);
  assert.equal(first.stats().totalChars, '.a{color:red}'.length);
});

test('parser: recycles after a large source followed by a small one', () => {
  const parser = createParser({ bigSource: 1024 });
  const big = '.x{color:red}'.repeat(200);

  parser.parse(big);
  assert.equal(parser.stats().rebuilds, 0);

  parser.parse('.a{color:red}');
  assert.equal(parser.stats().rebuilds, 1, 'a much smaller source must trigger a recycle');
});

test('parser: does not recycle while sources stay large', () => {
  const parser = createParser({ bigSource: 1024, cumulativeLimit: 10 * 1024 * 1024 });
  const big = '.x{color:red}'.repeat(200);

  parser.parse(big);
  parser.parse(big);
  parser.parse(big);

  assert.equal(parser.stats().rebuilds, 0);
});

test('parser: recycles when cumulative input exceeds the limit', () => {
  const chunk = '.x{color:red}';
  const parser = createParser({ bigSource: 10 * 1024 * 1024, cumulativeLimit: chunk.length * 2 });

  // The limit is checked before adding the new source, so the third parse is the
  // one that trips it.
  parser.parse(chunk);
  parser.parse(chunk);
  assert.equal(parser.stats().rebuilds, 0);

  parser.parse(chunk);
  assert.equal(parser.stats().rebuilds, 1);
  // A recycle resets the accumulator, then counts the source it was parsing.
  assert.equal(parser.stats().totalChars, chunk.length);
});

test('parser: stats report the largest source seen', () => {
  const parser = createParser();

  parser.parse('.a{}');
  parser.parse('.a{color:red}');

  assert.equal(parser.stats().maxSourceChars, 13);
});

/**
 * The point of the wrapper: the shared css-tree singleton degrades after a large
 * parse, the isolated one does not. If this test ever passes trivially (both fast),
 * upstream fixed the cliff and lib/parser.mjs can be simplified.
 */
test('parser: isolated instance avoids the upstream slowdown', () => {
  const shared = createParser({ isolate: false });
  const isolated = createParser();
  const big = '.x{color:red}'.repeat(Math.ceil((4 * 1024 * 1024) / 13));

  const baseline = measure(() => isolated.parse(SELECTOR, { context: 'selectorList' }));

  shared.parse(big);
  isolated.parse(big);

  const sharedAfter = measure(() => shared.parse(SELECTOR, { context: 'selectorList' }));
  const isolatedAfter = measure(() => isolated.parse(SELECTOR, { context: 'selectorList' }));

  // Deliberately loose: this runs on shared CI machines. The upstream ratio is
  // two orders of magnitude, so 3x is a safe threshold that still catches a
  // regression in the workaround.
  assert.ok(
    isolatedAfter < baseline * 3 + 0.05,
    `isolated parser slowed to ${isolatedAfter.toFixed(4)} ms from ${baseline.toFixed(4)} ms`
  );
  assert.ok(
    sharedAfter > baseline * 3,
    `expected the shared singleton to be slower; shared=${sharedAfter.toFixed(4)} baseline=${baseline.toFixed(4)}`
  );
});
