/**
 * The operand forms of a table's probes (collection/ordered.js formParams),
 * as a site's proofs pick them: shared by the method emitters
 * (module/collection.js tableProbe) and the fused read-modify-write
 * (src/compile/slot-update.js).
 *
 * @module collection/forms
 */
import { ctx } from '../../src/ctx.js'
import { valTypeOf } from '../../src/kind.js'
import { VAL } from '../../src/reps.js'
import { K as KIND, tagOf, tagsOf, bitOf, core } from '../../src/summary/kind.js'

// A probe of a table the summary proves a present Set or Map (`vt`): the
// table's offset passes as it is, with no tag to test, and the key's kinds
// pick its hash and equality (collection/ordered.js formParams): no string,
// BigInt or array, its bits; strings and atoms alone, a string's content;
// any other key the general pair. null where the receiver is not such a
// table, so the general probe takes the site. The speed tier keeps its
// prehashed probe for a literal key or a walked one.
export const provenTable = (recv, vt) => {
  const view = ctx.summary?.at(ctx.func.current)
  if (!view || valTypeOf(recv) !== vt) return false
  let k
  try { k = view.kindOfExpr(recv) } catch { return false }
  return tagOf(core(k)) === (vt === VAL.MAP ? KIND.MAP : KIND.SET) && view.mayBeNullishExpr(recv) === false
}
const NOT_BITS = bitOf(KIND.STRING) | bitOf(KIND.BIGINT) | bitOf(KIND.ARRAY)
const STR_OR_ATOM = bitOf(KIND.STRING) | bitOf(KIND.NULLISH) | bitOf(KIND.ABSENT) | bitOf(KIND.BOOL)
export const keyForm = (key) => {
  let tags = 0
  try { tags = tagsOf(ctx.summary.at(ctx.func.current).kindOfExpr(key)) } catch {}
  return !tags ? '' : !(tags & NOT_BITS) ? 'b' : (tags & bitOf(KIND.STRING)) && !(tags & ~STR_OR_ATOM) ? 's' : ''
}
