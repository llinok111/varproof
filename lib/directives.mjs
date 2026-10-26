/**
 * Suppression comments.
 *
 * The analyzer only sees static CSS. Variables injected at runtime (`el.style
 * .setProperty('--x', ...)`) are indistinguishable from typos, so projects need a
 * cheap escape hatch that survives code review:
 *
 *   /* varproof-disable *\/                      skip the whole file
 *   /* varproof-disable-next-line *\/             ignore every rule on the next line
 *   /* varproof-disable-next-line undefined-variable *\/  ignore one rule only
 *
 * A trailing comment on the offending line also works, which matches how
 * `eslint-disable-line` behaves in practice.
 */

const FILE_DISABLE = /\/\*\s*varproof-disable(?!-next-line)\s*\*\//;
const NEXT_LINE = /\/\*\s*varproof-disable-next-line\s*([^*]*?)\s*\*\//g;

/**
 * @param {string} source
 */
export function createDirectives(source) {
  /** @type {Map<number, Set<string>>} */
  const disabledLines = new Map();
  const fileDisabled = FILE_DISABLE.test(source);

  if (!fileDisabled) {
    NEXT_LINE.lastIndex = 0;

    let match;

    while ((match = NEXT_LINE.exec(source)) !== null) {
      const line = lineAt(source, match.index);
      const rules = match[1]
        .split(/[\s,]+/)
        .map((rule) => rule.trim())
        .filter(Boolean);
      const set = rules.length ? new Set(rules) : new Set(['*']);

      // A trailing comment disables its own line; a standalone comment disables
      // only the line that follows it. Applying both to both (an earlier version
      // did that) makes two stacked comments leak their rules onto the same line.
      const ownContent = source.slice(source.lastIndexOf('\n', match.index) + 1, match.index).trim();
      const targets = ownContent === '' ? [line + 1] : [line];

      for (const target of targets) {
        const existing = disabledLines.get(target);

        if (existing) {
          for (const rule of set) {
            existing.add(rule);
          }
        } else {
          disabledLines.set(target, new Set(set));
        }
      }
    }
  }

  return {
    fileDisabled,
    isDisabled(rule, line) {
      if (fileDisabled) {
        return true;
      }

      const set = disabledLines.get(line);

      return Boolean(set && (set.has('*') || set.has(rule)));
    }
  };
}

function lineAt(source, index) {
  let line = 1;

  for (let i = 0; i < index; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
    }
  }

  return line;
}
