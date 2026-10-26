/**
 * Resolve custom property names to the text(s) the browser would substitute.
 *
 * Two design decisions worth calling out, both driven by measured browser
 * behaviour rather than by the spec text alone:
 *
 * 1. **A name may have several definitions.** Media queries, `@layer` and theme
 *    files all redefine the same property. Rather than guess which one wins (that
 *    needs a full cascade implementation), the resolver returns *every* distinct
 *    expanded value. Callers only report a problem when **no** candidate can
 *    satisfy the property grammar, which keeps the analyzer free of false
 *    positives on code that is valid under some breakpoint.
 *
 * 2. **Empty is not the same as undefined.** `var(--e, 10px)` where `--e:` was
 *    declared empty resolves to nothing — the fallback is *not* used (Edge cases
 *    d1/d3/d4). Cyclic and undefined names, by contrast, do fall back.
 */

import { expandText, isEmptyValue } from './scanner.mjs';
import { findCycles } from './graph.mjs';

/**
 * @param {Map<string, Array<{name: string, text: string, empty: boolean, refs: Array<{name: string}>}>>} definitions
 * @param {{maxCandidates?: number}} [options]
 */
export function createResolver(definitions, options = {}) {
  const maxCandidates = options.maxCandidates ?? 8;
  const cycles = findCycles(definitions);
  const memo = new Map();
  const inProgress = new Set();

  function resolveName(name) {
    const cached = memo.get(name);

    if (cached) {
      return cached;
    }

    const list = definitions.get(name);

    if (!list || list.length === 0) {
      return remember(name, { status: 'undefined' });
    }

    if (cycles.cyclic.has(name)) {
      return remember(name, {
        status: 'cycle',
        cycle: cycles.path(name),
        members: cycles.members.get(name) ?? [name]
      });
    }

    if (inProgress.has(name)) {
      // Defensive: SCC detection should have caught this already.
      return { status: 'cycle', cycle: [name, name], members: [name] };
    }

    inProgress.add(name);

    try {
      const distinct = uniqueTexts(list.map((definition) => definition.text));
      const emptyTexts = distinct.filter(isEmptyValue);
      const usable = distinct.filter((text) => !isEmptyValue(text));

      if (usable.length === 0) {
        return remember(name, { status: 'empty', definitions: list });
      }

      const candidates = [];
      let truncated = false;
      let failure = null;

      for (const text of usable) {
        const expansion = expandText(text, resolveName, { limit: maxCandidates });

        if (expansion.ok) {
          candidates.push(...expansion.values);
          truncated = truncated || expansion.truncated;
        } else if (!failure) {
          failure = expansion;
        }
      }

      if (candidates.length === 0) {
        return remember(name, {
          status: 'invalid',
          reason: failure?.reason ?? 'invalid',
          missing: failure?.name ?? null,
          definitions: list
        });
      }

      return remember(name, {
        status: 'value',
        candidates: uniqueTexts(candidates.map((value) => value.trim())),
        definitions: list,
        definitionCount: distinct.length,
        hasEmpty: emptyTexts.length > 0,
        truncated
      });
    } finally {
      inProgress.delete(name);
    }
  }

  function remember(name, value) {
    memo.set(name, value);
    return value;
  }

  return { resolveName, cycles };
}

function uniqueTexts(list) {
  const seen = new Set();
  const out = [];

  for (const text of list) {
    const key = text.replace(/\s+/g, ' ').trim();

    if (!seen.has(key)) {
      seen.add(key);
      out.push(text);
    }
  }

  return out;
}
