/**
 * Grammar validation for substituted values.
 *
 * css-tree's lexer is the reason this project is small: it already knows the
 * <property> grammar for ~600 properties. What it refuses to do is look at a value
 * containing `var()` — `Lexer.js` returns "Matching for a tree with var() is not
 * supported". We substitute first, then ask the lexer, which turns an unsupported
 * case into an answerable one.
 */

import { lexer } from 'css-tree';

const IMPORTANT = /\s*!\s*important\s*$/i;

/**
 * @param {{parse: (source: string, options?: object) => object}} parser
 * @param {string} property
 * @param {string} valueText
 * @returns {{status: 'ok'|'mismatch'|'skipped', message?: string, detail?: string}}
 */
export function checkValue(parser, property, valueText) {
  const value = valueText.replace(IMPORTANT, '').trim();

  if (value === '') {
    return { status: 'mismatch', message: 'substituted value is empty', detail: 'empty' };
  }

  let ast;

  try {
    ast = parser.parse(value, { context: 'value' });
  } catch (error) {
    return {
      status: 'mismatch',
      message: `substituted value does not parse as a value: ${firstLine(error.message)}`,
      detail: 'parse-error'
    };
  }

  let match;

  try {
    match = lexer.matchProperty(property, ast);
  } catch (error) {
    return { status: 'skipped', message: firstLine(error.message) };
  }

  if (match.matched) {
    return { status: 'ok' };
  }

  const message = match.error ? firstLine(match.error.message) : 'mismatch';

  // Out of scope: unknown / vendor-specific properties, and values that still
  // contain var() because expansion was truncated by the candidate limit.
  if (/^Unknown property/.test(message) || /var\(\) is not supported/.test(message)) {
    return { status: 'skipped', message };
  }

  return {
    status: 'mismatch',
    message: `substituted value does not match <${property}> syntax`,
    detail: message
  };
}

function firstLine(message) {
  return String(message).split('\n')[0].trim();
}
