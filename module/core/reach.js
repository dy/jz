/**
 * Release by reach: what a call that ran an escape keeps of its memory.
 *
 * A frame that ran no escape restores the heap to its mark (optimize/
 * arena-rewind.js). One that did kept all it allocated, a megabyte of
 * temporaries beside the one array it filed in a cache. Here it keeps what
 * the escapes made reachable, and no more than lies below it: the heap goes
 * back to the end of the highest block a value it stored can reach.
 *
 * An escape that writes into storage older than every frame reading the flag
 * (`$__base`) logs where it wrote: the receiver (`__esc_val`, `__esc_elem`),
 * the cell of a captured binding (`__esc_cell`), the value a module binding
 * took (`__esc_root`). Whatever a frame made can be reached from outside it
 * only through such storage, and only by a store that ran while the frame
 * did, so the log names every way in. `__survive` walks from it when the
 * outermost frame returns, through the blocks the frame made, as they stand
 * then: a store of one fresh value into another needs no log.
 *
 * Nothing moves, and the walk takes every word that reads as a pointer into
 * the frame's memory for one: a number that happens to read so keeps a block
 * more, never one less. Blocks below the highest reached stay where they
 * are, reached or not.
 *
 * The frame keeps all it allocated, as before, where an escape named no
 * address and logged nothing (the flag at zero: a host handed a value, a
 * catch, a table of the runtime's own, optimize/arena-rewind.js), where the
 * log is full, or where the walk finds no room for its own stack.
 *
 * @module core/reach
 */
import { ctx, PTR, LAYOUT, HEAP, FORWARDING_MASK } from '../../src/ctx.js'
import { nanPrefixHex, nanPrefixMaskHex, ssoBitI64Hex } from '../../layout.js'
import { collectionLaneBytes } from '../collection/upsert.js'

// JZ_DEBUG_POISON=1: what the walk frees is overwritten, as a frame's restore does.
const DBG_POISON = typeof process !== 'undefined' && process.env?.JZ_DEBUG_POISON === '1'

/** Whether a frame that ran an escape walks from what it wrote into: the
 *  pass is on, and so is the rewind it refines. */
export const reachOn = () => ctx.transform.optimize?.arenaReach === true && ctx.transform.optimize.arenaRewind !== false

/** Receivers the log holds: past them the frame keeps all. Its slots are
 *  twice as many, a table an entry is found in by its address. */
const ROOTS = 128, SLOTS = 2 * ROOTS
/** The log's bytes, allocated as the module starts (wat/assemble/stdlib-pull.js):
 *  below every mark a frame takes, no call pays for it or holds it. */
export const ROOT_LOG_BYTES = SLOTS * 8
/** The tags whose pointer names memory of the module's. */
const HEAP_TAGS = 0x7FF & ~((1 << PTR.ATOM) | (1 << PTR.EXTERNAL))
const SET_ENTRY = 16, MAP_ENTRY = 24

export const registerReach = () => {
  const heap = ctx.memory.shared ? `(i32.load (i32.const ${HEAP.PTR_ADDR}))` : '(global.get $__heap)'
  const tagOf = (b) => `(i32.wrap_i64 (i64.and (i64.shr_u ${b} (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))`
  const auxOf = (b) => `(i32.wrap_i64 (i64.and (i64.shr_u ${b} (i64.const ${LAYOUT.AUX_SHIFT})) (i64.const ${LAYOUT.AUX_MASK})))`
  const isBox = (b) => `(i64.eq (i64.and ${b} (i64.const ${nanPrefixMaskHex()})) (i64.const ${nanPrefixHex()}))`

  // The log of one outermost frame (globals of src/compile/index.js):
  // `__roots` its table, made as the module starts, `__rootn` its count,
  // all ones once it is full, or where there is no table to fill, `__rootl`
  // the entry asked for last (module/core.js asks it first). An entry
  // stands at the slot its address names or at the next one free, so a store
  // into a receiver the log holds finds it at once, however many it holds;
  // no entry is zero, and half the slots stay empty.
  ctx.core.stdlib['__root'] = `(func $__root (param $b i64)
    (local $n i32) (local $p i32) (local $lo i32) (local $w i64)
    (global.set $__rootl (local.get $b))
    (local.set $n (global.get $__rootn))
    (if (i32.lt_s (local.get $n) (i32.const 0)) (then (return)))
    (if (i32.eqz (local.tee $lo (global.get $__roots))) (then (global.set $__rootn (i32.const -1)) (return)))
    (local.set $p (i32.add (local.get $lo)
      (i32.shl (i32.shr_u (i32.mul (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const 3))) (i32.const 0x9E3779B1)) (i32.const ${32 - Math.log2(SLOTS)})) (i32.const 3))))
    (loop $probe
      (if (i64.eq (local.tee $w (i64.load (local.get $p))) (local.get $b)) (then (return)))
      (if (i64.eqz (local.get $w))
        (then
          (if (i32.ge_u (local.get $n) (i32.const ${ROOTS})) (then (global.set $__rootn (i32.const -1)) (return)))
          (i64.store (local.get $p) (local.get $b))
          (global.set $__rootn (i32.add (local.get $n) (i32.const 1)))
          (return)))
      (local.set $p (i32.add (local.get $p) (i32.const 8)))
      (if (i32.eq (local.get $p) (i32.add (local.get $lo) (i32.const ${ROOT_LOG_BYTES}))) (then (local.set $p (local.get $lo))))
      (br $probe)))`

  // The log starts empty with the outermost frame: emptied where the frame
  // before it wrote one, so a call that logs nothing pays a test.
  ctx.core.stdlib['__root_reset'] = `(func $__root_reset
    (if (global.get $__rootn)
      (then
        (if (global.get $__roots) (then (memory.fill (global.get $__roots) (i32.const 0) (i32.const ${ROOT_LOG_BYTES}))))
        (global.set $__rootl (i64.const 0))
        (global.set $__rootn (i32.const 0)))))`

  // The cell of a captured binding took a value: the flag goes down to the
  // cell, and a cell older than every reading frame is a way in.
  ctx.core.stdlib['__esc_cell'] = `(func $__esc_cell (param $a i32)
    (call $__esc_at (local.get $a))
    (if (i32.lt_u (local.get $a) (global.get $__base))
      (then (if (i32.ne (global.get $__base) (i32.const -1)) (then (call $__root (i64.extend_i32_u (local.get $a))))))))`

  // A module binding took the value: one a running call made is a way in by
  // itself, and the flag goes to one, below every mark and above the zero of
  // an escape the log does not describe. A value made before every reading
  // frame, a number, an atom, a host's value, a string held in its pointer
  // escape nothing.
  ctx.core.stdlib['__esc_root'] = `(func $__esc_root (param $v f64)
    (local $b i64) (local $t i32)
    (if (f64.eq (local.get $v) (local.get $v)) (then (return)))
    (local.set $b (i64.reinterpret_f64 (local.get $v)))
    (local.set $t ${tagOf('(local.get $b)')})
    (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${HEAP_TAGS}))) (then (return)))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
          (i64.ne (i64.and (local.get $b) (i64.const ${ssoBitI64Hex()})) (i64.const 0)))
      (then (return)))
    (if (i32.lt_u (i32.wrap_i64 (local.get $b)) (global.get $__base)) (then (return)))
    (call $__root (local.get $b))
    (if (i32.lt_u (i32.const 1) (global.get $__esc)) (then (global.set $__esc (i32.const 1)))))`

  // Memory up to `need` for the walk's own stack: no allocation, the heap's
  // top stays. Zero where the memory cannot grow: the frame then keeps all.
  ctx.core.stdlib['__reach_room'] = `(func $__reach_room (param $need i32) (result i32)
    (local $have i64) (local $pages i32)
    (local.set $have (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16)))
    (if (i64.gt_u (i64.extend_i32_u (local.get $need)) (local.get $have))
      (then
        (local.set $pages (i32.add (i32.wrap_i64 (i64.shr_u (i64.sub (i64.add (i64.extend_i32_u (local.get $need)) (i64.const 65535)) (local.get $have)) (i64.const 16))) (i32.const 1)))
        (if (i32.eq (memory.grow (local.get $pages)) (i32.const -1)) (then (return (i32.const 0))))
        (local.set $have (i64.shl (i64.extend_i32_u (memory.size)) (i64.const 16)))
        (global.set $__heap_end (i32.wrap_i64 (local.get $have)))
        (global.set $__heap_end64 (local.get $have))))
    (global.set $__r_lim (select (i32.const -8) (i32.wrap_i64 (local.get $have)) (i64.gt_u (local.get $have) (i64.const 0xFFFFFFF8))))
    (i32.const 1))`

  // A word that reads as a pointer into the frame's memory waits on the stack.
  ctx.core.stdlib['__reach_see'] = `(func $__reach_see (param $w i64)
    (local $t i32) (local $off i32) (local $sp i32)
    (if (i32.eqz ${isBox('(local.get $w)')}) (then (return)))
    (local.set $t ${tagOf('(local.get $w)')})
    (if (i32.eqz (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${HEAP_TAGS}))) (then (return)))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
          (i64.ne (i64.and (local.get $w) (i64.const ${ssoBitI64Hex()})) (i64.const 0)))
      (then (return)))
    (local.set $off (i32.wrap_i64 (local.get $w)))
    ;; a block with no payload starts where it ends: the last one made, at the top
    (if (i32.or (i32.lt_u (local.get $off) (global.get $__r_mark)) (i32.gt_u (local.get $off) (global.get $__r_top))) (then (return)))
    (local.set $sp (global.get $__r_sp))
    (if (i32.eqz (local.get $sp)) (then (return)))
    (if (i32.gt_u (i32.add (local.get $sp) (i32.const 8)) (global.get $__r_lim))
      (then (if (i32.eqz (call $__reach_room (i32.add (local.get $sp) (i32.const 65536))))
        (then (global.set $__r_sp (i32.const 0)) (return)))))
    (i64.store (local.get $sp) (local.get $w))
    (global.set $__r_sp (i32.add (local.get $sp) (i32.const 8))))`

  // The words of a block, each taken for a value, or, its high word zero, for
  // the address of a cell a captured binding lives in (a closure's
  // environment holds such, module/function.js): the cell stays, and the
  // value in it waits.
  ctx.core.stdlib['__reach_cells'] = `(func $__reach_cells (param $p i32) (param $n i32)
    (local $e i32) (local $w i64) (local $c i32)
    (local.set $e (i32.add (local.get $p) (i32.shl (local.get $n) (i32.const 3))))
    (block $done (loop $cell
      (br_if $done (i32.ge_u (local.get $p) (local.get $e)))
      (local.set $w (i64.load (local.get $p)))
      (local.set $c (i32.wrap_i64 (local.get $w)))
      (if (i32.and
            (i32.and (i64.eqz (i64.shr_u (local.get $w) (i64.const 32))) (i32.eqz (i32.and (local.get $c) (i32.const 7))))
            (i32.and (i32.ge_u (local.get $c) (global.get $__r_mark)) (i32.lt_u (local.get $c) (global.get $__r_top))))
        (then
          (call $__reach_end (i32.add (local.get $c) (i32.const 8)))
          (call $__reach_see (i64.load (local.get $c))))
        (else (call $__reach_see (local.get $w))))
      (local.set $p (i32.add (local.get $p) (i32.const 8)))
      (br $cell))))`

  // A count read off a header, held to what the memory below the top has room for.
  ctx.core.stdlib['__reach_fit'] = `(func $__reach_fit (param $p i32) (param $n i32) (param $stride i32) (result i32)
    (local $room i32)
    (if (i32.ge_u (local.get $p) (global.get $__r_top)) (then (return (i32.const 0))))
    (local.set $room (i32.div_u (i32.sub (global.get $__r_top) (local.get $p)) (local.get $stride)))
    (select (local.get $room) (local.get $n) (i32.gt_u (local.get $n) (local.get $room))))`

  // A block of the frame's ends at \`e\`: the heap stays above it.
  ctx.core.stdlib['__reach_end'] = `(func $__reach_end (param $e i32)
    (local.set $e (i32.and (i32.add (local.get $e) (i32.const 7)) (i32.const -8)))
    (if (i32.gt_u (local.get $e) (global.get $__r_top)) (then (local.set $e (global.get $__r_top))))
    (if (i32.gt_u (local.get $e) (global.get $__r_end)) (then (global.set $__r_end (local.get $e)))))`

  // Whether the block at \`off\`, one the frame made, is met for the first time.
  ctx.core.stdlib['__reach_new'] = `(func $__reach_new (param $off i32) (result i32)
    (local $i i32) (local $cell i32) (local $bit i32)
    (local.set $i (i32.shr_u (i32.sub (local.get $off) (global.get $__r_mark)) (i32.const 3)))
    (local.set $cell (i32.add (global.get $__r_bits) (i32.shr_u (local.get $i) (i32.const 3))))
    (local.set $bit (i32.shl (i32.const 1) (i32.and (local.get $i) (i32.const 7))))
    (if (i32.and (i32.load8_u (local.get $cell)) (local.get $bit)) (then (return (i32.const 0))))
    (i32.store8 (local.get $cell) (i32.or (i32.load8_u (local.get $cell)) (local.get $bit)))
    (i32.const 1))`

  // The table of properties a header names (its word with the mark of a
  // shadowed receiver cleared, module/collection.js): of a block the frame
  // made it waits like any value; of a receiver older than the frame, \`old\`,
  // it is walked at once, being as old and as written into.
  ctx.core.stdlib['__reach_props'] = `(func $__reach_props (param $w i64) (param $old i32)
    (local.set $w (i64.and (local.get $w) (i64.const -2)))
    (if (i32.eqz ${isBox('(local.get $w)')}) (then (return)))
    (if (i32.ne ${tagOf('(local.get $w)')} (i32.const ${PTR.HASH})) (then (return)))
    (if (i32.and (local.get $old) (i32.lt_u (i32.wrap_i64 (local.get $w)) (global.get $__r_mark)))
      (then (call $__reach_in (local.get $w) (i32.const 0)))
      (else (call $__reach_see (local.get $w)))))`

  // One value: the blocks its pointer names, and the values they hold. \`old\`:
  // a receiver the log names, older than the frame, whose own blocks are no
  // memory of the frame's but hold what the frame stored. The end of a block
  // counts whatever its start: an array made before the frame that stood at
  // the heap's top grew in place, past the frame's mark (module/array.js).
  ctx.core.stdlib['__reach_in'] = () => {
    const lane = collectionLaneBytes()
    // the table the runtime keeps for receivers with no header of their own, keyed by their address
    const table = keyedProps()
    const keyed = (off) => table ? `(if (f64.ne (global.get $__dyn_props) (f64.const 0))
      (then (call $__reach_props
        (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s ${off})))
        (i32.const 1))))` : ''
    return `(func $__reach_in (param $b i64) (param $old i32)
    (local $t i32) (local $aux i32) (local $off i32) (local $p i32) (local $n i32) (local $cap i32) (local $e i32) (local $c i32) (local $stride i32)
    (local.set $t ${tagOf('(local.get $b)')})
    (local.set $aux ${auxOf('(local.get $b)')})
    (local.set $off (i32.wrap_i64 (local.get $b)))
    (if (i32.lt_u (local.get $off) (i32.const 8)) (then
      ;; a closure that captured nothing keeps its properties by its function's index
      ${table ? `(if (i32.and (local.get $old) (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE})))
        (then (if (f64.ne (global.get $__dyn_props) (f64.const 0))
          (then (call $__reach_props
            (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (i32.sub (i32.const -1) (local.get $aux)))))
            (i32.const 1))))))` : ''}
      (return)))
    (if (i32.gt_u (local.get $off) (global.get $__r_top)) (then (return)))
    (if (i32.ge_u (local.get $off) (global.get $__r_mark))
      (then (if (i32.eqz (call $__reach_new (local.get $off))) (then (return)))))
    (if (local.get $old) (then ${keyed('(local.get $off)')}))
    (local.set $p (local.get $off))
    ;; a block that moved left its header behind, naming where it went: the header stays, the walk goes on
    (if (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${FORWARDING_MASK}))
      (then
        (block $live (loop $hop
          (br_if $live (i32.lt_u (local.get $p) (i32.const 8)))
          (br_if $live (i32.gt_u (local.get $p) (global.get $__r_top)))
          (br_if $live (i32.ne (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const -1)))
          (call $__reach_end (local.get $p))
          (local.set $p (i32.load (i32.sub (local.get $p) (i32.const 8))))
          (br $hop)))
        (if (i32.or (i32.lt_u (local.get $p) (i32.const 16)) (i32.gt_u (local.get $p) (global.get $__r_top))) (then (return)))
        (if (i32.ne (local.get $p) (local.get $off))
          (then
            (if (i32.ge_u (local.get $p) (global.get $__r_mark))
              (then (if (i32.eqz (call $__reach_new (local.get $p))) (then (return)))))
            (if (local.get $old) (then ${keyed('(local.get $p)')}))))))

    ;; cells under a header: an array's elements up to its length, an object's
    ;; slots, the slots of a closure's environment
    (if (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${(1 << PTR.ARRAY) | (1 << PTR.OBJECT) | (1 << PTR.CLOSURE)}))
      (then
        (local.set $cap (call $__reach_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 8)))
        (local.set $n (local.get $cap))
        (if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
          (then (if (i32.lt_u (i32.load (i32.sub (local.get $p) (i32.const 8))) (local.get $cap)) (then (local.set $n (i32.load (i32.sub (local.get $p) (i32.const 8))))))))
        (call $__reach_end (i32.add (local.get $p) (i32.shl (local.get $cap) (i32.const 3))))
        (if (i32.ge_u (local.get $p) (i32.const 16)) (then (call $__reach_props (i64.load (i32.sub (local.get $p) (i32.const 16))) (local.get $old))))
        (call $__reach_cells (local.get $p) (local.get $n))
        (return)))

    (if (i32.and (i32.shl (i32.const 1) (local.get $t)) (i32.const ${(1 << PTR.HASH) | (1 << PTR.SET) | (1 << PTR.MAP)}))
      (then
        ;; a Set's and a Map's own properties hang at the address their pointer names, moved or not
        (if (i32.and (i32.ne (local.get $t) (i32.const ${PTR.HASH})) (i32.ge_u (local.get $off) (i32.const 16)))
          (then (call $__reach_props (i64.load (i32.sub (local.get $off) (i32.const 16))) (local.get $old))))
        (local.set $e (select (i32.const ${SET_ENTRY}) (i32.const ${MAP_ENTRY}) (i32.eq (local.get $t) (i32.const ${PTR.SET}))))
        (local.set $stride (i32.add (local.get $e) (i32.const ${lane})))
        (local.set $cap (call $__reach_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (local.get $stride)))
        (call $__reach_end (i32.add (local.get $p) (i32.mul (local.get $cap) (local.get $stride))))
        (local.set $c (local.get $p))
        (local.set $n (i32.add (local.get $p) (i32.mul (local.get $cap) (local.get $e))))
        (block $done (loop $entry
          (br_if $done (i32.ge_u (local.get $c) (local.get $n)))
          (if (i64.ne (i64.load (local.get $c)) (i64.const 0))
            (then
              (call $__reach_see (i64.load offset=8 (local.get $c)))
              (if (i32.eq (local.get $e) (i32.const ${MAP_ENTRY})) (then (call $__reach_see (i64.load offset=16 (local.get $c)))))))
          (local.set $c (i32.add (local.get $c) (local.get $e)))
          (br $entry)))
        (return)))

    (if (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
      (then
        ;; a slice names bytes inside another string, their count in its pointer
        (if (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_BIT}))
          (then (local.set $n (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_LEN_MASK}))))
          (else (local.set $n (i32.load (i32.sub (local.get $p) (i32.const 4))))))
        (call $__reach_end (i32.add (local.get $p) (i32.shl (call $__reach_fit (local.get $p) (local.get $n) (i32.const 2)) (i32.const 1))))
        (return)))

    (if (i32.eq (local.get $t) (i32.const ${PTR.BIGINT}))
      (then (call $__reach_end (i32.add (local.get $p) (i32.const 8))) (return)))

    ;; a typed array and a buffer hold numbers; a view names the block its bytes lie in
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.TYPED})) (i32.ne (i32.and (local.get $aux) (i32.const 8)) (i32.const 0)))
      (then
        (call $__reach_end (i32.add (local.get $p) (i32.const 16)))
        (local.set $c (i32.load offset=8 (local.get $p)))
        (if (i32.and (i32.ge_u (local.get $c) (global.get $__r_mark)) (i32.le_u (local.get $c) (global.get $__r_top)))
          (then (call $__reach_end (i32.add (local.get $c) (call $__reach_fit (local.get $c) (i32.load (i32.sub (local.get $c) (i32.const 4))) (i32.const 1))))))
        (return)))
    (call $__reach_end (i32.add (local.get $p) (call $__reach_fit (local.get $p) (i32.load (i32.sub (local.get $p) (i32.const 4))) (i32.const 1))))
    (if (i32.and (i32.eq (local.get $t) (i32.const ${PTR.TYPED})) (i32.ge_u (local.get $p) (i32.const 16)))
      (then (call $__reach_props (i64.load (i32.sub (local.get $p) (i32.const 16))) (local.get $old)))))`
  }

  // Where the heap goes as the outermost frame that ran an escape returns:
  // the end of the highest block reached, or its top where the frame keeps all.
  ctx.core.stdlib['__survive'] = () => {
    const has = (g) => ctx.scope.globals.has(g)
    // what the durable log made of the frame's memory (module/core/durable-log.js), named by globals alone
    const block = (g, size) => has(g) ? `(if (i32.and (i32.ge_u (global.get $${g}) (local.get $mark)) (i32.lt_u (global.get $${g}) (local.get $top)))
      (then (call $__reach_end (i32.add (global.get $${g}) ${size}))))` : ''
    const records = has('__durable_arr_log') ? `(local.set $p (global.get $__durable_arr_log))
    (block $done (loop $rec
      (br_if $done (i32.or (i32.lt_u (local.get $p) (local.get $mark)) (i32.ge_u (local.get $p) (local.get $top))))
      ;; an array's record holds its length in cells, an object's (its address odd) its capacity
      (call $__reach_end (i32.add (i32.add (local.get $p) (i32.const 16)) (i32.shl
        (call $__reach_fit (local.get $p)
          (select (i32.load offset=12 (local.get $p)) (i32.load offset=8 (local.get $p)) (i32.and (i32.load offset=4 (local.get $p)) (i32.const 1)))
          (i32.const 8))
        (i32.const 3))))
      (local.set $p (i32.load (local.get $p)))
      (br $rec)))` : ''
    return `(func $__survive (param $mark i32) (result i32)
    (local $top i32) (local $p i32) (local $e i32) (local $s0 i32) (local $b i64)
    (local.set $top ${heap})
    (if (i32.or (i32.eqz (global.get $__esc)) (i32.lt_s (global.get $__rootn) (i32.const 0))) (then (return (local.get $top))))
    (if (i32.ge_u (local.get $mark) (local.get $top)) (then (return (local.get $top))))
    ;; above the heap: a bit for each word the frame allocated, then the stack of values to walk
    (local.set $s0 (i32.add (local.get $top) (i32.and (i32.add (i32.shr_u (i32.sub (local.get $top) (local.get $mark)) (i32.const 6)) (i32.const 15)) (i32.const -8))))
    (if (i32.lt_u (local.get $s0) (local.get $top)) (then (return (local.get $top))))
    (if (i32.eqz (call $__reach_room (i32.add (local.get $s0) (i32.const 64)))) (then (return (local.get $top))))
    (memory.fill (local.get $top) (i32.const 0) (i32.sub (local.get $s0) (local.get $top)))
    (global.set $__r_mark (local.get $mark))
    (global.set $__r_top (local.get $top))
    (global.set $__r_bits (local.get $top))
    (global.set $__r_sp (local.get $s0))
    (global.set $__r_end (local.get $mark))
    ;; the durable log's blocks, where the frame made them
    ${block('__durable_fwd_buf', '(i32.const 3072)')}
    ${block('__durable_slot_buf', '(i32.const 8192)')}
    ${block('__durable_arr_seen', '(i32.add (i32.shr_u (global.get $__heap_reset) (i32.const 6)) (i32.const 1))')}
    ${records}
    (local.set $p (global.get $__roots))
    (local.set $e (i32.add (local.get $p) (i32.const ${ROOT_LOG_BYTES})))
    (block $walked (loop $root
      (br_if $walked (i32.ge_u (local.get $p) (local.get $e)))
      (local.set $b (i64.load (local.get $p)))
      (if (i64.ne (local.get $b) (i64.const 0)) (then
      (if (i64.eqz (i64.shr_u (local.get $b) (i64.const 32)))
        ;; a cell: the value it holds
        (then (call $__reach_see (i64.load (i32.wrap_i64 (local.get $b)))))
        (else (if (i32.lt_u (i32.wrap_i64 (local.get $b)) (local.get $mark))
          (then (call $__reach_in (local.get $b) (i32.const 1)))
          (else (call $__reach_see (local.get $b))))))))
      (local.set $p (i32.add (local.get $p) (i32.const 8)))
      (br $root)))
    (block $done (loop $next
      (br_if $done (i32.le_u (global.get $__r_sp) (local.get $s0)))
      (global.set $__r_sp (i32.sub (global.get $__r_sp) (i32.const 8)))
      (call $__reach_in (i64.load (global.get $__r_sp)) (i32.const 0))
      (br $next)))
    ;; the stack found no room: nothing is known of what it left unwalked
    (if (i32.eqz (global.get $__r_sp)) (then (return (local.get $top))))
    ${DBG_POISON ? '(memory.fill (global.get $__r_end) (i32.const 255) (i32.sub (local.get $top) (global.get $__r_end)))' : ''}
    (global.get $__r_end))`
  }
}

/** Whether the program keeps properties in the runtime's table by address
 *  (module/collection.js): `__dyn_set` alone writes it. */
const keyedProps = () => ctx.scope.globals.has('__dyn_props') && ctx.core.includes.has('__dyn_set') && ctx.core.stdlib['__ihash_get_local'] != null

/** What each kernel of the walk calls. */
export const REACH_DEPS = {
  __root: [],
  __root_reset: [],
  __esc_cell: ['__esc_at', '__root'],
  __esc_root: ['__root'],
  __reach_see: ['__reach_room'],
  __reach_cells: ['__reach_see', '__reach_end'],
  __reach_props: ['__reach_see', '__reach_in'],
  __reach_in: () => ['__reach_new', '__reach_end', '__reach_fit', '__reach_cells', '__reach_see', '__reach_props', ...(keyedProps() ? ['__ihash_get_local'] : [])],
  __survive: ['__reach_room', '__reach_end', '__reach_fit', '__reach_see', '__reach_in'],
}
