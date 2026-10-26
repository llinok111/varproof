/**
 * "Did you mean" suggestions for misspelled custom properties.
 *
 * A typo in a variable name is the single most common cause of an undefined
 * custom property, and it is silent: the declaration simply never applies.
 * Levenshtein distance over the declared names turns that into an actionable
 * message. Candidates are ranked by distance, then by shorter name, so
 * `--brand` wins over `--brand-color-alt` for the typo `--brnad`.
 */

import { stripComments } from './scanner.mjs';

/**
 * @param {string} name
 * @param {Iterable<string>} candidates
 * @returns {string|null}
 */
export function suggestName(name, candidates) {
  const target = name.toLowerCase();
  const budget = Math.max(2, Math.floor(target.length / 3));
  let best = null;
  let bestScore = Infinity;

  for (const candidate of candidates) {
    if (candidate === name) {
      continue;
    }

    const distance = levenshtein(target, candidate.toLowerCase(), budget);

    if (distance > budget) {
      continue;
    }

    const score = distance * 1000 + candidate.length;

    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}

function levenshtein(a, b, budget) {
  if (a === b) {
    return 0;
  }
  if (Math.abs(a.length - b.length) > budget) {
    return budget + 1;
  }

  const previous = new Array(b.length + 1);

  for (let j = 0; j <= b.length; j += 1) {
    previous[j] = j;
  }

  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    let rowMin = Infinity;
    previous[0] = i;

    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;

      previous[j] = Math.min(previous[j] + 1, previous[j - 1] + 1, diagonal + cost);
      diagonal = above;
      rowMin = Math.min(rowMin, previous[j]);
    }

    if (rowMin > budget) {
      return budget + 1;
    }
  }

  return previous[b.length];
}

/** Normalise a variable name for display/compare. */
export function cleanName(name) {
  return stripComments(name).trim();
}
