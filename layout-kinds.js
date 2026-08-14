/**
 * Heap-kind registry — COMPACT EXECUTABLE metadata only (audit-#16 registry
 * finding, .work/research.md §Heap-kind registry Slice 4: production dist
 * cost fix). This is the per-tag authority every consumer of a NaN-boxed
 * value's KIND derives from — the composition point for carrier boxing ×
 * region relocation. What's here is exactly what production READS: enums,
 * numbers, short symbolic strings, no prose.
 *
 * PRODUCTION-CONSUMED: module/core.js's $__eq and module/collection.js's
 * $__same_value_zero/$__map_hash import eqIdentityChain/
 * sameValueZeroIdentityChain/mapHashStringArm/mapHashBigintArm below —
 * every byte here ships in dist/jz.js. Slice 3 (2026-08-08) put this table
 * on that path; Slice 4 (this split) is the fix for what Slice 3's own
 * landing measured: the ORIGINAL single-file registry carried full per-kind
 * prose (allocShape, childPointers, forwarding, interopDecode, typeofArm
 * descriptions, cross-consumer findings writeups) in the SAME object the
 * generators iterate, and esbuild's minifier only strips JS comments —
 * string-literal PROPERTY VALUES survive verbatim, so that prose rode into
 * dist/jz.js (+19,613B) and, transitively through the generated WAT text
 * size, dist/jz.wasm (+60,511B). The prose itself, plus the FINDINGS array,
 * now lives in layout-kinds-doc.js, which imports and EXTENDS this table —
 * nothing here is duplicated there. See that file's header for the doc-side
 * rationale and test/layout-kinds.js for the shadow checks (import both).
 *
 * LEAF MODULE — imports only layout.js (the err-codes.js pattern: safe for
 * `jz/interop` and tests without pulling the compiler).
 */
import { PTR, LAYOUT, ATOM, STR_INTERN_BIT, STR_HCACHE_BIT } from './layout.js'

// Collection entry strides (module/collection.js) — duplicated here rather than
// imported, matching layout-kinds-doc.js's OWN precedent for the same three
// constants (its header comment: "not re-exported from layout.js today...
// duplicated so this doc module stays a leaf"; layout-kinds.js's leaf-module
// contract is identical — importing module/collection.js would pull the whole
// compiler in). Used here for real (interpolated into the region-arm generators'
// WAT text, not just prose) — keep in sync with module/collection.js's
// SET_ENTRY/MAP_ENTRY/LANE if those ever change; test/layout-kinds.js's shadow
// checks cover drift the same way they already do for the compact table.
const SET_ENTRY = 16   // [hash i64 @0][elem f64 @8]
const MAP_ENTRY = 24   // [hash i64 @0][key f64 @8][value f64 @16]
const LANE = 4          // trailing i32-per-slot fast-probe lane, appended after cap*stride

/**
 * @typedef {Object} KindEntry
 * @property {number|null} tag PTR.* (layout.js) or null for the two tagless kinds (NUMBER, and ATOM
 *                              sub-rows share PTR.ATOM=0 with a distinguishing `aux`).
 * @property {number|string|null} aux Short aux-semantics symbol: a reserved constant (0, ATOM.*), or a
 *                              short tag naming what the aux bits carry (e.g. 'schemaId'). Full prose is
 *                              layout-kinds-doc.js's `auxNote`.
 * @property {'value'|'content'|'pointer-bits'|'exact-bits'} identity Identity-arm family this kind's
 *                              ==/===/Set-Map keying belongs to. Full prose is doc's `identityNote`.
 * @property {{kind:'content', order:number}} [identityArm] STRING/BIGINT only — `order` fixes this
 *                              kind's position in the generated content-identity dispatch chain below
 *                              (checked in ascending order; the tags are mutually exclusive so this is a
 *                              byte-match constraint on generated text, not a soundness one).
 * @property {'none'|'slots(len@-8)'|'schema-slots(aux)+sidecar'|'hash-entries(kv)'|'hash-entries(elem)'|
 *            'env(aux-arity)'|'buffer-edge(raw-i32)'} children __region_copy_rec's tracer input: which
 *                              payload slots hold boxed children (the generic recursion target) vs a raw,
 *                              non-boxed edge (TYPED view's bufferRootOff) vs none (leaf). Full prose is
 *                              doc's `childPointers`.
 * @property {'copy'|'copy-forward'|'rebuild'|'value-relocate'|'copy-rebase'|'immediate'|'env-relocate'} relocate
 *                              Heap-kind registry Slice 2 (.work/research.md §Heap-kind registry): how
 *                              __region_copy_rec moves this kind across a region boundary — a DISTINCT
 *                              axis from GROWTH forwarding (FORWARDING_MASK, layout.js): 'copy' leaf
 *                              bytes (no children to rewrite); 'copy-forward' relocate-with-forward-stub,
 *                              recursing into boxed children (durable receivers walk in place instead,
 *                              memo'd at their own address); 'rebuild' always reconstruct via
 *                              __coll_order+reinsert (bucket position is a function of KEY BITS, which
 *                              change on relocation — SET/MAP); 'value-relocate' bucket-preserving
 *                              (KEYS are content-hashed STRINGs, invariant under relocation — only each
 *                              slot's VALUE recurses — HASH, via __region_relocate_props); 'copy-rebase'
 *                              relocate the block AND rewrite a raw (non-boxed) child edge through the
 *                              child's own new address (TYPED view → BUFFER); 'immediate' passthrough,
 *                              no wasm-heap block to move (ATOM/NUMBER, and EXTERNAL — an index into a
 *                              HOST table, not a wasm offset); 'env-relocate' — CLOSURE: env slot COUNT
 *                              and per-slot boxed/raw MODE come from the `$__closure_env_len`/
 *                              `$__closure_env_mask` side table (funcIdx-keyed, built in src/wat/
 *                              assemble.js from facts module/function.js's ctx.closure.make captures at
 *                              its own env-allocation site — not recoverable from a bare CLOSURE box at
 *                              runtime any other way, since `aux` carries the function-table index, not
 *                              the arity).
 */

/** @type {Record<string, KindEntry>} */
export const KIND_REGISTRY = {
  NUMBER: { tag: null, aux: null, identity: 'value', children: 'none', relocate: 'immediate' },
  STRING: { tag: PTR.STRING, aux: null, identity: 'content', identityArm: { kind: 'content', order: 1 }, children: 'none', relocate: 'copy' },
  ARRAY: { tag: PTR.ARRAY, aux: null, identity: 'pointer-bits', children: 'slots(len@-8)', relocate: 'copy-forward' },
  OBJECT: { tag: PTR.OBJECT, aux: 'schemaId', identity: 'pointer-bits', children: 'schema-slots(aux)+sidecar', relocate: 'copy-forward' },
  HASH: { tag: PTR.HASH, aux: 0, identity: 'pointer-bits', children: 'hash-entries(kv)', relocate: 'value-relocate' },
  SET: { tag: PTR.SET, aux: 0, identity: 'pointer-bits', children: 'hash-entries(elem)', relocate: 'rebuild' },
  MAP: { tag: PTR.MAP, aux: 0, identity: 'pointer-bits', children: 'hash-entries(kv)', relocate: 'rebuild' },
  TYPED: { tag: PTR.TYPED, aux: 'elemTypeCode', identity: 'pointer-bits', children: 'buffer-edge(raw-i32)', relocate: 'copy-rebase' },
  BUFFER: { tag: PTR.BUFFER, aux: 0, identity: 'pointer-bits', children: 'none', relocate: 'copy' },
  CLOSURE: { tag: PTR.CLOSURE, aux: 'fnTableIndex', identity: 'pointer-bits', children: 'env(funcIdx→len/mask table)', relocate: 'env-relocate' },
  EXTERNAL: { tag: PTR.EXTERNAL, aux: 'reserved', identity: 'pointer-bits', children: 'none', relocate: 'immediate' },
  BIGINT: { tag: PTR.BIGINT, aux: 0, identity: 'content', identityArm: { kind: 'content', order: 0 }, children: 'none', relocate: 'copy' },
  'ATOM.NULL': { tag: PTR.ATOM, aux: ATOM.NULL, identity: 'exact-bits', children: 'none', relocate: 'immediate' },
  'ATOM.UNDEFINED': { tag: PTR.ATOM, aux: ATOM.UNDEF, identity: 'exact-bits', children: 'none', relocate: 'immediate' },
  'ATOM.BOOLEAN': { tag: PTR.ATOM, aux: `${ATOM.FALSE}|${ATOM.TRUE}`, identity: 'exact-bits', children: 'none', relocate: 'immediate' },
  'ATOM.SYMBOL': { tag: PTR.ATOM, aux: 'symbolId', identity: 'exact-bits', children: 'none', relocate: 'immediate' },
}

// ============================================================================
// __region_copy_rec arm generation (Heap-kind registry Slice 2, .work/
// research.md §Heap-kind registry / §Region arena). Every KIND_REGISTRY row's
// `relocate` column above names the STRATEGY; the functions below are the
// EXECUTABLE arms implementing each strategy for module/core.js's
// __region_copy_rec (the region-arena Cheney-copy tracer). Not a single
// generic per-strategy template (rejected for the identical reason Slice 4's
// own header already documents for the eq-identity generators: OBJECT's
// dyn-props sidecar hazard, TYPED's raw-edge rebase, and HASH's bucket-
// stable-key shortcut are each a REAL, individually-shaped mechanism, not
// interchangeable instances of one pattern) — hand-authored, guarded
// functions per kind, composed in dispatch order by regionCopyRecBody().
//
// BIGINT/STRING/ARRAY/SET+MAP are EXTRACTED VERBATIM from the pre-Slice-2
// hand-written __region_copy_rec (module/core.js, git history) — byte-
// identity with that original text is the gate (test/layout-kinds.js pins
// it) before the hand-written switch retires in favor of calling
// regionCopyRecBody(). OBJECT/HASH/TYPED/BUFFER/EXTERNAL are NEWLY authored
// this slice, modeled on the closest existing precedent (OBJECT mirrors
// ARRAY's durable/ephemeral split + __obj_clone's schema-length/static-
// segment guards; HASH delegates to the memo-hardened __region_relocate_props
// — the SAME helper the ARRAY/OBJECT dyn-props sidecar already uses, since a
// bare HASH value is physically identical to a sidecar HASH; TYPED rebases
// its view descriptor's raw bufferRootOff edge through a recursive
// __region_copy_rec call on a synthesized BUFFER box, mirroring
// __sclone_rec's TYPED view arm; BUFFER mirrors __sclone_rec's BUFFER arm
// with a memo added, since — unlike structuredClone — region relocation
// must preserve the "same .buffer" identity multiple views may share).
// CLOSURE (region arena FRONT-BOUNDARY forcing case, .work/research.md
// §Region arena — the front boundary's own wall: "give CLOSURE a real
// region-copy arm — needs a capture-count/env-length side table") gets a
// real arm too: env slot count + per-slot boxed/raw mode come from the
// `$__closure_env_len`/`$__closure_env_mask` side table (funcIdx-keyed,
// src/wat/assemble.js), sourced from facts module/function.js's
// ctx.closure.make already computes at its own env-allocation site — see
// FINDINGS['region-forwarding'] (layout-kinds-doc.js) for the now-RESOLVED
// history (OBJECT/HASH/TYPED/BUFFER/EXTERNAL landed Slice 2; CLOSURE here).
// ============================================================================

/** BIGINT's region arm — verbatim (module/core.js, pre-Slice-2). Flat 8-byte
 *  payload cell, no header, no children: durable short-circuit / memo / fresh
 *  copy-with-delta, same shape as STRING's heap-block case below. */
export function regionArmBigint() {
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.BIGINT}))
        (then
          (local.set $off (call $__ptr_offset (local.get $bits)))
          (if (i32.lt_u (local.get $off) (local.get $mark)) (then (return (local.get $v))))
          (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
          (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
          (local.set $newOff (call $__alloc (i32.const 8)))
          (i64.store (local.get $newOff) (i64.load (local.get $off)))
          (local.set $out (call $__mkptr (i32.const ${PTR.BIGINT}) (i32.const 0) (i32.sub (local.get $newOff) (local.get $delta))))
          (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
          (return (local.get $out))))`
}

/** STRING's region arm. SSO is immediate; SLICE views are out of scope
 *  (unreachable — the region program never produces one); plain heap
 *  strings never forward (module/string.js invariant) so the raw offset
 *  mask is always canonical.
 *
 *  HCACHE header fix (region-arena front-boundary hunt, .work/research.md
 *  §Region arena): module/string.js allocates a heap-built (non-SSO,
 *  STR_HCACHE_BIT) string with an 8-byte `[hash u32][len u32]` header, and
 *  layout.js's own STR_HCACHE_BIT doc says the lazy-cache design is
 *  "Sound because heap strings never relocate and die with their arena" —
 *  an invariant true before this region arm existed and false the instant
 *  it does. The prior version here allocated/copied only a bare 4-byte
 *  `[len]` header for EVERY ephemeral string, silently dropping the hash-
 *  cache word for any HCACHE string (which is most non-trivial runtime-
 *  built strings, e.g. every prepareModule renameFunc mangled name —
 *  `${prefix}$${name}` concatenation): the new location's -8 slot is left
 *  as whatever byte happens to precede it in the bump arena, and the next
 *  `__str_hash` on that string reads garbage there — either a bogus
 *  "cached" hash directly, or (the observed failure) a false miss that
 *  falls through into reading -4 as a length despite it not being where
 *  this call expects it, walking the FNV loop off the end of memory
 *  (root-caused via a trap-frame decompile plus a worktree-only debug-
 *  global probe on `$__str_hash`'s own inputs, the SW-hunt method). Fix: give an HCACHE
 *  string its real 8-byte header at the new address too, RESETTING the
 *  cache to 0 (the documented "uncomputed" sentinel — byte-FNV clamps to
 *  ≥2 so 0 stays unambiguous) instead of copying whatever the old cache
 *  held. Sound, not a hack: 0 is the exact state a freshly bump-extended
 *  HCACHE string already starts from, and module/string.js's own in-place
 *  mutators already reset the cell to 0 on any content change — this is
 *  one more legitimate "uncomputed" transition, costing one lazy recompute
 *  on next hash, never a wrong answer. STR_INTERN_BIT also carries a -8
 *  cached hash (layout.js doc) but is unaffected: every INTERN pointer
 *  resolves to the static string pool (module/string.js's own intern
 *  lookup returns the STATIC candidate's offset), which is always below
 *  `$__heap_start` and therefore always durable (`off < mark`) — it can
 *  never reach the ephemeral branch below to begin with. */
export function regionArmString() {
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.STRING}))
        (then
          (local.set $aux (call $__ptr_aux (local.get $bits)))
          ;; SSO: immediate, no separate heap block
          (if (i32.and (local.get $aux) (i32.const ${LAYOUT.SSO_BIT})) (then (return (local.get $v))))
          ;; SLICE view (aliases a parent's bytes, no owned storage of its own): out of scope
          (if (i32.and (local.get $aux) (i32.const ${LAYOUT.SLICE_BIT})) (then (unreachable)))
          ;; STRING never forwards (module/string.js invariant) — raw offset is always canonical
          (local.set $off (i32.wrap_i64 (i64.and (local.get $bits) (i64.const ${LAYOUT.OFFSET_MASK}))))
          (if (i32.lt_u (local.get $off) (local.get $mark)) (then (return (local.get $v))))
          (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
          (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
          (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 4))))
          (if (i32.and (local.get $aux) (i32.const ${STR_HCACHE_BIT}))
            (then
              (local.set $newOff (i32.add (call $__alloc (i32.add (i32.const 8) (local.get $len))) (i32.const 8)))
              (i32.store (i32.sub (local.get $newOff) (i32.const 8)) (i32.const 0))
              (i32.store (i32.sub (local.get $newOff) (i32.const 4)) (local.get $len)))
            (else
              (local.set $newOff (i32.add (call $__alloc (i32.add (i32.const 4) (local.get $len))) (i32.const 4)))
              (i32.store (i32.sub (local.get $newOff) (i32.const 4)) (local.get $len))))
          (memory.copy (local.get $newOff) (local.get $off) (local.get $len))
          (local.set $out (call $__mkptr (i32.const ${PTR.STRING}) (local.get $aux) (i32.sub (local.get $newOff) (local.get $delta))))
          (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
          (return (local.get $out))))`
}

/** ARRAY's region arm — verbatim (module/core.js, pre-Slice-2), parametrized
 *  only over `hasDynProps` (was `ctx.scope.globals.has('__dyn_props')` read
 *  directly — layout-kinds.js stays ctx-free, so the caller resolves the
 *  flag and passes it in; the WAT text this produces is unchanged either
 *  way). Durable arrays walk in place (own address never changes); ephemeral
 *  arrays relocate fresh with a forward stub left at the old site. Both
 *  branches additionally migrate the off-16 dyn-props sidecar when present
 *  (kernel-oracle dvnested-mechanism O2/O3 regression fix, already landed). */
export function regionArmArray({ hasDynProps }) {
  const durableDynProps = !hasDynProps ? '' : `
              (local.set $oldProps (f64.load (i32.sub (local.get $off) (i32.const 16))))
              (local.set $oldProps (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $oldProps)) (i64.const -2))))
              (local.set $propsF (f64.const 0))
              (if (i32.eq
                    (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                    (i32.const ${PTR.HASH}))
                (then (local.set $propsF (local.get $oldProps)))
                (else
                  (if (f64.ne (global.get $__dyn_props) (f64.const 0))
                    (then
                      (local.set $hit (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
                      (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (local.set $propsF (f64.reinterpret_i64 (local.get $hit)))))))))
              (if (f64.ne (local.get $propsF) (f64.const 0))
                (then
                  (local.set $propsF (call $__region_relocate_props (local.get $propsF) (local.get $memo) (local.get $mark) (local.get $delta)))
                  (if (i32.eq
                        (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                        (i32.const ${PTR.HASH}))
                    (then
                      ;; was inline: __region_relocate_props may itself have moved the
                      ;; props container (if it was ephemeral) — write the (possibly
                      ;; new) pointer back to this STABLE off-16 slot.
                      (f64.store (i32.sub (local.get $off) (i32.const 16)) (local.get $propsF)))
                    (else
                      ;; was already in $__dyn_props keyed by this stable $off — refile
                      ;; the (possibly-relocated) value under the SAME key.
                      (local.set $dpRoot (f64.reinterpret_i64 (call $__ihash_set_local
                        (i64.reinterpret_f64 (global.get $__dyn_props))
                        (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))
                        (i64.reinterpret_f64 (local.get $propsF)))))
                      (global.set $__dyn_props (local.get $dpRoot))
                      (global.set $__enumc_off (i32.const 0))))))
              `
  const ephemeralDynProps = !hasDynProps ? '' : `
          (local.set $newFinal (i32.sub (local.get $newOff) (local.get $delta)))
          (local.set $oldProps (f64.load (i32.sub (local.get $off) (i32.const 16))))
          (local.set $oldProps (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $oldProps)) (i64.const -2))))
          (local.set $propsF (f64.const 0))
          (if (i32.eq
                (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                (i32.const ${PTR.HASH}))
            (then (local.set $propsF (local.get $oldProps)))
            (else
              ;; not inline — an earlier grow/shift/region-round may already have
              ;; filed it in $__dyn_props keyed by the array's OLD (still-valid-to-
              ;; read-right-now) offset.
              (if (f64.ne (global.get $__dyn_props) (f64.const 0))
                (then
                  (local.set $hit (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
                  (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (local.set $propsF (f64.reinterpret_i64 (local.get $hit)))))))))
          (if (f64.ne (local.get $propsF) (f64.const 0))
            (then
              (local.set $propsF (call $__region_relocate_props (local.get $propsF) (local.get $memo) (local.get $mark) (local.get $delta)))
              (local.set $dpRoot (global.get $__dyn_props))
              (if (f64.eq (local.get $dpRoot) (f64.const 0)) (then (local.set $dpRoot (call $__hash_new))))
              (local.set $dpRoot (f64.reinterpret_i64 (call $__ihash_set_local
                (i64.reinterpret_f64 (local.get $dpRoot))
                (i64.reinterpret_f64 (f64.convert_i32_s (local.get $newFinal)))
                (i64.reinterpret_f64 (local.get $propsF)))))
              (global.set $__dyn_props (local.get $dpRoot))
              (global.set $__enumc_off (i32.const 0))
              (i64.store (i32.sub (local.get $newOff) (i32.const 16)) (i64.const -1))))
          `
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.ARRAY}))
        (then
          (local.set $off (call $__ptr_offset (local.get $bits)))
          (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
          (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
          (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
          (if (i32.lt_u (local.get $off) (local.get $mark))
            (then
              ;; Durable container — never relocated (its own block stays put forever) —
              ;; but a durable array can still hold a slot written THIS round (e.g. a
              ;; compiler-internal registry array durable arrays only ever get PUSHED
              ;; into, not rebuilt), referencing non-durable data that would otherwise be
              ;; silently reclaimed by the closing rewind. Walk in place (no relocation of
              ;; the container itself — memo it at its OWN address — but recurse into
              ;; every slot and write back whatever comes out, exactly as durable_slot_log
              ;; recognizes "durable receiver, ephemeral payload" as the hazard needing a
              ;; write, except here the payload survives via relocation instead of dying).
              (local.set $out (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (local.get $off)))
              (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
              (block $dd (loop $dl
                (br_if $dd (i32.ge_s (local.get $i) (local.get $len)))
                (local.set $slot (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))
                (f64.store (local.get $slot)
                  (call $__region_copy_rec (f64.load (local.get $slot)) (local.get $memo) (local.get $mark) (local.get $delta)))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $dl)))
              ;; Same "durable receiver, ephemeral payload" hazard applies to the
              ;; dyn-props sidecar itself, not just element slots: the CONTAINER's
              ;; own address never changes (durable), so no re-keying is needed, but
              ;; whatever it points to (inline at off-16, or already filed in
              ;; $__dyn_props keyed by this stable $off) can still be ephemeral.
              ${durableDynProps}
              (return (local.get $out))))
          (local.set $newOff (call $__alloc_hdr (local.get $len) (local.get $len)))
          (local.set $out (call $__mkptr (i32.const ${PTR.ARRAY}) (i32.const 0) (i32.sub (local.get $newOff) (local.get $delta))))
          ;; memo BEFORE recursing into elements — cycles / diamond sharing terminate on revisit
          (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
          (block $ad (loop $al
            (br_if $ad (i32.ge_s (local.get $i) (local.get $len)))
            (local.set $slot (i32.add (local.get $newOff) (i32.shl (local.get $i) (i32.const 3))))
            (f64.store (local.get $slot)
              (call $__region_copy_rec (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))
                (local.get $memo) (local.get $mark) (local.get $delta)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $al)))
          ;; ARRAY dyn-props migration (audit finding, kernel-oracle dvnested-mechanism
          ;; O2/O3 regression root cause): the ORIGINAL comment below this function
          ;; ("watr's own AST/bookkeeping never attaches dynamic properties to its
          ;; internal arrays") was WRONG — src/compile/index.js's emitFunc stamps
          ;; fn.cseLoadBases = new Set(...) directly onto the compiled func-node
          ;; ARRAY during emission (src/optimize/index.js cseScalarLoad's whitelist),
          ;; and that node IS part of the region root (ast, bundled into region_exit's
          ;; root by watr's runRounds patch). An ARRAY's dyn-props sidecar lives EITHER
          ;; inline at off-16 (a HASH pointer, PTR.HASH-tagged) or, once any prior
          ;; grow/shift/durable-fallthrough/region-round has migrated it, in the
          ;; global $__dyn_props table keyed by the array's CURRENT offset
          ;; (module/array.js headerPropsCopyIR/headerPropsToGlobalIR/maybeDynMoveIR —
          ;; the exact mechanism arrGrow/arrShift already use to survive their OWN
          ;; relocation). Whichever form it's currently in, find the props-hash
          ;; pointer, relocate ITS OWN CONTENTS (__region_relocate_props — a bare
          ;; pointer copy would leave whatever it points to, e.g. cseLoadBases's
          ;; Set, unreachable from the region root and silently reclaimed), then
          ;; ALWAYS re-file it into $__dyn_props keyed by $newFinal (the array's
          ;; FINAL post-region_exit address: memory.copy hasn't landed the bytes
          ;; yet, so $newOff itself is a T-relative STAGING address, not a valid
          ;; $__dyn_props key — the SAME $out/$outPhys distinction the SET/MAP
          ;; branch above already makes). Gated on $__dyn_props existing at all
          ;; (ctx.scope.globals.has check in this function's deps() entry above) —
          ;; a build with no array/object dynamic-property support anywhere skips
          ;; this block entirely.
          ${ephemeralDynProps}
          ;; NO old-site forwarding stub (boundary-arithmetic audit, window B —
          ;; .work/research.md §Region arena: this function's own CALLER,
          ;; __region_exit, closes with a memory.copy(mark, T, size) — that copy
          ;; physically overwrites every byte in [mark, mark+size) with the
          ;; compacted survivors BEFORE any consumer outside this traversal can
          ;; possibly read a just-written stub there, and the round after that
          ;; one starts allocating fresh churn from the new heap top, overwriting
          ;; whatever stub bytes landed in [mark+size, T) the instant that space
          ;; is reused — a write with no reachable reader, in EVERY case, not a
          ;; probabilistic one (this was the target-pass-ablation "reshuffle"
          ;; mechanism: different pass orderings change how much of the dead
          ;; zone gets clobbered before a stray external reference — if one ever
          ;; existed — got a chance to chase it, reshuffling WHICH corpus rows
          ;; happened to trap, never fixing the underlying wall). Every reference
          ;; reachable from the region root is healed the honest way instead —
          ;; directly, by this very function returning $out and rewriting each
          ;; parent slot with it as the walk descends (already done above) — so
          ;; no chase is needed for anything region_exit is actually responsible
          ;; for. A holder OUTSIDE the root (watr's runRounds passes exactly
          ;; [ast, dirty, snapshots] as root, and drains every other known
          ;; module-scope scratch global before calling in — src/optimize.js)
          ;; is a root-completeness bug in the CALLER's registration, not
          ;; something an in-place stub could have fixed anyway (it never
          ;; survived long enough to be read).
          (return (local.get $out))))`
}

/** SET/MAP's region arm — verbatim (module/core.js, pre-Slice-2). Always
 *  rebuilds via __coll_order+reinsert (a relocated KEY's bits change its
 *  hash bucket — patching in place would leave it in the wrong bucket). */
export function regionArmSetMap() {
  return `(if (i32.or (i32.eq (local.get $t) (i32.const ${PTR.SET})) (i32.eq (local.get $t) (i32.const ${PTR.MAP})))
        (then
          (local.set $off (call $__ptr_offset (local.get $bits)))
          ;; No durable short-circuit here (unlike ARRAY): a SET/MAP's slot position is
          ;; a function of its KEY's hash (__map_hash — pointer-bits-based for non-string
          ;; keys), so patching a relocated key's bits in place would leave the entry in
          ;; the WRONG bucket for its new hash — an in-place fix would need a full rehash
          ;; anyway. Simplest correct answer: always rebuild via __coll_order + reinsert
          ;; (below), which computes fresh hashes for whatever the (possibly just-
          ;; relocated) keys currently are. dirty/snapshots are small relative to the
          ;; tree, so paying this every round is cheap next to the ARRAY win.
          (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
          (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
          (local.set $stride (select (i32.const ${MAP_ENTRY}) (i32.const ${SET_ENTRY}) (i32.eq (local.get $t) (i32.const ${PTR.MAP}))))
          (local.set $cap (i32.load (i32.sub (local.get $off) (i32.const 4))))
          (local.set $newOff (call $__alloc_hdr_n (i32.const 0) (local.get $cap) (i32.add (local.get $stride) (i32.const ${LANE}))))
          ;; Two addresses for the SAME new table: $outPhys (physical, T-relative — the
          ;; only form valid to DEREFERENCE right now, since the memmove down to mark
          ;; hasn't happened yet) drives __map_set/__set_add's OWN internal __ptr_offset
          ;; below; $out (logical, delta-adjusted) is the value returned/memoized — never
          ;; dereferenced until after region_exit's closing memory.copy lands it for real.
          (local.set $outPhys (call $__mkptr (local.get $t) (i32.const 0) (local.get $newOff)))
          (local.set $out (call $__mkptr (local.get $t) (i32.const 0) (i32.sub (local.get $newOff) (local.get $delta))))
          (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
          ;; walk the source in insertion order (__coll_order), like __sclone_rec's SET/MAP
          ;; branch — inserting into a fresh cap-sized table never grows, so $outPhys stays canonical,
          ;; PROVIDED $n is the real live count. Chained-region-round fix (.work/research.md §Region
          ;; arena, __coll_order/$__dyn_props chain-round defect): $n used to be read from the
          ;; table's own header count word (i32.load(off-8)) BEFORE ever calling __coll_order — the
          ;; ONE call site in this codebase that violated __coll_order's own documented contract
          ;; ("the header and the real gathered count are NOT guaranteed to agree... every caller
          ;; MUST read $__coll_order_n") — every sibling caller (__sclone_rec, __region_exit's own
          ;; $__dyn_props rebuild, every genLookup/genUpsertGrow iteration site in
          ;; module/collection.js) reads $__coll_order_n AFTER the call instead. A header/real-count
          ;; divergence here doesn't just under/over-count for THIS table — it feeds genUpsertStrictPrehashed
          ;; (__set_add_h/__map_set_h), which has NO grow path at all ("inserting into a fresh
          ;; cap-sized table never grows" — true only when $n is the genuine live count, since a
          ;; real n < cap guarantees open-addressed probing terminates by the pigeonhole principle,
          ;; independent of hash-bucket clustering from relocated keys' changed bits). An inflated
          ;; $n reads past __coll_order's own gathered $ord entries (uninitialized bump-allocator
          ;; bytes decoded as bogus "slot" pointers); a table that genuinely fills under a wrong $n
          ;; drives __zomb_scan's documented "falls back to slot 0... which the 75%-load grow makes
          ;; unreachable" escape hatch, which unconditionally increments the header count even
          ;; though it overwrote (not added) an entry — inflating the REBUILT table's own header for
          ;; the NEXT round to inherit and compound. Every ADDITIONAL region round is another
          ;; unconditional rebuild of every reachable Set/Map (this arm has no durable short-circuit
          ;; — see the comment above), so more rounds mean more chances for the divergence to first
          ;; appear and then compound round over round — exactly the "any additional region round"
          ;; trigger and the "round N confuses round N+2" composition the task named. Fixed by
          ;; reading $n from $__coll_order_n, AFTER the call, matching every other caller in this
          ;; codebase — no special-casing, just the documented contract finally honored here too.
          (local.set $ord (call $__coll_order (local.get $off) (local.get $cap) (local.get $stride)))
          (local.set $n (global.get $__coll_order_n))
          (block $cd (loop $cl
            (br_if $cd (i32.ge_s (local.get $i) (local.get $n)))
            (local.set $slot (i32.load (i32.add (local.get $ord) (i32.shl (local.get $i) (i32.const 2)))))
            ;; Region-arena rebuild fix (.work/research.md §Region arena, front-
            ;; boundary hunt — full mechanism on __set_add_h/__map_set_h,
            ;; module/collection.js): a relocated key's stored bits are the
            ;; LOGICAL (post-move) address — correct to STORE, but its target
            ;; memory only physically exists at the PRE-move address until
            ;; region_exit's closing memory.copy. $__map_hash's STRING/BIGINT
            ;; arms dereference the key's payload (content hash); every other
            ;; kind hashes the raw bits with no dereference. So: content-hashed
            ;; keys hash the ORIGINAL bits (content is copied byte-for-byte,
            ;; identical either way, and the original address stays valid to
            ;; read all the way to region_exit's own last instruction); every
            ;; other key hashes the RELOCATED bits (bits-based, must match
            ;; what a future lookup — which only ever sees the stored, final
            ;; bits — will compute; no dereference, so the not-yet-moved
            ;; address is never touched). Then insert with the precomputed
            ;; hash via the STRICT prehashed sibling (skips $__map_set/
            ;; $__set_add's OWN internal re-hash of the — for content kinds,
            ;; still-premature — relocated pointer).
            (local.set $propsF (f64.load (i32.add (local.get $slot) (i32.const 8))))
            (local.set $newFinal (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $propsF)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK}))))
            (local.set $oldProps (call $__region_copy_rec (local.get $propsF) (local.get $memo) (local.get $mark) (local.get $delta)))
            (local.set $len (call $__map_hash (i64.reinterpret_f64
              (select (local.get $propsF) (local.get $oldProps)
                (i32.or (i32.eq (local.get $newFinal) (i32.const ${PTR.STRING})) (i32.eq (local.get $newFinal) (i32.const ${PTR.BIGINT})))))))
            (if (i32.eq (local.get $t) (i32.const ${PTR.MAP}))
              (then (drop (call $__map_set_h (i64.reinterpret_f64 (local.get $outPhys))
                (i64.reinterpret_f64 (local.get $oldProps))
                (local.get $len)
                (i64.reinterpret_f64 (call $__region_copy_rec (f64.load (i32.add (local.get $slot) (i32.const 16))) (local.get $memo) (local.get $mark) (local.get $delta))))))
              (else (drop (call $__set_add_h (i64.reinterpret_f64 (local.get $outPhys))
                (i64.reinterpret_f64 (local.get $oldProps))
                (local.get $len)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $cl)))
          ;; NO old-site forwarding stub — boundary-arithmetic audit, window B
          ;; (see regionArmArray's matching comment above for the full
          ;; mechanism: __region_exit's closing memory.copy destroys any stub
          ;; written here before an external reader could ever chase it).
          (return (local.get $out))))`
}

/** OBJECT's region arm — NEW (Slice 2). Mirrors ARRAY's durable/ephemeral
 *  split exactly (OBJECT shares ARRAY's own header shape via __alloc_hdr —
 *  layout-kinds-doc.js OBJECT.allocShape) with two differences: (1) slot
 *  COUNT comes from the schema table (aux = schemaId indexes it), the same
 *  __schema_tbl[sid] → __len lookup __obj_clone/__sclone_rec already use,
 *  not a header length word (OBJECT's header len word is unused — schema
 *  slot count is compile-time-fixed per shape, never grows); (2) the durable
 *  branch's off-16 dyn-props peek is guarded by `off >= $__heap_start`
 *  (__obj_clone's own guard, mirrored here) — a STATIC-SEGMENT object
 *  literal (compile-time constant, off < heap base) has NO header at all,
 *  unlike every ARRAY this function ever sees (region roots are always
 *  heap-resident compiler-internal data, never a bare static array literal
 *  reached as a schema-less OBJECT would be). */
export function regionArmObject({ hasDynProps }) {
  const durableDynProps = !hasDynProps ? '' : `
              (if (i32.ge_u (local.get $off) (global.get $__heap_start))
                (then
                  (local.set $oldProps (f64.load (i32.sub (local.get $off) (i32.const 16))))
                  (local.set $oldProps (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $oldProps)) (i64.const -2))))
                  (local.set $propsF (f64.const 0))
                  (if (i32.eq
                        (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                        (i32.const ${PTR.HASH}))
                    (then (local.set $propsF (local.get $oldProps)))
                    (else
                      (if (f64.ne (global.get $__dyn_props) (f64.const 0))
                        (then
                          (local.set $hit (call $__ihash_get_local (i64.reinterpret_f64 (global.get $__dyn_props)) (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))))
                          (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (local.set $propsF (f64.reinterpret_i64 (local.get $hit)))))))))
                  (if (f64.ne (local.get $propsF) (f64.const 0))
                    (then
                      (local.set $propsF (call $__region_relocate_props (local.get $propsF) (local.get $memo) (local.get $mark) (local.get $delta)))
                      (if (i32.eq
                            (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                            (i32.const ${PTR.HASH}))
                        (then
                          (f64.store (i32.sub (local.get $off) (i32.const 16)) (local.get $propsF)))
                        (else
                          (local.set $dpRoot (f64.reinterpret_i64 (call $__ihash_set_local
                            (i64.reinterpret_f64 (global.get $__dyn_props))
                            (i64.reinterpret_f64 (f64.convert_i32_s (local.get $off)))
                            (i64.reinterpret_f64 (local.get $propsF)))))
                          (global.set $__dyn_props (local.get $dpRoot))
                          (global.set $__enumc_off (i32.const 0))))))))
              `
  // NOT ARRAY's migrate-to-$__dyn_props-with-a--1-sentinel pattern (module/
  // collection.js __dyn_set's ARRAY arm treats a non-zero, non-HASH-tagged
  // off-16 word — e.g. -1 — as "look in the global table instead", falling
  // through past its inline check). OBJECT's __dyn_set arm has NO such
  // fallback (module/collection.js, the "OBJECT: heap-allocated AND ephemeral
  // ... writes propsPtr directly at off-16" comment): it treats ANY non-zero
  // off-16 word as an already-valid HASH pointer, unconditionally, with no
  // tag check. Writing ARRAY's -1 sentinel there would misdirect the next
  // dyn-prop access into dereferencing that -1 bit pattern as a real pointer
  // — confirmed live (native repro: an ephemeral `{}` given a dynamic key
  // then read back after a region boundary, `memory access out of bounds`).
  // So OBJECT's ephemeral relocation keeps props INLINE at the object's NEW
  // off-16, unconditionally — never migrates to $__dyn_props (matching
  // __dyn_set's own policy: an ephemeral OBJECT's props are ALWAYS inline;
  // only a static-segment or durable-heap receiver ever uses the global
  // table, and this branch is for a freshly-relocated EPHEMERAL object).
  const ephemeralDynProps = !hasDynProps ? '' : `
          (local.set $oldProps (f64.load (i32.sub (local.get $off) (i32.const 16))))
          (local.set $oldProps (f64.reinterpret_i64 (i64.and (i64.reinterpret_f64 (local.get $oldProps)) (i64.const -2))))
          (if (i32.eq
                (i32.wrap_i64 (i64.and (i64.shr_u (i64.reinterpret_f64 (local.get $oldProps)) (i64.const ${LAYOUT.TAG_SHIFT})) (i64.const ${LAYOUT.TAG_MASK})))
                (i32.const ${PTR.HASH}))
            (then
              (f64.store (i32.sub (local.get $newOff) (i32.const 16))
                (call $__region_relocate_props (local.get $oldProps) (local.get $memo) (local.get $mark) (local.get $delta)))))
          `
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.OBJECT}))
        (then
          (local.set $off (call $__ptr_offset (local.get $bits)))
          (local.set $aux (call $__ptr_aux (local.get $bits)))
          (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
          (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
          (local.set $n (i32.const 0))
          (if (i32.ne (global.get $__schema_tbl) (i32.const 0))
            (then (local.set $n (call $__len
              (i64.load (i32.add (global.get $__schema_tbl) (i32.shl (local.get $aux) (i32.const 3))))))))
          (if (i32.lt_u (local.get $off) (local.get $mark))
            (then
              ;; Durable — schema slots never grow (fixed count once allocated), so the
              ;; container's own address never changes; walk in place exactly like
              ;; ARRAY's durable branch (a durable object can still hold an ephemeral
              ;; slot value, e.g. a freshly-built child written into it this round).
              (local.set $out (call $__mkptr (i32.const ${PTR.OBJECT}) (local.get $aux) (local.get $off)))
              (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
              (block $od (loop $ol
                (br_if $od (i32.ge_s (local.get $i) (local.get $n)))
                (local.set $slot (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))
                (f64.store (local.get $slot)
                  (call $__region_copy_rec (f64.load (local.get $slot)) (local.get $memo) (local.get $mark) (local.get $delta)))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $ol)))
              ;; Same off-16 dyn-props sidecar shape/hazard as ARRAY's (layout-kinds-doc.js
              ;; OBJECT.childPointers) — guarded against static-segment objects, which have
              ;; no header at all (__obj_clone's own guard, mirrored here).
              ${durableDynProps}
              (return (local.get $out))))
          (local.set $newOff (call $__alloc_hdr (i32.const 0) (i32.add (local.get $n) (i32.eqz (local.get $n)))))
          (local.set $out (call $__mkptr (i32.const ${PTR.OBJECT}) (local.get $aux) (i32.sub (local.get $newOff) (local.get $delta))))
          ;; memo BEFORE recursing into slots — cycles / diamond sharing terminate on revisit
          (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
          (block $pd (loop $pl
            (br_if $pd (i32.ge_s (local.get $i) (local.get $n)))
            (local.set $slot (i32.add (local.get $newOff) (i32.shl (local.get $i) (i32.const 3))))
            (f64.store (local.get $slot)
              (call $__region_copy_rec (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))
                (local.get $memo) (local.get $mark) (local.get $delta)))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $pl)))
          ;; ephemeral OBJECTs are always heap-resident (never static-segment), so no
          ;; $__heap_start guard is needed here (mirrors ARRAY's ephemeral branch).
          ${ephemeralDynProps}
          ;; NO old-site forwarding stub (boundary-arithmetic audit, window A):
          ;; PTR.OBJECT is not a FORWARDING_MASK member (layout.js) — __ptr_offset's
          ;; chase never even inspects an OBJECT-tagged pointer's header for one, so
          ;; a stub written here could never be read by ANY consumer, ever, chase or
          ;; no chase — a dead write regardless of the closing-memcpy timing that
          ;; kills every OTHER kind's stub too (window B — see regionArmArray).
          ;; Consistent with TYPED/BUFFER, neither of which ever wrote one either.
          (return (local.get $out))))`
}

/** HASH's region arm — NEW (Slice 2). A bare PTR.HASH value is physically
 *  identical to the dyn-props sidecar case __region_relocate_props already
 *  handles (same header/entry shape, same content-hashed-STRING-key bucket-
 *  stability argument — layout-kinds-doc.js HASH.forwarding) — delegate to
 *  it directly rather than duplicating the durable-walk/ephemeral-bulk-copy
 *  logic a second time. */
export function regionArmHash() {
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.HASH}))
        (then (return (call $__region_relocate_props (local.get $v) (local.get $memo) (local.get $mark) (local.get $delta)))))`
}

/** TYPED's region arm — NEW (Slice 2). OWNED storage is a leaf raw-byte copy
 *  (byteLen at header -8, no boxed children — mirrors BUFFER's own arm). A
 *  VIEW's 16B descriptor holds bufferRootOff as a RAW i32 edge (not a boxed
 *  f64 slot — layout-kinds-doc.js TYPED.childPointers' "structurally
 *  different edge shape" note): rebased by recursing __region_copy_rec on a
 *  SYNTHESIZED BUFFER box for the root (mirrors __sclone_rec's TYPED view
 *  arm), then re-deriving dataOff from the (possibly-relocated) root's new
 *  offset plus the original byte delta into it. */
export function regionArmTyped() {
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.TYPED}))
        (then
          (local.set $off (call $__ptr_offset (local.get $bits)))
          (local.set $aux (call $__ptr_aux (local.get $bits)))
          (if (i32.and (local.get $aux) (i32.const 8))
            (then
              ;; VIEW: 16B descriptor [0]byteLen [4]dataOff [8]rootOff [12]reserved.
              (if (i32.lt_u (local.get $off) (local.get $mark))
                (then
                  ;; durable descriptor (stable address) — its root buffer may still be
                  ;; ephemeral (this round); rebase in place if it moved. Ordering audit
                  ;; (.work/research.md §Region arena): memo-guard the durable branch
                  ;; itself, same fix class as __region_relocate_props's durable branch
                  ;; below (both were the only two "walks/mutates in place, no memo"
                  ;; arms in the whole dispatch — ARRAY/OBJECT's durable branches memo
                  ;; themselves before this). Without it, a diamond-shared durable view
                  ;; (the SAME descriptor object reachable via two root paths) would
                  ;; re-read off+8 on a second visit AFTER the first visit already
                  ;; overwrote it with the FINAL (delta-adjusted, not-yet-physically-
                  ;; valid) buffer address — re-deriving $oldRoot from that final value
                  ;; and recursing into __region_copy_rec on a bogus synthesized BUFFER
                  ;; box, corrupting state exactly like the HASH-durable case this audit
                  ;; found and fixed natively.
                  (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
                  (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (local.get $v))))
                  (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $v))))
                  (local.set $oldRoot (i32.load (i32.add (local.get $off) (i32.const 8))))
                  (local.set $rootBox (call $__region_copy_rec
                    (call $__mkptr (i32.const ${PTR.BUFFER}) (i32.const 0) (local.get $oldRoot))
                    (local.get $memo) (local.get $mark) (local.get $delta)))
                  (local.set $newRoot (call $__ptr_offset (i64.reinterpret_f64 (local.get $rootBox))))
                  (i32.store (i32.add (local.get $off) (i32.const 4))
                    (i32.add (local.get $newRoot) (i32.sub (i32.load (i32.add (local.get $off) (i32.const 4))) (local.get $oldRoot))))
                  (i32.store (i32.add (local.get $off) (i32.const 8)) (local.get $newRoot))
                  (return (local.get $v))))
              (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
              (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
              (local.set $oldRoot (i32.load (i32.add (local.get $off) (i32.const 8))))
              (local.set $rootBox (call $__region_copy_rec
                (call $__mkptr (i32.const ${PTR.BUFFER}) (i32.const 0) (local.get $oldRoot))
                (local.get $memo) (local.get $mark) (local.get $delta)))
              (local.set $newRoot (call $__ptr_offset (i64.reinterpret_f64 (local.get $rootBox))))
              (local.set $newOff (call $__alloc (i32.const 16)))
              (i32.store (local.get $newOff) (i32.load (local.get $off)))
              (i32.store (i32.add (local.get $newOff) (i32.const 4))
                (i32.add (local.get $newRoot) (i32.sub (i32.load (i32.add (local.get $off) (i32.const 4))) (local.get $oldRoot))))
              (i32.store (i32.add (local.get $newOff) (i32.const 8)) (local.get $newRoot))
              (i32.store (i32.add (local.get $newOff) (i32.const 12)) (i32.load (i32.add (local.get $off) (i32.const 12))))
              (local.set $out (call $__mkptr (i32.const ${PTR.TYPED}) (local.get $aux) (i32.sub (local.get $newOff) (local.get $delta))))
              (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
              (return (local.get $out)))
            (else
              ;; OWNED: leaf raw bytes, header byteLen at -8, no boxed children.
              (if (i32.lt_u (local.get $off) (local.get $mark)) (then (return (local.get $v))))
              (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
              (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
              (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
              (local.set $newOff (call $__alloc_hdr_n (local.get $len) (local.get $len) (i32.const 1)))
              (memory.copy (local.get $newOff) (local.get $off) (local.get $len))
              (local.set $out (call $__mkptr (i32.const ${PTR.TYPED}) (local.get $aux) (i32.sub (local.get $newOff) (local.get $delta))))
              (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
              (return (local.get $out))))))`
}

/** BUFFER's region arm — NEW (Slice 2). Leaf raw-byte copy (byteLen at
 *  header -8, no boxed children), memo'd — unlike structuredClone (which
 *  intentionally makes an independent copy), region relocation MUST
 *  preserve "same .buffer" identity across multiple typed-array views that
 *  legitimately share one BUFFER (TYPED's view arm above relies on this: two
 *  views over the SAME root, relocated in the same round, must land on the
 *  SAME new BUFFER address). */
export function regionArmBuffer() {
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.BUFFER}))
        (then
          (local.set $off (call $__ptr_offset (local.get $bits)))
          (if (i32.lt_u (local.get $off) (local.get $mark)) (then (return (local.get $v))))
          (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
          (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
          (local.set $len (i32.load (i32.sub (local.get $off) (i32.const 8))))
          (local.set $newOff (call $__alloc_hdr_n (local.get $len) (local.get $len) (i32.const 1)))
          (memory.copy (local.get $newOff) (local.get $off) (local.get $len))
          (local.set $out (call $__mkptr (i32.const ${PTR.BUFFER}) (i32.const 0) (i32.sub (local.get $newOff) (local.get $delta))))
          (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
          (return (local.get $out))))`
}

/** EXTERNAL's region arm — NEW (Slice 2). Immediate passthrough: the offset
 *  is an INDEX into the host-side mem._extMap table, not a wasm-heap
 *  address — there is nothing for the wasm side to relocate at all
 *  (layout-kinds-doc.js EXTERNAL.allocShape). */
export function regionArmExternal() {
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.EXTERNAL})) (then (return (local.get $v))))`
}

/** CLOSURE's region arm — the front-boundary forcing case (.work/research.md
 *  §Region arena), a real relocation now instead of a trap. Shape mirrors
 *  OBJECT's durable/ephemeral split (the env block, like OBJECT's schema
 *  slots, is a fixed-count-once-allocated run with no separate indirect
 *  backing pointer) with two differences: (1) slot COUNT and per-slot
 *  boxed/raw MODE come from the `$__closure_env_len`/`$__closure_env_mask`
 *  side table (funcIdx = aux indexes it — module/function.js's
 *  ctx.closure.make captures both facts at its own env-allocation site,
 *  materialized here by src/wat/assemble.js, exactly mirroring
 *  `$__schema_tbl`'s "build once, index by a stable small int" shape); (2) a
 *  zero-capture closure's offset is the LITERAL immediate `0` (no heap block
 *  at all — module/function.js `mkPtrIR(PTR.CLOSURE, tableIdx, 0)`), passed
 *  through unchanged before ever touching `$memo` (bits never change across
 *  any relocation, so this is trivially identity-safe, mirroring the
 *  preamble's ATOM arm). A cell-mode slot (mask bit set — the boxed/mutable-
 *  capture path, module/function.js's `ctx.func.boxed`) holds a RAW i32
 *  pointer to a shared, independently-heap-allocated 8-byte payload cell
 *  (`${T}cell_${name}`) — NOT a NaN-boxed f64 — so it can't route through
 *  `__region_copy_rec`'s own f64 dispatch; `__region_relocate_cell` (module/
 *  core.js) is the dedicated helper, memoized by a synthetic (never-NaN,
 *  never colliding with a real heap pointer's bits) f64 key so a cell shared
 *  by two closures (the whole point of the boxed-capture mechanism) lands on
 *  the SAME new address from both env slots — breaking that would silently
 *  un-alias a mutable capture across the boundary. */
export function regionArmClosure() {
  return `(if (i32.eq (local.get $t) (i32.const ${PTR.CLOSURE}))
        (then
          (local.set $off (call $__ptr_offset (local.get $bits)))
          (local.set $aux (call $__ptr_aux (local.get $bits)))
          ;; zero-capture: no heap block, offset is the literal 0 sentinel — see doc above.
          (if (i32.eqz (local.get $off)) (then (return (local.get $v))))
          (local.set $hit (call $__map_get (local.get $memo) (local.get $bits)))
          (if (i32.eqz (call $__is_nullish (local.get $hit))) (then (return (f64.reinterpret_i64 (local.get $hit)))))
          ;; Side table absent is impossible once ANY real (non-zero-offset)
          ;; CLOSURE value reaches here — a program with zero closures never
          ;; constructs a PTR.CLOSURE box with a real heap block at all.
          (if (i32.eqz (global.get $__closure_env_len)) (then (unreachable)))
          (local.set $n (i32.load (i32.add (global.get $__closure_env_len) (i32.shl (local.get $aux) (i32.const 2)))))
          ;; >31 captures can't fit the i32 cell-mode bitmask (module/function.js's
          ;; own envCellMask cap — unobserved on every measured corpus, .work/
          ;; closure-plan-design.md §1.5 tops out at 27 captures) — a NAMED trap
          ;; for that one case, not a silent truncation of which slots are pointers.
          (if (i32.gt_s (local.get $n) (i32.const 32)) (then (unreachable)))
          (local.set $cellMask (i32.load (i32.add (global.get $__closure_env_mask) (i32.shl (local.get $aux) (i32.const 2)))))
          (if (i32.lt_u (local.get $off) (local.get $mark))
            (then
              ;; Durable env block — exclusively owned by this ONE closure box
              ;; (unlike a boxed cell, which CAN be shared — see
              ;; __region_relocate_cell), so its address never changes; memo
              ;; itself, walk slots in place, mirroring ARRAY/OBJECT's own
              ;; durable branches.
              (local.set $out (call $__mkptr (i32.const ${PTR.CLOSURE}) (local.get $aux) (local.get $off)))
              (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
              (block $cld (loop $cll
                (br_if $cld (i32.ge_s (local.get $i) (local.get $n)))
                (local.set $slot (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3))))
                (if (i32.and (i32.shr_u (local.get $cellMask) (local.get $i)) (i32.const 1))
                  (then (i32.store (local.get $slot)
                    (call $__region_relocate_cell (i32.load (local.get $slot)) (local.get $memo) (local.get $mark) (local.get $delta))))
                  (else (f64.store (local.get $slot)
                    (call $__region_copy_rec (f64.load (local.get $slot)) (local.get $memo) (local.get $mark) (local.get $delta)))))
                (local.set $i (i32.add (local.get $i) (i32.const 1)))
                (br $cll)))
              (return (local.get $out))))
          (local.set $newOff (call $__alloc (i32.shl (local.get $n) (i32.const 3))))
          (local.set $out (call $__mkptr (i32.const ${PTR.CLOSURE}) (local.get $aux) (i32.sub (local.get $newOff) (local.get $delta))))
          ;; memo BEFORE recursing into slots — cycles / diamond sharing terminate on revisit
          (drop (call $__map_set (local.get $memo) (local.get $bits) (i64.reinterpret_f64 (local.get $out))))
          (block $ced (loop $cel
            (br_if $ced (i32.ge_s (local.get $i) (local.get $n)))
            (local.set $slot (i32.add (local.get $newOff) (i32.shl (local.get $i) (i32.const 3))))
            (if (i32.and (i32.shr_u (local.get $cellMask) (local.get $i)) (i32.const 1))
              (then (i32.store (local.get $slot)
                (call $__region_relocate_cell (i32.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))) (local.get $memo) (local.get $mark) (local.get $delta))))
              (else (f64.store (local.get $slot)
                (call $__region_copy_rec (f64.load (i32.add (local.get $off) (i32.shl (local.get $i) (i32.const 3)))) (local.get $memo) (local.get $mark) (local.get $delta)))))
            (local.set $i (i32.add (local.get $i) (i32.const 1)))
            (br $cel)))
          (return (local.get $out))))`
}

/** Extended locals declaration for __region_copy_rec (Slice 2 adds TYPED's
 *  view-rebase temporaries; every other new arm reuses locals the pre-
 *  Slice-2 function already declared). */
export function regionCopyRecLocals() {
  return `(local $bits i64) (local $t i32) (local $off i32) (local $aux i32) (local $hit i64) (local $out f64)
      (local $newOff i32) (local $n i32) (local $i i32) (local $slot i32) (local $len i32) (local $cap i32)
      (local $stride i32) (local $ord i32) (local $outPhys f64) (local $oldProps f64) (local $dpRoot f64) (local $newFinal i32) (local $propsF f64)
      (local $oldRoot i32) (local $rootBox f64) (local $newRoot i32) (local $cellMask i32)`
}

/** Preamble — verbatim (module/core.js, pre-Slice-2) plus ONE new immediate
 *  check (EXTERNAL — Slice 2, same "no wasm heap block at all" shape as
 *  ATOM, so it sits right beside it). */
export function regionCopyRecPreamble() {
  return `;; ordinary numbers (incl. +/-Infinity) are immediate
      (if (f64.eq (local.get $v) (local.get $v)) (then (return (local.get $v))))
      (local.set $bits (i64.reinterpret_f64 (local.get $v)))
      ;; negative-NaN bit patterns are numeric NaN, never boxes (__sclone_rec precedent)
      (if (i64.eq (i64.and (local.get $bits) (i64.const 0xFFF0000000000000)) (i64.const 0xFFF0000000000000))
        (then (return (local.get $v))))
      (local.set $t (call $__ptr_type (local.get $bits)))
      ;; ATOM (null/undefined/bool/canonical-NaN): immediate, passes through
      (if (i32.eq (local.get $t) (i32.const ${PTR.ATOM})) (then (return (local.get $v))))
      ${regionArmExternal()}
`
}

/** Composes the full __region_copy_rec body (Slice 2 + the CLOSURE arm):
 *  preamble, then every kind's arm in KIND_REGISTRY's own declared order
 *  (skipping ATOM/EXTERNAL/NUMBER, folded into the preamble already), then
 *  the trailing backstop — reachable ONLY by a tag value no PTR.*
 *  enumerates; every real heap kind, CLOSURE included, now has its own arm.
 *  `hasDynProps` is the caller-resolved `ctx.scope.globals.has('__dyn_props')`
 *  flag (layout-kinds.js stays ctx-free — see regionArmArray's doc). */
export function regionCopyRecBody({ hasDynProps }) {
  return `      ${regionCopyRecLocals()}
      ${regionCopyRecPreamble()}
      ${regionArmBigint()}

      ${regionArmString()}

      ${regionArmArray({ hasDynProps })}

      ${regionArmObject({ hasDynProps })}

      ${regionArmHash()}

      ${regionArmSetMap()}

      ${regionArmTyped()}

      ${regionArmBuffer()}

      ${regionArmClosure()}

      ;; any tag not one of the above is not a valid PTR.* value — impossible
      ;; by construction (every real heap kind now has an arm).
      (unreachable))`
}

// ============================================================================
// Identity-dispatch arm generation (Heap-kind registry Slice 3, .work/
// research.md §Heap-kind registry — "3 $__eq/$__map_hash arms generated").
// module/core.js's $__eq and module/collection.js's $__same_value_zero/
// $__map_hash each hand-roll a tag-dispatch chain that special-cases the
// CONTENT-identity kinds — every other kind needs no arm at all, relying on
// the caller's own bit-equality fast path (pointer-bits identity IS bit
// equality). Which kinds get an arm, and in what order, is data: the
// `identityArm` column on KIND_REGISTRY.STRING/BIGINT above (every other
// row has no identityArm, so none is seeded).
//
// NOT a single generic WAT-synthesis template: $__eq and $__same_value_zero
// realize the SAME STRING content-identity fact with ONE remaining real
// textual difference (an interned-vs-interned short-circuit, present in
// $__eq, absent in $__same_value_zero — pure perf, __str_eq already decides
// that case correctly on its own). The per-operand NaN re-guard used to be a
// second difference; audit re-derivation found it load-bearing (not
// defense-in-depth as originally presumed — a genuine finite f64 whose
// mantissa aliases the STRING tag reaches __str_eq and OOB-traps without it,
// reproduced in test/layout-kinds.js) and it now ships in BOTH generators —
// see sameValueZeroIdentityChain's own comment and layout-kinds-doc.js's
// FINDINGS[identity-arm-divergence] for the closed writeup. Each consumer
// still keeps its own generator function below, hand-authored and guarded
// (assertContentOrder) rather than synthesized from a shared template: with
// only two content-identity kinds and one remaining textually-different
// STRING arm across consumers, a shared-template rewrite would change the
// generated WAT text by construction — byte-identity with the existing
// generated output wins over a marginal iteration-count reduction from 2 to
// "a loop of 2".
// ============================================================================

export const CONTENT_IDENTITY_ORDER = Object.keys(KIND_REGISTRY)
  .filter(k => KIND_REGISTRY[k].identityArm?.kind === 'content')
  .sort((a, b) => KIND_REGISTRY[a].identityArm.order - KIND_REGISTRY[b].identityArm.order)

// Every generator below hand-encodes CONTENT_IDENTITY_ORDER === ['BIGINT', 'STRING']
// in its own nesting (BIGINT checked first) — this assert fires closed instead of
// silently drifting if the registry's content-identity kind set or order ever
// changes without the generator text being revisited.
const assertContentOrder = (fnName) => {
  if (CONTENT_IDENTITY_ORDER.length !== 2 || CONTENT_IDENTITY_ORDER[0] !== 'BIGINT' || CONTENT_IDENTITY_ORDER[1] !== 'STRING')
    throw new Error(`${fnName}: KIND_REGISTRY's content-identity kinds changed (${CONTENT_IDENTITY_ORDER.join(',')}) — this hand-authored arm text needs updating to match`)
}

/** $__eq's (module/core.js) content-identity tag-dispatch chain, spliced in right
 *  after $ta/$tb are extracted: BIGINT payload compare, else STRING (guarded
 *  per-operand against a non-NaN false-tag alias, with an interned-vs-interned
 *  short-circuit), else unequal. Verbatim source of truth for that span — see
 *  test/layout-kinds.js's byte-identity proof. */
export function eqIdentityChain() {
  assertContentOrder('eqIdentityChain')
  return `(if (result i32)
              (i32.and (i32.eq (local.get $ta) (i32.const ${PTR.BIGINT})) (i32.eq (local.get $tb) (i32.const ${PTR.BIGINT})))
              (then (i64.eq
                (i64.load (call $__ptr_offset (local.get $a)))
                (i64.load (call $__ptr_offset (local.get $b)))))
              (else
            (if (result i32)
              (i32.and
                (i32.and (f64.ne (local.get $fa) (local.get $fa)) (i32.eq (local.get $ta) (i32.const ${PTR.STRING})))
                (i32.and (f64.ne (local.get $fb) (local.get $fb)) (i32.eq (local.get $tb) (i32.const ${PTR.STRING}))))
              (then
                ;; both canonical interned (bit-ne already known) ⇒ unequal —
                ;; skip the __str_eq call entirely (see STR_INTERN_BIT, layout.js)
                (if (result i32)
                  (i32.and
                    (i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (local.get $a) (i64.const ${LAYOUT.AUX_SHIFT}))) (i32.const ${LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT | STR_INTERN_BIT})) (i32.const ${STR_INTERN_BIT}))
                    (i32.eq (i32.and (i32.wrap_i64 (i64.shr_u (local.get $b) (i64.const ${LAYOUT.AUX_SHIFT}))) (i32.const ${LAYOUT.SSO_BIT | LAYOUT.SLICE_BIT | STR_INTERN_BIT})) (i32.const ${STR_INTERN_BIT})))
                  (then (i32.const 0))
                  (else (call $__str_eq (local.get $a) (local.get $b)))))
              (else (i32.const 0)))))`
}

/** $__same_value_zero's (module/collection.js) content-identity chain — same
 *  BIGINT arm as eqIdentityChain (byte-identical text). STRING arm carries the
 *  SAME per-operand NaN re-guard as eqIdentityChain (audit: FINDINGS[identity-
 *  arm-divergence] closed — the guard is load-bearing, not defense-in-depth:
 *  an ordinary finite f64 whose mantissa bits 47-50 alias PTR.STRING can reach
 *  this arm on a genuine hash collision against a real heap string, and
 *  without the guard $__str_eq dereferences the number's low 32 bits as a
 *  string offset — a real OOB trap, reproduced in test/layout-kinds.js).
 *  Intentionally OMITS eqIdentityChain's interned-vs-interned short-circuit —
 *  that half of the divergence stays: both operands are already proven real
 *  STRING pointers past the guard, so skipping it is pure perf (__str_eq
 *  itself decides interned-vs-interned correctly), not a soundness gap. */
export function sameValueZeroIdentityChain() {
  assertContentOrder('sameValueZeroIdentityChain')
  return `(if (result i32)
              (i32.and (i32.eq (local.get $ta) (i32.const ${PTR.BIGINT})) (i32.eq (local.get $tb) (i32.const ${PTR.BIGINT})))
              (then (i64.eq
                (i64.load (call $__ptr_offset (local.get $a)))
                (i64.load (call $__ptr_offset (local.get $b)))))
              (else
            (if (result i32)
              (i32.and
                (i32.and (f64.ne (local.get $fa) (local.get $fa)) (i32.eq (local.get $ta) (i32.const ${PTR.STRING})))
                (i32.and (f64.ne (local.get $fb) (local.get $fb)) (i32.eq (local.get $tb) (i32.const ${PTR.STRING}))))
              (then (call $__str_eq (local.get $a) (local.get $b)))
              (else (i32.const 0)))))`
}

/** $__map_hash's STRING content-identity arm — an early-return statement
 *  (map_hash's shape is sequential guards, not a nested chain), hashes via
 *  __str_hash. */
export function mapHashStringArm() {
  return `(if (i32.and (f64.ne (local.get $f) (local.get $f))
          (i32.eq (local.get $t) (i32.const ${PTR.STRING})))
      (then (return (call $__str_hash (local.get $v)))))`
}

/** $__map_hash's BIGINT content-identity arm — hashes the payload cell via
 *  __hash, folding away the two reserved sentinel buckets (0/1). */
export function mapHashBigintArm() {
  return `(if (i32.and (f64.ne (local.get $f) (local.get $f))
          (i32.eq (local.get $t) (i32.const ${PTR.BIGINT})))
      (then (local.set $h (call $__hash (i64.load (call $__ptr_offset (local.get $v)))))
        (return (if (result i32) (i32.le_s (local.get $h) (i32.const 1))
          (then (i32.add (local.get $h) (i32.const 2)))
          (else (local.get $h))))))`
}
