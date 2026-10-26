/**
 * Benchmarks the parser wrapper against the upstream singleton.
 *
 * Method: the same small selector is parsed N times per configuration; each
 * configuration is measured `rounds` times and the **median** is reported. A
 * single timing is not trustworthy on a shared machine (a competing process can
 * swing the result by 3x), so medians plus the full sample list are printed and
 * the numbers in README.md are the medians from a quiet run.
 *
 * Usage: npm run bench
 */

import { createParser, DEFAULT_BIG_SOURCE } from '../lib/parser.mjs';

const SELECTOR = '.container > .row:not(.hidden) a[href^="https"] span.label';
const PARSE_OPTIONS = { context: 'selectorList' };
const N = 2000;
const ROUNDS = 5;

const bigSource = (mb) => '.x{color:red}'.repeat(Math.ceil((mb * 1024 * 1024) / 13));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;

  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function measure(parseFn) {
  for (let i = 0; i < 200; i += 1) {
    parseFn();
  }

  const start = performance.now();

  for (let i = 0; i < N; i += 1) {
    parseFn();
  }

  return (performance.now() - start) / N;
}

function run(label, parseFn) {
  const samples = [];

  for (let round = 0; round < ROUNDS; round += 1) {
    samples.push(measure(parseFn));
  }

  const value = median(samples);

  console.log(
    `${label.padEnd(46)} ${value.toFixed(4)} ms/parse   ` +
      `[${samples.map((sample) => sample.toFixed(4)).join(' ')}]`
  );

  return value;
}

console.log(`node ${process.version} — median of ${ROUNDS} rounds x ${N} parses\n`);

const shared = createParser({ isolate: false });
const isolated = createParser();

const baseline = run('upstream singleton, clean', () => shared.parse(SELECTOR, PARSE_OPTIONS));

for (const mb of [1, 4, 22]) {
  // Feed the big source through whichever parser is being measured, so each
  // configuration sees exactly the same workload.
  shared.parse(bigSource(mb), {});
  run(`upstream singleton, after ${mb} MB source`, () => shared.parse(SELECTOR, PARSE_OPTIONS));
}

console.log();

for (const mb of [1, 4, 22]) {
  isolated.parse(bigSource(mb), {});
  const polluted = run(`isolated parser, after ${mb} MB source`, () => isolated.parse(SELECTOR, PARSE_OPTIONS));

  console.log(`${''.padEnd(46)} ${(polluted / baseline).toFixed(2)}x baseline`);
}

console.log();

// The recycle path is what actually protects a long-running process: after the
// big file, the next small parse must be back at the clean cost.
isolated.parse(bigSource(22), {});
run('isolated parser, 22 MB then one small parse', () => isolated.parse(SELECTOR, PARSE_OPTIONS));

const stats = isolated.stats();

console.log(`\nparser stats: ${JSON.stringify(stats)}`);
console.log(`big-source threshold: ${DEFAULT_BIG_SOURCE} chars`);
