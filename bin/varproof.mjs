#!/usr/bin/env node
/**
 * varproof CLI.
 *
 * Exit codes follow the usual linter convention so it can be wired into CI:
 *   0 no errors (warnings allowed)
 *   1 at least one error
 *   2 usage / IO problem, nothing analyzed
 *
 * Portability note: globbing is implemented here rather than with
 * `fs.promises.glob`, which only exists from Node 22 while this package declares
 * Node >= 18.17. Node 18/20 also cannot expand a quoted pattern for `node --test`,
 * so the test script uses bare discovery. Both were caught by the CI matrix.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { analyzeSources, VERSION, RULES } from '../lib/index.mjs';

const HELP = `varproof ${VERSION} — static analyzer for CSS custom properties

Usage
  varproof [options] <file-or-glob ...>
  cat styles.css | varproof -

Options
  --check-unused          also report declared-but-unreferenced custom properties
  --allow-undefined       report undefined variables as warnings instead of errors
  --ignore <glob>         ignore variable names matching a glob (repeatable)
  --max-candidates <n>    cap distinct resolutions per variable (default 8)
  --format <text|json>    output format (default text)
  --quiet                 print only the summary line
  --no-color              disable ANSI colour
  --list-rules            print the rule catalogue and exit
  -h, --help              show this help
  -v, --version           print the version

Rules
${Object.entries(RULES).map(([rule, description]) => `  ${rule.padEnd(22)} ${description}`).join('\n')}

Suppressing a finding
  /* varproof-disable *\\/                       skip the whole file
  /* varproof-disable-next-line *\\/              skip the next line
  /* varproof-disable-next-line <rule> *\\/       skip one rule on the next line
`;

async function main(argv) {
  const args = { patterns: [], ignore: [], format: 'text', options: {} };

  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i];
    const equals = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const inlineValue = equals > 2 ? raw.slice(equals + 1) : null;
    const arg = equals > 2 ? raw.slice(0, equals) : raw;

    switch (arg) {
      case '-h':
      case '--help':
        process.stdout.write(HELP);
        return 0;

      case '-v':
      case '--version':
        process.stdout.write(`${VERSION}\n`);
        return 0;

      case '--list-rules':
        for (const [rule, description] of Object.entries(RULES)) {
          process.stdout.write(`${rule}\t${description}\n`);
        }
        return 0;

      case '--check-unused':
        args.options.checkUnused = true;
        break;

      case '--allow-undefined':
        args.options.allowUndefined = true;
        break;

      case '--quiet':
        args.options.quiet = true;
        break;

      case '--no-color':
        args.noColor = true;
        break;

      case '--ignore':
        args.ignore.push(inlineValue ?? needValue(argv, ++i, '--ignore'));
        break;

      case '--max-candidates': {
        const value = Number(inlineValue ?? needValue(argv, ++i, '--max-candidates'));

        if (!Number.isInteger(value) || value < 1) {
          throw new UsageError('--max-candidates expects a positive integer');
        }
        args.options.maxCandidates = value;
        break;
      }

      case '--format': {
        const value = inlineValue ?? needValue(argv, ++i, '--format');

        if (value !== 'text' && value !== 'json') {
          throw new UsageError('--format expects "text" or "json"');
        }
        args.format = value;
        break;
      }

      default:
        if (arg.startsWith('--')) {
          throw new UsageError(`unknown option ${arg}`);
        }
        args.patterns.push(arg);
    }
  }

  if (args.patterns.length === 0) {
    process.stdout.write(HELP);
    return 2;
  }

  args.options.ignoreNames = args.ignore;

  const sources = await loadSources(args.patterns);

  if (sources.length === 0) {
    process.stderr.write('varproof: no CSS input matched\n');
    return 2;
  }

  const result = analyzeSources(sources, args.options);

  if (args.format === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printText(result, { color: !args.noColor && process.stdout.isTTY, quiet: args.options.quiet });
  }

  return result.stats.errors > 0 ? 1 : 0;
}

async function loadSources(patterns) {
  const sources = [];
  const files = new Set();

  for (const pattern of patterns) {
    if (pattern === '-') {
      sources.push({ path: '<stdin>', text: await readStdin() });
      continue;
    }

    if (looksLikeGlob(pattern)) {
      for await (const file of expandGlob(pattern)) {
        files.add(file);
      }
      continue;
    }

    // A directory is walked for .css files: passing a folder is the obvious thing
    // to try, and it used to fail with EISDIR.
    let stats;

    try {
      stats = await stat(pattern);
    } catch (error) {
      throw new UsageError(`cannot read ${pattern}: ${error.code ?? error.message}`);
    }

    if (stats.isDirectory()) {
      for await (const file of walkCss(pattern)) {
        files.add(file);
      }
    } else {
      files.add(pattern);
    }
  }

  for (const file of [...files].sort()) {
    const resolved = path.resolve(file);

    try {
      sources.push({ path: path.relative(process.cwd(), resolved) || file, text: await readFile(resolved, 'utf8') });
    } catch (error) {
      throw new UsageError(`cannot read ${file}: ${error.code ?? error.message}`);
    }
  }

  return sources;
}

/** Recursive .css discovery, skipping the usual build/vendor directories. */
async function* walkCss(root) {
  for await (const file of walkAll(root)) {
    if (file.endsWith('.css')) {
      yield file;
    }
  }
}

function looksLikeGlob(pattern) {
  return /[*?]/.test(pattern);
}

/**
 * Expand `*`, `?` and `**` without depending on `fs.promises.glob` (Node 22+).
 *
 * The pattern is split at the first segment containing a metacharacter; that
 * prefix becomes the walk root and the remainder is compiled into a regex applied
 * to each path relative to the root. Brackets are treated literally.
 */
async function* expandGlob(pattern) {
  const magic = /[*?]/;
  const segments = pattern.split(/[\\/]+/);
  let firstMagic = segments.findIndex((segment) => magic.test(segment));

  if (firstMagic === -1) {
    yield pattern;
    return;
  }

  // A leading separator (absolute POSIX path) must survive the join.
  const root = segments.slice(0, firstMagic).join('/') || (pattern.startsWith('/') ? '/' : '.');
  const tail = segments.slice(firstMagic).join('/');
  const regex = globToRegExp(tail);

  for await (const file of walkAll(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');

    if (regex.test(relative) && file.endsWith('.css')) {
      yield file;
    }
  }
}

function globToRegExp(pattern) {
  let source = '';

  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];

    if (char === '*') {
      // `**/` spans any number of directories, `*` stays inside one segment.
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:[^/]+/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      continue;
    }

    source += char.replace(/[.+^${}()|[\]\\]/, '\\$&');
  }

  return new RegExp(`^${source}$`);
}

/** Every file under `root`, skipping dependency and build directories. */
async function* walkAll(root) {
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

  let entries;

  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = path.join(root, entry.name);

    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) {
        continue;
      }
      yield* walkAll(full);
    } else if (entry.isFile()) {
      yield full;
    }
  }
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

function printText(result, { color, quiet }) {
  const paint = createPainter(color);

  for (const finding of result.findings) {
    if (quiet) {
      continue;
    }

    const location = `${finding.file}:${finding.line}:${finding.column}`;
    const severity = finding.severity === 'error' ? paint('31', 'error') : paint('33', 'warn ');
    const rule = paint('2', finding.rule);

    process.stdout.write(`${location}  ${severity}  ${finding.message}  ${rule}\n`);

    for (const hint of [finding.suggestion, finding.hint]) {
      if (hint) {
        process.stdout.write(`${' '.repeat(location.length)}        ${paint('36', hint)}\n`);
      }
    }
  }

  const { errors, warnings, files, variables, references, customProperties, suppressed, parser } = result.stats;
  const summary =
    `${files} file(s), ${customProperties} custom propert(y/ies), ${references} var() reference(s): ` +
    `${paint(errors ? '31' : '32', `${errors} error(s)`)}, ${paint(warnings ? '33' : '32', `${warnings} warning(s)`)}`;

  process.stdout.write(`\n${summary}\n`);

  if (suppressed > 0) {
    process.stdout.write(`${suppressed} finding(s) suppressed by directives\n`);
  }

  if (parser.rebuilds > 0) {
    process.stdout.write(`${paint('2', `parser recycled ${parser.rebuilds} time(s) to stay off the css-tree buffer cliff`)}\n`);
  }
}

function createPainter(enabled) {
  if (!enabled) {
    return (code, text) => text;
  }

  return (code, text) => `\u001b[${code}m${text}\u001b[0m`;
}

/**
 * Every custom property name starts with `--`, so a value-taking option must be
 * able to accept an argument beginning with `--`. Only arguments that *are* known
 * options are rejected, which keeps a forgotten value from silently swallowing the
 * next flag. `--ignore=--brand` also works for anyone who prefers the explicit
 * form.
 */
const VALUE_OPTIONS = new Set(['--ignore', '--max-candidates', '--format']);

function needValue(argv, index, flag) {
  const value = argv[index];

  if (value === undefined || VALUE_OPTIONS.has(value)) {
    throw new UsageError(`${flag} requires a value`);
  }

  return value;
}

class UsageError extends Error {}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    if (error instanceof UsageError) {
      process.stderr.write(`varproof: ${error.message}\n`);
    } else {
      process.stderr.write(`varproof: ${error.message}\n`);
    }
    process.exitCode = 2;
  });
