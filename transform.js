/**
 * jz/transform — full JS source → canonical jz source.
 *
 * Parses, lowers full-JS forms (var/function/class/switch/==/undefined/…) into the
 * jz subset via jzify, and pretty-prints back to jz source. The compile path runs
 * jzify on the AST directly (default-on); this is the standalone source→source tool
 * for tooling and REPLs ("clean my JS to the subset", auto-transform on paste).
 *
 * @module jz/transform
 */
import { parse } from 'subscript/feature/jessie'
import jzify from './jzify/index.js'
import { codegen } from './src/wat/codegen.js'

/**
 * @param {string} code - full-JS source
 * @returns {string} canonical jz source
 */
export default function transform(code) {
  return codegen(jzify(parse(code)))
}
