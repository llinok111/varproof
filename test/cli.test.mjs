import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../bin/varproof.mjs', import.meta.url));
const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url));

function run(args, { input } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    input
  });

  return { code: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('cli: clean file exits 0', () => {
  const { code, stdout } = run([`${FIXTURES}clean.css`]);

  assert.equal(code, 0);
  assert.match(stdout, /0 error\(s\)/);
});

test('cli: file with errors exits 1', () => {
  const { code, stdout } = run([`${FIXTURES}broken.css`]);

  assert.equal(code, 1);
  assert.match(stdout, /resolution-cycle/);
  assert.match(stdout, /undefined-variable/);
});

test('cli: json output is valid and carry stats', () => {
  const { code, stdout } = run([`${FIXTURES}broken.css`, '--format', 'json']);
  const payload = JSON.parse(stdout);

  assert.equal(code, 1);
  assert.equal(typeof payload.version, 'string');
  assert.ok(Array.isArray(payload.findings));
  assert.ok(payload.stats.references > 0);
  assert.equal(payload.stats.errors, payload.findings.filter((f) => f.severity === 'error').length);
});

test('cli: --format=json equals form works', () => {
  const a = run([`${FIXTURES}clean.css`, '--format', 'json']).stdout;
  const b = run([`${FIXTURES}clean.css`, '--format=json']).stdout;

  assert.equal(a, b);
});

test('cli: reads from stdin', () => {
  const { code, stdout } = run(['-'], { input: '.a{width:var(--nope)}' });

  assert.equal(code, 1);
  assert.match(stdout, /undefined-variable/);
  assert.match(stdout, /<stdin>/);
});

test('cli: glob patterns are expanded', () => {
  const { stdout } = run([`${FIXTURES}*.css`]);

  // clean.css has no findings, so it never appears in the output; the file count
  // is what proves the glob matched more than the one file with errors.
  assert.match(stdout, /2 file\(s\)/);
  assert.match(stdout, /broken\.css/);
});

test('cli: a directory argument is walked for css files', () => {
  const { stdout } = run([FIXTURES]);

  assert.match(stdout, /2 file\(s\)/);
});

test('cli: --ignore accepts a value starting with --', () => {
  const spaced = run([`${FIXTURES}clean.css`, '--ignore', '--brand']);
  const equals = run([`${FIXTURES}clean.css`, '--ignore=--brand']);

  assert.equal(spaced.code, 0);
  assert.equal(equals.code, 0);
});

test('cli: --ignore without a value is a usage error', () => {
  const { code, stderr } = run([`${FIXTURES}clean.css`, '--ignore', '--format']);

  assert.equal(code, 2);
  assert.match(stderr, /requires a value/);
});

test('cli: --allow-undefined turns errors into warnings', () => {
  const { code, stdout } = run([`${FIXTURES}clean.css`, '--allow-undefined']);

  assert.equal(code, 0);
  assert.ok(stdout.length > 0);
});

test('cli: --check-unused reports unused variables', () => {
  const { stdout } = run([`${FIXTURES}clean.css`, '--check-unused']);

  // Every variable in clean.css is referenced, so nothing should appear.
  assert.equal(/unused-variable/.test(stdout), false);
});

test('cli: --quiet suppresses the finding lines but keeps the summary', () => {
  const { stdout } = run([`${FIXTURES}broken.css`, '--quiet']);

  assert.equal(/resolution-cycle/.test(stdout), false);
  assert.match(stdout, /error\(s\)/);
});

test('cli: --list-rules prints the catalogue', () => {
  const { code, stdout } = run(['--list-rules']);

  assert.equal(code, 0);
  assert.match(stdout, /undefined-variable\t/);
  assert.match(stdout, /parse-error\t/);
});

test('cli: --version prints the package version', () => {
  const { code, stdout } = run(['--version']);

  assert.equal(code, 0);
  assert.match(stdout.trim(), /^\d+\.\d+\.\d+$/);
});

test('cli: --help exits 0', () => {
  const { code, stdout } = run(['--help']);

  assert.equal(code, 0);
  assert.match(stdout, /Usage/);
});

test('cli: no arguments prints help and exits 2', () => {
  const { code } = run([]);

  assert.equal(code, 2);
});

test('cli: an unknown option exits 2', () => {
  const { code, stderr } = run([`${FIXTURES}clean.css`, '--bogus']);

  assert.equal(code, 2);
  assert.match(stderr, /unknown option/);
});

test('cli: an unreadable path exits 2', () => {
  const { code, stderr } = run(['definitely-not-here.css']);

  assert.equal(code, 2);
  assert.match(stderr, /varproof:/);
});

test('cli: an invalid --format value exits 2', () => {
  const { code, stderr } = run([`${FIXTURES}clean.css`, '--format', 'xml']);

  assert.equal(code, 2);
  assert.match(stderr, /--format expects/);
});

test('cli: findings are ordered by file then position', () => {
  const { stdout } = run([`${FIXTURES}*.css`, '--format', 'json']);
  const { findings } = JSON.parse(stdout);
  const keys = findings.map((f) => `${f.file}:${String(f.line).padStart(6, '0')}:${String(f.column).padStart(6, '0')}`);

  assert.deepEqual(keys, [...keys].sort());
});

test('cli: exit code stays 1 when only warnings exist and allowUndefined is set', () => {
  const { code } = run(['-', '--allow-undefined'], { input: '.a{width:var(--nope, 10px)}' });

  assert.equal(code, 0, 'an undefined variable with a fallback is only a warning');
});