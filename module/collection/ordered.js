/**
 * Insertion-ordered tables: the storage of every Set and Map.
 *
 * Entries sit in insertion order at the front of the block, each in the
 * layout the walkers read (`[seq<<32 | hash][key]`, a Map's value beside),
 * the buckets after the last usable entry, one word each, and the block's
 * last word counts the entries appended. A bucket holds its entry's index
 * plus one under the top six bits of the entry's hash (0 is an empty bucket),
 * so a probe reads an entry only where those bits agree. A delete leaves the
 * entry where it stands, its key the tombstone (TOMB_NAN, which a reset's heal
 * also writes), and closes its bucket's gap by backward shift; enumeration
 * walks the appended entries in order past the tombstones, with no sort.
 * An append past the last usable entry rebuilds the live entries, still in
 * order, into a new block of twice the buckets (or as many, when half the
 * entries are tombstones), and the old block forwards to it as a grown
 * array's does; a block at the heap top grows where it stands instead.
 *
 *   cap buckets (a power of two), E bytes an entry (16 a Set's, 24 a Map's):
 *   block = [entries: ecap × E][buckets: cap × 4][zero…][used: 4]
 *   block = cap × (E·k/8 + 4) bytes, ecap = cap − cap·(8 − k)/8 − 1
 *   k = 4 in a program, 6 in compact collections and at the size tier
 *
 * At most ecap entries, and so at most ecap buckets, are ever filled: an
 * empty bucket ends every probe. A program's table keeps fewer than half its
 * buckets full, so a probe that misses ends after a bucket or two. The
 * compiler's own artifact (`compactCollections`, the build that also drops a
 * dictionary's probe lane) keeps its tables three in four full: its memory is
 * the hosted compiler's, held to a bound. So does the size tier. Every
 * allocator and walker computes the block's bytes from cap (layout.js
 * `ordStride`); past the buckets E bytes are free, the last 4 the count. The
 * host's decoder reads entries until it has the table's size, so it needs
 * no geometry.
 *
 * @module collection/ordered
 */

import { TOMB_NAN, UNDEF_NAN } from '../../src/ir.js'
import { ctx, PTR, LAYOUT } from '../../src/ctx.js'
import { STR_HCACHE_BIT, ordStride as ordStrideAt, ordEntries as ordEntriesAt } from '../../layout.js'
import { durableFwdLogIR, durableLenLogIR, durableSlotLogIR, durableEntryLogIR, durableSlotCancelIR, hasDurableReset, heapResetWat } from './durable.js'
import { stubLogIR } from '../core/stub-log.js'
import { arrayKeysOn } from './identity.js'
import { forwardHop } from './upsert.js'

const TAG = 0xFC000000 | 0      // a bucket's hash bits
const IDX = 0x03FFFFFF          // a bucket's entry index plus one (TABLE_MAX buckets hold fewer entries)
const GROW_QUAD_CAP = 8192      // past it a table quadruples (module/collection/upsert.js nextCapIR)

// The geometry (layout.js): a program's table fills half its buckets less one;
// the compact collections of the compiler's own artifact (upsert.js
// collectionLaneBytes reads the same flag) and the size tier three in four.
const load = () => ctx.transform.compactCollections || ctx.transform.optimize?.leanRuntime ? 6 : 4
const constOf = (w) => { const c = /^\(i32\.const (-?\d+)\)$/.exec(w); return c ? +c[1] : null }
/** A table block's bytes per bucket, for entries of `es` bytes (a Set's 12 and
 *  a Map's 16 in a program, 16 and 22 in compact collections and at the size tier). */
export const ordStride = (es) => ordStrideAt(es, load())
/** The usable entries of a table of `cap` buckets. */
export const ordEntries = (cap) => ordEntriesAt(cap, load())
/** The same as i32 WAT expressions, of constants or runtime values. */
export const ordStrideWat = (es) => {
  const e = constOf(es)
  if (e != null) return `(i32.const ${ordStride(e)})`
  return load() === 6 ? `(i32.add (i32.sub ${es} (i32.shr_u ${es} (i32.const 2))) (i32.const 4))`
    : `(i32.add (i32.shr_u ${es} (i32.const 1)) (i32.const 4))`
}
export const ordEntriesWat = (cap) => {
  const c = constOf(cap)
  if (c != null) return `(i32.const ${ordEntries(c)})`
  return load() === 6 ? `(i32.sub (i32.sub ${cap} (i32.shr_u ${cap} (i32.const 2))) (i32.const 1))`
    : `(i32.sub (i32.shr_u ${cap} (i32.const 1)) (i32.const 1))`
}
/** The bytes of the block of a table of `cap` buckets. */
export const ordBytesWat = (cap, es) => `(i32.mul ${cap} ${ordStrideWat(es)})`
/** The address of the appended-entry count of the table at `off`. */
export const ordUsedAddrWat = (off, cap, es) => `(i32.sub (i32.add ${off} ${ordBytesWat(cap, es)}) (i32.const 4))`
/** The buckets of the smallest table that holds `n` entries, at least `floor` (a
 *  power of two): `$__ord_cap`, which every seeded and copied table sizes by.
 *  Half full, the power of two at least 2(n + 1); three in four full, at least
 *  4(n + 1)/3, or two buckets for one entry. */
export const genOrdCap = (floor) => {
  const pow2 = (t) => `(i32.shl (i32.const 1) (i32.sub (i32.const 32) (i32.clz (i32.sub ${t} (i32.const 1)))))`
  const c = load() === 6
    ? `(select (i32.const 2) ${pow2('(i32.div_u (i32.add (i32.shl (i32.add (local.get $n) (i32.const 1)) (i32.const 2)) (i32.const 2)) (i32.const 3))')} (i32.le_u (local.get $n) (i32.const 1)))`
    : pow2('(i32.shl (i32.add (local.get $n) (i32.const 1)) (i32.const 1))')
  return `(func $__ord_cap (param $n i32) (result i32)
    (local $c i32)
    (local.set $c ${c})
    (select (i32.const ${floor}) (local.get $c) (i32.gt_u (i32.const ${floor}) (local.get $c))))`
}

const resolve = (recv) => `(local.set $off (i32.wrap_i64 (i64.and (local.get ${recv}) (i64.const ${LAYOUT.OFFSET_MASK}))))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    ${forwardHop()}`

const geometry = (es) => `(local.set $ecap ${ordEntriesWat('(local.get $cap)')})
    (local.set $ix (i32.add (local.get $off) (i32.mul (local.get $ecap) (i32.const ${es}))))
    (local.set $m (i32.sub (local.get $cap) (i32.const 1)))`

// An inserted key of -0 is stored as +0, as Map.prototype.set and
// Set.prototype.add store it (ECMA-262 CanonicalizeKeyedCollectionKey): the
// probe finds either zero (SameValueZero), a walk hands out +0.
const keyStore = `(i64.store offset=8 (local.get $slot)
          (select (i64.const 0) (local.get $key) (i64.eq (local.get $key) (i64.const 0x8000000000000000))))`
const bucketAt = (b) => `(i32.add (local.get $ix) (i32.shl ${b} (i32.const 2)))`
const entryOf = (w, es) => `(i32.add (local.get $off) (i32.mul (i32.sub (i32.and ${w} (i32.const ${IDX})) (i32.const 1)) (i32.const ${es})))`

// The probe: from the key's home bucket to the bucket of its entry ($slot set,
// `onHit` runs) or to the first empty bucket ($b names it, the block falls
// through to what follows). A tombstoned entry a reset left indexed matches no key.
const probe = (es, eqExpr, onHit) => `(local.set $b (i32.and (local.get $h) (local.get $m)))
    (block $miss (loop $probe
      (local.set $w (i32.load ${bucketAt('(local.get $b)')}))
      (br_if $miss (i32.eqz (local.get $w)))
      (if (i32.eqz (i32.and (i32.xor (local.get $w) (local.get $h)) (i32.const ${TAG})))
        (then
          (local.set $slot ${entryOf('(local.get $w)', es)})
          (if (i32.eq (i32.load (local.get $slot)) (local.get $h))
            (then (if ${eqExpr} (then ${onHit}))))))
      (local.set $b (i32.and (i32.add (local.get $b) (i32.const 1)) (local.get $m)))
      (br $probe)))`

const probeLocals = '(local $off i32) (local $cap i32) (local $h i32) (local $ecap i32) (local $ix i32) (local $m i32) (local $b i32) (local $w i32) (local $slot i32) (local $hi i32) (local $t i32)'

// The key's hash into $h. The speed tier computes `$__map_hash`'s value for
// the common keys in place, its arms as written there: a number's mix of its
// bits (either zero 2), a packed string's mix, a heap string's filled hash
// cell, a reference's (an object's, a collection's, a function's) mix of its
// bits; any other key (an atom, a BigInt, an array where arrays keep an
// identity, an unfilled cell) takes the call. The size tier calls it outright.
const BOX_HI = (LAYOUT.NAN_PREFIX << 16) | 0, PREFIX_HI = 0xFFF80000 | 0
const mixInto = `(local.set $h (i32.wrap_i64 (i64.xor (local.get $key) (i64.shr_u (local.get $key) (i64.const 32)))))
            (local.set $h (i32.mul (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 16))) (i32.const 0x85EBCA6B)))
            (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 13))))
            (if (i32.le_u (local.get $h) (i32.const 1)) (then (local.set $h (i32.add (local.get $h) (i32.const 2)))))`
// the tags `$__map_hash` mixes by their bits: every one but an atom, a string, a BigInt and an array keeping an identity
const bitsHashed = () => 0xFFFF & ~((1 << PTR.ATOM) | (1 << PTR.STRING) | (1 << PTR.BIGINT) | (arrayKeysOn() ? 1 << PTR.ARRAY : 0))
const keyHash = (hashFn) => hashFn !== '$__map_hash' || ctx.transform.optimize?.leanRuntime
  ? `(local.set $h (call ${hashFn} (local.get $key)))`
  : `(local.set $h (i32.const 0))
    (if (f64.eq (f64.reinterpret_i64 (local.get $key)) (f64.reinterpret_i64 (local.get $key)))
      (then
        (if (f64.eq (f64.reinterpret_i64 (local.get $key)) (f64.const 0))
          (then (local.set $h (i32.const 2)))
          (else ${mixInto})))
      (else
        (local.set $hi (i32.wrap_i64 (i64.shr_u (local.get $key) (i64.const 32))))
        (if (i32.eq (i32.and (local.get $hi) (i32.const ${PREFIX_HI})) (i32.const ${BOX_HI}))
          (then
            (local.set $t (i32.and (i32.shr_u (local.get $hi) (i32.const ${LAYOUT.TAG_SHIFT - 32})) (i32.const ${LAYOUT.TAG_MASK})))
            (if (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
              (then
                (if (i32.and (local.get $hi) (i32.const ${LAYOUT.SSO_BIT}))
                  (then
                    (local.set $h (i32.mul
                      (i32.xor (i32.wrap_i64 (local.get $key)) (i32.mul (i32.xor (i32.and (local.get $hi) (i32.const 0x1FFF)) (i32.const 0x9E3779B9)) (i32.const 0x85EBCA6B)))
                      (i32.const 0xC2B2AE35)))
                    (local.set $h (i32.xor (local.get $h) (i32.shr_u (local.get $h) (i32.const 15))))
                    (if (i32.le_u (local.get $h) (i32.const 1)) (then (local.set $h (i32.add (local.get $h) (i32.const 2))))))
                  (else (if (i32.eq (i32.and (local.get $hi) (i32.const ${LAYOUT.SLICE_BIT | STR_HCACHE_BIT})) (i32.const ${STR_HCACHE_BIT}))
                    (then (local.set $h (i32.load (i32.sub (i32.wrap_i64 (local.get $key)) (i32.const 8)))))))))
              (else (if (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${bitsHashed()}))
                (then ${mixInto}))))))))
    (if (i32.eqz (local.get $h)) (then (local.set $h (call $__map_hash (local.get $key)))))`
const typeExpr = (recv) => `(i32.wrap_i64 (i64.and (i64.shr_u (local.get ${recv}) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`

// A fresh entry's hash word packs the insertion sequence above the hash: the
// walkers order nothing by it any more, but a cursor finds its place by it
// and a rebuild keeps it.
const seqStore = () => `(i64.store (local.get $slot)
          (i64.or (i64.extend_i32_u (local.get $h)) (i64.shl (i64.extend_i32_u (global.get $__seq)) (i64.const 32))))
        (global.set $__seq (i32.add (global.get $__seq) (i32.const 1)))`

/** Add/set: a found key's value is replaced; a missing one is appended, its
 *  bucket the empty one the probe ended at; a full table is rebuilt first.
 *  `slotOnly` returns the value's address, a miss inserting undefined (the
 *  fused read-modify-write, src/compile/slot-update.js). */
export function genOrdUpsert(name, es, hashFn, eqExpr, expectedType, hasVal, hasExt, { slotOnly = false, prologue = '' } = {}) {
  const valParam = hasVal && !slotOnly ? '(param $val i64) ' : ''
  const slotLog = hasVal && !slotOnly ? durableSlotLogIR('slot', 16, 'val') : ''
  const storeVal = slotOnly ? `\n        (i64.store offset=16 (local.get $slot) (i64.const ${UNDEF_NAN}))`
    : hasVal ? `\n        (i64.store offset=16 (local.get $slot) (local.get $val))${slotLog}` : ''
  const onHit = hasVal && !slotOnly
    ? `(i64.store offset=16 (local.get $slot) (local.get $val))${slotLog} (br $done)`
    : '(br $done)'
  const miss = slotOnly ? '(i32.const 0)' : '(local.get $coll)'
  const t = typeExpr('$coll')
  const extBranch = hasVal
    ? '(then (call $__ext_set (local.get $coll) (local.get $key) (local.get $val)) drop)'
    : '(then (nop))'
  const typeGuard = hasExt
    ? `(if (i32.ne ${t} (i32.const ${expectedType})) (then (if (i32.eq ${t} (i32.const ${PTR.EXTERNAL})) ${extBranch}) (return ${miss})))`
    : `(if (i32.ne ${t} (i32.const ${expectedType})) (then (return ${miss})))`
  return `(func $${name} (param $coll i64) (param $key i64) ${valParam}(result ${slotOnly ? 'i32' : 'i64'})
    ${probeLocals} (local $used i32) (local $size i32) (local $newptr i32) (local $o0 i32)
    ${typeGuard}
    ${resolve('$coll')}${prologue}
    ${keyHash(hashFn)}
    (block $done (loop $retry
    ${geometry(es)}
    ${probe(es, eqExpr, onHit)}
    (local.set $used (i32.load ${ordUsedAddrWat('(local.get $off)', '(local.get $cap)', `(i32.const ${es})`)}))
    (if (i32.lt_u (local.get $used) (local.get $ecap))
      (then
        (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $used) (i32.const ${es}))))
        ${seqStore()}
        ${keyStore}${durableEntryLogIR('slot', 'off')}${storeVal}
        (i32.store ${bucketAt('(local.get $b)')}
          (i32.or (i32.and (local.get $h) (i32.const ${TAG})) (i32.add (local.get $used) (i32.const 1))))
        (i32.store ${ordUsedAddrWat('(local.get $off)', '(local.get $cap)', `(i32.const ${es})`)} (i32.add (local.get $used) (i32.const 1)))
        (i32.store (i32.sub (local.get $off) (i32.const 8))
          (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
        (br $done)))
    ;; full: the live entries move to a new block, the old one forwards there
    (local.set $size (i32.load (i32.sub (local.get $off) (i32.const 8))))
    (local.set $newptr (call $__ord_grow (local.get $off) (local.get $cap) (i32.const ${es})))
    ;; a table that moved leaves a stub (one grown in place stands where it was)
    (if (i32.ne (local.get $newptr) (local.get $off))
      (then
        ${durableFwdLogIR('off', 'newptr', 'size', 'cap')}
        (i32.store (i32.sub (local.get $off) (i32.const 8)) (local.get $newptr))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (i32.const -1))
        ${stubLogIR('off', 'newptr', expectedType)}
        ;; the stub the holder names forwards straight to the new block (upsert.js retargetStub)
        (local.set $o0 (i32.wrap_i64 (i64.and (local.get $coll) (i64.const ${LAYOUT.OFFSET_MASK}))))
        (if (i32.ne (local.get $o0) (local.get $off))
          (then${durableLenLogIR('o0')}
            (i32.store (i32.sub (local.get $o0) (i32.const 8)) (local.get $newptr))
            ${stubLogIR('o0', 'newptr', expectedType)}))))
    (local.set $off (local.get $newptr))
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (br $retry)))
    ${slotOnly ? '(i32.add (local.get $slot) (i32.const 16))' : '(local.get $coll)'})`
}

// A Map's value that is an array grown since it was stored names the stub its
// growth left: the read hands out the live block's pointer (the same array to
// `===`, core.js __same_ref) and stores it back, so the program's next reads
// of it hop nowhere (`m.get(k).push(v)` keeps every list of a multimap a stub
// otherwise). A table the reset keeps (below `__heap_reset`) keeps its slot.
const BOX_TAG_HI = (0xFFF80000 | (LAYOUT.TAG_MASK << (LAYOUT.TAG_SHIFT - 32))) | 0
const ARRAY_BOX_HI = ((LAYOUT.NAN_PREFIX << 16) | (PTR.ARRAY << (LAYOUT.TAG_SHIFT - 32))) | 0
const healValue = () => `(local.set $v (i64.load offset=16 (local.get $slot)))
          (if (i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (local.get $v) (i64.const 32))) (i32.const ${BOX_TAG_HI})) (i32.const ${ARRAY_BOX_HI}))
            (then
              (local.set $vo (i32.wrap_i64 (local.get $v)))
              (if (i32.and (i32.ge_u (local.get $vo) (i32.const 8)) (i32.eq (i32.load (i32.sub (local.get $vo) (i32.const 4))) (i32.const -1)))
                (then
                  (local.set $v (i64.or (i64.and (local.get $v) (i64.const 0xFFFFFFFF00000000)) (i64.extend_i32_u (call $__ptr_offset_fwd (local.get $vo)))))
                  ${hasDurableReset() ? `(if (i32.ge_u (local.get $slot) ${heapResetWat()}) (then (i64.store offset=16 (local.get $slot) (local.get $v))))` : '(i64.store offset=16 (local.get $slot) (local.get $v))'}))))
          (return (local.get $v))`

/** The value of the entry at `slot`, healed as a Map read heals it (a statement's
 *  fused read, compile/emit/fuse-probes.js). */
export const genSlotHeal = () => `(func $__slot_heal (param $slot i32) (result i64)
    (local $v i64) (local $vo i32)
    ${healValue()})`

/** get/has: the value (or `missing`), or 1/0. hashFn null takes the hash as a parameter. */
export function genOrdLookup(name, es, hashFn, eqExpr, expectedType, wantValue = true, hasExt = false, missing = UNDEF_NAN) {
  const rt = wantValue ? 'i64' : 'i32'
  const absent = wantValue ? `(i64.const ${missing})` : '(i32.const 0)'
  const onHit = wantValue ? '(br $hit)' : '(return (i32.const 1))'
  const t = typeExpr('$coll')
  const typeGuard = hasExt
    ? `(if (i32.ne ${t} (i32.const ${expectedType})) (then (if (i32.eq ${t} (i32.const ${PTR.EXTERNAL}))
        (then (return ${wantValue
          ? '(call $__ext_get (local.get $coll) (local.get $key))'
          : '(call $__ext_has (local.get $coll) (local.get $key))'}))
        (else (return ${absent})))))`
    : `(if (i32.ne ${t} (i32.const ${expectedType})) (then (return ${absent})))`
  return `(func $${name} (param $coll i64) (param $key i64) ${hashFn ? '' : '(param $hk i32)'} (result ${rt})
    ${probeLocals}${wantValue ? ' (local $v i64) (local $vo i32)' : ''}
    ${typeGuard}
    ${resolve('$coll')}
    ${hashFn ? keyHash(hashFn) : '(local.set $h (local.get $hk))'}
    ${geometry(es)}
    ${wantValue ? `(block $hit
      ${probe(es, eqExpr, onHit)}
      (return ${absent}))
    ${healValue()}` : `${probe(es, eqExpr, onHit)}
    ${absent}`})`
}

/** A statement's probe that may store (compile/emit/fuse-probes.js): the key's
 *  entry address, or 0 with the empty bucket the probe ended at and the key's
 *  hash left in `$__find_b`/`$__find_h` for `__ord_put_at`, which inserts there
 *  with no second probe. The receiver is a present table of `expectedType`. */
export function genOrdFind(name, es, hashFn, eqExpr, prologue = '') {
  return `(func $${name} (param $coll i64) (param $key i64) (result i32)
    ${probeLocals}
    ${resolve('$coll')}${prologue}
    ${keyHash(hashFn)}
    ${geometry(es)}
    ${probe(es, eqExpr, '(return (local.get $slot))')}
    (global.set $__find_b (local.get $b))
    (global.set $__find_h (local.get $h))
    (i32.const 0))`
}

/** The insertion a find that missed leaves for its statement: the entry
 *  appended, bucket `b` (empty since: nothing ran between) pointing at it; a
 *  full table takes the ordinary insertion, which grows it. */
export function genOrdPutAt(name, es, hasVal, fallback) {
  return `(func $${name} (param $coll i64) (param $key i64) ${hasVal ? '(param $val i64) ' : ''}(param $b i32) (param $h i32)
    (local $off i32) (local $cap i32) (local $ecap i32) (local $ix i32) (local $used i32) (local $slot i32)
    ${resolve('$coll')}
    (local.set $ecap ${ordEntriesWat('(local.get $cap)')})
    (local.set $used (i32.load ${ordUsedAddrWat('(local.get $off)', '(local.get $cap)', `(i32.const ${es})`)}))
    (if (i32.ge_u (local.get $used) (local.get $ecap))
      (then (drop (call $${fallback} (local.get $coll) (local.get $key)${hasVal ? ' (local.get $val)' : ''})) (return)))
    (local.set $ix (i32.add (local.get $off) (i32.mul (local.get $ecap) (i32.const ${es}))))
    (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $used) (i32.const ${es}))))
    ${seqStore()}
    ${keyStore}${durableEntryLogIR('slot', 'off')}${hasVal ? `
    (i64.store offset=16 (local.get $slot) (local.get $val))${durableSlotLogIR('slot', 16, 'val')}` : ''}
    (i32.store (i32.add (local.get $ix) (i32.shl (local.get $b) (i32.const 2)))
      (i32.or (i32.and (local.get $h) (i32.const ${TAG})) (i32.add (local.get $used) (i32.const 1))))
    (i32.store ${ordUsedAddrWat('(local.get $off)', '(local.get $cap)', `(i32.const ${es})`)} (i32.add (local.get $used) (i32.const 1)))
    (i32.store (i32.sub (local.get $off) (i32.const 8))
      (i32.add (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1))))`
}

/** delete: the entry tombstoned in place, its bucket's gap closed by backward
 *  shift (a bucket stays where its home lies cyclically in the gap's (b, j]);
 *  1 when the key was there. */
export function genOrdDelete(name, es, hashFn, eqExpr, expectedType) {
  return `(func $${name} (param $coll i64) (param $key i64) (result i32)
    ${probeLocals} (local $j i32) (local $k i32)
    (if (i32.ne ${typeExpr('$coll')} (i32.const ${expectedType})) (then (return (i32.const 0))))
    ${resolve('$coll')}
    ${keyHash(hashFn)}
    ${geometry(es)}
    (block $found
      ${probe(es, eqExpr, '(br $found)')}
      (return (i32.const 0)))
    ${durableSlotCancelIR('slot', es)}
    (i64.store offset=8 (local.get $slot) (i64.const ${TOMB_NAN}))
    (local.set $j (local.get $b))
    (block $stop (loop $shift
      (local.set $j (i32.and (i32.add (local.get $j) (i32.const 1)) (local.get $m)))
      (local.set $w (i32.load ${bucketAt('(local.get $j)')}))
      (br_if $stop (i32.eqz (local.get $w)))
      (local.set $k (i32.and (i32.load ${entryOf('(local.get $w)', es)}) (local.get $m)))
      (if (i32.le_u (local.get $b) (local.get $j))
        (then (br_if $shift (i32.and (i32.lt_u (local.get $b) (local.get $k)) (i32.le_u (local.get $k) (local.get $j)))))
        (else (br_if $shift (i32.or (i32.lt_u (local.get $b) (local.get $k)) (i32.le_u (local.get $k) (local.get $j))))))
      (i32.store ${bucketAt('(local.get $b)')} (local.get $w))
      (local.set $b (local.get $j))
      (br $shift)))
    (i32.store ${bucketAt('(local.get $b)')} (i32.const 0))
    (i32.store (i32.sub (local.get $off) (i32.const 8))
      (i32.sub (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1)))
    (i32.const 1))`
}

/** The cold rebuild of a full table: twice the buckets (four times past
 *  GROW_QUAD_CAP), or as many when at least half the usable entries are
 *  tombstones. A table that ends at the heap top above the reset mark grows
 *  where it stands (as an array's storage does, module/array.js): its live
 *  entries close up in place, the rest of the block clears, the heap top
 *  moves to the new end and the buckets re-index from the stored hashes; no
 *  copy, and no stub for a holder to hop. Any other table moves to a new block
 *  (`__ord_rebuild`). Returns the table's block; the caller forwards the old
 *  one where it moved. */
export const genOrdGrow = () => {
  const inPlace = !ctx.memory.shared && (ctx.transform.alloc !== false || !ctx.transform.optimize?.leanRuntime)
  return `(func $__ord_grow (param $off i32) (param $cap i32) (param $es i32) (result i32)
    (local $newcap i32)${inPlace ? ' (local $next i32) (local $j i32)' : ''}
    (local.set $newcap (select (local.get $cap)
      (i32.shl (local.get $cap) (select (i32.const 2) (i32.const 1) (i32.ge_u (local.get $cap) (i32.const ${GROW_QUAD_CAP}))))
      (i32.lt_u (i32.shl (i32.load (i32.sub (local.get $off) (i32.const 8))) (i32.const 1))
        (i32.load ${ordUsedAddrWat('(local.get $off)', '(local.get $cap)', '(local.get $es)')}))))
    (call $__table_check (local.get $newcap))${inPlace ? `
    (local.set $next (i32.add (local.get $off) ${ordBytesWat('(local.get $newcap)', '(local.get $es)')}))
    (if (i32.and
          (i32.and (i32.ge_u (local.get $off) ${heapResetWat()}) (i32.ge_u (local.get $next) (local.get $off)))
          (i32.or (i32.eq (local.get $newcap) (local.get $cap))
            (i32.eq (i32.add (local.get $off) ${ordBytesWat('(local.get $cap)', '(local.get $es)')}) (global.get $__heap))))
      (then
        (if (i32.gt_u (local.get $next) (global.get $__heap))
          (then
            (if (i32.gt_u (local.get $next) (global.get $__heap_end)) (then (call $__memgrow (local.get $next))))
            (global.set $__heap (local.get $next))))
        ;; the live entries close up in place; past them the block clears
        (local.set $j (call $__ord_live (local.get $off) (local.get $off) (local.get $cap) (local.get $es)))
        (memory.fill (i32.add (local.get $off) (i32.mul (local.get $j) (local.get $es))) (i32.const 0)
          (i32.sub (local.get $next) (i32.add (local.get $off) (i32.mul (local.get $j) (local.get $es)))))
        (call $__ord_index (local.get $off) (local.get $newcap) (local.get $es) (local.get $j))
        (i32.store (i32.sub (local.get $off) (i32.const 4)) (local.get $newcap))
        (return (local.get $off))))` : ''}
    (call $__ord_rebuild (local.get $off) (local.get $cap) (local.get $es) (local.get $newcap)))`
}

/** A cursor's step (module/collection.js cursorStep, written out): the next
 *  live entry of the table `$coll` names, walking from index `$i` past the entry
 *  of sequence `$s`, in `$es`-byte entries: its address, the index after it in
 *  `$__coll_i`; 0 past the last. A rebuild or a clear the walk met seeks. */
export const genCollStep = () => `(func $__coll_step (param $coll i64) (param $i i32) (param $s i32) (param $es i32) (result i32)
    (local $off i32) (local $cap i32) (local $used i32) (local $slot i32)
    ${resolve('$coll')}
    (local.set $used (i32.load ${ordUsedAddrWat('(local.get $off)', '(local.get $cap)', '(local.get $es)')}))
    (if (i32.and (i32.ne (local.get $i) (i32.const 0))
          (i32.or (i32.gt_u (local.get $i) (local.get $used))
            (i32.ne (i32.load offset=4 (i32.add (local.get $off) (i32.mul (i32.sub (local.get $i) (i32.const 1)) (local.get $es)))) (local.get $s))))
      (then (local.set $i (call $__coll_seek (local.get $off) (local.get $used) (local.get $es) (local.get $s)))))
    (loop $skip
      (if (i32.ge_u (local.get $i) (local.get $used)) (then (return (i32.const 0))))
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $i) (local.get $es))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $skip (i64.eq (i64.load offset=8 (local.get $slot)) (i64.const ${TOMB_NAN}))))
    (global.set $__coll_i (local.get $i))
    (local.get $slot))`

/** The live entries of the table at `off`, in their order, at `dst` (the block
 *  itself closes them up): their count. */
export const genOrdLive = () => `(func $__ord_live (param $off i32) (param $dst i32) (param $cap i32) (param $es i32) (result i32)
    (local $used i32) (local $i i32) (local $j i32) (local $slot i32)
    (local.set $used (i32.load ${ordUsedAddrWat('(local.get $off)', '(local.get $cap)', '(local.get $es)')}))
    ;; no tombstone among them: they move in one copy, or stand where they are
    (if (i32.eq (i32.load (i32.sub (local.get $off) (i32.const 8))) (local.get $used))
      (then
        (if (i32.ne (local.get $dst) (local.get $off))
          (then (memory.copy (local.get $dst) (local.get $off) (i32.mul (local.get $used) (local.get $es)))))
        (return (local.get $used))))
    (block $done (loop $each
      (br_if $done (i32.ge_u (local.get $i) (local.get $used)))
      (local.set $slot (i32.add (local.get $off) (i32.mul (local.get $i) (local.get $es))))
      (if (i64.ne (i64.load offset=8 (local.get $slot)) (i64.const ${TOMB_NAN}))
        (then
          (memory.copy (i32.add (local.get $dst) (i32.mul (local.get $j) (local.get $es))) (local.get $slot) (local.get $es))
          (local.set $j (i32.add (local.get $j) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $each)))
    (local.get $j))`

/** The first `n` entries of the block at `off`, of `cap` empty buckets, take a
 *  bucket each by their stored hashes, and the block's count is `n`. */
export const genOrdIndex = () => `(func $__ord_index (param $off i32) (param $cap i32) (param $es i32) (param $n i32)
    (local $nix i32) (local $m i32) (local $i i32) (local $slot i32) (local $h i32) (local $b i32)
    (local.set $nix (i32.add (local.get $off) (i32.mul ${ordEntriesWat('(local.get $cap)')} (local.get $es))))
    (local.set $m (i32.sub (local.get $cap) (i32.const 1)))
    (local.set $slot (local.get $off))
    (block $indexed (loop $index
      (br_if $indexed (i32.ge_u (local.get $i) (local.get $n)))
      (local.set $h (i32.load (local.get $slot)))
      (local.set $b (i32.and (local.get $h) (local.get $m)))
      (block $placed (loop $probe
        (br_if $placed (i32.eqz (i32.load (i32.add (local.get $nix) (i32.shl (local.get $b) (i32.const 2))))))
        (local.set $b (i32.and (i32.add (local.get $b) (i32.const 1)) (local.get $m)))
        (br $probe)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (i32.store (i32.add (local.get $nix) (i32.shl (local.get $b) (i32.const 2)))
        (i32.or (i32.and (local.get $h) (i32.const ${TAG})) (local.get $i)))
      (local.set $slot (i32.add (local.get $slot) (local.get $es)))
      (br $index)))
    (i32.store ${ordUsedAddrWat('(local.get $off)', '(local.get $cap)', '(local.get $es)')} (local.get $n)))`

/** A copy of the table at `off` (`new Set(set)`, `new Map(map)`), sized for
 *  `want` buckets: the block whole where it holds no more (its entries keep
 *  their order and their sequences, its buckets their places), else the live
 *  entries rebuilt into `want`. The table's own properties stay its own. */
export const genOrdCopy = () => `(func $__ord_copy (param $off i32) (param $es i32) (param $want i32) (result i32)
    (local $cap i32) (local $dst i32)
    (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
    (if (i32.le_u (local.get $cap) (local.get $want))
      (then
        (local.set $dst (call $__alloc_hdr_n (i32.load (i32.sub (local.get $off) (i32.const 8))) (local.get $cap) ${ordStrideWat('(local.get $es)')}))
        (memory.copy (local.get $dst) (local.get $off) ${ordBytesWat('(local.get $cap)', '(local.get $es)')})
        (return (local.get $dst))))
    (local.set $dst (call $__ord_rebuild (local.get $off) (local.get $cap) (local.get $es) (local.get $want)))
    (i64.store (i32.sub (local.get $dst) (i32.const 16)) (i64.const 0))
    (local.get $dst))`

/** The live entries of the table at `off`, in their order, in a new block of
 *  `newcap` buckets (it holds them: the callers size it), re-indexed by their
 *  stored hashes; the table's own properties carried. */
export const genOrdRebuild = () => `(func $__ord_rebuild (param $off i32) (param $cap i32) (param $es i32) (param $newcap i32) (result i32)
    (local $newptr i32) (local $j i32)
    (local.set $newptr (call $__alloc_hdr_n (i32.const 0) (local.get $newcap) ${ordStrideWat('(local.get $es)')}))
    ;; the table's own properties stay its own
    (i64.store (i32.sub (local.get $newptr) (i32.const 16)) (i64.load (i32.sub (local.get $off) (i32.const 16))))
    (local.set $j (call $__ord_live (local.get $off) (local.get $newptr) (local.get $cap) (local.get $es)))
    (call $__ord_index (local.get $newptr) (local.get $newcap) (local.get $es) (local.get $j))
    (i32.store (i32.sub (local.get $newptr) (i32.const 8)) (local.get $j))
    (local.get $newptr))`
