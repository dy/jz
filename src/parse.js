/**
 * Parser - subscript wrapper with syntax extensions
 * @module parse
 */

import 'subscript/jessie'
import { parse as subscriptParse } from 'subscript/jessie'

/**
 * Parse jz source code to AST
 * @param {string} code - Source code
 * @returns {Array} AST in subscript format
 */
export function parse(code) {
  // For now, just parse with default subscript/jessie
  return subscriptParse(code)
}
