import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { VERSION, RULES, analyzeSources } from '../lib/index.mjs';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

test('package: VERSION matches package.json', () => {
  assert.equal(VERSION, pkg.version, 'bump both together');
});

test('package: CLI version output matches package.json', () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../bin/varproof.mjs', import.meta.url)), '--version'], {
    encoding: 'utf8'
  });

  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), pkg.version);
});

test('package: declared entry points exist', () => {
  assert.equal(pkg.bin.varproof, './bin/varproof.mjs');
  assert.equal(pkg.exports['.'], './lib/index.mjs');
  assert.equal(pkg.type, 'module');
});

test('package: every rule in the catalogue is documented in the README', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');

  for (const rule of Object.keys(RULES)) {
    assert.ok(readme.includes(rule), `${rule} is missing from the README rule table`);
  }
});

test('package: licence files are present and consistent', async () => {
  const [license, notice] = await Promise.all([
    readFile(new URL('../LICENSE', import.meta.url), 'utf8'),
    readFile(new URL('../NOTICE.md', import.meta.url), 'utf8')
  ]);

  assert.match(license, /^MIT License/);
  assert.match(notice, /css-tree/);
  assert.match(notice, /Permission is hereby granted/, 'upstream MIT text must be reproduced');
});

test('package: no source file imports a private css-tree path', async () => {
  const files = ['parser', 'collect', 'resolve', 'graph', 'grammar', 'scanner', 'suggest', 'directives', 'index'];

  for (const name of files) {
    const text = await readFile(new URL(`../lib/${name}.mjs`, import.meta.url), 'utf8');
    const imports = [...text.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]);

    for (const specifier of imports) {
      assert.equal(
        specifier.startsWith('css-tree/'),
        false,
        `${name}.mjs reaches into css-tree internals via ${specifier}; public API only`
      );
    }
  }
});

test('package: the analyzer does not mutate the shared css-tree singleton', () => {
  // Two independent runs must not influence each other through shared state.
  const first = analyzeSources([{ path: 'a.css', text: '.a{width:var(--nope)}' }]);
  const second = analyzeSources([{ path: 'a.css', text: '.a{width:var(--nope)}' }]);

  assert.deepEqual(
    second.findings.map((finding) => finding.message),
    first.findings.map((finding) => finding.message)
  );
});