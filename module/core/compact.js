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
import { ctx, PTR, LAYOUT, HEAP, FORWARDING_MASK, declGlobal } from '../../src/ctx.js'
import { TOMB_NAN } from '../../src/ir.js'
import { nanPrefixHex, nanPrefixMaskHex, ssoBitI64Hex, STR_HCACHE_BIT } from '../../layout.js'
import { collectionLaneBytes } from '../collection/upsert.js'
import { valKindToPtr } from '../../src/ir/pointers.js'
import { BIGINT_REP_RAW } from '../../src/compile/representation-plan.js'
import { ROOT_LOG_BYTES } from './reach.js'
import { K, bitOf, tagsOf, hasTag, NULL_BITS } from '../../src/summary/kind.js'

// JZ_DEBUG_POISON=1: what a compaction frees is overwritten with all ones.
const DBG_POISON = typeof process !== 'undefined' && process.env?.JZ_DEBUG_POISON === '1'
// JZ_DEBUG_GC=1: the module exports counters of the compactions asked for
// (`__g_asks`), run (`__g_runs`) and the words they walked (`__g_walked`).
const DBG_GC = typeof process !== 'undefined' && process.env?.JZ_DEBUG_GC === '1'

/** Whether the module compacts what it keeps: the JS host (which calls it),
 *  an owned memory, the rewind on, no fixed-memory contract, and the option not off. */
export const compactOn = () => ctx.transform.host === 'js' && !ctx.memory.shared && !ctx.memory.atomic && ctx.transform.optimize?.compact !== false
  && ctx.transform.optimize?.arenaRewind !== false && !ctx.memory.fixed?.length

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

/** The host's pin, declared with the kernels (wat/assemble/stdlib-pull.js): the
 *  end of the highest block the host holds by address (a view of the module's
 *  memory, a closure, storage it made). No compaction moves memory below it;
 *  the host raises it as it decodes (interop.js). */
export const declarePin = () => {
  if (ctx.scope.globals.has('__pin')) return
  declGlobal('__pin', 'i32', 0, { export: '__pin' })
  // what the last compaction walked, in bytes of the blocks it reached above
  // the floor and below: what the next one costs, which its trigger amortizes
  // (the host's `settle`, interop.js; a loop's site, optimize/loop-compact.js)
  declGlobal('__g_cost', 'i32', 0, { export: '__g_cost' })
}

export const registerCompact = () => {
  for (const g of ['__g_floor', '__g_top', '__g_lo', '__g_vis', '__g_live', '__g_pre', '__g_list', '__g_ln', '__g_sp', '__g_lim', '__g_fail', '__g_nl']) declGlobal(g, 'i32', 0)
  if (DBG_GC) for (const g of ['__g_asks', '__g_runs', '__g_walked']) declGlobal(g, 'i32', 0, { export: g })

  const tagOf = (b) => `(i32.wrap_i64 (i64.and (i64.shr_u ${b} (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const auxOf = (b) => `(i32.wrap_i64 (i64.and (i64.shr_u ${b} (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))`
  const isBox = (b) => `(i64.eq (i64.and ${b} (i64.const ${nanPrefixMaskHex()})) (i64.const ${nanPrefixHex()}))`
  const lane = collectionLaneBytes()
  const has = (g) => ctx.scope.globals.has(g)

  // Whether the word names memory of the module's: a box with a heap tag, not
  // a string held in its pointer.
  ctx.core.stdlib['__gc_box'] = `(func $__gc_box (param $w i64) (result i32)
    (local $t i32)
    (if (i32.eqz ${isBox('(local.get $w)')}) (then (return (i32.const 0))))
    (local.set $t ${tagOf('(local.get $w)')})
    (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${HEAP_TAGS}))) (then (return (i32.const 0))))
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
      ;; the target a live, shifted header: this stub is its base record, the handle
      (if (i32.and (i32.and (i32.ge_u (local.get $to) (i32.const 16)) (i32.le_u (local.get $to) (global.get $__g_top)))
                   (i32.and (i32.ne (i32.load (i32.sub (local.get $to) (i32.const 4))) (i32.const -1))
                            (i32.eq (i32.load (i32.sub (local.get $to) (i32.const 12))) (i32.const -1))))
        (then (br $done)))
      (local.set $off (local.get $to))
      (br $hop)))
    (local.get $off))`

  // Memory up to `need` bytes, grown where the engine allows; the heap's top stays.
  ctx.core.stdlib['__gc_room'] = `(func $__gc_room (param $need i32) (result i32)
    (local $have i64) (local $pages i32)
    (local.set $have (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16)))
    (if (i64.gt_u (i64.extend_i32_u (local.get $need)) (local.get $have))
      (then
        (local.set $pages (i32.add (i32.wrap_i64 (i64.shr_u (i64.sub (i64.add (i64.extend_i32_u (local.get $need)) (i64.const 65535)) (local.get $have)) (i64.const 16))) (i32.const 1)))
        (if (i32.eq (memory.grow (local.get $pages)) (i32.const -1)) (then (return (i32.const 0))))
        (local.set $have (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16)))
        (global.set $__heap_end (i32.wrap_i64 (local.get $have)))
        (global.set $__heap_end64 (local.get $have))))
    (global.set $__g_lim (select (i32.const -8) (i32.wrap_i64 (local.get $have)) (i64.gt_u (local.get $have) (i64.const 0xFFFFFFF8))))
    (i32.const 1))`

  // Room for one more entry of the list and the stack, which grow towards
  // each other: the memory grows a page and the stack moves up with its end.
  ctx.core.stdlib['__gc_more'] = `(func $__gc_more (result i32)
    (local $lim i32) (local $delta i32)
    (local.set $lim (global.get $__g_lim))
    (if (i32.eqz (call $__gc_room (i32.add (local.get $lim) (i32.const 65536)))) (then (global.set $__g_fail (i32.const 1)) (return (i32.const 0))))
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

  // A count read off a header, held to what the memory below the top has room for.
  ctx.core.stdlib['__gc_fit'] = `(func $__gc_fit (param $p i32) (param $n i32) (param $stride i32) (result i32)
    (local $room i32)
    (if (i32.ge_u (local.get $p) (global.get $__g_top)) (then (return (i32.const 0))))
    (local.set $room (i32.div_u (i32.sub (global.get $__g_top) (local.get $p)) (local.get $stride)))
    (select (local.get $room) (local.get $n) (i32.gt_u (local.get $n) (local.get $room))))`

  // The words of [start, end) stay: live where they lie above the floor,
  // walked wherever they lie.
  ctx.core.stdlib['__gc_keep'] = `(func $__gc_keep (param $start i32) (param $end i32)
    (local $i i32) (local $e i32) (local $cell i32)
    (global.set $__g_cost (i32.add (global.get $__g_cost) (i32.sub (local.get $end) (local.get $start))))
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

  // The reset log's records (core/durable-log.js): [next, off, len, cap, cells…].
  ctx.core.stdlib['__gc_rec'] = `(func $__gc_rec (param $rec i32)
    (local $n i32) (local $p i32) (local $e i32)
    (block $done (loop $next
      (br_if $done (i32.or (i32.lt_u (local.get $rec) (global.get $__g_lo)) (i32.gt_u (local.get $rec) (global.get $__g_top))))
      (br_if $done (call $__gc_seen (local.get $rec)))
      (local.set $n (call $__gc_fit (i32.add (local.get $rec) (i32.const 16)) (select (i32.load offset=12 (local.get $rec)) (i32.load offset=8 (local.get $rec)) (i32.and (i32.load offset=4 (local.get $rec)) (i32.const 1))) (i32.const 8)))
      (call $__gc_keep (local.get $rec) (i32.add (i32.add (local.get $rec) (i32.const 16)) (i32.shl (local.get $n) (i32.const 3))))
      (call $__gc_list (i32.const ${KIND_REC << 16}) (local.get $rec))
      (local.set $p (i32.add (local.get $rec) (i32.const 16)))
      (local.set $e (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3))))
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
  ctx.core.stdlib['__gc_mark'] = `(func $__gc_mark (param $w i64)
    (local $t i32) (local $aux i32) (local $off i32) (local $n i32) (local $cap i32) (local $p i32) (local $e i32) (local $stride i32) (local $row i32) (local $k i32)
    (if (i32.eqz (call $__gc_box (local.get $w))) (then (return)))
    (local.set $t ${tagOf('(local.get $w)')})
    (local.set $aux ${auxOf('(local.get $w)')})
    (local.set $off (i32.wrap_i64 (local.get $w)))
    (if (i32.lt_u (local.get $off) (i32.const 8)) (then (return)))
    (local.set $p (call $__gc_canon (local.get $off) (local.get $t)))
    ;; a stub below the floor, whose block moves: its forward is rewritten once every pointer is (KIND_STUB)
    (if (i32.and (i32.ne (local.get $p) (local.get $off)) (i32.lt_u (local.get $off) (global.get $__g_floor)))
      (then (if (i32.eqz (call $__gc_seen (local.get $off))) (then (call $__gc_list (i32.const ${KIND_STUB << 16}) (local.get $off))))))
    ;; past a base record to the live header it forwards to
    (if (i32.and (i32.and (i32.ge_u (local.get $p) (i32.const 16)) (i32.le_u (local.get $p) (global.get $__g_top))) (i32.eq (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const -1)))
      (then (local.set $p (i32.load (i32.sub (local.get $p) (i32.const 8))))))
    (local.set $off (local.get $p))
    (if (i32.or (i32.lt_u (local.get $off) (global.get $__g_lo)) (i32.gt_u (local.get $off) (global.get $__g_top))) (then (return)))
    ;; a slice names bytes inside another string: kept, nothing to walk
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING})) (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_BIT})))
      (then
        (call $__gc_keep (local.get $off) (i32.add (local.get $off) (i32.shl (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_LEN_MASK})) (i32.const 1))))
        (return)))
    (if (call $__gc_seen (local.get $off)) (then (return)))
    (local.set $p (local.get $off))
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
  ctx.core.stdlib['__gc_update'] = `(func $__gc_update (param $hi i32) (param $p i32)
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
        (local.set $q (i32.add (local.get $p) (i32.const 16)))
        (local.set $e (i32.add (local.get $q) (i32.shl (local.get $n) (i32.const 3))))
        (block $done (loop $cell
          (br_if $done (i32.ge_u (local.get $q) (local.get $e)))
          ${fwdAt('(local.get $q)')}
          (local.set $q (i32.add (local.get $q) (i32.const 8)))
          (br $cell)))
        (return)))
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
  const rebuildOn = () => !!(ctx.linkDemand.set || ctx.linkDemand.map)
  ctx.core.stdlib['__gc_rehash'] = () => `(func $__gc_rehash (param $p i32) (param $es i32)
    (local $cap i32) (local $stride i32) (local $tmp i32) (local $i i32) (local $slot i32) (local $key i64) (local $h i32) (local $idx i32) (local $to i32) (local $n i32) (local $t i32) (local $any i32) (local $w i64)
    (local.set $cap (i32.load (i32.sub (local.get $p) (i32.const 4))))
    (local.set $stride (i32.add (local.get $es) (i32.const ${lane})))
    ;; keys hashed by their bits: any that names memory the move may have changed
    (local.set $i (i32.const 0))
    (block $scan (loop $probe
      (br_if $scan (i32.ge_u (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $p) (i32.mul (local.get $i) (local.get $es))))
      (local.set $key (i64.load offset=8 (local.get $slot)))
      (if (i32.and (i64.ne (i64.load (local.get $slot)) (i64.const 0)) (call $__gc_box (local.get $key)))
        (then (if (i32.and (i32.shl (i32.const 1) ${tagOf('(local.get $key)')}) (i32.const ${IDENTITY_TAGS})) (then (local.set $any (i32.const 1))))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $probe)))
    (if (i32.eqz (local.get $any)) (then (return)))
    ;; the entries copied aside, the table emptied, each live entry placed anew
    (local.set $tmp (i32.and (i32.add (i32.add (global.get $__g_list) (i32.shl (global.get $__g_ln) (i32.const 3))) (i32.const 7)) (i32.const -8)))
    (if (i32.eqz (call $__gc_room (i32.add (local.get $tmp) (i32.mul (local.get $cap) (local.get $es))))) (then (return)))
    (memory.copy (local.get $tmp) (local.get $p) (i32.mul (local.get $cap) (local.get $es)))
    (memory.fill (local.get $p) (i32.const 0) (i32.mul (local.get $cap) (local.get $stride)))
    (local.set $i (i32.const 0))
    (block $done (loop $entry
      (br_if $done (i32.ge_u (local.get $i) (local.get $cap)))
      (local.set $slot (i32.add (local.get $tmp) (i32.mul (local.get $i) (local.get $es))))
      (local.set $w (i64.load (local.get $slot)))
      (local.set $key (i64.load offset=8 (local.get $slot)))
      (if (i32.and (i64.ne (local.get $w) (i64.const 0)) (i64.ne (local.get $key) (i64.const ${TOMB_NAN})))
        (then
          (local.set $h (i32.wrap_i64 (local.get $w)))
          (if (call $__gc_box (local.get $key))
            (then (if (i32.and (i32.shl (i32.const 1) ${tagOf('(local.get $key)')}) (i32.const ${IDENTITY_TAGS}))
              (then (local.set $h (call $__map_hash (local.get $key)))))))
          (local.set $idx (i32.and (local.get $h) (i32.sub (local.get $cap) (i32.const 1))))
          (block $placed (loop $next
            (local.set $to (i32.add (local.get $p) (i32.mul (local.get $idx) (local.get $es))))
            (br_if $placed (i64.eqz (i64.load (local.get $to))))
            (local.set $idx (i32.and (i32.add (local.get $idx) (i32.const 1)) (i32.sub (local.get $cap) (i32.const 1))))
            (br $next)))
          (memory.copy (local.get $to) (local.get $slot) (local.get $es))
          (i64.store (local.get $to) (i64.or (i64.extend_i32_u (local.get $h)) (i64.and (local.get $w) (i64.const -4294967296))))
          ${lane ? `(i32.store (i32.add (i32.add (local.get $p) (i32.mul (local.get $cap) (local.get $es))) (i32.shl (local.get $idx) (i32.const 2))) (local.get $h))` : ''}
          (local.set $n (i32.add (local.get $n) (i32.const 1)))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $entry)))
    (i32.store (i32.sub (local.get $p) (i32.const 8)) (local.get $n)))`

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
        if (name === '__dyn_get_cache_props' || name.startsWith('__tof_') || name.startsWith('__hc_')) continue
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
    if (has('__durable_fwd_buf')) bytes('__durable_fwd_buf', '(i32.const 3072)')
    if (has('__durable_slot_buf')) bytes('__durable_slot_buf', '(i32.const 8192)')
    if (has('__durable_arr_seen')) bytes('__durable_arr_seen', '(i32.add (i32.shr_u (global.get $__heap_reset) (i32.const 6)) (i32.const 1))')
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
    ${has('__park_base') ? `;; a phase checkpoint holds parked data above the heap (module/core.js): the heap stays
    (if (global.get $__park_base) (then (return (i32.const 0))))` : ''}
    (if (i32.lt_u (local.get $floor) (global.get $__heap_reset)) (then (local.set $floor (global.get $__heap_reset))))
    (if (i32.lt_u (local.get $floor) (global.get $__pin)) (then (local.set $floor (global.get $__pin))))
    (local.set $floor (i32.and (i32.add (local.get $floor) (i32.const 7)) (i32.const -8)))
    (if (i32.ge_u (local.get $floor) (local.get $top)) (then (return (i32.const 0))))
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
    (global.set $__g_nl (local.get $nl))
    (global.set $__g_vis (local.get $s))
    (global.set $__g_live (i32.add (local.get $s) (local.get $nv)))
    (global.set $__g_pre (i32.add (global.get $__g_live) (local.get $nl)))
    (global.set $__g_list (i32.add (global.get $__g_pre) (i32.add (i32.shr_u (local.get $nl) (i32.const 1)) (i32.const 8))))
    (global.set $__g_ln (i32.const 0))
    (global.set $__g_cost (i32.const 0))
    (if (i32.eqz (call $__gc_room (i32.add (global.get $__g_list) (i32.const 65536)))) (then (return (i32.const 0))))
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
    if (has('__jbuf')) resets.push(`(global.set $__jbuf (i32.const 0)) (global.set $__jcap (i32.const 0))`)
    if (has('__jstack')) resets.push(`(global.set $__jstack (i32.const 0))`)
    if (has('__closure_spill')) resets.push(`(global.set $__closure_spill (i32.const 0))`)
    if (has('__jz_last_err_bits') && ctx.scope.globals.get('__jz_last_err_bits').mut) resets.push(`(global.set $__jz_last_err_bits (i64.const 0))`)
    const rehash = rebuildOn() ? `(local.set $i (i32.const 0))
    (block $done (loop $next
      (br_if $done (i32.ge_u (local.get $i) (global.get $__g_ln)))
      (local.set $at (i32.add (global.get $__g_list) (i32.shl (local.get $i) (i32.const 3))))
      (local.set $t (i32.and (i32.shr_u (i32.load offset=4 (local.get $at)) (i32.const ${LAYOUT.TAG_SHIFT - 32})) (i32.const ${LAYOUT.TAG_MASK})))
      ;; a pointer's high word carries the NaN prefix, above the list's own kinds
      (if (i32.gt_u (i32.load offset=4 (local.get $at)) (i32.const ${KIND_STUB << 16}))
        (then
          (if (i32.eq (local.get $t) (i32.const ${PTR.SET})) (then (call $__gc_rehash (i32.load (local.get $at)) (i32.const ${SET_ENTRY}))))
          (if (i32.eq (local.get $t) (i32.const ${PTR.MAP})) (then (call $__gc_rehash (i32.load (local.get $at)) (i32.const ${MAP_ENTRY}))))))
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
    (local.set $top (global.get $__g_top))
    (local.set $nl (global.get $__g_nl))
    (if (global.get $__g_fail) (then (return)))
    ;; 1. the walk, depth first
    (block $marked (loop $walk
      (br_if $marked (i32.ge_u (global.get $__g_sp) (global.get $__g_lim)))
      (local.set $bits (i64.load (global.get $__g_sp)))
      (global.set $__g_sp (i32.add (global.get $__g_sp) (i32.const 8)))
      (call $__gc_mark (local.get $bits))
      (br $walk)))
    (if (global.get $__g_fail) (then (return)))
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
    ;; 3. every pointer rewritten where it stands
    (local.set $i (i32.const 0))
    (block $updated (loop $next
      (br_if $updated (i32.ge_u (local.get $i) (global.get $__g_ln)))
      (local.set $at (i32.add (global.get $__g_list) (i32.shl (local.get $i) (i32.const 3))))
      (call $__gc_update (i32.load offset=4 (local.get $at)) (i32.load (local.get $at)))
      (i32.store (local.get $at) (call $__gc_fwd_raw (i32.load (local.get $at))))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br $next)))
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
    ${resets.join('\n    ')}
    (local.get $dst))`
  }

  // The host's compaction, as the outermost call returns: no roots but the module's.
  ctx.core.stdlib['__compact'] = `(func $__compact (export "__compact") (param $floor i32) (result i32)
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
  __gc_walk: ['__gc_mark', '__gc_update', '__gc_fwd_raw', '__gc_roots'],
  __gc_move: () => [...(ctx.linkDemand.set || ctx.linkDemand.map ? ['__gc_rehash'] : [])],
  __compact: ['__gc_begin', '__gc_walk', '__gc_move'],
}
