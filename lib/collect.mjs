/**
 * Turn a css-tree stylesheet AST into the facts the analyzer needs:
 * custom property definitions, `var()` references, and every declaration that
 * uses a custom property (so each can be judged individually).
 *
 * Two implementation notes:
 *
 * 1. The walk is hand-written rather than `walk()` with visitors because every
 *    fact needs its enclosing selector and at-rule stack, which the visitor API
 *    does not expose directly.
 *
 * 2. **Value text is sliced out of the source, not produced by `generate()`.**
 *    css-tree 3.2.1 drops the whitespace that follows a `Function` node:
 *
 *      parse('.a{border-radius: 0 var(--r) var(--r) 0}') -> generate() ->
 *      "0 var(--r) var(--r)0"
 *
 *    That silently glues tokens together and made the analyzer report a valid
 *    docsify declaration (`border-radius`) as a syntax error. Slicing by node
 *    offsets preserves the author's text exactly. Verified against
 *    test/collect.test.mjs.
 */

import { generate } from 'css-tree';
import { isEmptyValue, scanVarRefs } from './scanner.mjs';

/**
 * @typedef {object} Definition
 * @property {string} name
 * @property {string} text raw value text, sliced from the source
 * @property {boolean} empty
 * @property {Array<{name: string, fallback: string|null, malformed: boolean}>} refs
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {string} selector
 * @property {string[]} atRules
 *
 * @typedef {object} Usage
 * @property {string} property
 * @property {string} value
 * @property {Array<{name: string, fallback: string|null, malformed: boolean}>} refs
 * @property {string} file
 * @property {number} line
 * @property {number} column
 * @property {string} selector
 * @property {string[]} atRules
 */

export function createCollector() {
  /** @type {Map<string, Definition[]>} */
  const definitions = new Map();
  /** @type {Usage[]} */
  const usages = [];
  let declarations = 0;
  let customProperties = 0;
  let source = '';
  let slicedFromSource = 0;
  let generated = 0;

  function textOf(node) {
    if (node.loc && node.loc.start.offset !== undefined) {
      slicedFromSource += 1;
      return source.slice(node.loc.start.offset, node.loc.end.offset);
    }

    generated += 1;
    return safeGenerate(node);
  }

  function walk(nodes, context) {
    for (const node of nodes) {
      switch (node.type) {
        case 'Rule':
          walkChildren(node.block, {
            ...context,
            selectors: [...context.selectors, textOf(node.prelude)]
          });
          break;

        case 'Atrule': {
          // Preludes are sliced verbatim, so collapse the extra whitespace a
          // minifier-free source may carry; this string is only used in messages.
          const prelude = node.prelude ? textOf(node.prelude).replace(/\s+/g, ' ').trim() : '';
          const atRule = `@${node.name}${prelude ? ' ' + prelude : ''}`;
          if (node.block) {
            walkChildren(node.block, { ...context, atRules: [...context.atRules, atRule] });
          }
          break;
        }

        case 'Declaration':
          addDeclaration(node, context);
          break;

        default:
          break;
      }
    }
  }

  function walkChildren(block, context) {
    if (block && block.children) {
      walk(block.children, context);
    }
  }

  function addDeclaration(node, context) {
    declarations += 1;

    const text = textOf(node.value);
    const anchor = {
      file: context.file,
      line: node.loc ? node.loc.start.line : 1,
      column: node.loc ? node.loc.start.column : 1,
      selector: context.selectors.length ? context.selectors[context.selectors.length - 1] : '',
      atRules: context.atRules
    };

    if (node.property.startsWith('--')) {
      customProperties += 1;
      const definition = {
        name: node.property,
        text,
        empty: isEmptyValue(text),
        refs: scanVarRefs(text),
        ...anchor
      };
      const list = definitions.get(definition.name);

      if (list) {
        list.push(definition);
      } else {
        definitions.set(definition.name, [definition]);
      }
      return;
    }

    const refs = scanVarRefs(text);

    if (refs.length > 0) {
      usages.push({ property: node.property, value: text, refs, ...anchor });
    }
  }

  return {
    collect(ast, file, fileSource = '') {
      source = fileSource;
      walk(ast.children, { file, selectors: [], atRules: [] });
    },
    result() {
      return {
        definitions,
        usages,
        stats: { declarations, customProperties, slicedFromSource, generated }
      };
    }
  };
}

function safeGenerate(node) {
  try {
    return generate(node);
  } catch {
    return '';
  }
}
