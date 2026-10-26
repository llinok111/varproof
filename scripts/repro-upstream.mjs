/**
 * Reproduces the two upstream css-tree defects that motivated this project.
 *
 * Both were reported upstream and are still open with no response at the time of
 * writing; the reproduction below does not depend on those reports, it measures
 * the behaviour directly.
 *
 *   #379  performance cliff — one large parse slows every later parse in the
 *         same process (retained tokenizer buffers are never released)
 *   #388  non-termination — a specific small input makes parse() hang forever
 *
 * #388 cannot be observed in-process: the hang is synchronous, so no timer can
 * interrupt it. It is therefore run in a child process that the parent kills on a
 * watchdog, which is exactly how a CI job would hit it (a hung worker, no error).
 *
 * Usage: npm run repro
 * Exit code is 1 if a defect no longer reproduces, so this doubles as a canary for
 * the workarounds in lib/parser.mjs.
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parse } from 'css-tree';

const WATCHDOG_MS = 8000;
const childMode = process.argv[2] === '--child-388';

if (childMode) {
  runHangCase();
} else {
  main();
}

/** Runs only in the child process. */
async function runHangCase() {
  const { parse: parseHere } = await import('css-tree');
  const options = { positions: false, parseAtrulePrelude: false, parseRulePrelude: true, parseValue: false };

  parseHere('/**/ ' + 'a{}'.repeat(100), options);
  process.send?.({ stage: 'first-done' });

  parseHere('[x]{}a{b:c}}@supports not (x:y){a{b:c}}', options);
  process.send?.({ stage: 'second-done' });
}

async function main() {
  let failures = 0;

  const report = (name, reproduced, detail) => {
    console.log(`${reproduced ? 'REPRODUCED' : 'NOT REPRODUCED'}  ${name}`);
    console.log(`  ${detail}\n`);

    if (!reproduced) {
      failures += 1;
    }
  };

  console.log(`node ${process.version}, css-tree ${await version()}\n`);

  // -------------------------------------------------------------- #379 cliff
  {
    const selector = '.container > .row:not(.hidden) a[href^="https"] span.label';
    const options = { context: 'selectorList' };

    const perParse = () => {
      for (let i = 0; i < 200; i += 1) parse(selector, options);

      const start = performance.now();

      for (let i = 0; i < 2000; i += 1) parse(selector, options);

      return (performance.now() - start) / 2000;
    };

    const clean = perParse();
    parse('.x{color:red}'.repeat(Math.ceil((22 * 1024 * 1024) / 13)));
    const polluted = perParse();
    parse('.a{color:red}');
    const afterSmall = perParse();
    const ratio = polluted / clean;

    report(
      'csstree/csstree#379 — one 22 MB parse slows every later parse',
      ratio > 10,
      `clean ${clean.toFixed(4)} ms/parse -> after 22 MB ${polluted.toFixed(4)} ms/parse ` +
        `(${ratio.toFixed(0)}x); feeding a small source afterwards does not recover ` +
        `(${afterSmall.toFixed(4)} ms/parse)`
    );
  }

  // ------------------------------------------------------ #388 non-termination
  {
    const outcome = await hangInChild();

    report(
      'csstree/csstree#388 — small input hangs the parser',
      outcome === 'timeout',
      outcome === 'timeout'
        ? `child process still inside parse() after ${WATCHDOG_MS} ms and had to be killed ` +
          '(the first parse in the same process had already completed)'
        : `child process exited normally (${outcome})`
    );
  }

  console.log(failures === 0 ? 'Both defects reproduced.' : `${failures} defect(s) no longer reproduce — revisit lib/parser.mjs.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

function hangInChild() {
  return new Promise((resolve) => {
    const child = fork(fileURLToPath(import.meta.url), ['--child-388'], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      resolve(value);
    };

    const timer = setTimeout(() => finish('timeout'), WATCHDOG_MS);

    child.on('message', (message) => {
      if (message && message.stage === 'second-done') {
        finish('completed');
      }
    });

    child.on('exit', (code) => finish(`exit ${code}`));
  });
}

async function version() {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);

  return require('css-tree/package.json').version;
}
