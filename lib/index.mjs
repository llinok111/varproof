/**
 * varproof — public API.
 *
 * Pipeline of small, separately testable stages:
 *   parse (parser.mjs) -> collect (collect.mjs) -> resolve (resolve.mjs)
 *   -> substitute (scanner.mjs) -> grammar check (grammar.mjs) -> findings
 *
 * Every rule here is backed by a browser measurement recorded in
 * test/fixtures/browser-oracle.json and replayed by test/oracle.test.mjs, so the
 * analyzer's claims can be re-verified against a real engine at any time.
 */

import { createParser } from './parser.mjs';
import { createCollector } from './collect.mjs';
import { createResolver } from './resolve.mjs';
import { createDirectives } from './directives.mjs';
import { checkValue } from './grammar.mjs';
import { expandText, isEmptyValue } from './scanner.mjs';
import { suggestName } from './suggest.mjs';

export const VERSION = '0.1.0';

export const RULES = {
  'undefined-variable': 'A var() reference names a custom property declared nowhere in the analyzed set.',
  'fallback-invalid': 'The fallback of an undefined var() does not match the using property grammar.',
  'invalid-substitution': 'The substituted value does not match the using property grammar, so the declaration is dropped.',
  'resolution-cycle': 'Custom properties reference each other in a cycle; uses without a fallback are invalid at computed-value time.',
  'empty-value': 'A custom property holds no tokens; var() of it is invalid and its fallback is ignored.',
  'malformed-var': 'The first argument of var() is not a custom property name.',
  'unused-variable': 'A custom property is declared but never referenced (opt-in via --check-unused).',
  'parse-error': 'css-tree could not parse the stylesheet; findings for the affected region may be incomplete.'
};

/**
 * Judge one declaration that uses at least one custom property.
 *
 * This is the same logic the CLI uses, exposed separately so the browser oracle
 * can compare a per-declaration verdict with what a real engine computes.
 *
 * @param {{parse: Function}} parser
 * @param {ReturnType<typeof createResolver>} resolver
 * @param {string} property
 * @param {string} value
 * @returns {{verdict: 'valid'|'invalid'|'unknown', reason: string, detail?: string, values?: string[]}}
 */
export function judgeDeclaration(parser, resolver, property, value) {
  const expansion = expandText(value, resolver.resolveName);

  if (!expansion.ok) {
    return { verdict: 'invalid', reason: expansion.reason, detail: expansion.detail, variable: expansion.name };
  }

  const results = expansion.values.map((candidate) => ({
    value: candidate,
    check: checkValue(parser, property, candidate)
  }));

  if (results.some((result) => result.check.status === 'ok')) {
    return { verdict: 'valid', reason: 'grammar', values: expansion.values };
  }

  // A skipped check means "cannot judge" (unknown property, vendor syntax). Do not
  // claim the declaration is broken when the grammar is not understood.
  if (results.every((result) => result.check.status === 'skipped')) {
    return { verdict: 'unknown', reason: 'grammar-unsupported', values: expansion.values };
  }

  if (results.some((result) => result.check.status === 'skipped')) {
    return { verdict: 'unknown', reason: 'grammar-partially-supported', values: expansion.values };
  }

  const [first] = results;

  return {
    verdict: 'invalid',
    reason: 'grammar',
    detail: first.check.detail ?? first.check.message,
    values: expansion.values
  };
}

/**
 * @param {Array<{path: string, text: string}>} sources
 * @param {object} [options]
 * @param {boolean} [options.isolate] use an isolated css-tree instance (default true)
 * @param {boolean} [options.checkUnused] report declared-but-unreferenced properties
 * @param {boolean} [options.allowUndefined] downgrade undefined-variable to warning
 * @param {string[]} [options.ignoreNames] glob patterns of variable names to ignore
 * @param {number} [options.maxCandidates] cap on distinct resolutions per name
 */
export function analyzeSources(sources, options = {}) {
  const parser = createParser({ isolate: options.isolate !== false });
  const collector = createCollector();
  const ignore = createNameFilter(options.ignoreNames);
  const directives = new Map();
  const findings = [];
  const parseErrors = [];
  let skippedFiles = 0;

  for (const source of sources) {
    const fileDirectives = createDirectives(source.text);
    directives.set(source.path, fileDirectives);

    if (fileDirectives.fileDisabled) {
      skippedFiles += 1;
      continue;
    }

    let ast;

    try {
      ast = parser.parse(source.text, {
        positions: true,
        filename: source.path,
        onParseError(error) {
          parseErrors.push({ file: source.path, error });
        }
      });
    } catch (error) {
      parseErrors.push({ file: source.path, error });
      continue;
    }

    collector.collect(ast, source.path, source.text);
  }

  for (const { file, error } of parseErrors) {
    findings.push({
      rule: 'parse-error',
      severity: 'error',
      message: firstLine(error.message ?? String(error)),
      hint: /Identifier is expected|Colon is expected|is expected/.test(String(error.message))
        ? 'nested rules (SCSS/Less) or a non-CSS dialect; run varproof on compiled CSS instead'
        : undefined,
      file,
      line: error.line ?? 1,
      column: error.column ?? 1
    });
  }

  const { definitions, usages, stats } = collector.result();
  const resolver = createResolver(definitions, { maxCandidates: options.maxCandidates });
  const declaredNames = [...definitions.keys()];
  const referencedNames = new Set();

  for (const usage of usages) {
    for (const ref of usage.refs) {
      referencedNames.add(ref.name);
    }
  }

  for (const list of definitions.values()) {
    for (const definition of list) {
      for (const ref of definition.refs) {
        referencedNames.add(ref.name);
      }
    }
  }

  checkDefinitions(definitions, resolver, referencedNames, ignore, findings);
  checkUsages(usages, resolver, ignore, options, parser, declaredNames, findings);

  if (options.checkUnused) {
    reportUnused(definitions, referencedNames, ignore, findings);
  }

  const kept = [];
  const verdicts = [];
  let suppressed = 0;

  if (options.includeVerdicts) {
    for (const usage of usages) {
      const judged = judgeDeclaration(parser, resolver, usage.property, usage.value);

      verdicts.push({
        property: usage.property,
        value: usage.value,
        file: usage.file,
        line: usage.line,
        column: usage.column,
        verdict: judged.verdict,
        reason: judged.reason,
        detail: judged.detail,
        values: judged.values
      });
    }
  }

  for (const finding of findings) {
    const fileDirectives = directives.get(finding.file);

    if (fileDirectives && fileDirectives.isDisabled(finding.rule, finding.line)) {
      suppressed += 1;
      continue;
    }

    kept.push(finding);
  }

  kept.sort(compareFindings);

  return {
    version: VERSION,
    findings: kept,
    verdicts,
    stats: {
      files: sources.length,
      filesSkipped: skippedFiles,
      declarations: stats.declarations,
      customProperties: stats.customProperties,
      references: usages.reduce((total, usage) => total + usage.refs.length, 0),
      variables: definitions.size,
      cyclicVariables: resolver.cycles.cyclic.size,
      suppressed,
      errors: kept.filter((finding) => finding.severity === 'error').length,
      warnings: kept.filter((finding) => finding.severity === 'warning').length,
      parser: parser.stats()
    }
  };
}

function checkDefinitions(definitions, resolver, referencedNames, ignore, findings) {
  for (const [name, list] of definitions) {
    if (ignore(name)) {
      continue;
    }

    // References *inside* a definition are the root cause of downstream
    // breakage, so they are reported here rather than on every use site.
    for (const definition of list) {
      for (const ref of definition.refs) {
        if (ignore(ref.name)) {
          continue;
        }

        if (ref.malformed) {
          findings.push({
            rule: 'malformed-var',
            severity: 'error',
            variable: ref.name,
            message: `var(${ref.name}) inside ${name} does not name a custom property`,
            file: definition.file,
            line: definition.line,
            column: definition.column
          });
          continue;
        }

        if (resolver.resolveName(ref.name).status !== 'undefined') {
          continue;
        }

        findings.push({
          rule: 'undefined-variable',
          severity: ref.fallback === null ? 'error' : 'warning',
          variable: ref.name,
          property: name,
          message:
            ref.fallback === null
              ? `${name} references undeclared ${ref.name} with no fallback, so ${name} itself becomes invalid at computed-value time`
              : `${name} references undeclared ${ref.name}; the fallback \`${ref.fallback}\` is used instead`,
          file: definition.file,
          line: definition.line,
          column: definition.column
        });
      }
    }

    const resolution = resolver.resolveName(name);

    if (resolution.status === 'cycle') {
      const path = resolution.cycle.join(' \u2192 ');

      for (const definition of list) {
        findings.push({
          rule: 'resolution-cycle',
          severity: 'error',
          variable: name,
          message: `${name} sits in a dependency cycle (${path}); a use without a fallback is invalid at computed-value time`,
          file: definition.file,
          line: definition.line,
          column: definition.column
        });
      }
      continue;
    }

    if (!referencedNames.has(name)) {
      continue;
    }

    const emptyDefinitions = list.filter((definition) => definition.empty);

    if (emptyDefinitions.length === 0) {
      continue;
    }

    const allEmpty = emptyDefinitions.length === list.length;

    for (const definition of emptyDefinitions) {
      // Severity is deliberate. An empty custom property genuinely kills the
      // declaration at computed-value time (Edge: `--e: ;` then `width: var(--e,
      // 50px)` still yields the initial value, fallback ignored). But declaring a
      // token empty is a recognised idiom for "let this inherit" — docsify's core
      // theme does it 20 times on purpose. Reporting that as an error would make
      // the tool unusable on real stylesheets, so it is a warning that names the
      // two possible intents.
      findings.push({
        rule: 'empty-value',
        severity: 'warning',
        variable: name,
        message: allEmpty
          ? `${name} holds no tokens; var(${name}) is invalid at computed-value time and its fallback is ignored (intentional if this is a "let it inherit" switch)`
          : `${name} is empty in this scope while other definitions are not; a use here is invalid and ignores its fallback`,
        file: definition.file,
        line: definition.line,
        column: definition.column
      });
    }
  }
}

function checkUsages(usages, resolver, ignore, options, parser, declaredNames, findings) {
  for (const usage of usages) {
    const refs = usage.refs.filter((ref) => !ignore(ref.name));

    if (refs.length === 0) {
      continue;
    }

    for (const ref of refs) {
      if (ref.malformed) {
        findings.push({
          rule: 'malformed-var',
          severity: 'error',
          variable: ref.name,
          message: `var(${ref.name}) does not name a custom property`,
          file: usage.file,
          line: usage.line,
          column: usage.column
        });
      }
    }

    let explained = false;

    // Undefined names explain the verdict, so they are reported first.
    for (const ref of refs) {
      if (ref.malformed) {
        continue;
      }

      if (resolver.resolveName(ref.name).status !== 'undefined') {
        continue;
      }

      const hasFallback = ref.fallback !== null;
      const suggestion = suggestName(ref.name, declaredNames);

      findings.push({
        rule: 'undefined-variable',
        severity: hasFallback || options.allowUndefined ? 'warning' : 'error',
        variable: ref.name,
        property: usage.property,
        message: hasFallback
          ? `${ref.name} is never declared; the fallback \`${ref.fallback}\` is used instead`
          : `${ref.name} is never declared and has no fallback, so this declaration is dropped`,
        suggestion: suggestion ? `did you mean ${suggestion}?` : undefined,
        file: usage.file,
        line: usage.line,
        column: usage.column
      });

      if (hasFallback) {
        const check = checkValue(parser, usage.property, ref.fallback);

        if (check.status === 'mismatch') {
          explained = true;
          findings.push({
            rule: 'fallback-invalid',
            severity: 'error',
            variable: ref.name,
            property: usage.property,
            message: `fallback \`${ref.fallback}\` does not match <${usage.property}> syntax (${check.detail}); the declaration is still dropped`,
            file: usage.file,
            line: usage.line,
            column: usage.column
          });
        }
      }
    }

    if (explained) {
      continue;
    }

    const judged = judgeDeclaration(parser, resolver, usage.property, usage.value);

    if (judged.verdict !== 'invalid') {
      continue;
    }

    // Cycles, empty definitions and missing names are reported where they
    // originate; repeating them on every use site would bury the real cause.
    if (judged.reason !== 'grammar') {
      continue;
    }

    findings.push({
      rule: 'invalid-substitution',
      severity: 'error',
      variable: judged.variable ?? refs[0].name,
      property: usage.property,
      message: describeInvalid(judged, usage.property),
      file: usage.file,
      line: usage.line,
      column: usage.column
    });
  }
}

function describeInvalid(judged, property) {
  const values = judged.values ?? [];
  const shown = values.map((value) => `\`${value.trim()}\``).join(' / ');

  if (values.length === 1) {
    return `substituted value ${shown} does not match <${property}> syntax (${judged.detail}), so the declaration is dropped`;
  }

  return `none of the substituted values (${shown}) matches <${property}> syntax, so the declaration is dropped`;
}

function reportUnused(definitions, referencedNames, ignore, findings) {
  for (const [name, list] of definitions) {
    if (ignore(name) || referencedNames.has(name)) {
      continue;
    }

    for (const definition of list) {
      findings.push({
        rule: 'unused-variable',
        severity: 'warning',
        variable: name,
        message: `${name} is declared but never referenced`,
        file: definition.file,
        line: definition.line,
        column: definition.column
      });
    }
  }
}

function firstLine(message) {
  return String(message).split('\n')[0].trim();
}

function compareFindings(a, b) {
  if (a.file !== b.file) {
    return a.file < b.file ? -1 : 1;
  }
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  if (a.column !== b.column) {
    return a.column - b.column;
  }
  return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
}

/**
 * Minimal glob support (`*` and `?`) so ignore lists behave the same on every OS
 * without pulling a dependency.
 *
 * @param {string[]} [patterns]
 */
export function createNameFilter(patterns = []) {
  if (!patterns || patterns.length === 0) {
    return () => false;
  }

  const regexes = patterns.map((pattern) => {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');

    return new RegExp(`^${escaped.replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  });

  return (name) => regexes.some((regex) => regex.test(name));
}

export { isEmptyValue };
