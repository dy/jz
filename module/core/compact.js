/**
 * Compaction of what the module keeps: the memory above the mark `memory.reset()`
 * returns to holds every value a call stored into module state since, and the
 * values those replaced, which the bump allocator never gives back. A program
 * that replaces its state call after call (`state = { ...state, x }`,
 * `buf = new Float64Array(n)`, `log = log + line`) grows without bound. Here
 * the host, as the outermost call returns, asks the module to keep only what
 * its roots reach: the live blocks slide down over the dead ones, in their
 * order, and every pointer to a moved block is rewritten.
 *
 * The walk is precise, not conservative as the release-by-reach walk is
 * (core/reach.js): a word read as a pointer is rewritten, so each block is
 * read by what its kind says it holds. An object's slots that hold numbers
 * only (raw bits, which may spell a box) and a closure environment's cells
 * and raw-carrier slots are named by tables the compiler lays out
 * (`__gc_tbl`); generic slots hold normalized values, where a NaN spelling a
 * heap pointer is a pointer. Interior pointers (a string slice, a typed
 * view's data) forward through the same bitmap as any address: a block's
 * words are marked live, and an address forwards to the floor plus the live
 * words below it, its low bits kept.
 *
 * Roots: the module's globals that hold values (`__gc_roots`, laid out per
 * program), the runtime's address-keyed table of properties on headerless
 * receivers, the reset log's buffers and records. What the host holds is
 * below the floor the host passes (interop.js: its own allocations, and the
 * top of the heap after any call that handed it a view of the module's
 * memory or a closure), so nothing the host names moves.
 *
 * Phases, all in scratch memory above the heap's top, which stays the heap's:
 *  1. mark: a depth-first walk from the roots over blocks at or above the
 *     static data's end; a visited bit per word keeps cycles finite, a live bit
 *     per word above the floor names what stays, and a list keeps every block
 *     whose words hold pointers.
 *  2. prefix counts of the live bits, so an address forwards in constant time.
 *  3. update: every pointer word of every listed block, every root, forwarded
 *     in place; a pointer to a growth stub below the floor rewrites the stub's
 *     forward too (the host may hold the stub's address).
 *  4. move: runs of live words slide down to the floor.
 *  5. a Set or Map keyed by identity (a pointer's bits hash it) is rebuilt in
 *     place from its entries; caches that name addresses are emptied.
 *
 * Nothing moves below the floor, and a walk that finds no room for its
 * scratch, or a memory the engine cannot grow, leaves the heap as it was.
 *
 * @module core/compact
 */
import { numericArraysOn } from '../../src/compile/numeric-arrays.js'
import { ctx, PTR, LAYOUT, HEAP, FORWARDING_MASK, declGlobal } from '../../src/ctx.js'
import { TOMB_NAN } from '../../src/ir.js'
import { nanPrefixHex, nanPrefixMaskHex, ssoBitI64Hex, STR_HCACHE_BIT, ARRAY_RAW } from '../../layout.js'
import { collectionLaneBytes } from '../collection/upsert.js'
import { compactOn, sitesOn, stubEntries, stubLogBytes, declarePin, declareSites, stubLogIR, COST_CAP, compactSlack, PRESSURE_SLACK, MARGIN } from './stub-log.js'
export { compactOn, sitesOn, stubEntries, stubLogBytes, declarePin, declareSites, stubLogIR, COST_CAP }
import { valKindToPtr } from '../../src/ir/pointers.js'
import { BIGINT_REP_RAW } from '../../src/compile/representation-plan.js'
import { ROOT_LOG_BYTES } from './reach.js'
import { recordsOn } from '../../src/compile/array-records.js'
import { K, bitOf, tagsOf, hasTag, NULL_BITS } from '../../src/summary/kind.js'

// JZ_DEBUG_POISON=1: what a compaction frees is overwritten with all ones.
const DBG_POISON = typeof process !== 'undefined' && process.env?.JZ_DEBUG_POISON === '1'
// JZ_DEBUG_GC=1: the module exports counters of the compactions asked for
// (`__g_asks`), run (`__g_runs`) and the words they walked (`__g_walked`),
// why the others were declined (`__g_no_floor`, `__g_no_stub`,
// `__g_no_room`), the region of the last (`__g_floor`, `__g_top`, `__g_lo`,
// `__g_fail`), the stub log's count (`__stubn`), and the first pointer whose
// header could not be one (`__g_bad_*`, with the block listed before it).
const DBG_GC = typeof process !== 'undefined' && process.env?.JZ_DEBUG_GC === '1'

/** Whether the module compacts what it keeps: the JS host (which calls it),
 *  an owned memory, the rewind on, no fixed-memory contract, and the option not off. */
const HEAP_TAGS = 0x7FF & ~((1 << PTR.ATOM) | (1 << PTR.EXTERNAL))
const SET_ENTRY = 16, MAP_ENTRY = 24
/** Kinds beside a pointer's tags in the block list: a captured binding's cell,
 *  a reset-log record, a growth stub below the floor whose forward moves. */
const KIND_CELL = 32, KIND_REC = 33, KIND_STUB = 34
/** Environment slot kinds in `__gc_tbl`: a value, a cell of an f64, a cell of an i32, raw bits. */
const ENV_VALUE = 0, ENV_CELL = 1, ENV_CELL32 = 2, ENV_RAW = 3

/** Tags whose keys a Set or Map hashes by identity (module/collection.js `__map_hash`
 *  mixes the pointer's bits): a moved key must be rehashed. */
const IDENTITY_TAGS = HEAP_TAGS & ~((1 << PTR.STRING) | (1 << PTR.BIGINT))

const SCALAR_TAGS = bitOf(K.NUMBER) | bitOf(K.BOOL) | NULL_BITS
const holdsNoHeap = (k) => k != null && tagsOf(k) !== 0 && (tagsOf(k) & ~SCALAR_TAGS) === 0

/** The table the kernels read (`__gc_tbl`): per object layout the slots that may
 *  hold a pointer, per closure its environment's slot kinds. Laid out as
 *  [u32 layouts][u32 closures][u32 offset…][u32 offset…], each offset naming
 *  [u32 count][u8 kind…] from the table's start. */
export function gcTableBytes() {
  const sids = ctx.schema.list ?? [], closures = ctx.closure.table ?? []
  const bodies = new Map((ctx.closure.bodies ?? []).map(b => [b.name, b]))
  const rows = []
  for (let sid = 0; sid < sids.length; sid++) {
    const props = sids[sid]
    rows.push(props.map((prop, i) => {
      const k = ctx.summary?.fieldKind?.(sid, prop) ?? 0
      // a slot the summary saw nothing reach holds what generic stores normalized
      if (k === 0 || tagsOf(k) === 0) return 1
      const raw = ctx.schema.slotRawBigint?.get(sid)?.has(i) || (tagsOf(k) === bitOf(K.BIGINT) && !ctx.schema.slotBigintBoxedBySid?.(sid, prop))
      if (raw) return 0
      let heap = false
      for (let tag = 1; tag < 32; tag++) if (hasTag(k, tag) && tag !== K.NUMBER && tag !== K.BOOL && tag !== K.NULLISH && tag !== K.ABSENT) heap = true
      return heap ? 1 : 0
    }))
  }
  for (const name of closures) {
    const b = bodies.get(name)
    if (!b) { rows.push([]); continue }
    rows.push(b.captures.map(c => b.boxed?.has(c) ? (b.cellI32?.has(c) ? ENV_CELL32 : ENV_CELL) : (b.bigintReps?.get(c) & BIGINT_REP_RAW) ? ENV_RAW : ENV_VALUE))
  }
  const head = 8 + 4 * rows.length
  let size = head
  const offs = rows.map(r => { const at = size; size += 4 + r.length; size = (size + 3) & ~3; return at })
  const bytes = new Uint8Array((size + 7) & ~7), dv = new DataView(bytes.buffer)
  dv.setUint32(0, sids.length, true)
  dv.setUint32(4, closures.length, true)
  rows.forEach((r, i) => { dv.setUint32(8 + 4 * i, offs[i], true); dv.setUint32(offs[i], r.length, true); bytes.set(r, offs[i] + 4) })
  return bytes
}


export const registerCompact = () => {
  for (const g of ['__g_floor', '__g_top', '__g_lo', '__g_vis', '__g_live', '__g_pre', '__g_list', '__g_ln', '__g_sp', '__g_lim', '__g_fail', '__g_nl']) declGlobal(g, 'i32', 0)
  if (DBG_GC) for (const g of ['__g_asks', '__g_runs', '__g_walked', '__g_no_floor', '__g_no_stub', '__g_no_room', '__g_bad_n', '__g_bad_off', '__g_bad_hi', '__g_bad_cap', '__g_bad_len', '__g_walking', '__g_last', '__g_last_hi', '__g_bad_walking', '__g_bad_last', '__g_bad_last_hi']) declGlobal(g, 'i32', 0, { export: g })
  if (DBG_GC) for (const g of ['__g_floor', '__g_top', '__g_lo', '__g_fail']) ctx.scope.globals.get(g).export = g

  const tagOf = (b) => `(i32.wrap_i64 (i64.and (i64.shr_u ${b} (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const auxOf = (b) => `(i32.wrap_i64 (i64.and (i64.shr_u ${b} (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))`
  const isBox = (b) => `(i64.eq (i64.and ${b} (i64.const ${nanPrefixMaskHex()})) (i64.const ${nanPrefixHex()}))`
  const lane = collectionLaneBytes()
  const has = (g) => ctx.scope.globals.has(g)

  // Whether the word names memory of the module's: a box with a heap tag, not
  // a string held in its pointer.
  // An array's record (module/collection/record.js) is a block of the heap's too.
  ctx.core.stdlib['__gc_box'] = () => `(func $__gc_box (param $w i64) (result i32)
    (local $t i32)
    (if (i32.eqz ${isBox('(local.get $w)')}) (then (return (i32.const 0))))
    (local.set $t ${tagOf('(local.get $w)')})
    (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${HEAP_TAGS | (recordsOn() ? 1 << PTR.RECORD : 0)}))) (then (return (i32.const 0))))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
          (i64.ne (i64.and (local.get $w) (i64.const ${ssoBitI64Hex()})) (i64.const 0)))
      (then (return (i32.const 0))))
    (i32.const 1))`

  // The block a pointer of a growable kind names now: past the stubs growth left.
  ctx.core.stdlib['__gc_final'] = `(func $__gc_final (param $off i32) (param $t i32) (result i32)
    (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${FORWARDING_MASK}))) (then (return (local.get $off))))
    (block $done (loop $hop
      (br_if $done (i32.lt_u (local.get $off) (i32.const 16)))
      (br_if $done (i32.gt_u (local.get $off) (global.get $__g_top)))
      (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
      (local.set $off (i32.load (i32.sub (local.get $off) (i32.const 8))))
      (br $hop)))
    (local.get $off))`

  // The handle a pointer of a growable kind resolves to: past the stubs
  // relocation left, to the block's header, or to a shifted array's base
  // record (a stub forwarding to a live header that carries a mark,
  // module/array.js arrBaseWat), which is what the array's own kernels keep
  // as the storage's base. A pointer collapsed past the base to the live
  // header would name words the next slide reuses for elements.
  ctx.core.stdlib['__gc_canon'] = `(func $__gc_canon (param $off i32) (param $t i32) (result i32)
    (local $to i32)
    (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${FORWARDING_MASK}))) (then (return (local.get $off))))
    (block $done (loop $hop
      (br_if $done (i32.lt_u (local.get $off) (i32.const 16)))
      (br_if $done (i32.gt_u (local.get $off) (global.get $__g_top)))
      (br_if $done (i32.ne (i32.load (i32.sub (local.get $off) (i32.const 4))) (i32.const -1)))
      (local.set $to (i32.load (i32.sub (local.get $off) (i32.const 8))))
      ;; the target a live, shifted header: this stub is its base record, the handle.
      ;; Its words are read only once it lies in the heap: a stale pointer into
      ;; memory a rewind released names a stub of ones, whose forward is anything.
      (if (i32.and (i32.ge_u (local.get $to) (i32.const 16)) (i32.le_u (local.get $to) (global.get $__g_top)))
        (then (if (i32.and (i32.ne (i32.load (i32.sub (local.get $to) (i32.const 4))) (i32.const -1))
                           (i32.eq (i32.load (i32.sub (local.get $to) (i32.const 12))) (i32.const -1)))
          (then (br $done)))))
      (local.set $off (local.get $to))
      (br $hop)))
    (local.get $off))`

  // Memory up to `need` bytes, grown where the engine allows and `grow` lets
  // it; the heap's top stays.
  ctx.core.stdlib['__gc_room'] = () => `(func $__gc_room (param $need i32) (param $grow i32) (result i32)
    (local $have i64) (local $pages i32)
    ${has('__park_base') ? `;; a phase checkpoint holds parked data in a lane above the heap (module/core.js): the scratch ends where the lane starts
    (if (global.get $__park_base) (then
      (if (i32.gt_u (local.get $need) (i32.sub (global.get $__park_base) (i32.const 8))) (then (return (i32.const 0))))))` : ''}
    (local.set $have (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16)))
    (if (i64.gt_u (i64.extend_i32_u (local.get $need)) (local.get $have))
      (then
        (if (i32.eqz (local.get $grow)) (then (return (i32.const 0))))
        (local.set $pages (i32.add (i32.wrap_i64 (i64.shr_u (i64.sub (i64.add (i64.extend_i32_u (local.get $need)) (i64.const 65535)) (local.get $have)) (i64.const 16))) (i32.const 1)))
        (if (i32.eq (memory.grow (local.get $pages)) (i32.const -1)) (then (return (i32.const 0))))
        (local.set $have (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16)))
        (global.set $__heap_end (i32.wrap_i64 (local.get $have)))
        (global.set $__heap_end64 (local.get $have))))
    (global.set $__g_lim (select (i32.const -8) (i32.wrap_i64 (local.get $have)) (i64.gt_u (local.get $have) (i64.const 0xFFFFFFF8))))
    ${has('__park_base') ? `(if (global.get $__park_base) (then (if (i32.gt_u (global.get $__g_lim) (i32.sub (global.get $__park_base) (i32.const 8)))
      (then (global.set $__g_lim (i32.sub (global.get $__park_base) (i32.const 8)))))))` : ''}
    (i32.const 1))`

  // Room for one more entry of the list and the stack, which grow towards
  // each other: the memory grows a page and the stack moves up with its end.
  ctx.core.stdlib['__gc_more'] = `(func $__gc_more (result i32)
    (local $lim i32) (local $delta i32)
    (local.set $lim (global.get $__g_lim))
    (if (i32.eqz (call $__gc_room (i32.add (local.get $lim) (i32.const 65536)) (i32.eqz (global.get $__viewed)))) (then (global.set $__g_fail (i32.const 1)) (return (i32.const 0))))
    (local.set $delta (i32.sub (global.get $__g_lim) (local.get $lim)))
    (if (i32.eqz (local.get $delta)) (then (global.set $__g_fail (i32.const 1)) (return (i32.const 0))))
    (memory.copy (i32.add (global.get $__g_sp) (local.get $delta)) (global.get $__g_sp) (i32.sub (local.get $lim) (global.get $__g_sp)))
    (global.set $__g_sp (i32.add (global.get $__g_sp) (local.get $delta)))
    (i32.const 1))`

  // A value waits on the stack for its walk.
  ctx.core.stdlib['__gc_push'] = `(func $__gc_push (param $w i64)
    (if (i32.eqz (call $__gc_box (local.get $w))) (then (return)))
    (if (i32.lt_u (i32.sub (global.get $__g_sp) (i32.const 8)) (i32.add (global.get $__g_list) (i32.shl (global.get $__g_ln) (i32.const 3))))
      (then (if (i32.eqz (call $__gc_more)) (then (return)))))
    (global.set $__g_sp (i32.sub (global.get $__g_sp) (i32.const 8)))
    (i64.store (global.get $__g_sp) (local.get $w)))`

  // A block whose words hold pointers joins the list, by its kind and address.
  ctx.core.stdlib['__gc_list'] = `(func $__gc_list (param $hi i32) (param $off i32)
    (local $at i32)
    (local.set $at (i32.add (global.get $__g_list) (i32.shl (global.get $__g_ln) (i32.const 3))))
    (if (i32.gt_u (i32.add (local.get $at) (i32.const 8)) (global.get $__g_sp))
      (then (if (i32.eqz (call $__gc_more)) (then (return)))))
    (i32.store (local.get $at) (local.get $off))
    (i32.store offset=4 (local.get $at) (local.get $hi))
    (global.set $__g_ln (i32.add (global.get $__g_ln) (i32.const 1))))`

  // A word to rewrite once every pointer is forwarded: the forward of a stub
  // pointers still follow (a durable one, a shifted array's base record and
  // mark). Written then, so no pointer forwards twice through it. The pairs
  // wait on the stack, which the walk left empty.
  ctx.core.stdlib['__gc_defer'] = `(func $__gc_defer (param $at i32) (param $v i32)
    (if (i32.lt_u (i32.sub (global.get $__g_sp) (i32.const 8)) (i32.add (global.get $__g_list) (i32.shl (global.get $__g_ln) (i32.const 3))))
      (then (if (i32.eqz (call $__gc_more)) (then (return)))))
    (global.set $__g_sp (i32.sub (global.get $__g_sp) (i32.const 8)))
    (i32.store (global.get $__g_sp) (local.get $at))
    (i32.store offset=4 (global.get $__g_sp) (local.get $v)))`

  // Whether the word at `off` is met for the first time (a bit per word from the static data's end).
  ctx.core.stdlib['__gc_seen'] = `(func $__gc_seen (param $off i32) (result i32)
    (local $i i32) (local $cell i32) (local $bit i32)
    (local.set $i (i32.shr_u (i32.sub (local.get $off) (global.get $__g_lo)) (i32.const 3)))
    (local.set $cell (i32.add (global.get $__g_vis) (i32.shr_u (local.get $i) (i32.const 3))))
    (local.set $bit (i32.shl (i32.const 1) (i32.and (local.get $i) (i32.const 7))))
    (if (i32.and (i32.load8_u (local.get $cell)) (local.get $bit)) (then (return (i32.const 1))))
    (i32.store8 (local.get $cell) (i32.or (i32.load8_u (local.get $cell)) (local.get $bit)))
    (i32.const 0))`

  // Whether the walk visited the block at `off` (`__gc_seen` without marking).
  ctx.core.stdlib['__gc_was'] = `(func $__gc_was (param $off i32) (result i32)
    (local $i i32)
    (local.set $i (i32.shr_u (i32.sub (local.get $off) (global.get $__g_lo)) (i32.const 3)))
    (i32.and (i32.load8_u (i32.add (global.get $__g_vis) (i32.shr_u (local.get $i) (i32.const 3)))) (i32.shl (i32.const 1) (i32.and (local.get $i) (i32.const 7)))))`

  // A count read off a header, held to what the memory below the top has room for.
  ctx.core.stdlib['__gc_fit'] = `(func $__gc_fit (param $p i32) (param $n i32) (param $stride i32) (result i32)
    (local $room i32)
    (if (i32.ge_u (local.get $p) (global.get $__g_top)) (then (return (i32.const 0))))
    (local.set $room (i32.div_u (i32.sub (global.get $__g_top) (local.get $p)) (local.get $stride)))
    (select (local.get $room) (local.get $n) (i32.gt_u (local.get $n) (local.get $room))))`

  // A stub a block left as it grew (module/array.js relocateWat, the
  // collections' growth): logged for a loop's compaction, which rewrites the
  // forward of one below its floor and keeps what it names, for the caller's
  // local that may still name the stub; one above the floor it skips. The
  // log overflowing declines every compaction until the next outermost call.
  ctx.core.stdlib['__gc_stub'] = `(func $__gc_stub (param $off i32) (param $box i64)
    (local $n i32) (local $at i32)
    (local.set $n (global.get $__stubn))
    (if (i32.lt_s (local.get $n) (i32.const 0)) (then (return)))
    (if (i32.ge_u (local.get $n) (i32.const ${stubEntries()})) (then (global.set $__stubn (i32.const -1)) (return)))
    (local.set $at (i32.add (global.get $__stubs) (i32.shl (local.get $n) (i32.const 4))))
    (i32.store (local.get $at) (local.get $off))
    (i64.store offset=8 (local.get $at) (local.get $box))
    (global.set $__stubn (i32.add (local.get $n) (i32.const 1))))`

  // A loop site's threshold (optimize/loop-compact.js), asked right after its
  // compaction moved: the heap address past which the loop compacts, from its
  // mark, what the compaction walked (\`cost\`) and the memory's cap less one.
  // The amortizing rule fires past mark + 2·cost·r + slack, r the walk's
  // yield: 8·above / (8·freed + above) of the memory above the floor
  // (\`__g_floor\` to \`__g_top\`, \`__heap\` where the move left it), held to
  // 1…8. A loop that drops what it made (a string carried and replaced)
  // frees most of it, r = 1; one that keeps it (a builder pushing fresh
  // objects into a container older than the loop) frees little, and its next
  // walk waits up to eight times as long: either way the garbage between two
  // walks stays within twice the last one's cost. The pressure rule, once the
  // room to the cap less an eighth of the heap and a margin is short of that,
  // fires past mark + cost/8 + slack: heap > min(mark + need, max(8·room, mark + low)).
  ctx.core.stdlib['__gc_thresh'] = `(func $__gc_thresh (param $mark i32) (param $cost i32) (param $cap1 i32) (result i32)
    (local $need i64) (local $low i64) (local $m i64) (local $room i64) (local $p i64) (local $t i64) (local $above i64) (local $r i64)
    (local.set $m (i64.extend_i32_u (local.get $mark)))
    ${has('__park_base') ? `;; a parked lane caps the heap where it starts
    (if (global.get $__park_base) (then (local.set $cap1 (i32.sub (global.get $__park_base) (i32.const 9)))))` : ''}
    (local.set $above (i64.extend_i32_u (i32.sub (global.get $__g_top) (global.get $__g_floor))))
    (local.set $r (i64.div_u (i64.shl (local.get $above) (i64.const 3))
      (i64.add (i64.add (i64.shl (i64.extend_i32_u (i32.sub (global.get $__g_top) (global.get $__heap))) (i64.const 3)) (local.get $above)) (i64.const 1))))
    (if (i64.eqz (local.get $r)) (then (local.set $r (i64.const 1))))
    (if (i64.gt_u (local.get $r) (i64.const 8)) (then (local.set $r (i64.const 8))))
    (local.set $need (i64.add (i64.mul (i64.shl (i64.extend_i32_u (local.get $cost)) (i64.const 1)) (local.get $r)) (i64.const ${compactSlack()})))
    (local.set $low (i64.add (i64.shr_u (i64.extend_i32_u (local.get $cost)) (i64.const 3)) (i64.const ${PRESSURE_SLACK})))
    ;; 8 · (cap − 1 − mark − margin − need), the heap past which the pressure rule holds
    (local.set $room (i64.sub (i64.sub (i64.sub (i64.extend_i32_u (local.get $cap1)) (local.get $m)) (i64.const ${MARGIN})) (local.get $need)))
    (local.set $p (select (i64.add (i64.shl (local.get $room) (i64.const 3)) (i64.const 7)) (i64.const 0) (i64.gt_s (local.get $room) (i64.const 0))))
    (if (i64.lt_u (local.get $p) (i64.add (local.get $m) (local.get $low))) (then (local.set $p (i64.add (local.get $m) (local.get $low)))))
    (local.set $t (i64.add (local.get $m) (local.get $need)))
    (if (i64.gt_u (local.get $t) (local.get $p)) (then (local.set $t (local.get $p))))
    (if (i64.gt_u (local.get $t) (i64.const 0xFFFFFFFF)) (then (local.set $t (i64.const 0xFFFFFFFF))))
    (i32.wrap_i64 (local.get $t)))`

  // The words of [start, end) stay: live where they lie above the floor,
  // walked wherever they lie.
  ctx.core.stdlib['__gc_keep'] = `(func $__gc_keep (param $start i32) (param $end i32)
    (local $i i32) (local $e i32) (local $cell i32)
    (global.set $__g_cost (i32.add (global.get $__g_cost) (i32.sub (local.get $end) (local.get $start))))
    (if (i32.gt_u (global.get $__g_cost) (i32.const ${COST_CAP})) (then (global.set $__g_cost (i32.const ${COST_CAP}))))
    (if (i32.lt_u (local.get $start) (global.get $__g_floor)) (then (local.set $start (global.get $__g_floor))))
    (if (i32.gt_u (local.get $end) (global.get $__g_top)) (then (local.set $end (global.get $__g_top))))
    (if (i32.ge_u (local.get $start) (local.get $end)) (then (return)))
    (local.set $i (i32.shr_u (i32.sub (i32.and (local.get $start) (i32.const -8)) (global.get $__g_floor)) (i32.const 3)))
    (local.set $e (i32.shr_u (i32.sub (i32.and (i32.add (local.get $end) (i32.const 7)) (i32.const -8)) (global.get $__g_floor)) (i32.const 3)))
    (block $done (loop $word
      (br_if $done (i32.ge_u (local.get $i) (local.get $e)))
      ;; a whole byte of words at once
      (if (i32.and (i32.eqz (i32.and (local.get $i) (i32.const 7))) (i32.le_u (i32.add (local.get $i) (i32.const 8)) (local.get $e)))
        (then
          (i32.store8 (i32.add (global.get $__g_live) (i32.shr_u (local.get $i) (i32.const 3))) (i32.const 255))
          (local.set $i (i32.add (local.get $i) (i32.const 8)))
          (br $word)))
      (local.set $cell (i32.add (global.get $__g_live) (i32.shr_u (local.get $i) (i32.const 3))))
      (i32.store8 (local.get $cell) (i32.or (i32.load8_u (local.get $cell)) (i32.shl (i32.const 1) (i32.and (local.get $i) (i32.const 7)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $word))))`

  // A table of the program's layouts and closures (gcTableBytes): the row of
  // one, [count][kinds…], or 0 where the table holds none.
  ctx.core.stdlib['__gc_row'] = `(func $__gc_row (param $which i32) (param $i i32) (result i32)
    (local $n i32)
    (local.set $n (i32.load (i32.add (global.get $__gc_tbl) (local.get $which))))
    (if (i32.ge_u (local.get $i) (local.get $n)) (then (return (i32.const 0))))
    (if (local.get $which) (then (local.set $i (i32.add (local.get $i) (i32.load (global.get $__gc_tbl))))))
    (i32.add (global.get $__gc_tbl) (i32.load (i32.add (i32.add (global.get $__gc_tbl) (i32.const 8)) (i32.shl (local.get $i) (i32.const 2))))))`

  // One cell of a captured binding: an 8-byte block holding a value (`wide`) or an i32.
  ctx.core.stdlib['__gc_cell'] = `(func $__gc_cell (param $c i32) (param $wide i32)
    (if (i32.or (i32.lt_u (local.get $c) (global.get $__g_lo)) (i32.gt_u (local.get $c) (global.get $__g_top))) (then (return)))
    (if (i32.and (local.get $c) (i32.const 7)) (then (return)))
    (if (call $__gc_seen (local.get $c)) (then (return)))
    (call $__gc_keep (local.get $c) (i32.add (local.get $c) (i32.const 8)))
    (if (local.get $wide) (then
      (call $__gc_list (i32.const ${KIND_CELL << 16}) (local.get $c))
      (call $__gc_push (i64.load (local.get $c))))))`

  // The reset log's records (core/durable-log.js): [next, off, len, cap, cells…];
  // bit 1 of the offset marks an array of raw Numbers, whose cells hold no pointer.
  ctx.core.stdlib['__gc_rec'] = () => `(func $__gc_rec (param $rec i32)
    (local $n i32) (local $p i32) (local $e i32)
    (block $done (loop $next
      (br_if $done (i32.or (i32.lt_u (local.get $rec) (global.get $__g_lo)) (i32.gt_u (local.get $rec) (global.get $__g_top))))
      (br_if $done (call $__gc_seen (local.get $rec)))
      (local.set $n (call $__gc_fit (i32.add (local.get $rec) (i32.const 16)) (select (i32.load offset=12 (local.get $rec)) (i32.load offset=8 (local.get $rec)) (i32.and (i32.load offset=4 (local.get $rec)) (i32.const 1))) (i32.const 8)))
      (call $__gc_keep (local.get $rec) (i32.add (i32.add (local.get $rec) (i32.const 16)) (i32.shl (local.get $n) (i32.const 3))))
      (call $__gc_list (i32.const ${KIND_REC << 16}) (local.get $rec))
      (local.set $p (i32.add (local.get $rec) (i32.const 16)))
      (local.set $e ${numericArraysOn() ? `(select (local.get $p) (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3)))
        (i32.and (i32.load offset=4 (local.get $rec)) (i32.const 2)))` : '(i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3)))'})
      (block $cells (loop $cell
        (br_if $cells (i32.ge_u (local.get $p) (local.get $e)))
        (call $__gc_push (i64.load (local.get $p)))
        (local.set $p (i32.add (local.get $p) (i32.const 8)))
        (br $cell)))
      (local.set $rec (i32.load (local.get $rec)))
      (br $next))))`

  // The properties a header names at `p - 16`: a HASH pointer, its low bit a mark.
  const props = (p) => `(call $__gc_push (i64.and (i64.load (i32.sub ${p} (i32.const 16))) (i64.const -2)))`

  // One value: the block it names kept whole, listed where its words hold
  // pointers, those pointers pushed for their walk.
  ctx.core.stdlib['__gc_mark'] = () => `(func $__gc_mark (param $w i64)
    (local $t i32) (local $aux i32) (local $off i32) (local $n i32) (local $cap i32) (local $p i32) (local $e i32) (local $stride i32) (local $row i32) (local $k i32)
    (if (i32.eqz (call $__gc_box (local.get $w))) (then (return)))
    (local.set $t ${tagOf('(local.get $w)')})
    (local.set $aux ${auxOf('(local.get $w)')})
    (local.set $off (i32.wrap_i64 (local.get $w)))
    (if (i32.lt_u (local.get $off) (i32.const 8)) (then (return)))
    (local.set $p (call $__gc_canon (local.get $off) (local.get $t)))
    ;; a stub below the floor, whose block moves: its forward is rewritten once every pointer is (KIND_STUB)${ctx.core.includes.has('__durable_fwd_log') ? `.
    ;; In a chain, the last stub below the floor: the stubs before it forward to stubs that stay,
    ;; and a reset's relocation heal restores the one that grew in the round, the last; rewritten,
    ;; the first would skip it, past the heal, into the released round` : ''}
    (if (i32.and (i32.ne (local.get $p) (local.get $off)) (i32.lt_u (local.get $off) (global.get $__g_floor)))
      (then${ctx.core.includes.has('__durable_fwd_log') ? `
        (local.set $e (local.get $off))
        (block $last (loop $hop
          (local.set $k (i32.load (i32.sub (local.get $e) (i32.const 8))))
          (br_if $last (i32.or (i32.lt_u (local.get $k) (i32.const 16)) (i32.ge_u (local.get $k) (global.get $__g_floor))))
          (br_if $last (i32.ne (i32.load (i32.sub (local.get $k) (i32.const 4))) (i32.const -1)))
          (local.set $e (local.get $k))
          (br $hop)))
        (if (i32.eqz (call $__gc_seen (local.get $e))) (then (call $__gc_list (i32.const ${KIND_STUB << 16}) (local.get $e))))))` : ` (if (i32.eqz (call $__gc_seen (local.get $off))) (then (call $__gc_list (i32.const ${KIND_STUB << 16}) (local.get $off))))))`}
    ;; past a base record to the live header it forwards to
    (if (i32.and (i32.ge_u (local.get $p) (i32.const 16)) (i32.le_u (local.get $p) (global.get $__g_top)))
      (then (if (i32.eq (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const -1))
        (then (local.set $p (i32.load (i32.sub (local.get $p) (i32.const 8))))))))
    (local.set $off (local.get $p))
    (if (i32.or (i32.lt_u (local.get $off) (global.get $__g_lo)) (i32.gt_u (local.get $off) (global.get $__g_top))) (then (return)))
    ;; a slice names bytes inside another string: kept, nothing to walk
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_BIT})))
      (then
        (call $__gc_keep (local.get $off) (i32.add (local.get $off) (i32.shl (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_LEN_MASK})) (i32.const 1))))
        (return)))
    (if (call $__gc_seen (local.get $off)) (then (return)))
    (local.set $p (local.get $off))
    ${DBG_GC ? `;; debug: a header that cannot be one (a negative capacity, a length past it, storage past the top): the first noted
    (if (i32.and (i32.ne (local.get $t) (i32.const ${PTR.TYPED})) (i32.ne (local.get $t) (i32.const ${PTR.STRING})))
      (then
        (if (i32.or (i32.or (i32.lt_s (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 0))
                            (i32.gt_u (i32.load (i32.sub (local.get $p) (i32.const 8))) (i32.load (i32.sub (local.get $p) (i32.const 4)))))
                    (i32.gt_u (i32.add (local.get $p) (i32.shl (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 3))) (global.get $__g_top)))
          (then
            (if (i32.eqz (global.get $__g_bad_n))
              (then
                (global.set $__g_bad_off (local.get $p))
                (global.set $__g_bad_hi (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))))
                (global.set $__g_bad_cap (i32.load (i32.sub (local.get $p) (i32.const 4))))
                (global.set $__g_bad_len (i32.load (i32.sub (local.get $p) (i32.const 8))))
                (global.set $__g_bad_walking (global.get $__g_walking))
                (global.set $__g_bad_last (global.get $__g_last))
                (global.set $__g_bad_last_hi (global.get $__g_last_hi))))
            (global.set $__g_bad_n (i32.add (global.get $__g_bad_n) (i32.const 1))))
          (else
            (global.set $__g_last (local.get $p))
            (global.set $__g_last_hi (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))))))))` : ''}
    ${recordsOn() ? `;; a record: its header, slots and order list kept, its slots' values walked
    (if (i32.eq (local.get $t) (i32.const ${PTR.RECORD}))
      (then
        (local.set $cap (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (call $__gc_keep (i32.sub (local.get $p) (i32.const 16)) (i32.add (local.get $p) (i32.shl (local.get $cap) (i32.const 3))))
        (call $__gc_list (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (local.get $p))
        (local.set $n (i32.load (i32.sub (local.get $p) (i32.const 16))))
        (if (i32.gt_u (local.get $n) (local.get $cap)) (then (local.set $n (local.get $cap))))
        (local.set $e (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3))))
        (block $done (loop $slot
          (br_if $done (i32.ge_u (local.get $p) (local.get $e)))
          (call $__gc_push (i64.load (local.get $p)))
          (local.set $p (i32.add (local.get $p) (i32.const 8)))
          (br $slot)))
        (return)))` : ''}
    (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
      (then
        (local.set $cap (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (local.set $n (i32.load (i32.sub (local.get $p) (i32.const 8))))
        (if (i32.gt_u (local.get $n) (local.get $cap)) (then (local.set $n (local.get $cap))))
        ;; a shifted array's storage begins at its base, which the header's mark names (module/array.js arrBaseWat)
        (local.set $e (i32.sub (local.get $p) (i32.const 16)))
        (if (i32.and (i32.eq (i32.load (i32.sub (local.get $p) (i32.const 12))) (i32.const -1)) (i32.ne (i32.load (local.get $e)) (i32.const -1)))
          (then
            (local.set $k (i32.load (local.get $e)))
            (local.set $k (select (i32.sub (local.get $p) (i32.const 8)) (local.get $k) (i32.eq (local.get $k) (local.get $p))))
            (if (i32.and (i32.ge_u (local.get $k) (global.get $__g_lo)) (i32.lt_u (local.get $k) (local.get $p)))
              (then (local.set $e (i32.sub (local.get $k) (i32.const 16)))))))
        (call $__gc_keep (local.get $e) (i32.add (local.get $p) (i32.shl (local.get $cap) (i32.const 3))))
        (call $__gc_list (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (local.get $p))
        (if (i32.ne (i32.load (i32.sub (local.get $p) (i32.const 12))) (i32.const -1)) (then ${props('(local.get $p)')}))
        ;; an array of raw Numbers (its aux ARRAY_RAW) holds no pointer
        ${numericArraysOn() ? `(if (i32.and (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (i32.const ${ARRAY_RAW})) (then (local.set $n (i32.const 0))))` : ''}
        (local.set $e (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3))))
        (block $done (loop $cell
          (br_if $done (i32.ge_u (local.get $p) (local.get $e)))
          (call $__gc_push (i64.load (local.get $p)))
          (local.set $p (i32.add (local.get $p) (i32.const 8)))
          (br $cell)))
        (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.OBJECT}))
      (then
        (local.set $cap (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (call $__gc_keep (i32.sub (local.get $p) (i32.const 16)) (i32.add (local.get $p) (i32.shl (local.get $cap) (i32.const 3))))
        (call $__gc_list (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (local.get $p))
        ${props('(local.get $p)')}
        (local.set $row (call $__gc_row (i32.const 0) (local.get $aux)))
        (local.set $n (local.get $cap))
        (if (local.get $row) (then (if (i32.lt_u (i32.load (local.get $row)) (local.get $n)) (then (local.set $n (i32.load (local.get $row)))))))
        (local.set $k (i32.const 0))
        (block $done (loop $slot
          (br_if $done (i32.ge_u (local.get $k) (local.get $n)))
          (if (i32.or (i32.eqz (local.get $row)) (i32.load8_u (i32.add (i32.add (local.get $row) (i32.const 4)) (local.get $k))))
            (then (call $__gc_push (i64.load (i32.add (local.get $p) (i32.shl (local.get $k) (i32.const 3)))))))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $slot)))
        (return)))
    (if (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${(1 << PTR.HASH) | (1 << PTR.SET) | (1 << PTR.MAP)}))
      (then
        (local.set $e (select (i32.const ${SET_ENTRY}) (i32.const ${MAP_ENTRY}) (i32.eq (local.get $t) (i32.const ${PTR.SET}))))
        (local.set $stride (i32.add (local.get $e) (i32.const ${lane})))
        (local.set $cap (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (local.get $stride)))
        (call $__gc_keep (i32.sub (local.get $p) (i32.const 16)) (i32.add (local.get $p) (i32.mul (local.get $cap) (local.get $stride))))
        (call $__gc_list (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (local.get $p))
        (if (i32.ne (local.get $t) (i32.const ${PTR.HASH})) (then ${props('(local.get $p)')}))
        (local.set $n (i32.add (local.get $p) (i32.mul (local.get $cap) (local.get $e))))
        (block $done (loop $entry
          (br_if $done (i32.ge_u (local.get $p) (local.get $n)))
          (if (i32.and (i64.ne (i64.load (local.get $p)) (i64.const 0)) (i64.ne (i64.load offset=8 (local.get $p)) (i64.const ${TOMB_NAN})))
            (then
              (call $__gc_push (i64.load offset=8 (local.get $p)))
              (if (i32.eq (local.get $e) (i32.const ${MAP_ENTRY})) (then (call $__gc_push (i64.load offset=16 (local.get $p)))))))
          (local.set $p (i32.add (local.get $p) (local.get $e)))
          (br $entry)))
        (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE}))
      (then
        (local.set $cap (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (call $__gc_keep (i32.sub (local.get $p) (i32.const 16)) (i32.add (local.get $p) (i32.shl (local.get $cap) (i32.const 3))))
        (call $__gc_list (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (local.get $p))
        ${props('(local.get $p)')}
        (local.set $row (call $__gc_row (i32.const 4) (local.get $aux)))
        (local.set $n (local.get $cap))
        (if (local.get $row) (then (if (i32.lt_u (i32.load (local.get $row)) (local.get $n)) (then (local.set $n (i32.load (local.get $row)))))))
        (local.set $k (i32.const 0))
        (block $done (loop $slot
          (br_if $done (i32.ge_u (local.get $k) (local.get $n)))
          (local.set $e (select (i32.load8_u (i32.add (i32.add (local.get $row) (i32.const 4)) (local.get $k))) (i32.const ${ENV_VALUE}) (local.get $row)))
          (if (i32.eq (local.get $e) (i32.const ${ENV_VALUE}))
            (then (call $__gc_push (i64.load (i32.add (local.get $p) (i32.shl (local.get $k) (i32.const 3))))))
            (else (if (i32.ne (local.get $e) (i32.const ${ENV_RAW}))
              (then (call $__gc_cell (i32.load (i32.add (local.get $p) (i32.shl (local.get $k) (i32.const 3)))) (i32.eq (local.get $e) (i32.const ${ENV_CELL})))))))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $slot)))
        (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
      (then
        (if (i32.and (local.get $aux) (i32.const 8))
          (then
            ;; a view: its descriptor, and the block its bytes lie in
            (call $__gc_keep (local.get $p) (i32.add (local.get $p) (i32.const 16)))
            (call $__gc_list (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (local.get $p))
            (local.set $cap (i32.load offset=8 (local.get $p)))
            (if (i32.and (i32.ge_u (local.get $cap) (global.get $__g_lo)) (i32.le_u (local.get $cap) (global.get $__g_top)))
              (then (if (i32.eqz (call $__gc_seen (local.get $cap)))
                (then (call $__gc_keep (i32.sub (local.get $cap) (i32.const 16)) (i32.add (local.get $cap) (call $__gc_fit (local.get $cap) (i32.load (i32.sub (local.get $cap) (i32.const 4))) (i32.const 1))))))))
            (return)))
        (call $__gc_keep (i32.sub (local.get $p) (i32.const 16)) (i32.add (local.get $p) (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 1))))
        (call $__gc_list (i32.wrap_i64 (i64.shr_u (local.get $w) (i64.const 32))) (local.get $p))
        ${props('(local.get $p)')}
        (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.BUFFER}))
      (then (call $__gc_keep (i32.sub (local.get $p) (i32.const 16)) (i32.add (local.get $p) (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 1)))) (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
      (then
        (call $__gc_keep (i32.sub (local.get $p) (select (i32.const 8) (i32.const 4) (i32.and (local.get $aux) (i32.const ${STR_HCACHE_BIT}))))
          (i32.add (local.get $p) (i32.shl (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 1))))
        (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.BIGINT}))
      (then (call $__gc_keep (local.get $p) (i32.add (local.get $p) (i32.const 8))))))`

  // Where an address goes: the floor plus the live words below it, its low bits kept.
  ctx.core.stdlib['__gc_fwd_raw'] = `(func $__gc_fwd_raw (param $a i32) (result i32)
    (local $i i32) (local $j i32)
    (if (global.get $__g_fail) (then (return (local.get $a))))
    (if (i32.or (i32.lt_u (local.get $a) (global.get $__g_floor)) (i32.gt_u (local.get $a) (global.get $__g_top))) (then (return (local.get $a))))
    (local.set $i (i32.shr_u (i32.sub (local.get $a) (global.get $__g_floor)) (i32.const 3)))
    (local.set $j (i32.shr_u (local.get $i) (i32.const 6)))
    (i32.add (global.get $__g_floor)
      (i32.add
        (i32.shl (i32.add (i32.load (i32.add (global.get $__g_pre) (i32.shl (local.get $j) (i32.const 2))))
          (i32.wrap_i64 (i64.popcnt (i64.and (i64.load (i32.add (global.get $__g_live) (i32.shl (local.get $j) (i32.const 3))))
            (i64.sub (i64.shl (i64.const 1) (i64.extend_i32_u (i32.and (local.get $i) (i32.const 63)))) (i64.const 1)))))) (i32.const 3))
        (i32.and (local.get $a) (i32.const 7)))))`

  // A value past the move: a pointer into the moved memory rewritten past the
  // stubs growth left above the floor; one naming a stub below the floor stays
  // as it is, the stub's forward rewritten instead (deferred: other pointers
  // still follow it as it stands).
  ctx.core.stdlib['__gc_fwd'] = `(func $__gc_fwd (param $w i64) (result i64)
    (local $t i32) (local $off i32) (local $f i32) (local $to i32)
    (if (global.get $__g_fail) (then (return (local.get $w))))
    (if (i32.eqz (call $__gc_box (local.get $w))) (then (return (local.get $w))))
    (local.set $t ${tagOf('(local.get $w)')})
    (local.set $off (i32.wrap_i64 (local.get $w)))
    (if (i32.lt_u (local.get $off) (i32.const 8)) (then (return (local.get $w))))
    ;; a pointer to a stub below the floor keeps naming the stub, which the
    ;; program may hold for durable (module/core/durable-log.js): its forward moves (KIND_STUB)
    (if (i32.lt_u (local.get $off) (global.get $__g_floor)) (then (return (local.get $w))))
    (local.set $f (call $__gc_canon (local.get $off) (local.get $t)))
    (local.set $to (call $__gc_fwd_raw (local.get $f)))
    (i64.or (i64.and (local.get $w) (i64.const 0xFFFFFFFF00000000)) (i64.extend_i32_u (local.get $to))))`

  const fwdAt = (p) => `(i64.store ${p} (call $__gc_fwd (i64.load ${p})))`
  const fwdProps = (p) => `(i64.store (i32.sub ${p} (i32.const 16))
      (i64.or (call $__gc_fwd (i64.and (i64.load (i32.sub ${p} (i32.const 16))) (i64.const -2))) (i64.and (i64.load (i32.sub ${p} (i32.const 16))) (i64.const 1))))`

  // Every pointer word of one listed block, rewritten in place.
  ctx.core.stdlib['__gc_update'] = () => `(func $__gc_update (param $hi i32) (param $p i32)
    (local $t i32) (local $aux i32) (local $n i32) (local $cap i32) (local $e i32) (local $k i32) (local $row i32) (local $q i32)
    (local.set $t (i32.and (i32.shr_u (local.get $hi) (i32.const ${LAYOUT.TAG_SHIFT - 32})) (i32.const ${LAYOUT.TAG_MASK})))
    (local.set $aux (i32.and (local.get $hi) (i32.const ${LAYOUT.AUX_MASK})))
    (if (i32.eq (local.get $hi) (i32.const ${KIND_CELL << 16})) (then ${fwdAt('(local.get $p)')} (return)))
    (if (i32.eq (local.get $hi) (i32.const ${KIND_STUB << 16}))
      (then
        ;; its forward names the handle (a header, or a shifted array's base record), forwarded
        (call $__gc_defer (i32.sub (local.get $p) (i32.const 8)) (call $__gc_fwd_raw (call $__gc_canon (local.get $p) (i32.const ${PTR.ARRAY}))))
        (return)))
    (if (i32.eq (local.get $hi) (i32.const ${KIND_REC << 16}))
      (then
        (i32.store (local.get $p) (call $__gc_fwd_raw (i32.load (local.get $p))))
        (local.set $n (select (i32.load offset=12 (local.get $p)) (i32.load offset=8 (local.get $p)) (i32.and (i32.load offset=4 (local.get $p)) (i32.const 1))))
        ${numericArraysOn() ? '(if (i32.and (i32.load offset=4 (local.get $p)) (i32.const 2)) (then (local.set $n (i32.const 0))))' : ''}
        (local.set $q (i32.add (local.get $p) (i32.const 16)))
        (local.set $e (i32.add (local.get $q) (i32.shl (local.get $n) (i32.const 3))))
        (block $done (loop $cell
          (br_if $done (i32.ge_u (local.get $q) (local.get $e)))
          ${fwdAt('(local.get $q)')}
          (local.set $q (i32.add (local.get $q) (i32.const 8)))
          (br $cell)))
        (return)))
    ${recordsOn() ? `(if (i32.eq (local.get $t) (i32.const ${PTR.RECORD}))
      (then
        (local.set $n (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (if (i32.lt_u (i32.load (i32.sub (local.get $p) (i32.const 16))) (local.get $n)) (then (local.set $n (i32.load (i32.sub (local.get $p) (i32.const 16))))))
        (local.set $e (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3))))
        (block $done (loop $slot
          (br_if $done (i32.ge_u (local.get $p) (local.get $e)))
          ${fwdAt('(local.get $p)')}
          (local.set $p (i32.add (local.get $p) (i32.const 8)))
          (br $slot)))
        (return)))` : ''}
    (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
      (then
        (if (i32.and (i32.eq (i32.load (i32.sub (local.get $p) (i32.const 12))) (i32.const -1)) (i32.ne (i32.load (i32.sub (local.get $p) (i32.const 16))) (i32.const -1)))
          (then
            ;; the mark of a shifted array: its base, and the base's record forwarding to the header
            (local.set $k (i32.load (i32.sub (local.get $p) (i32.const 16))))
            (call $__gc_defer (i32.sub (local.get $p) (i32.const 16)) (call $__gc_fwd_raw (local.get $k)))
            (if (i32.ne (local.get $k) (local.get $p))
              (then (if (i32.eq (i32.load (i32.sub (local.get $k) (i32.const 4))) (i32.const -1))
                (then (call $__gc_defer (i32.sub (local.get $k) (i32.const 8)) (call $__gc_fwd_raw (i32.load (i32.sub (local.get $k) (i32.const 8))))))))))
          (else ${fwdProps('(local.get $p)')}))
        (local.set $cap (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (local.set $n (i32.load (i32.sub (local.get $p) (i32.const 8))))
        (if (i32.gt_u (local.get $n) (local.get $cap)) (then (local.set $n (local.get $cap))))
        ${numericArraysOn() ? `(if (i32.and (local.get $aux) (i32.const ${ARRAY_RAW})) (then (local.set $n (i32.const 0))))` : ''}
        (local.set $e (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3))))
        (block $done (loop $cell
          (br_if $done (i32.ge_u (local.get $p) (local.get $e)))
          ${fwdAt('(local.get $p)')}
          (local.set $p (i32.add (local.get $p) (i32.const 8)))
          (br $cell)))
        (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.OBJECT}))
      (then
        ${fwdProps('(local.get $p)')}
        (local.set $n (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (local.set $row (call $__gc_row (i32.const 0) (local.get $aux)))
        (if (local.get $row) (then (if (i32.lt_u (i32.load (local.get $row)) (local.get $n)) (then (local.set $n (i32.load (local.get $row)))))))
        (local.set $k (i32.const 0))
        (block $done (loop $slot
          (br_if $done (i32.ge_u (local.get $k) (local.get $n)))
          (if (i32.or (i32.eqz (local.get $row)) (i32.load8_u (i32.add (i32.add (local.get $row) (i32.const 4)) (local.get $k))))
            (then ${fwdAt('(i32.add (local.get $p) (i32.shl (local.get $k) (i32.const 3)))')}))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $slot)))
        (return)))
    (if (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${(1 << PTR.HASH) | (1 << PTR.SET) | (1 << PTR.MAP)}))
      (then
        (if (i32.ne (local.get $t) (i32.const ${PTR.HASH})) (then ${fwdProps('(local.get $p)')}))
        (local.set $e (select (i32.const ${SET_ENTRY}) (i32.const ${MAP_ENTRY}) (i32.eq (local.get $t) (i32.const ${PTR.SET}))))
        (local.set $cap (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.add (local.get $e) (i32.const ${lane}))))
        (local.set $n (i32.add (local.get $p) (i32.mul (local.get $cap) (local.get $e))))
        (block $done (loop $entry
          (br_if $done (i32.ge_u (local.get $p) (local.get $n)))
          (if (i32.and (i64.ne (i64.load (local.get $p)) (i64.const 0)) (i64.ne (i64.load offset=8 (local.get $p)) (i64.const ${TOMB_NAN})))
            (then
              ${fwdAt('(i32.add (local.get $p) (i32.const 8))')}
              (if (i32.eq (local.get $e) (i32.const ${MAP_ENTRY})) (then ${fwdAt('(i32.add (local.get $p) (i32.const 16))')}))))
          (local.set $p (i32.add (local.get $p) (local.get $e)))
          (br $entry)))
        (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE}))
      (then
        ${fwdProps('(local.get $p)')}
        (local.set $n (call $__gc_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (local.set $row (call $__gc_row (i32.const 4) (local.get $aux)))
        (if (local.get $row) (then (if (i32.lt_u (i32.load (local.get $row)) (local.get $n)) (then (local.set $n (i32.load (local.get $row)))))))
        (local.set $k (i32.const 0))
        (block $done (loop $slot
          (br_if $done (i32.ge_u (local.get $k) (local.get $n)))
          (local.set $e (select (i32.load8_u (i32.add (i32.add (local.get $row) (i32.const 4)) (local.get $k))) (i32.const ${ENV_VALUE}) (local.get $row)))
          (local.set $q (i32.add (local.get $p) (i32.shl (local.get $k) (i32.const 3))))
          (if (i32.eq (local.get $e) (i32.const ${ENV_VALUE}))
            (then ${fwdAt('(local.get $q)')})
            (else (if (i32.ne (local.get $e) (i32.const ${ENV_RAW}))
              (then (i64.store (local.get $q) (i64.extend_i32_u (call $__gc_fwd_raw (i32.load (local.get $q)))))))))
          (local.set $k (i32.add (local.get $k) (i32.const 1)))
          (br $slot)))
        (return)))
    (if (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
      (then
        (if (i32.and (local.get $aux) (i32.const 8))
          (then
            (i32.store offset=4 (local.get $p) (call $__gc_fwd_raw (i32.load offset=4 (local.get $p))))
            (i32.store offset=8 (local.get $p) (call $__gc_fwd_raw (i32.load offset=8 (local.get $p))))
            (return)))
        ${fwdProps('(local.get $p)')})))`

  // A Set or Map whose keys the move changed is rebuilt in place from its
  // entries (module/collection/upsert.js lays the table out): each live entry
  // rehashed where its key is a pointer, placed by linear probing into the
  // emptied table, its insertion sequence kept in the hash word's high half.
  // With `$addr` the keys are numbers naming offsets (the table of named
  // properties kept by address, `__gc_rekey_dyn` below): a key in the moved
  // memory takes its object's new offset, and an entry whose object the walk
  // did not reach goes, so no object later laid at that address takes its
  // properties. A table `__start` made lies below the reset mark, and the
  // round's writes into it are logged by their slot's address
  // (core/durable-log.js `__durable_slot_log`), healed at the reset: each
  // logged address follows its entry to its new slot, and a dropped entry's
  // record is cancelled. Answers whether it rebuilt the table.
  const rebuildOn = () => !!(ctx.linkDemand.set || ctx.linkDemand.map)
  // the program writes the table of named properties and compacts (wat/assemble/stdlib-pull.js joins the rekey to the move)
  const rekeyOn = () => (ctx.core.includes.has('__dyn_set') || ctx.core.includes.has('__dyn_set_own')) && ctx.core.includes.has('__gc_move')
  ctx.core.stdlib['__gc_rehash'] = () => {
    const addr = rekeyOn(), logged = ctx.core.includes.has('__durable_slot_log')
    // the rekey asks whether the table was rebuilt
    const none = addr ? '(return (i32.const 0))' : '(return)'
    const relog = (from, to, size) => logged ? `
          (if (local.get $relog) (then (call $__durable_slot_relog ${from} ${to} ${size})))` : ''
    const cancel = logged ? `(if (local.get $relog) (then (call $__durable_slot_cancel (local.get $slot) (local.get $es))))` : ''
    const moved = `(i32.and (i32.ge_u (local.get $off) (global.get $__g_floor)) (i32.lt_u (local.get $off) (global.get $__g_top)))`
    const offOf = `(local.set $off (i32.trunc_sat_f64_s (f64.reinterpret_i64 (local.get $key))))`
    const identityScan = `(if (i32.and (i64.ne (i64.load (local.get $slot)) (i64.const 0)) (call $__gc_box (local.get $key)))
        (then (if (i32.and (i32.shl (i32.const 1) ${tagOf('(local.get $key)')}) (i32.const ${IDENTITY_TAGS})) (then (local.set $any (i32.const 1))))))`
    const addrScan = `(if (i32.and (i64.ne (i64.load (local.get $slot)) (i64.const 0)) (i64.ne (local.get $key) (i64.const ${TOMB_NAN})))
        (then ${offOf} (if ${moved} (then (local.set $any (i32.const 1))))))`
    const identityHash = `(if (call $__gc_box (local.get $key))
            (then (if (i32.and (i32.shl (i32.const 1) ${tagOf('(local.get $key)')}) (i32.const ${IDENTITY_TAGS}))
              (then (local.set $h (call $__map_hash (local.get $key)))))))`
    // an object the walk did not reach: its entry goes (its words can't tell: a
    // shifted array emptied to no capacity ends where its data starts)
    const addrKey = `(block $kept
            ${offOf}
            (br_if $kept (i32.eqz ${moved}))
            (if (i32.eqz (call $__gc_was (local.get $off))) (then ${cancel} (br $skip)))
            (local.set $key (i64.reinterpret_f64 (f64.convert_i32_s (call $__gc_fwd_raw (local.get $off)))))
            (i64.store offset=8 (local.get $slot) (local.get $key))
            (local.set $h (call $__map_hash (local.get $key))))`
    // an empty slot, and a zombie (a reset healed it) the rebuild drops
    const live = addr || logged
      ? `(block $skip
          (br_if $skip (i64.eqz (local.get $w)))
          (if (i64.eq (local.get $key) (i64.const ${TOMB_NAN})) (then ${cancel} (br $skip)))`
      : `(if (i32.and (i64.ne (local.get $w) (i64.const 0)) (i64.ne (local.get $key) (i64.const ${TOMB_NAN})))
        (then`
    return `(func $__gc_rehash (param $p i32) (param $es i32)${addr ? ' (param $addr i32) (result i32)' : ''}
    (local $cap i32) (local $stride i32) (local $tmp i32) (local $i i32) (local $slot i32) (local $key i64) (local $h i32) (local $idx i32) (local $to i32) (local $n i32) (local $t i32) (local $any i32) (local $w i64)${addr ? ' (local $off i32)' : ''}${logged ? ' (local $relog i32)' : ''}
    (local.set $cap (i32.load (i32.sub (local.get $p) (i32.const 4))))
    (local.set $stride (i32.add (local.get $es) (i32.const ${lane})))
    ;; keys hashed by their bits: any that names memory the move may have changed
    (local.set $i (i32.const 0))
    (block $scan (loop $probe
      (br_if $scan (i32.ge_u (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $p) (i32.mul (local.get $i) (local.get $es))))
      (local.set $key (i64.load offset=8 (local.get $slot)))
      ${addr ? `(if (local.get $addr) (then ${addrScan}) (else ${identityScan}))` : identityScan}
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $probe)))
    (if (i32.eqz (local.get $any)) (then ${none}))
    ;; the entries copied aside, the table emptied, each live entry placed anew
    (local.set $tmp (i32.and (i32.add (i32.add (global.get $__g_list) (i32.shl (global.get $__g_ln) (i32.const 3))) (i32.const 7)) (i32.const -8)))
    ;; past the move the table must be rebuilt: the walk claimed its room ($__gc_walk); short of it, its scratch grows the memory even a host's view names
    (if (i32.eqz (call $__gc_room (i32.add (local.get $tmp) (i32.mul (local.get $cap) (local.get $es))) (i32.const 1))) (then ${none}))
    (memory.copy (local.get $tmp) (local.get $p) (i32.mul (local.get $cap) (local.get $es)))${logged ? `
    (local.set $relog (i32.and (i32.lt_u (local.get $p) (global.get $__heap_reset)) (i32.ne (global.get $__durable_slot_n) (i32.const 0))))${relog('(local.get $p)', '(local.get $tmp)', '(i32.mul (local.get $cap) (local.get $es))')}` : ''}
    (memory.fill (local.get $p) (i32.const 0) (i32.mul (local.get $cap) (local.get $stride)))
    (local.set $i (i32.const 0))
    (block $done (loop $entry
      (br_if $done (i32.ge_u (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $tmp) (i32.mul (local.get $i) (local.get $es))))
      (local.set $w (i64.load (local.get $slot)))
      (local.set $key (i64.load offset=8 (local.get $slot)))
      ${live}
          (local.set $h (i32.wrap_i64 (local.get $w)))
          ${addr ? `(if (local.get $addr) (then ${addrKey}) (else ${identityHash}))` : identityHash}
          (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
          (block $placed (loop $next
            (local.set $to (i32.add (local.get $p) (i32.mul (local.get $idx) (local.get $es))))
            (br_if $placed (i64.eqz (i64.load (local.get $to))))
            (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
            (br $next)))
          (memory.copy (local.get $to) (local.get $slot) (local.get $es))${relog('(local.get $slot)', '(local.get $to)', '(local.get $es)')}
          (i64.store (local.get $to) (i64.or (i64.extend_i32_u (local.get $h)) (i64.and (local.get $w) (i64.const -4294967296))))
          ${lane ? `(i32.store (i32.add (i32.add (local.get $p) (i32.mul (local.get $cap) (local.get $es))) (i32.shl (local.get $idx) (i32.const 2))) (local.get $h))` : ''}
          (local.set $n (i32.add (local.get $n) (i32.const 1)))${addr || logged ? ')' : '))'}
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $entry)))
    (i32.store (i32.sub (local.get $p) (i32.const 8)) (local.get $n))${addr ? '\n    (i32.const 1)' : ''})`
  }

  // The table of named properties kept by address (module/collection.js
  // `__dyn_props`: a closure's, a shifted array's) keyed by the number of its
  // object's offset, which no walk reads as a pointer: rebuilt by its keys'
  // addresses after the move (`__gc_rehash` above), the membership filter
  // rebuilt from them.
  ctx.core.stdlib['__gc_rekey_dyn'] = () => `(func $__gc_rekey_dyn
    (local $p i32)${has('__dyn_props_filter') ? ' (local $end i32) (local $slot i32) (local $off i32) (local $filter i64)' : ''}
    (if (f64.eq (global.get $__dyn_props) (f64.const 0)) (then (return)))
    (local.set $p (i32.wrap_i64 (i64.reinterpret_f64 (global.get $__dyn_props))))
    (if (i32.eqz (call $__gc_rehash (local.get $p) (i32.const ${MAP_ENTRY}) (i32.const 1))) (then (return)))${has('__dyn_props_filter') ? `
    (local.set $end (i32.add (local.get $p) (i32.mul (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const ${MAP_ENTRY}))))
    (local.set $slot (local.get $p))
    (block $done (loop $entry
      (br_if $done (i32.ge_u (local.get $slot) (local.get $end)))
      (if (i64.ne (i64.load (local.get $slot)) (i64.const 0))
        (then
          (local.set $off (i32.trunc_sat_f64_s (f64.reinterpret_i64 (i64.load offset=8 (local.get $slot)))))
          (local.set $filter (i64.or (local.get $filter) (i64.shl (i64.const 1) (i64.extend_i32_u (i32.and (i32.xor (i32.shr_u (local.get $off) (i32.const 3)) (i32.shr_u (local.get $off) (i32.const 9))) (i32.const 63))))))))
      (local.set $slot (i32.add (local.get $slot) (i32.const ${MAP_ENTRY})))
      (br $entry)))
    (global.set $__dyn_props_filter (local.get $filter))` : ''})`

  // The module's own roots: every global that holds a value, marked (`fwd` 0)
  // or rewritten (`fwd` 1). Laid out per program as the module is assembled:
  // its bindings and the runtime's tables, raw addresses by their kind.
  ctx.core.stdlib['__gc_roots'] = () => {
    const lines = []
    const boxed = (g) => lines.push(`(if (local.get $fwd)
      (then (global.set $${g} (f64.reinterpret_i64 (call $__gc_fwd (i64.reinterpret_f64 (global.get $${g}))))))
      (else (call $__gc_mark (i64.reinterpret_f64 (global.get $${g})))))`)
    const raw = (g, tag, aux) => lines.push(`(if (local.get $fwd)
      (then (global.set $${g} (call $__gc_fwd_raw (global.get $${g}))))
      (else (call $__gc_mark (i64.reinterpret_f64 (call $__mkptr (i32.const ${tag}) (i32.const ${aux}) (global.get $${g}))))))`)
    const bytes = (g, size) => lines.push(`(if (local.get $fwd)
      (then (global.set $${g} (call $__gc_fwd_raw (global.get $${g}))))
      (else (if (global.get $${g}) (then (call $__gc_keep (global.get $${g}) (i32.add (global.get $${g}) ${size}))))))`)
    const user = ctx.scope.userGlobals ?? new Set()
    for (const [name, g] of ctx.scope.globals) {
      if (!g.mut) continue
      if (g.type === 'f64') {
        // Caches name memory they do not own: the for-in key cache (module/object.js)
        // is read only while its epoch holds, and the move bumps the epoch (endParts);
        // walked, the cache a reset left (`_clear` bumps the epoch, the pointer stays)
        // would name the released round, whatever it holds now.
        if (name === '__dyn_get_cache_props' || name.startsWith('__tof_') || name.startsWith('__hc_') || /^__enumc_arr\d*$/.test(name)) continue
        if (user.has(name) && holdsNoHeap(ctx.summary?.kindOfExpr(name))) continue
        boxed(name)
      } else if (g.type === 'i32') {
        const rep = ctx.scope.globalReps?.get(name)
        const tag = rep?.ptrKind != null ? valKindToPtr(rep.ptrKind) : undefined
        if (tag !== undefined) raw(name, tag, rep.ptrAux ?? 0)
      }
    }
    // The JSON parser's runtime layouts (module/json.js `__jp_schema_get`): the
    // schema table's registered entries name key arrays, in the static
    // reserve or in the table's grown copy (whose tail is unwritten arena
    // memory); the cache holds hashes and ids.
    if (has('__schema_cache')) bytes('__schema_cache', '(i32.const 512)')
    if (has('__schema_tbl') && has('__schema_cap') && has('__schema_next')) lines.push(`(local.set $p (global.get $__schema_tbl))
    (local.set $e (i32.add (local.get $p) (i32.shl (global.get $__schema_next) (i32.const 3))))
    (if (local.get $fwd)
      (then
        (block $done (loop $word
          (br_if $done (i32.ge_u (local.get $p) (local.get $e)))
          (i64.store (local.get $p) (call $__gc_fwd (i64.load (local.get $p))))
          (local.set $p (i32.add (local.get $p) (i32.const 8)))
          (br $word)))
        (global.set $__schema_tbl (call $__gc_fwd_raw (global.get $__schema_tbl))))
      (else
        ;; the whole table stays, its tail past the registered entries unread
        (call $__gc_keep (local.get $p) (i32.add (local.get $p) (i32.shl (global.get $__schema_cap) (i32.const 3))))
        (block $done (loop $word
          (br_if $done (i32.ge_u (local.get $p) (local.get $e)))
          (call $__gc_push (i64.load (local.get $p)))
          (local.set $p (i32.add (local.get $p) (i32.const 8)))
          (br $word)))))`)
    if (has('__durable_fwd_buf')) bytes('__durable_fwd_buf', '(i32.mul (global.get $__durable_fwd_cap) (i32.const 12))')
    if (has('__durable_slot_buf')) bytes('__durable_slot_buf', '(i32.shl (global.get $__durable_slot_cap) (i32.const 3))')
    if (has('__durable_arr_seen')) bytes('__durable_arr_seen', '(i32.add (i32.shr_u (i32.sub (global.get $__heap_reset) (global.get $__durable_skip)) (i32.const 6)) (i32.const 1))')
    if (has('__durable_arr_log')) lines.push(`(if (local.get $fwd)
      (then (global.set $__durable_arr_log (call $__gc_fwd_raw (global.get $__durable_arr_log))))
      (else (if (global.get $__durable_arr_log) (then (call $__gc_rec (global.get $__durable_arr_log))))))`)
    return `(func $__gc_roots (param $fwd i32)
    (local $p i32) (local $e i32)
    ${lines.join('\n    ')})`
  }

  // The compaction in three parts around the roots a site names: `__gc_begin`
  // lays the scratch out above the heap and marks the module's globals,
  // `__gc_walk` walks what waits and rewrites every pointer the module holds
  // where it stands, `__gc_move` slides the live words down and answers the
  // new top. `__compact`, the host's, is the three with no roots between; a
  // loop's site (optimize/loop-compact.js) marks its function's locals after
  // the first and forwards them after the second, while the memory they name
  // still stands.
  ctx.core.stdlib['__gc_begin'] = () => `(func $__gc_begin (param $floor i32) (result i32)
    (local $top i32) (local $s i32) (local $nv i32) (local $nl i32)
    (local.set $top (global.get $__heap))
    (global.set $__g_fail (i32.const 1))
    ${DBG_GC ? '(global.set $__g_asks (i32.add (global.get $__g_asks) (i32.const 1)))' : ''}
    (if (i32.lt_u (local.get $floor) (global.get $__heap_reset)) (then (local.set $floor (global.get $__heap_reset))))
    (if (i32.lt_u (local.get $floor) (global.get $__pin)) (then (local.set $floor (global.get $__pin))))
    (local.set $floor (i32.and (i32.add (local.get $floor) (i32.const 7)) (i32.const -8)))
    (if (i32.ge_u (local.get $floor) (local.get $top)) (then ${DBG_GC ? '(global.set $__g_no_floor (i32.add (global.get $__g_no_floor) (i32.const 1)))' : ''} (return (i32.const 0))))
    ${has('__stubn') ? `;; a stub log that overflowed: a caller's local may name a stub this compaction would not rewrite
    (if (i32.lt_s (global.get $__stubn) (i32.const 0)) (then ${DBG_GC ? '(global.set $__g_no_stub (i32.add (global.get $__g_no_stub) (i32.const 1)))' : ''} (return (i32.const 0))))` : ''}
    (global.set $__g_floor (local.get $floor))
    (global.set $__g_top (local.get $top))
    ;; the static data's end, which the heap starts past (HEAP.START where the data is shorter)
    (global.set $__g_lo (select (global.get $__heap_start) (i32.const ${HEAP.START}) (i32.gt_u (global.get $__heap_start) (i32.const ${HEAP.START}))))
    ;; scratch above the top: a visited bit per word from the static data's end,
    ;; a live bit per word above the floor, the prefix counts, then the list
    ;; growing up and the stack growing down from the memory's end
    (local.set $s (i32.and (i32.add (local.get $top) (i32.const 7)) (i32.const -8)))
    (local.set $nv (i32.shl (i32.shr_u (i32.add (i32.shr_u (i32.sub (local.get $top) (global.get $__g_lo)) (i32.const 3)) (i32.const 64)) (i32.const 6)) (i32.const 3)))
    (local.set $nl (i32.shl (i32.shr_u (i32.add (i32.shr_u (i32.sub (local.get $top) (local.get $floor)) (i32.const 3)) (i32.const 64)) (i32.const 6)) (i32.const 3)))
    ;; the scratch must end before the address space does: a heap near the top of wasm32 declines
    (if (i64.gt_u (i64.add (i64.add (i64.extend_i32_u (local.get $s)) (i64.extend_i32_u (local.get $nv)))
                           (i64.add (i64.add (i64.extend_i32_u (local.get $nl)) (i64.extend_i32_u (i32.shr_u (local.get $nl) (i32.const 1)))) (i64.const ${8 + 65536})))
                  (i64.const 0xFFFFFFF8))
      (then ${DBG_GC ? '(global.set $__g_no_room (i32.add (global.get $__g_no_room) (i32.const 1)))' : ''} (return (i32.const 0))))
    (global.set $__g_nl (local.get $nl))
    (global.set $__g_vis (local.get $s))
    (global.set $__g_live (i32.add (local.get $s) (local.get $nv)))
    (global.set $__g_pre (i32.add (global.get $__g_live) (local.get $nl)))
    (global.set $__g_list (i32.add (global.get $__g_pre) (i32.add (i32.shr_u (local.get $nl) (i32.const 1)) (i32.const 8))))
    (global.set $__g_ln (i32.const 0))
    (global.set $__g_cost (i32.const 0))
    (if (i32.eqz (call $__gc_room (i32.add (global.get $__g_list) (i32.const 65536)) (i32.eqz (global.get $__viewed)))) (then ${DBG_GC ? '(global.set $__g_no_room (i32.add (global.get $__g_no_room) (i32.const 1)))' : ''} (return (i32.const 0))))
    (global.set $__g_sp (global.get $__g_lim))
    (memory.fill (local.get $s) (i32.const 0) (i32.sub (global.get $__g_list) (local.get $s)))
    (global.set $__g_fail (i32.const 0))
    ${DBG_GC ? '(global.set $__g_runs (i32.add (global.get $__g_runs) (i32.const 1))) (global.set $__g_walked (i32.add (global.get $__g_walked) (i32.shr_u (i32.sub (local.get $top) (local.get $floor)) (i32.const 3))))' : ''}
    ;; 1. the module's roots, marked; what they reach waits on the stack
    (call $__gc_roots (i32.const 0))
    (i32.const 1))`

  const endParts = () => {
    const resets = []
    if (has('__dyn_get_cache_off')) resets.push(`(global.set $__dyn_get_cache_off (i32.const 1))`)
    if (has('__dyn_get_cache_props')) resets.push(`(global.set $__dyn_get_cache_props (f64.const 0))`)
    if (has('__enumc_epoch')) resets.push(`(global.set $__enumc_epoch (i32.add (global.get $__enumc_epoch) (i32.const 1)))`)
    if (has('__rootn') && has('__roots')) resets.push(`(if (global.get $__roots) (then (memory.fill (global.get $__roots) (i32.const 0) (i32.const ${ROOT_LOG_BYTES}))))
    (global.set $__rootn (i32.const 0))`)
    if (has('__rootl')) resets.push(`(global.set $__rootl (i64.const 0))`)
    // a loop releasing its iterations walks from a mark the move left behind (module/core/reach.js `__iter_release`)
    if (has('__gc_epoch')) resets.push(`(global.set $__gc_epoch (i32.add (global.get $__gc_epoch) (i32.const 1)))`)
    if (has('__jbuf')) resets.push(`(global.set $__jbuf (i32.const 0)) (global.set $__jcap (i32.const 0))`)
    if (has('__jstack')) resets.push(`(global.set $__jstack (i32.const 0))`)
    if (has('__closure_spill')) resets.push(`(global.set $__closure_spill (i32.const 0))`)
    if (has('__jz_last_err_bits') && ctx.scope.globals.get('__jz_last_err_bits').mut) resets.push(`(global.set $__jz_last_err_bits (i64.const 0))`)
    const rehashAt = (es) => rekeyOn() ? `(drop (call $__gc_rehash (i32.load (local.get $at)) (i32.const ${es}) (i32.const 0)))` : `(call $__gc_rehash (i32.load (local.get $at)) (i32.const ${es}))`
    const rehash = rebuildOn() ? `(local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (global.get $__g_ln)))
      (local.set $at (i32.add (global.get $__g_list) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $t (i32.and (i32.shr_u (i32.load offset=4 (local.get $at)) (i32.const ${LAYOUT.TAG_SHIFT - 32})) (i32.const ${LAYOUT.TAG_MASK})))
      ;; a pointer's high word carries the NaN prefix, above the list's own kinds
      (if (i32.gt_u (i32.load offset=4 (local.get $at)) (i32.const ${KIND_STUB << 16}))
        (then
          (if (i32.eq (local.get $t) (i32.const ${PTR.SET})) (then ${rehashAt(SET_ENTRY)}))
          (if (i32.eq (local.get $t) (i32.const ${PTR.MAP})) (then ${rehashAt(MAP_ENTRY)}))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))` : ''
    return { resets, rehash }
  }

  // The walk from what waits on the stack, the counts, and every pointer the
  // module holds rewritten where it stands (the memory still unmoved): a site
  // forwards its own locals after this and before the move.
  ctx.core.stdlib['__gc_walk'] = () => {
    return `(func $__gc_walk
    (local $top i32) (local $nl i32) (local $i i32) (local $at i32) (local $bits i64) (local $cnt i32)
    (local $p i32) (local $hi i32) (local $need i64) (local $rh i64)
    (local.set $top (global.get $__g_top))
    (local.set $nl (global.get $__g_nl))
    (if (global.get $__g_fail) (then (return)))
    ${DBG_GC ? '(global.set $__g_walking (i32.const 1))' : ''}
    ;; 1. the walk, depth first
    (block $marked (loop $walk
      (br_if $marked (i32.ge_u (global.get $__g_sp) (global.get $__g_lim)))
      (local.set $bits (i64.load (global.get $__g_sp)))
      (global.set $__g_sp (i32.add (global.get $__g_sp) (i32.const 8)))
      (call $__gc_mark (local.get $bits))
      (br $walk)))
    (if (global.get $__g_fail) (then (return)))
    ${has('__stubn') ? `;; the logged stubs below the floor, still stubs forwarding where logged, whose chains end in a block the walk
    ;; reached: listed for their forwards (KIND_STUB), for the caller's local that names the stub alone. One whose chain
    ;; ends in a block nothing reached names garbage, and is left: nothing live leads to it.
    (local.set $i (i32.const 0))
    (block $logged (loop $stub
      (br_if $logged (i32.ge_s (local.get $i) (global.get $__stubn)))
      (local.set $at (i32.add (global.get $__stubs) (i32.shl (local.get $i) (i32.const 4))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $cnt (i32.load (local.get $at)))
      (br_if $stub (i32.or (i32.lt_u (local.get $cnt) (i32.add (global.get $__g_lo) (i32.const 16))) (i32.ge_u (local.get $cnt) (global.get $__g_floor))))
      (br_if $stub (i32.ne (i32.load (i32.sub (local.get $cnt) (i32.const 4))) (i32.const -1)))
      (br_if $stub (i32.ne (i32.load (i32.sub (local.get $cnt) (i32.const 8))) (i32.wrap_i64 (i64.load offset=8 (local.get $at)))))
      (br_if $stub (i32.eqz (call $__gc_was (call $__gc_canon (local.get $cnt) (i32.const ${PTR.ARRAY})))))
      (if (i32.eqz (call $__gc_seen (local.get $cnt))) (then (call $__gc_list (i32.const ${KIND_STUB << 16}) (local.get $cnt))))
      (br $stub)))` : ''}
    ;; 2. the live words below each group of 64
    (local.set $i (i32.const 0))
    (local.set $cnt (i32.const 0))
    (block $counted (loop $group
      (br_if $counted (i32.ge_u (i32.shl (local.get $i) (i32.const 3)) (local.get $nl)))
      (i32.store (i32.add (global.get $__g_pre) (i32.shl (local.get $i) (i32.const 2))) (local.get $cnt))
      (local.set $cnt (i32.add (local.get $cnt) (i32.wrap_i64 (i64.popcnt (i64.load (i32.add (global.get $__g_live) (i32.shl (local.get $i) (i32.const 3))))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $group)))
    (i32.store (i32.add (global.get $__g_pre) (i32.shl (local.get $i) (i32.const 2))) (local.get $cnt))
    ;; the room what follows takes, claimed while nothing is rewritten: the words
    ;; the rewrite defers (a stub's forward, a shifted array's mark and record) on
    ;; the stack, then, once those are written, a rebuilt table's entries past the
    ;; list. A memory that cannot give it leaves the heap as it was.
    (local.set $i (i32.const 0))
    (block $sized (loop $entry
      (br_if $sized (i32.ge_u (local.get $i) (global.get $__g_ln)))
      (local.set $at (i32.add (global.get $__g_list) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (local.set $hi (i32.load offset=4 (local.get $at)))
      (local.set $p (i32.load (local.get $at)))
      (if (i32.eq (local.get $hi) (i32.const ${KIND_STUB << 16})) (then (local.set $need (i64.add (local.get $need) (i64.const 8))) (br $entry)))
      (br_if $entry (i32.le_u (local.get $hi) (i32.const ${KIND_STUB << 16})))
      (local.set $cnt (i32.and (i32.shr_u (local.get $hi) (i32.const ${LAYOUT.TAG_SHIFT - 32})) (i32.const ${LAYOUT.TAG_MASK})))
      (if (i32.and (i32.eq (local.get $cnt) (i32.const ${PTR.ARRAY}))
            (i32.and (i32.eq (i32.load (i32.sub (local.get $p) (i32.const 12))) (i32.const -1)) (i32.ne (i32.load (i32.sub (local.get $p) (i32.const 16))) (i32.const -1))))
        (then (local.set $need (i64.add (local.get $need) (i64.const 16)))))
      ${rebuildOn() ? `(if (i32.or (i32.eq (local.get $cnt) (i32.const ${PTR.SET})) (i32.eq (local.get $cnt) (i32.const ${PTR.MAP})))
        (then
          (local.set $bits (i64.mul (i64.extend_i32_u (i32.load (i32.sub (local.get $p) (i32.const 4))))
            (select (i64.const ${SET_ENTRY}) (i64.const ${MAP_ENTRY}) (i32.eq (local.get $cnt) (i32.const ${PTR.SET})))))
          (if (i64.gt_u (local.get $bits) (local.get $rh)) (then (local.set $rh (local.get $bits))))))` : ''}
      (br $entry)))${rekeyOn() ? `
    ;; and the table of named properties kept by address, rebuilt there too (\`__gc_rekey_dyn\`)
    (if (f64.ne (global.get $__dyn_props) (f64.const 0))
      (then
        (local.set $bits (i64.mul (i64.extend_i32_u (i32.load (i32.sub (i32.wrap_i64 (i64.reinterpret_f64 (global.get $__dyn_props))) (i32.const 4)))) (i64.const ${MAP_ENTRY})))
        (if (i64.gt_u (local.get $bits) (local.get $rh)) (then (local.set $rh (local.get $bits))))))` : ''}
    (if (i64.gt_u (local.get $rh) (local.get $need)) (then (local.set $need (local.get $rh))))
    (local.set $need (i64.add (local.get $need) (i64.add (i64.extend_i32_u (i32.add (global.get $__g_list) (i32.shl (global.get $__g_ln) (i32.const 3)))) (i64.const 8))))
    (if (i64.gt_u (local.get $need) (i64.extend_i32_u (global.get $__g_lim)))
      (then
        (if (i64.gt_u (local.get $need) (i64.const 0xFFFFFFF8)) (then (global.set $__g_fail (i32.const 1)) (return)))
        (if (i32.eqz (call $__gc_room (i32.wrap_i64 (local.get $need)) (i32.eqz (global.get $__viewed)))) (then (global.set $__g_fail (i32.const 1)) (return)))
        ;; the stack is empty: it starts again at the memory's new end
        (global.set $__g_sp (global.get $__g_lim))))
    ;; 3. every pointer rewritten where it stands
    (local.set $i (i32.const 0))
    (block $updated (loop $next
      (br_if $updated (i32.ge_u (local.get $i) (global.get $__g_ln)))
      (local.set $at (i32.add (global.get $__g_list) (i32.shl (local.get $i) (i32.const 3))))
      (call $__gc_update (i32.load offset=4 (local.get $at)) (i32.load (local.get $at)))
      (i32.store (local.get $at) (call $__gc_fwd_raw (i32.load (local.get $at))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
    ${DBG_GC ? '(global.set $__g_walking (i32.const 0))' : ''}
    (call $__gc_roots (i32.const 1)))`
  }

  // The move, once every pointer the walk and the site know is forwarded:
  // the live words slide down, tables keyed by identity are rebuilt, and the
  // caches naming addresses are emptied. Answers the new top, the old one
  // where the walk failed.
  ctx.core.stdlib['__gc_move'] = () => {
    const { resets, rehash } = endParts()
    return `(func $__gc_move (result i32)
    (local $top i32) (local $floor i32) (local $i i32) (local $at i32) (local $t i32) (local $bits i64) (local $run i32) (local $dst i32) (local $w i32)
    (local.set $top (global.get $__g_top))
    (local.set $floor (global.get $__g_floor))
    (if (global.get $__g_fail) (then (return (local.get $top))))
    ${has('__stubn') ? `;; the stub log's boxes, forwarded while the chains still stand
    (local.set $i (i32.const 0))
    (block $logged (loop $entry
      (br_if $logged (i32.ge_s (local.get $i) (global.get $__stubn)))
      (local.set $at (i32.add (global.get $__stubs) (i32.shl (local.get $i) (i32.const 4))))
      (i64.store offset=8 (local.get $at) (call $__gc_fwd (i64.load offset=8 (local.get $at))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $entry)))` : ''}
    ;; the stubs' forwards, each once, now that every pointer forwarded through the chains as they stood
    (block $written (loop $pair
      (br_if $written (i32.ge_u (global.get $__g_sp) (global.get $__g_lim)))
      (i32.store (i32.load (global.get $__g_sp)) (i32.load offset=4 (global.get $__g_sp)))
      (global.set $__g_sp (i32.add (global.get $__g_sp) (i32.const 8)))
      (br $pair)))
    ;; 4. the live words slide down, run by run: each group of 64 bits read
    ;; once, its runs found by counting trailing bits, a run carried across groups
    (local.set $dst (local.get $floor))
    (local.set $w (local.get $floor))
    (local.set $run (i32.const 0))
    (block $moved (loop $group
      (br_if $moved (i32.ge_u (local.get $w) (local.get $top)))
      (local.set $bits (i64.load (i32.add (global.get $__g_live) (i32.shr_u (i32.sub (local.get $w) (local.get $floor)) (i32.const 6)))))
      (local.set $i (i32.const 0))
      (block $next (loop $bit
        (br_if $next (i32.ge_u (local.get $i) (i32.const 64)))
        (if (i32.wrap_i64 (i64.and (i64.shr_u (local.get $bits) (i64.extend_i32_u (local.get $i))) (i64.const 1)))
          (then
            ;; live from here: the run opens or goes on, over the ones that follow
            (if (i32.eqz (local.get $run)) (then (local.set $run (i32.add (local.get $w) (i32.shl (local.get $i) (i32.const 3))))))
            (local.set $i (i32.add (local.get $i) (i32.wrap_i64 (i64.ctz (i64.xor (i64.shr_u (local.get $bits) (i64.extend_i32_u (local.get $i))) (i64.const -1)))))))
          (else
            ;; dead from here: the run, if one, ends; the zeros that follow are skipped
            (if (local.get $run) (then
              (memory.copy (local.get $dst) (local.get $run) (i32.sub (i32.add (local.get $w) (i32.shl (local.get $i) (i32.const 3))) (local.get $run)))
              (local.set $dst (i32.add (local.get $dst) (i32.sub (i32.add (local.get $w) (i32.shl (local.get $i) (i32.const 3))) (local.get $run))))
              (local.set $run (i32.const 0))))
            (local.set $i (i32.add (local.get $i) (i32.wrap_i64 (i64.ctz (i64.shr_u (local.get $bits) (i64.extend_i32_u (local.get $i)))))))))
        (br $bit)))
      (local.set $w (i32.add (local.get $w) (i32.const 512)))
      (br $group)))
    (if (local.get $run) (then
      (if (i32.gt_u (local.get $w) (local.get $top)) (then (local.set $w (local.get $top))))
      (memory.copy (local.get $dst) (local.get $run) (i32.sub (local.get $w) (local.get $run)))
      (local.set $dst (i32.add (local.get $dst) (i32.sub (local.get $w) (local.get $run))))))
    ${DBG_POISON ? '(memory.fill (local.get $dst) (i32.const 255) (i32.sub (local.get $top) (local.get $dst)))' : ''}
    (global.set $__heap (local.get $dst))
    ;; 5. tables keyed by identity rebuilt, caches naming addresses emptied
    ${rehash}
    ;; rekey:dyn
    ${resets.join('\n    ')}
    (local.get $dst))`
  }

  // The host's compaction, as the outermost call returns: no roots but the module's.
  ctx.core.stdlib['__compact'] = () => `(func $__compact (export "__compact") (param $floor i32) (result i32)
    ${has('__stubn') ? '(global.set $__stubn (i32.const 0))' : ''}
    (if (i32.eqz (call $__gc_begin (local.get $floor))) (then (return (global.get $__heap))))
    (call $__gc_walk)
    (call $__gc_move))`
}

/** What each kernel calls. */
export const COMPACT_DEPS = {
  __gc_box: [],
  __gc_final: [],
  __gc_canon: [],
  __gc_room: [],
  __gc_more: ['__gc_room'],
  __gc_push: ['__gc_box', '__gc_more'],
  __gc_list: ['__gc_more'],
  __gc_seen: [],
  __gc_stub: [],
  __gc_thresh: [],
  __gc_rekey_dyn: ['__gc_rehash', '__gc_box', '__gc_room', '__gc_fwd_raw', '__gc_was', '__map_hash'],
  __gc_keep: [],
  __gc_row: [],
  __gc_fit: [],
  __gc_cell: ['__gc_seen', '__gc_keep', '__gc_list', '__gc_push'],
  __gc_rec: ['__gc_seen', '__gc_keep', '__gc_list', '__gc_push', '__gc_fit'],
  __gc_mark: ['__gc_box', '__gc_canon', '__gc_seen', '__gc_keep', '__gc_list', '__gc_push', '__gc_row', '__gc_cell', '__gc_fit'],
  __gc_fwd_raw: [],
  __gc_defer: ['__gc_more'],
  __gc_fwd: ['__gc_box', '__gc_canon', '__gc_fwd_raw'],
  __gc_update: ['__gc_fwd', '__gc_fwd_raw', '__gc_row', '__gc_defer', '__gc_fit', '__gc_canon'],
  __gc_rehash: ['__gc_box', '__gc_room', '__map_hash'],
  __gc_roots: () => ['__gc_mark', '__gc_fwd', '__gc_fwd_raw', '__gc_keep', '__gc_rec', '__gc_push', '__mkptr'],
  __gc_begin: ['__gc_room', '__gc_roots'],
  __gc_walk: ['__gc_mark', '__gc_update', '__gc_fwd_raw', '__gc_roots', '__gc_was', '__gc_canon', '__gc_seen', '__gc_list'],
  __gc_was: [],
  __gc_move: () => ['__gc_fwd', ...(ctx.linkDemand.set || ctx.linkDemand.map ? ['__gc_rehash'] : [])],
  __compact: ['__gc_begin', '__gc_walk', '__gc_move'],
}
