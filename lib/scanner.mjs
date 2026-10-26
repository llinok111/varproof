/**
 * Token-level scanner for `var()` references and for candidate expansion.
 *
 * Why a hand-written scanner instead of walking the css-tree AST:
 * css-tree represents custom property values as `Raw` nodes, so
 * `--gap: var(--space)` arrives as a single opaque string. Verified against
 * css-tree 3.2.1:
 *
 *   walk(parse('a{--x:var(--y)}')) -> Declaration "--x" value.type === 'Raw'
 *
 * A raw text scanner therefore has to exist anyway; using it for *all* values
 * keeps one code path for both ordinary declarations and custom properties.
 * It also lets us expand text the way the CSS engine does (token substitution),
 * rather than rebuilding an AST that css-tree refuses to type-check.
 */

const VAR = /^var\(/i;
const CUSTOM_PROPERTY_NAME = /^--[^\s,()'"\\]+$/;

function isIdentChar(ch) {
  return ch !== undefined && /[A-Za-z0-9_\-\u00A0-\uFFFF\\]/.test(ch);
}

function skipString(text, start) {
  const quote = text[start];
  let i = start + 1;

  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) {
      return i + 1;
    }
    i += 1;
  }

  return text.length;
}

function skipComment(text, start) {
  const end = text.indexOf('*/', start + 2);
  return end === -1 ? text.length : end + 2;
}

/** Index of the `)` that closes the `(` at `open`, or -1. */
function matchParen(text, open) {
  let depth = 0;
  let i = open;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = skipComment(text, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    i += 1;
  }

  return -1;
}

/** Split on the first comma that is not nested inside brackets or strings. */
function splitFirstComma(inner) {
  let depth = 0;
  let i = 0;

  while (i < inner.length) {
    const ch = inner[i];

    if (ch === '"' || ch === "'") {
      i = skipString(inner, i);
      continue;
    }
    if (ch === '/' && inner[i + 1] === '*') {
      i = skipComment(inner, i);
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      return { head: inner.slice(0, i), tail: inner.slice(i + 1) };
    }
    i += 1;
  }

  return { head: inner, tail: null };
}

/** Strip comments and collapse whitespace, e.g. for emptiness checks. */
export function stripComments(text) {
  let out = '';
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = skipComment(text, i);
      continue;
    }
    out += ch;
    i += 1;
  }

  return out;
}

/**
 * A custom property is *empty* when its value carries no tokens at all.
 * Edge 152 treats `--e: ;`, `--e:   ;` and `--e: /**\/;` identically:
 * the declaration is invalid at computed-value time and, unlike a cycled or
 * undefined variable, a `var(--e, fallback)` at the use site does **not**
 * rescue it (measured, see test/fixtures/browser-oracle.json case d1).
 */
export function isEmptyValue(text) {
  return stripComments(text).trim() === '';
}

/**
 * Extract every `var()` reference from a value string.
 *
 * @param {string} text
 * @returns {Array<{name: string, fallback: string|null, index: number, malformed: boolean}>}
 */
export function scanVarRefs(text) {
  const refs = [];
  scanRange(text, refs);
  return refs;
}

function scanRange(text, out) {
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i = skipComment(text, i);
      continue;
    }
    // `var(` must not continue an identifier (e.g. `myvar(` is a different function).
    if (!isIdentChar(text[i - 1]) && (ch === 'v' || ch === 'V') && VAR.test(text.slice(i, i + 4))) {
      const open = i + 3;
      const close = matchParen(text, open);

      if (close === -1) {
        i += 4;
        continue;
      }

      const inner = text.slice(open + 1, close);
      const { head, tail } = splitFirstComma(inner);
      const name = head.trim();
      const fallback = tail === null ? null : tail.trim();

      out.push({
        name,
        fallback,
        index: i,
        malformed: !CUSTOM_PROPERTY_NAME.test(name)
      });

      // Fallbacks may hold nested references (`var(--a, var(--b))`); they take
      // part in dependency-cycle detection exactly like direct references.
      if (fallback) {
        scanRange(fallback, out);
      }

      i = close + 1;
      continue;
    }

    i += 1;
  }
}

/**
 * Replace every `var()` reference in `text` with the value(s) it resolves to.
 *
 * Returns one expanded string per plausible resolution. Multiple strings only
 * happen when a custom property has several *different* definitions (very common
 * with media-query overrides); callers treat the set as "any of these may apply".
 *
 * @param {string} text
 * @param {(name: string) => {status: string, candidates?: string[], cycle?: string[], reason?: string}} resolveName
 * @param {{limit?: number, stack?: Set<string>}} [options]
 * @returns {{ok: true, values: string[], truncated: boolean} | {ok: false, reason: string, name?: string, detail?: string}}
 */
export function expandText(text, resolveName, options = {}) {
  const limit = options.limit ?? 8;
  const stack = options.stack ?? new Set();
  const values = expandInto(text, resolveName, stack, limit);

  if (values.error) {
    return { ok: false, reason: values.error.reason, name: values.error.name, detail: values.error.detail };
  }

  return {
    ok: true,
    values: unique(values.list),
    truncated: Boolean(values.truncated)
  };
}

function unique(list) {
  return [...new Set(list)];
}

function expandInto(text, resolveName, stack, limit) {
  let prefixes = [''];
  let i = 0;
  let truncated = false;

  const push = (chunk) => {
    const next = [];

    for (const prefix of prefixes) {
      for (const value of chunk) {
        next.push(prefix + value);
      }
    }
    prefixes = next.length > limit ? (truncated = true, next.slice(0, limit)) : next;
  };

  while (i < text.length) {
    const ch = text[i];

    if (ch === '"' || ch === "'") {
      const end = skipString(text, i);
      push([text.slice(i, end)]);
      i = end;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      const end = skipComment(text, i);
      push([text.slice(i, end)]);
      i = end;
      continue;
    }
    if (!isIdentChar(text[i - 1]) && (ch === 'v' || ch === 'V') && VAR.test(text.slice(i, i + 4))) {
      const open = i + 3;
      const close = matchParen(text, open);

      if (close === -1) {
        push([text.slice(i, i + 4)]);
        i += 4;
        continue;
      }

      const inner = text.slice(open + 1, close);
      const { head, tail } = splitFirstComma(inner);
      const name = head.trim();
      const fallback = tail === null ? null : tail.trim();
      const replacement = resolveReference(name, fallback, resolveName, stack, limit);

      if (replacement.error) {
        return replacement;
      }

      push(replacement.list);
      i = close + 1;
      continue;
    }

    push([ch]);
    i += 1;
  }

  return { list: prefixes, truncated };
}

/**
 * Fallback semantics, as measured in Edge 152 (see browser-oracle fixtures):
 *
 *   undefined variable  + fallback -> fallback wins
 *   cyclic variable     + fallback -> fallback wins (usage-site fallback only)
 *   empty variable      + fallback -> fallback is IGNORED, the declaration dies
 *   defined variable    + fallback -> fallback is dead code, even when the
 *                                     defined value has the wrong type
 */
function resolveReference(name, fallback, resolveName, stack, limit) {
  if (stack.has(name)) {
    return fallback !== null
      ? expandFallback(fallback, resolveName, stack, limit)
      : { error: { reason: 'cycle', name } };
  }

  const resolution = resolveName(name);

  switch (resolution.status) {
    case 'value': {
      const nextStack = new Set(stack).add(name);
      const list = [];

      for (const candidate of resolution.candidates) {
        const expanded = expandInto(candidate, resolveName, nextStack, limit);

        if (expanded.error) {
          if (fallback !== null) {
            return expandFallback(fallback, resolveName, stack, limit);
          }
          return expanded;
        }
        list.push(...expanded.list);
      }

      return { list: list.length > limit ? list.slice(0, limit) : list };
    }

    case 'undefined':
    case 'cycle':
    case 'invalid':
      return fallback !== null
        ? expandFallback(fallback, resolveName, stack, limit)
        : { error: { reason: resolution.status, name, detail: resolution.reason } };

    case 'empty':
      // Deliberate: an empty custom property is *defined*, so the fallback is
      // not consulted. Verified in Edge (cases d1, d3, d4).
      return { error: { reason: 'empty', name } };

    default:
      return { error: { reason: 'unknown', name } };
  }
}

function expandFallback(fallback, resolveName, stack, limit) {
  if (isEmptyValue(fallback)) {
    return { error: { reason: 'empty-fallback', name: null } };
  }

  const expanded = expandInto(fallback, resolveName, stack, limit);
  return expanded.error ? expanded : { list: expanded.list };
}
