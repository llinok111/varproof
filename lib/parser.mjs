/**
 * Parser wrapper that works around an upstream performance cliff in css-tree.
 *
 * The problem (upstream issue csstree/csstree#379, open, no response at the time
 * of writing): `parse()` reuses one `TokenStream` whose backing arrays are only
 * ever grown, never shrunk, and every parse calls `balance.fill(0)` over the
 * *whole* retained buffer. Parsing one large stylesheet therefore slows down
 * every later parse in the same process.
 *
 * Measured with css-tree 3.2.1 on Node 22.22.2, 0.0190 ms per small selector
 * parse when clean:
 *
 *   largest source parsed before measuring   small parse   slowdown
 *   --------------------------------------  -----------   --------
 *   32 KB - 128 KB                           0.011-0.015       ~0x
 *   256 KB                                   0.0323           1.2x
 *   512 KB                                   0.0582           2.8x
 *   1 MB                                     0.1951           9.4x
 *   4 MB                                     0.7493          39.1x
 *   22 MB                                    3.1200         134.7x
 *
 * A project-wide analyzer parses hundreds of small declaration values after a
 * single big bundle, so the cliff is squarely in the hot path.
 *
 * Fixing it upstream would mean patching `tokenizer/TokenStream.js`; as a
 * derived project we must not fork internals we cannot maintain. Instead this
 * wrapper recycles the syntax instance (css-tree's public `fork()`) when the
 * retained buffer stops matching the workload:
 *
 *   - a much smaller source arrives after a large one  -> recycle
 *   - cumulative bytes since the last recycle exceed 4 MB -> recycle
 *
 * A recycle costs ~3.5 ms and happens at most once per large file, so it is
 * amortized to nothing, while the per-parse cost stays at the clean baseline.
 * `scripts/bench-parser.mjs` measures both paths side by side.
 */

import { fork, parse as sharedParse } from 'css-tree';

export const DEFAULT_BIG_SOURCE = 256 * 1024;
export const DEFAULT_CUMULATIVE_LIMIT = 4 * 1024 * 1024;

/**
 * @param {object} [options]
 * @param {boolean} [options.isolate] false = use the shared css-tree singleton (only useful for benchmarking)
 * @param {number} [options.bigSource] source size after which small parses trigger a recycle
 * @param {number} [options.cumulativeLimit] bytes fed to one instance before recycling
 */
export function createParser(options = {}) {
  const isolate = options.isolate !== false;
  const bigSource = options.bigSource ?? DEFAULT_BIG_SOURCE;
  const cumulativeLimit = options.cumulativeLimit ?? DEFAULT_CUMULATIVE_LIMIT;

  let syntax = isolate ? fork({}) : null;
  let maxSourceChars = 0;
  let totalChars = 0;
  let rebuilds = 0;

  function recycle() {
    syntax = fork({});
    maxSourceChars = 0;
    totalChars = 0;
    rebuilds += 1;
  }

  return {
    isolate,

    /**
     * @param {string} source
     * @param {object} [parseOptions]
     */
    parse(source, parseOptions) {
      const length = String(source ?? '').length;

      if (isolate) {
        const shrinking = maxSourceChars >= bigSource && length * 4 < maxSourceChars;

        if (shrinking || totalChars + length > cumulativeLimit) {
          recycle();
        }
      }

      try {
        return isolate ? syntax.parse(source, parseOptions) : sharedParse(source, parseOptions);
      } finally {
        if (length > maxSourceChars) {
          maxSourceChars = length;
        }
        totalChars += length;
      }
    },

    stats() {
      return {
        isolate,
        rebuilds,
        maxSourceChars,
        totalChars
      };
    }
  };
}
