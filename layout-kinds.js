/**
 * Heap-kind registry — the one per-tag authority every consumer of a NaN-boxed
 * value's KIND should eventually derive from (.work/research.md §Heap-kind registry,
 * audit-#13 critical-path item 3).
 *
 * SLICE 1 (this file): the table + a shadow-check (test/layout-kinds.js) proving
 * each column against TODAY's live behavior. Zero codegen change — nothing here
 * is imported by module/*.js or src/*.js, so it cannot reach dist (verified by
 * the "fresh build byte-identical" gate). Later slices (region tracer, $__eq/
 * $__map_hash arm generation, interop decode, carrier read-side) GENERATE their
 * arms from this table instead of hand-rolling parallel switches — see the design
 * doc's "Consumers that DERIVE" list; that generation infrastructure is still
 * future work (this table remains a leaf, imported by nothing), but CARRIER
 * PROGRAM Slice 3 (.work/carrier-representation-design.md §7) hand-landed every
 * BIGINT arm this table's own FINDINGS named as missing — $__typeof/$__eq/
 * $__eq_strict/$__same_value_zero/$__map_hash/mem.read/__region_copy_rec/
 * __sclone_rec — matching the columns documented below exactly, ahead of the
 * table-driven codegen that will one day generate them FROM this file.
 *
 * LEAF MODULE — imports only layout.js (the err-codes.js pattern: safe for
 * `jz/interop` and tests without pulling the compiler).
 *
 * Method: this table documents CURRENT TRUTH, read directly out of the
 * consumers it describes ($__typeof/$__ptr_type — module/core.js; $__eq/
 * $__eq_strict — module/core.js; $__same_value_zero/$__map_hash — module/
 * collection.js; __region_copy_rec — module/core.js; mem.read/mem.write —
 * interop.js; REF_EQ_KINDS — src/compile/emit.js). Where two consumers (or a
 * consumer and its own doc comment) disagree, that is recorded as a FINDING
 * below, not silently resolved one way — per the design doc's explicit
 * instruction. See test/layout-kinds.js for the live probes that reproduce
 * each finding.
 */
import { PTR, LAYOUT, ATOM, FORWARDING_MASK } from './layout.js'

// Collection entry strides (module/collection.js) — not re-exported from
// layout.js today (Slice 1 reads them at their source); duplicated here as
// plain numbers so this leaf stays import-light. Keep in sync with
// module/collection.js's SET_ENTRY/MAP_ENTRY/LANE if those ever change.
const SET_ENTRY = 16   // [hash i64 @0][elem f64 @8]
const MAP_ENTRY = 24   // [hash i64 @0][key f64 @8][value f64 @16]
const LANE = 4         // trailing i32-per-slot fast-probe lane, appended after cap*stride

/**
 * @typedef {Object} KindEntry
 * @property {number|null} tag        PTR.* (layout.js) or null for the two tagless kinds (NUMBER, and
 *                                     ATOM sub-rows share PTR.ATOM=0 with a distinguishing `aux`).
 * @property {number|null|string} aux For ATOM sub-kinds: the reserved aux id (ATOM.NULL/UNDEF/FALSE/TRUE)
 *                                     or a description of the open Symbol-id sub-range. Null/0 for most
 *                                     other kinds; a description string where aux carries real meaning
 *                                     (schema id, element-type code, function-table index, …).
 * @property {string} allocShape      Header words + payload layout + element width/stride rule.
 * @property {string} childPointers   Which payload slots hold boxed values — the tracer's per-kind input.
 * @property {string} forwarding      Relocatable? in-place-walk? rebuild-on-move? out-of-scope/traps?
 * @property {string} identity        Pointer-bits identity vs content identity — feeds $__eq/$__map_hash.
 * @property {string} interopDecode   How interop.js's mem.read/mem.write handle it.
 * @property {string} typeofArm       What $__typeof (module/core.js) returns for this kind, dynamically.
 * @property {string[]} [findings]    Cross-consumer disagreements this row is party to (see FINDINGS below
 *                                     for the full writeup + live-probe pointer).
 */

/** @type {Record<string, KindEntry>} */
export const KIND_REGISTRY = {
  // ===========================================================================
  // Implicit NUMBER — no PTR tag at all. Any f64 bit pattern that round-trips
  // through `f64.eq(v,v)` is a genuine number (canonical NaN excepted — see
  // ATOM.NUMBER_NAN below); everything NaN-boxed carries a PTR tag instead.
  // ===========================================================================
  NUMBER: {
    tag: null, aux: null,
    allocShape: 'immediate — the f64 IS the value, no heap block',
    childPointers: 'none (leaf)',
    forwarding: 'n/a (immediate)',
    identity: 'value identity (f64.eq); -0 === +0, NaN !== NaN — ordinary IEEE-754, not pointer-bits',
    interopDecode: 'mem.read: `typeof p === "number" && p === p` passthrough (module/core.js never reached)',
    typeofArm: '"number" — $__typeof\'s f64.eq(v,v) self-equality fast path, before any tag dispatch',
  },

  STRING: {
    tag: PTR.STRING, aux: null,
    allocShape:
      'THREE shapes share one tag, discriminated by aux bits (module/string.js): ' +
      '(1) SSO (aux SSO_BIT set) — ≤6 ASCII bytes packed directly into the NaN-box payload/aux, no heap ' +
      'block at all (the box IS the string). (2) plain heap — [len u32 @-4][bytes @0..len), offset points ' +
      'past the length; STR_HCACHE_BIT variant prepends a lazy FNV cache word at @-8 ([hash u32][len u32][bytes]), ' +
      'seeded 0 = uncomputed, filled by __str_hash on first hash. STR_INTERN_BIT marks a canonical ' +
      'static-pool/intern-table copy (bit-equal ⇒ content-equal, no byte compare needed). ' +
      '(3) SLICE (aux SLICE_BIT set) — a view: length in aux[12:0], bytes alias a PARENT string\'s storage, no owned block.',
    childPointers: 'none (leaf bytes) for all three shapes',
    forwarding: 'never relocates (module/string.js invariant, not in FORWARDING_MASK) — SLICE is out of __region_copy_rec\'s scope (unreachable trap; the parent it aliases may relocate, which would leave a dangling view — Slice-1 region program never produces slices, so this is dormant, not exercised)',
    identity: 'CONTENT identity — the one kind $__eq/$__eq_strict/$__same_value_zero special-case: bit-equal ⇒ trivially equal (SSO and canonical-interned strings), bit-different NaN-boxed STRING pair ⇒ __str_eq byte compare (skipped only when BOTH sides are STR_INTERN_BIT-marked, since two distinct canonicals can never be content-equal)',
    interopDecode: 'mem.read t===4: SSO_BIT → decodeSSO (7-bit-per-char unpack); else TEXT_DEC.decode over [off, off+len) read from the -4 header',
    typeofArm: '"string" — $__typeof\'s stringTest arm ($__ptr_type(v) === PTR.STRING)',
  },

  ARRAY: {
    tag: PTR.ARRAY, aux: null,
    allocShape: '16B header ([-16:-8) reserved/forwarding, [-8:-4) len i32, [-4:0) cap i32) + cap*8B payload of f64 slots',
    childPointers: 'each live slot [0, len) — a boxed value; PLUS an off-16 dyn-props sidecar pointer (HASH-tagged, or filed in the global $__dyn_props table keyed by offset) — easily missed (the kernel-oracle dvnested-mechanism O2/O3 regression __region_copy_rec\'s own comments document: watr\'s emitFunc stamps dyn props directly onto compiler-internal ARRAYs)',
    forwarding: 'relocatable — in FORWARDING_MASK; grow leaves [-8:newOffset][-4:-1 sentinel] at the old site, __ptr_offset chases it. __region_copy_rec walks a durable (pre-round) array IN PLACE (memo\'d at its own address, slots still recursed) and rebuilds an ephemeral one fresh',
    identity: 'pointer-bits (REF_EQ_KINDS) — JS `==`/`===` on arrays is reference equality, no content path',
    interopDecode: 'mem.read t===1: follows forwarding (-4 === -1 sentinel loop), reads len @-8, maps mem.read over each BigInt64 slot',
    typeofArm: '"object" — falls through $__typeof\'s STRING/CLOSURE/symbol tests to the default arm',
  },

  OBJECT: {
    tag: PTR.OBJECT, aux: 'schema id (sid) — indexes ctx.schema\'s slot-name table',
    allocShape: '16B header (__alloc_hdr, off-16 = dyn-props sidecar word) + N*8B fixed schema slots (N = schema sid\'s prop count, compile-time fixed per shape)',
    childPointers: 'each of the N schema slots (a boxed value) + the off-16 dyn-props sidecar (same shape/hazard as ARRAY\'s)',
    forwarding: 'never relocates via growth (fixed slot count once allocated, NOT in FORWARDING_MASK) — but __region_copy_rec has NO arm for it at all: falls to the trailing `(unreachable)` (explicitly documented "OBJECT/HASH/CLOSURE/TYPED/BUFFER/EXTERNAL: out of Slice-1 scope" — a live-but-unrouted region-program gap, Slice 2 territory per the design doc)',
    identity: 'pointer-bits (REF_EQ_KINDS)',
    interopDecode: 'mem.read t===6: mem.schemas[aux] → {} with each key read from its slot via mem.read (recursive)',
    typeofArm: '"object". Date/RegExp are schema\'d OBJECT instances too (VAL.REGEX/VAL.DATE in src/reps.js are compile-time STATIC refinements the analyzer tracks — NOT separate PTR tags; at the heap-kind level they are ordinary OBJECT rows)',
    findings: ['region-forwarding'],
  },

  HASH: {
    tag: PTR.HASH, aux: 0,
    allocShape: '16B header (same __alloc_hdr_n shape as SET/MAP) + cap*24B (MAP_ENTRY) slots [hash i64 @0][key f64 @8][value f64 @16] + trailing cap*4B (LANE) probe-index array',
    childPointers: 'each occupied slot (hash word ≠ 0) contributes TWO boxed children: key @8, value @16',
    forwarding: 'never relocates via plain growth in the OBJECT/ARRAY sidecar role (module/core.js\'s __region_relocate_props walks it in place if durable, rebuild-fresh + rehash if ephemeral — a DIFFERENT, narrower helper than __region_copy_rec, used only for the dyn-props-sidecar case). As a bare HASH value reached via __region_copy_rec\'s general dispatch: unrouted, falls to the unreachable trap (same gap as OBJECT)',
    identity: 'pointer-bits (never used as a first-class jz value for ==/===/Set-Map keying — HASH is always an internal dyn-props sidecar or dict backing store, never returned to user code as itself)',
    interopDecode: 'mem.read t===7: walks cap slots (hash≠0 test), builds {} keyed by mem.read(key) → mem.read(value)',
    typeofArm: '"object" (same default arm as ARRAY/OBJECT/SET/MAP/TYPED/BUFFER/EXTERNAL/BIGINT — HASH is never directly typeof\'d by ordinary jz source since it has no literal syntax; probed synthetically in the shadow-check via __mkptr(PTR.HASH,...), the test/pointers.js EXTERNAL precedent)',
    findings: ['region-forwarding'],
  },

  SET: {
    tag: PTR.SET, aux: 0,
    allocShape: '16B header + cap*16B (SET_ENTRY) slots [hash i64 @0][elem f64 @8] + trailing cap*4B (LANE) probe array',
    childPointers: 'each occupied slot contributes ONE boxed child: elem @8',
    forwarding: 'relocatable — in FORWARDING_MASK, but grow-in-place forwarding is moot: SET/MAP never patch a relocated KEY\'s bits in place (would leave it in the wrong hash bucket), so __region_copy_rec ALWAYS rebuilds fresh via __coll_order insertion order + reinsert (fresh hash per current, possibly-relocated key) rather than reusing the forwarding-header convention for its own contents — the header IS still left as a normal forward stub at the old site so other referents self-heal',
    identity: 'pointer-bits (REF_EQ_KINDS) container identity; per-ELEMENT dedup inside the table is SameValueZero via $__same_value_zero (content for STRING elements, pointer-bits for everything else — see the BIGINT finding)',
    interopDecode: 'mem.read t===8: walks cap slots, Set() of mem.read(elem) per occupied slot',
    typeofArm: '"object"',
  },

  MAP: {
    tag: PTR.MAP, aux: 0,
    allocShape: 'identical physical shape to HASH (24B MAP_ENTRY stride) — MAP and HASH are the SAME backing-table code (genUpsert/genLookup parameterized by PTR.MAP vs PTR.HASH), distinguished only by tag and by which built-in surfaces it (user Map vs internal dyn-props dict)',
    childPointers: 'each occupied slot: key @8, value @16 (both boxed)',
    forwarding: 'same as SET — relocatable tag, but __region_copy_rec always rebuilds via __coll_order + reinsert rather than patching in place',
    identity: 'pointer-bits (REF_EQ_KINDS) container identity; per-KEY dedup is SameValueZero (same caveat as SET)',
    interopDecode: 'mem.read t===9: walks cap slots, Map() of mem.read(key) → mem.read(value) per occupied slot',
    typeofArm: '"object"',
  },

  TYPED: {
    tag: PTR.TYPED,
    aux: 'element-type code (TYPED_ELEM_CODE, layout.js) | VIEW_FLAG(8) | BIGINT_FLAG(16) | F16_FLAG(32) | CLAMPED_FLAG(64)',
    allocShape:
      'TWO shapes by VIEW_FLAG: (1) owned — 16B header ([-8] byteLen i32) + raw byte payload, stride 1/2/4/8 per element code. ' +
      '(2) view (DataView / typed-array-over-external-buffer) — 16B DESCRIPTOR block (not a byte payload): ' +
      '[0] byteLen i32, [4] dataOff i32 (absolute), [8] bufferRootOff i32, [12] reserved i32.',
    childPointers: 'owned: none (leaf numeric bytes). view: bufferRootOff @8 is a child edge back to the owning BUFFER — but it is a RAW i32 offset, not a boxed NaN-box f64 slot, a structurally different edge shape than every other kind\'s child pointers (a future tracer\'s child-pointer column needs an "offset-typed edge" case, not just "f64 slot")',
    forwarding: 'never relocates (not in FORWARDING_MASK) — owned storage is fixed-size once allocated; a view\'s bufferRootOff is stable since BUFFER itself never relocates either',
    identity: 'pointer-bits (REF_EQ_KINDS) — two typed arrays over equal bytes are !== (reference identity), matching real JS',
    interopDecode: 'mem.read t===3: view (aux&8) reads the descriptor and returns `new Ctor(mem.buffer, dataOff, byteLen/stride)`; owned reads byteLen@-8 and returns `new Ctor(mem.buffer, off, byteLen/stride)` — both are LIVE views over wasm memory, not copies (mem.write can mutate them back)',
    typeofArm: '"object" (real JS: typeof new Int32Array() === "object", matches)',
  },

  BUFFER: {
    tag: PTR.BUFFER, aux: 0,
    allocShape: '16B header ([-8] byteLen i32) + raw byte payload',
    childPointers: 'none (leaf bytes) — TYPED views reference IT (see TYPED\'s bufferRootOff edge), it never references anything',
    forwarding: 'never relocates (not in FORWARDING_MASK)',
    identity: 'pointer-bits (REF_EQ_KINDS)',
    interopDecode: 'mem.read t===2: reads byteLen@-8, copies into a fresh host ArrayBuffer (COPY, unlike TYPED\'s live view — a returned ArrayBuffer has no wasm-memory-backed representation on the host side)',
    typeofArm: '"object"',
  },

  CLOSURE: {
    tag: PTR.CLOSURE, aux: 'function-table index (indirect_call target), NOT a heap-block discriminator',
    allocShape: 'offset → captured-upvalues block, N contiguous f64 slots (N = this closure SHAPE\'s capture count, fixed at compile time per call site/literal — module/function.js). A closure with zero captures uses offset 0 (no heap block at all, mkPtrIR(PTR.CLOSURE, tableIdx, 0))',
    childPointers: 'each of the N captured-upvalue slots (a boxed value)',
    forwarding: 'never relocates (not in FORWARDING_MASK) — but __region_copy_rec has no arm for it either (falls to the same unreachable trap as OBJECT/HASH — "out of Slice-1 scope")',
    identity:
      'pointer-bits (REF_EQ_KINDS) — but NOT uniformly "fresh allocation per creation" like real JS: a closure with ' +
      'ONE OR MORE captures gets a real heap block per creation (genuinely distinct pointers, matches real JS). A ' +
      'ZERO-capture closure allocates NOTHING (module/function.js: `mkPtrIR(PTR.CLOSURE, tableIdx, 0)` — tag + ' +
      'fixed table-index aux + offset 0, no heap block) — bit-identical every time the SAME literal executes, so ' +
      '`mk()===mk()` for a captureless `mk = () => (() => 1)` is TRUE, unlike real JS where two function-object ' +
      'creations are always distinct. A real, live, single-consumer (not cross-consumer) representation quirk — ' +
      'noted here, not elevated to FINDINGS (no other consumer claims otherwise to disagree with; it is simply a ' +
      'surprising consequence of "immediate when no payload" applied to CLOSURE, worth a future audit item)',
    interopDecode: 'mem.read: NO arm for t===10 — falls to the default `return i64ToF64(p)`, reinterpreting the boxed pointer\'s bits as a raw float. Unlike BIGINT (below) this looks intentional/inert: a CLOSURE crossing to the host has no meaningful host-side JS value to decode INTO (calling it needs a wrapped-export path, not mem.read) — flagged here as a documented gap, not elevated to a FINDING since no comment anywhere claims CLOSURE should decode to something else',
    typeofArm: '"function" — the ONE kind besides STRING that $__typeof special-cases explicitly (closureArm, gated on ctx.features.closure)',
    findings: ['region-forwarding'],
  },

  EXTERNAL: {
    tag: PTR.EXTERNAL, aux: 'reserved (0 in current use)',
    allocShape: 'offset is an INDEX into the host-side mem._extMap table, not a wasm-heap offset — the referenced value lives entirely in JS, outside the traced arena',
    childPointers: 'none from the wasm heap\'s perspective (opaque host handle) — whatever the host object graph contains is invisible to every in-wasm consumer in this table',
    forwarding: 'never relocates (not in FORWARDING_MASK; the wasm side never touches the referent\'s bytes at all)',
    identity: 'pointer-bits on the wasm side (the extMap index) — genuinely content/reference identity is whatever the HOST\'s === says about mem._extMap[off], invisible to $__eq',
    interopDecode: 'mem.read t===11: `mem._extMap[off]` direct lookup (only arm requiring `mem._extMap` to exist)',
    typeofArm: '"object" (a host handle is never CLOSURE/STRING/symbol-shaped at the wasm tag level, regardless of what it is on the host side — `typeof someExternalFunction` reads "object" even if the host value is host-callable, a real but narrow gap noted for completeness, not runtime-probed here since it needs a live host-function fixture)',
  },

  BIGINT: {
    tag: PTR.BIGINT, aux: 0,
    allocShape: '8B payload cell — the BigInt\'s raw two\'s-complement i64 bits, no header at all (module/core.js __alloc(8), not __alloc_hdr — ir.js boxBigInt)',
    childPointers: 'none (leaf, like a heap string byte run)',
    forwarding: 'GROWTH forwarding: never (not in FORWARDING_MASK — fixed 8B cell, content never changes post-allocation). REGION relocation is a distinct axis (audit-#14 item 4): __region_copy_rec fresh-copies an ephemeral BigInt cell like any leaf allocation — "no growth forwarding" must not be read as "region-immovable"',
    identity: 'CONTENT identity (CARRIER PROGRAM Slice 3, .work/carrier-representation-design.md — closes the divergence FINDINGS[eq-identity] documented): $__eq/$__eq_strict (module/core.js) and $__same_value_zero/$__map_hash (module/collection.js) all carry a PTR.BIGINT arm now — two independently-boxed equal-value BigInts compare EQUAL and hash to the same bucket, matching src/compile/emit.js\'s REF_EQ_KINDS comment\'s stated intent ("BIGINT needs __eq (heap-allocated, content compare)")',
    interopDecode: 'mem.read t===5 (CARRIER PROGRAM Slice 3): reads the payload cell directly (`m.getBigInt64(off, true)`) and returns a real host `bigint` — closes FINDINGS[interop-decode]. Distinct from the UNBOXED raw-i64 jz:i64exp `s`-lane sentinel machinery (decodeBigintSentinel) — a separate, already-shipped mechanism for a different representation crossing the boundary, untouched by this fix',
    typeofArm: '"bigint" dynamically too now (CARRIER PROGRAM Slice 3): $__typeof (module/core.js) carries a PTR.BIGINT tag arm, landed ALONGSIDE emit.js\'s magnitude-heuristic TYPEOF.bigint arm (not replacing it yet — Slice 5 retires the heuristic once every R-recovery arm is independently verified). A PROVEN-bigint operand still statically folds to the literal "bigint" and never reaches $__typeof at all; the dynamic arm is what a boxed-but-unproven value (the test-only __box_bigint intrinsic, or a live carrier-box consumer) now hits, closing FINDINGS[typeof]',
    findings: [],
  },

  // ===========================================================================
  // ATOM (PTR.ATOM = 0) — one tag, four+ sub-kinds distinguished by aux.
  // ===========================================================================
  'ATOM.NULL': {
    tag: PTR.ATOM, aux: ATOM.NULL,
    allocShape: 'immediate sentinel (NaN-box with tag=ATOM, aux=1, offset=0) — no heap block',
    childPointers: 'none',
    forwarding: 'n/a (immediate)',
    identity: 'exact-bits identity for ===; LOOSE (==) additionally treats null and undefined as equal via $__eq\'s explicit __is_nullish/__is_nullish both-true special case (bit-DISTINCT sentinels, JS-true anyway)',
    interopDecode: 'mem.read: t===0, off===0, a===1 → JS null',
    typeofArm: '"object" — the historical JS quirk (typeof null === "object"), $__typeof checks this exact bit pattern explicitly before the general tag dispatch',
  },
  'ATOM.UNDEFINED': {
    tag: PTR.ATOM, aux: ATOM.UNDEF,
    allocShape: 'immediate sentinel (aux=2)',
    childPointers: 'none',
    forwarding: 'n/a',
    identity: 'exact-bits for ===; loose == to null (see ATOM.NULL)',
    interopDecode: 'mem.read: a===2 → JS undefined',
    typeofArm: '"undefined"',
  },
  'ATOM.BOOLEAN': {
    tag: PTR.ATOM, aux: `${ATOM.FALSE}|${ATOM.TRUE}`,
    allocShape:
      'TWO representations for "a JS boolean", not one: (1) the BOXED atom (aux=FALSE/TRUE, this row) — used ' +
      'whenever a boolean flows through an untyped/dynamic sink (dyn-prop store, Set/Map element, closure ' +
      'capture, typeof\'s own dynamic path). (2) an UNBOXED raw 0/1 f64 carrier — the static VAL.BOOL fast path ' +
      '(comparisons, `!`, inferred-boolean bindings) that never touches this atom at all; recently hardened ' +
      '(commit 756ae10f) so BOOL∪NUMBER-ambiguous merge sites box to this atom before any consumer that needs ' +
      'REAL typeof/String/identity semantics reads them, instead of leaking a raw bit indistinguishable from ' +
      'NUMBER 0/1.',
    childPointers: 'none',
    forwarding: 'n/a (immediate, this row) / n/a (raw f64, unboxed row)',
    identity: 'exact-bits for ===; loose == does NOT special-case booleans (only null/undefined get the __is_nullish exception) — `true == 1` is real JS-true and IS handled, but via the NUMBER path after $__eq\'s is_nullish/string arms all miss and… actually resolves earlier in emit.js\'s static coercion (needsToNumberCoercion), not in $__eq itself for the fully-dynamic case; not independently re-verified here beyond typeof/Set-Map, noted as a boundary this table does not fully re-derive',
    interopDecode: 'mem.read: a===4 → false, a===5 → true',
    typeofArm: '"boolean" — $__typeof\'s FALSE_NAN/TRUE_NAN bit-pattern check (masks the TRUE/FALSE-distinguishing bit off, one compare for both)',
  },
  'ATOM.SYMBOL': {
    tag: PTR.ATOM, aux: 'any value outside {NULL,UNDEF,FALSE,TRUE} — a dynamically minted per-Symbol id',
    allocShape: 'immediate sentinel (tag=ATOM, aux=this symbol\'s id, offset=0) — Symbols never heap-allocate, the id IS the identity',
    childPointers: 'none',
    forwarding: 'n/a',
    identity: 'exact-bits (aux) identity — every Symbol() call mints a fresh, distinct aux id',
    interopDecode: 'NOT in mem.read\'s explicit atom check (a===1/2/4/5 only) — falls through to the generic `i32.eqz` symbol test only inside $__typeof, not interop; mem.read has no dedicated Symbol decode arm (falls to the default `i64ToF64(p)` reinterpret, same class of gap as CLOSURE/BIGINT — not runtime-probed here, out of this slice\'s headline)',
    typeofArm: '"symbol" — $__typeof\'s final `i32.eqz($t)` check (tag===ATOM and none of the four reserved aux ids matched above)',
  },
}

/**
 * Cross-consumer disagreements found while building the table above (Slice 1's
 * mandate: "report, don't pick a side silently"). Each entry names the
 * consumers in conflict and the live probe in test/layout-kinds.js that
 * reproduces it. None of these are NEW bugs introduced by this slice — they
 * are gaps already latent in module/core.js, module/collection.js, and
 * interop.js, now named in one place instead of being independently
 * rediscovered per audit.
 */
// RESOLVED (CARRIER PROGRAM Slice 3, .work/carrier-representation-design.md
// §7): the three BIGINT-only findings this table originally recorded here —
// 'typeof' ($__typeof gained a PTR.BIGINT tag arm), 'eq-identity' ($__eq/
// $__eq_strict/$__same_value_zero/$__map_hash gained content-compare/hash
// arms), 'interop-decode' (interop.js mem.read gained a t===5 arm) — are
// closed; each KIND_REGISTRY.BIGINT column above documents the landed arm in
// place of the old divergence writeup. 'region-forwarding' stays open below,
// narrowed: BIGINT's own gap (both __region_copy_rec and __sclone_rec now
// carry an explicit, individually-correct arm) is closed, but OBJECT/HASH/
// CLOSURE remain unrouted in __region_copy_rec — untouched by carrier
// boxing, the region program's own Slice 2 territory.
export const FINDINGS = [
  {
    id: 'region-forwarding',
    kinds: ['OBJECT', 'HASH', 'CLOSURE'],
    summary:
      'module/core.js\'s __region_copy_rec (the region-arena Cheney-copy tracer) has dispatch arms for ATOM/ ' +
      'STRING/ARRAY/SET/MAP/BIGINT only; OBJECT, HASH, CLOSURE, TYPED, BUFFER, and EXTERNAL still fall to a ' +
      'trailing `(unreachable)` trap, EXPLICITLY documented in-source as "out of Slice-1 scope" (the region ' +
      'program\'s own Slice 1, .work/research.md §Region arena — a DIFFERENT Slice 1 than this file\'s). Module/ ' +
      'collection.js\'s __sclone_rec (structuredClone) has real OBJECT/HASH arms already (via __obj_clone) but ' +
      'still has none for CLOSURE (throws DataCloneError instead, matching real JS) — the remaining live gap is ' +
      'OBJECT/HASH/CLOSURE inside __region_copy_rec specifically, region-program-scoped, not carrier-scoped.',
    consumers: [
      'module/core.js __region_copy_rec (traps: unreachable, for OBJECT/HASH/CLOSURE/TYPED/BUFFER/EXTERNAL)',
    ],
    probe: 'code-read only: unreachable from outside the self-host kernel\'s region rounds (the region program\'s own re-enable path, not yet live).',
  },
]
