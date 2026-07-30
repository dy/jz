// Dynamic-key dictionary semantics vs V8 (the lean-write/generic-read layout
// mismatch family — ledger 2026-07-22). The load-bearing pin: a LOOP-BUILT
// dict (keys from array elements — qualifies the ephemeral write layout
// unless reads disqualify it) read with a missing key must be undefined,
// never a trap and never a garbage hit.
import test from 'tst'
import { is } from 'tst/assert.js'
import jz from '../index.js'

const run = (body) => jz('export let f = () => {' + body + '}', { jzify: true }).exports.f()

test('dyn-keys: direct-write dict, present + missing keys', () => {
  is(run(`const d = {}; d['a'] = 1; return d['a']`), 1)
  is(run(`const d = {}; d['a'] = 1; return d['zz'] === undefined ? 1 : 0`), 1)
  is(run(`const d = {}; d['a'] = 1; return d['undefined'] === undefined ? 1 : 0`), 1)
})

test('dyn-keys: loop-built dict (element-sourced keys) — the trap class', () => {
  is(run(`const d = {}; const ks = ['a','b']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i; return d['zz'] === undefined ? 1 : 0`), 1)
  is(run(`const d = {}; const ks = ['a','b']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i; return d['b']`), 1)
  is(run(`const d = {}; const ks = ['if','for','while','x','y','(','{',':']; for (let i = 0; i < ks.length; i++) d[ks[i]] = i + 1; return (d['undefined'] === undefined ? 10 : 20) + (d['('] === 6 ? 1 : 2)`), 11)
})

test('dyn-keys: histogram RMW stays lean-eligible (the fused read is not a plain read)', () => {
  is(run(`const d = {}; const ks = ['a','b','a']; for (let i = 0; i < ks.length; i++) d[ks[i]] = (d[ks[i]] | 0) + 1; return (d['a'] | 0) * 10 + (d['b'] | 0)`), 21)
})

test('dyn-keys: atom-vs-NaN key split (index contract preserved)', () => {
  // Real NaN keeps the documented i32-truncating index contract (a[NaN] → a[0]);
  // only ATOM boxes (undefined/null) stringify. The first ToPropertyKey arm
  // used f64.eq(k,k), which lumped real NaN in with the atoms and broke the
  // contract pin in array-methods.
  is(run(`const a = [11, 22]; const k = 0/0; return a[k]`), 11)
  is(run(`const d = {}; d['undefined'] = 7; const u = [, 1][0]; return d[u]`), 7)
})

test('dyn-keys: ToPropertyKey for atom keys (the prec[undefined] class)', () => {
  // V8 truth 2112: prec[undefined] reads key "undefined" — never index 0.
  is(run(`const prec = {}
    const keys = ['if', 'for', 'while', 'x', 'y', '(', '{', ':']
    for (let i = 0; i < keys.length; i++) prec[keys[i]] = i + 1
    const hole = [, 'k']
    const u = hole[0]
    return (prec[u] <= 5 ? 1000 : 2000) + (prec['('] === 6 ? 100 : 200) + (prec[u] === undefined ? 10 : 20) + (prec['nope'] <= 5 ? 1 : 2)`), 2112)
  is(run(`const d = {}; d['null'] = 8; return d[null]`), 8)
  // KNOWN GAP (carrier-level, pre-existing): jz booleans are bare-number
  // carriers (true ≡ 1.0 at runtime), so a DYNAMIC d[true] coerces to key '1',
  // not 'true'. Static bool keys fold correctly; only runtime-flowing bools
  // diverge. Pin the current behavior so a carrier change surfaces here.
  is(run(`const d = {}; d['true'] = 9; return d[true] === undefined ? 1 : 0`), 1)
})

// dyn-prop KEYING on a NUMERIC (non-string) key against an OBJECT receiver
// whose static type is fully unknown — repro A + sweep siblings, ledger
// 2026-07-29. Root: module/array.js's generic `arr[i]` fallback ("Unknown ->
// runtime dispatch") assumed a numeric key on an unproven receiver is always
// ARRAY/TYPED access, routing straight to __typed_idx — sound for ARRAY/TYPED,
// but __typed_idx's own non-ARRAY/TYPED fallback bounds-checks against __len
// (0 for OBJECT), which has nothing to do with dyn-props key presence: an
// empty-schema OBJECT with a literal-string-key write (`o={}; o['1']=9` — a
// LITERAL key, invisible to dynWriteVars, so `o` never qualifies as dict-mode
// HASH) silently read undefined instead of the stored value for ANY numeric
// key reached at runtime. Fixed ONLY on the runtime-is_str_key-dispatched arm
// (key kind ALSO unproven, not just the receiver) — a sibling NAMED perf pin
// (test/perf.js "codegen: unknown-receiver index with NUMBER key skips
// __is_str_key dispatch") locks the PROVEN-NUMBER-key fallback __dyn_get-free
// for the dominant `a[loopCounter]` hot-loop shape, so that arm is
// deliberately left as the pre-existing, accepted gap (last case below).
// `j` is a PARAMETER and `o`/`nums` are MODULE-LEVEL globals throughout (not
// jzify'd/wrapped locals) — load-bearing: a local `nums` can let `nums[j]`'s
// element kind get proven NUMBER (a DIFFERENT, still-open shape covered by
// the accepted-gap case), which would silently skip the fixed code path and
// turn these into false negatives.
test('dyn-keys: numeric key on an unknown-type OBJECT receiver resolves through dyn-props', () => {
  // repro A: numeric key sourced from an array read (key kind unproven at the
  // outer `o[...]` site — is_str_key dispatch survives), receiver `o` has no
  // static val type (empty `{}`, literal-key-only writes).
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => o[nums[j]] | 0`).exports.f(0), 9)
  // WRITE-side sibling: a numeric key WRITE on the same shape (o[nums[j]]=v)
  // must land where the matching literal-key READ finds it.
  is(jz(`const o = {}
    let nums = []; nums.push(1)
    export let f = (j) => { o[nums[j]] = 5; return o['1'] | 0 }`).exports.f(0), 5)
  // `delete` sibling: same ToPropertyKey normalization on the removal path.
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => { delete o[nums[j]]; return o['1'] === undefined ? 1 : 0 }`).exports.f(0), 1)
  // `in` operator sibling (module/collection.js): a numeric key must
  // ToPropertyKey-probe an OBJECT's dyn-props the same way a string key
  // already does, not just check ARRAY/TYPED in-range membership.
  is(jz(`const o = {}; o['1'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => (nums[j] in o) ? 1 : 0`).exports.f(0), 1)
  is(jz(`const o = {}; o['2'] = 9
    let nums = []; nums.push(1)
    export let f = (j) => (nums[j] in o) ? 1 : 0`).exports.f(0), 0)
  // Map keys are SameValueZero, NOT ToPropertyKey — must NOT be conflated
  // with the OBJECT/HASH dyn-props fix above (a Map's numeric key stays a
  // real number key, never coerced to a string).
  is(jz(`const m = new Map()
    let nums = []; nums.push(1)
    export let f = (j) => { m.set(nums[j], 'x'); return m.has('1') ? 1 : 0 }`).exports.f(0), 0)
  // PRE-EXISTING, ACCEPTED GAP (not this sweep's fix — see the NAMED perf pin
  // above): a numeric key PROVEN VAL.NUMBER at compile time on an unknown
  // receiver skips the runtime is_str_key dispatch entirely by design (kept
  // __dyn_get-free for the `a[loopCounter]` hot-loop shape) — `o[n]` for a
  // proven-number local `n` still reads undefined even when `o['1']` is set.
  is(jz(`const o = {}; o['1'] = 9
    export let f = () => { let n = 1; return o[n] | 0 }`).exports.f(), 0)
})
