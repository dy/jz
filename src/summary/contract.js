/** The result contract of a callable: the summary's result kind, its presence
 *  and the carrier the kind and the callable's ABI class decide, frozen once at
 *  the summary's freeze (`summarize`). Read through `resultContract` (query.js)
 *  and published into ProgramIndex beside the boundary data (narrow/results.js
 *  seedResultKinds), so a callable identity owns it. No solver state, no body walk. */
import { K, TAGS, tagOf, tagsOf, hasTag, isNullable, valOf, core, join } from './kind.js'
import { VAL } from '../reps.js'

/** A kind the summary could not bound: every tag set. */
export const unbounded = k => tagsOf(k) === TAGS

/** The carrier a result crosses its ABI in. `i32`/`f64`/`v128`/`ptr` are the
 *  wasm result the range and pointer narrowing chose (narrow/results.js): the
 *  ABI half stays theirs until the range domain lands. `raw-i64` is a BigInt
 *  as its bits, `boxed` a BigInt as a PTR.BIGINT cell in a tagged f64 slot,
 *  `any` a result the contract names no carrier for. */
export const CARRIER = Object.freeze({ I32: 'i32', F64: 'f64', V128: 'v128', PTR: 'ptr', RAW_I64: 'raw-i64', BOXED: 'boxed', ANY: 'any' })
export const PRESENCE = Object.freeze({ PRESENT: 'present', MAYBE_UNDEF: 'maybe-undef', MAYBE_NULL: 'maybe-null' })

const CLOSURE_ABI = Object.freeze({ results: Object.freeze(['f64']), ptrKind: null, ptrAux: null, unsignedResult: false })
const NO_ABI = Object.freeze({ results: Object.freeze([]), ptrKind: null, ptrAux: null, unsignedResult: false })

/** The projection of the kind's NULLISH/ABSENT bits; a kind that never completes (NONE) is undefined. */
export const presenceOf = k => tagOf(k) === K.NONE || hasTag(k, K.ABSENT) && !hasTag(k, K.NULLISH) ? PRESENCE.MAYBE_UNDEF
  : hasTag(k, K.NULLISH) ? PRESENCE.MAYBE_NULL : PRESENCE.PRESENT

/** The BigInt half of the carrier, decided from the kind and the callable's ABI
 *  class alone: a closure, a dispatcher, an export or a value-used function
 *  crosses a BigInt boxed (its slot is an any slot, or its callers are unknown);
 *  a direct-only function whose every completion is a BigInt crosses it raw
 *  (every call site is enumerable). A kind the summary cannot bound names the
 *  carrier only when a return's own kind names BigInt (`certain`): the join to
 *  ANY erases the member, the box discipline does not. Null when no BigInt. */
const bigintLane = (k, closure, direct, certain) => {
  if (!hasTag(k, K.BIGINT)) return null
  if (unbounded(k)) return certain ? CARRIER.BOXED : CARRIER.ANY
  if (closure || !direct) return CARRIER.BOXED
  return tagOf(k) === K.BIGINT && !isNullable(k) ? CARRIER.RAW_I64 : CARRIER.BOXED
}

const abiOf = sig => sig ? { results: sig.results, ptrKind: sig.ptrKind ?? null, ptrAux: sig.ptrAux ?? null, unsignedResult: sig.unsignedResult === true } : NO_ABI
const abiCarrier = abi => abi.ptrKind != null ? CARRIER.PTR : abi.results.length === 1 ? abi.results[0] : CARRIER.ANY

// The frozen half: the kind, its presence and the BigInt lane; `sig` is the
// named callable's signature, which the narrowing writes the ABI half onto
// after the freeze (null for a closure, whose ABI is the closure's).
const frozen = (k, lane, sig, closure, voidResult = false) => Object.freeze({ kind: k, presence: presenceOf(k), lane, sig, closure, voidResult })
const NONE_FROZEN = frozen(K.NONE, null, null, false)

/** The contract a frozen half reads as now: `abi` from the signature, the
 *  carrier the lane or the ABI's. */
export const readContract = f => {
  const abi = f.closure ? CLOSURE_ABI : abiOf(f.sig)
  return { kind: f.kind, voidResult: f.voidResult, presence: f.presence, carrier: f.lane ?? abiCarrier(abi), abi }
}
export const NONE_CONTRACT = readContract(NONE_FROZEN)

/** The frozen half of one contract per function name, closure id and
 *  closure-set id. `certain` holds the keys with a BigInt-naming return;
 *  `direct` answers whether a function's callers are all enumerable (not
 *  exported, not escaped, not a dispatcher). */
export function buildResultContracts({ results, funcs, closureCount, closureSets, setBase, membersOf, certain, returns, direct }) {
  const contracts = new Map()
  for (const f of funcs) contracts.set(f.name, frozen(results.get(f.name) ?? K.NONE, bigintLane(results.get(f.name) ?? K.NONE, false, direct(f.name), certain.has(f.name)), f.sig, false, returns.get(f.name)?.length === 0))
  const closureKind = ids => { let k = K.NONE; for (const id of ids) k = join(k, results.get(id) ?? K.NONE); return k }
  for (let id = 0; id < closureCount; id++) contracts.set(id, frozen(results.get(id) ?? K.NONE, bigintLane(results.get(id) ?? K.NONE, true, false, certain.has(id)), null, true, returns.get(id)?.length === 0))
  for (let i = 0; i < closureSets.length; i++) {
    const id = setBase + i, members = membersOf(id), k = closureKind(members)
    contracts.set(id, frozen(k, bigintLane(k, true, false, members.some(m => certain.has(m))), null, true, returns.get(id)?.length === 0))
  }
  return contracts
}

/** The one value kind a contract names for `valTypeOf`: the kind's single
 *  non-nullish tag, or NUMBER for a result the range channel narrowed to i32
 *  (narrow/results.js commits i32 only for tails it proved numeric; a Boolean
 *  member beside a Number crosses that i32 as 0/1, the range half's own choice). */
export const contractVal = c => valOf(core(c.kind)) ?? (c.carrier === CARRIER.I32 ? VAL.NUMBER : null)
