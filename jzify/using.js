/**
 * Explicit resource management: a `using` or `await using` declaration binds
 * its resources and disposes them when its block exits, last first, however
 * it exits (ECMA-262 DisposeResources, as Node runs it).
 *
 *   using x = r          let x = r
 *   …rest                let m = x != null ? x[@@dispose] : null   (a TypeError where x is present and m no function)
 *                        let has = false, err = undefined
 *                        try { …rest } catch (e) { has = true; err = e }
 *                        finally {
 *                          if (x != null) try { m.call(x) }
 *                            catch (d) { err = has ? new SuppressedError(d, err, MESSAGE) : d; has = true }
 *                          if (has) throw err
 *                        }
 *
 * A disposal that throws over an earlier throw (the body's, or a later
 * resource's disposal) throws a SuppressedError of the two. `await using`
 * reads [@@asyncDispose], else [@@dispose] (whose result it does not await),
 * and awaits each disposal; a null resource awaits once for its block, at its
 * end or before a `using` disposed after it, unless a disposal of the block
 * awaited meanwhile (needsAwait, hasAwaited: the block's `scope`).
 * The statements are source AST: the caller lowers them.
 *
 * @module jzify/using
 */
import { withLoc } from '../src/ast.js'

const NULL = [null, null], UNDEF = [null, undefined], TRUE = [null, true], FALSE = [null, false]
const MESSAGE = 'An error was suppressed during disposal'
const block = (...stmts) => ['{}', [';', ...stmts]]
const typeError = (msg) => ['throw', ['new', ['()', 'TypeError', [null, msg]]]]

/** A resource declaration: `using` or `await using`. */
export const isResourceDecl = (st) => Array.isArray(st) && (st[0] === 'using' || st[0] === 'await using')

/** The disposal state a block with an `await using` keeps (needsAwait,
 *  hasAwaited), or null for a block of `using` declarations alone. */
export const resourceScope = (stmts, temp) => stmts.some(st => Array.isArray(st) && st[0] === 'await using') ? { na: temp('una'), ha: temp('uha') } : null

/** The statements `decl` (a resource declaration) lowers to over `rest`, the
 *  statements of its block after it; `scope` the block's (resourceScope),
 *  `first` whether `decl` is the block's first resource declaration. */
export function resourceSteps(decl, rest, scope, first, temp) {
  const async = decl[0] === 'await using'
  let inner = rest
  for (let k = decl.length - 1; k >= 1; k--) {
    const [, name, init] = decl[k]
    const m = temp('dsp'), s = async ? temp('dss') : null, r = async ? temp('dsr') : null, has = temp('dsh'), err = temp('dse'), e = temp('dsc'), d = temp('dsd')
    const present = ['!=', name, NULL]
    const bind = async ? [
      ['let', ['=', m, UNDEF], ['=', s, FALSE]],
      ['if', present, block(
        ['=', m, ['.', name, '@@asyncDispose']],
        ['if', ['==', m, NULL], block(['=', m, ['.', name, '@@dispose']], ['=', s, TRUE])],
        ['if', ['!==', ['typeof', m], [null, 'function']], typeError('await using: value has no [Symbol.asyncDispose]() or [Symbol.dispose]() method')])],
    ] : [
      ['let', ['=', m, ['?', present, ['.', name, '@@dispose'], NULL]]],
      ['if', ['&&', present, ['!==', ['typeof', m], [null, 'function']]], typeError('using: value has no [Symbol.dispose]() method')],
    ]
    const suppress = [['=', err, ['?', has, ['new', ['()', 'SuppressedError', [',', d, err, [null, MESSAGE]]]], d]], ['=', has, TRUE]]
    const call = ['()', ['.', m, 'call'], name]
    const dispose = async
      // a sync fallback's result is not awaited (GetDisposeMethod's closure)
      ? ['if', present,
        block(['try', block(['let', ['=', r, call]], ['=', scope.ha, TRUE], ['await', ['?', s, UNDEF, r]]), ['catch', d, block(...suppress)]]),
        ['=', scope.na, TRUE]]
      : ['if', present, block(
        ...(scope ? [['if', ['&&', scope.na, ['!', scope.ha]], block(['await', UNDEF], ['=', scope.na, FALSE])]] : []),
        ['try', block(call), ['catch', d, block(...suppress)]])]
    inner = [
      withLoc(['let', ['=', name, init]], decl),
      ...bind,
      ['let', ['=', has, FALSE], ['=', err, UNDEF]],
      ['try', block(...inner), ['catch', e, block(['=', has, TRUE], ['=', err, e])], ['finally', block(
        dispose,
        // the block's last disposal: a null resource's await, unless one awaited
        ...(first && k === 1 && scope ? [['if', ['&&', scope.na, ['!', scope.ha]], ['await', UNDEF]]] : []),
        ['if', has, ['throw', err]])]],
    ]
  }
  return first && scope ? [['let', ['=', scope.na, FALSE], ['=', scope.ha, FALSE]], ...inner] : inner
}
