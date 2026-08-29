/**
 * Data-segment tail lifecycle — a coarse, over-approximating inject decides
 * a table/span might be needed; these three phases reclaim what the FINAL,
 * exact reachability proves dead, and shift every static-data pointer once
 * the dead head is stripped.
 *
 * Split out of assemble.js (pipeline-minimality slice) — pure move, no
 * behavior change. See ../assemble.js for the stage contract and
 * `.work/archive/assemble-outliers.md` §4: none of the three calls another in this
 * file, but all three share the same `dataString`/`dataReset`/`dataAlign`/
 * `dataPush` substrate (../../static-data.js) and compile/index.js runs them
 * back-to-back (stripStaticDataPrefix, then optimizeModule, then
 * stripDeadLazyTables, then stripDeadInternedSpans).
 */

import { ctx, PTR, LAYOUT, declGlobal } from '../../ctx.js'
import { i64Hex } from '../../../layout.js'
import { dataAlign, dataPush, dataLen, dataString, dataReset } from '../../static-data.js'
import { walkAst } from '../../ast.js'

/**
 * Phase: strip the Eisel-Lemire table when it is dead.
 *
 * pullStdlib injects the ~2 KB power-of-10 table whenever `__dec_to_f64` is *reachable*,
 * but that over-counts: a dead inlined helper's `arr[i] | 0` on an untyped param pulls
 * `__to_num` → `__dec_to_f64`, so the table lands even in a module no live code parses
 * decimals in. watr later treeshakes the dead function + its `$__el_tbl` global, but it
 * does NOT treeshake the data segment — so the orphaned table bloated every module ~2 KB.
 *
 * This runs LAST (after every lowering has emitted its call/ref.func — doing it earlier is
 * unsound: refs like `util.clone` are emitted *after* pullStdlib), so a mark-sweep from the
 * real roots (inline-exported funcs, __start, the closure table, globals/tags/table) gives
 * EXACT liveness. If `__dec_to_f64` is dead, truncate the table from the data tail (it is
 * the last append — see pullStdlib). DATA only: the dead function + global are left for
 * watr, which already removes them. Keeps correctly-rounded decimal parsing wherever it is
 * genuinely live (parseFloat, the self-compile compiler's `Number()` on source literals).
 */
export function stripDeadLazyTables(sec) {
  const spans = ctx.runtime.lazySpans
  if (!spans || !spans.length) return
  const byName = new Map()
  for (const arr of [sec.funcs, sec.stdlib, sec.start])
    for (const f of arr || []) if (Array.isArray(f) && f[0] === 'func' && typeof f[1] === 'string') byName.set(f[1], f)
  const live = new Set(), work = []
  const mark = (ref) => { if (typeof ref === 'string' && byName.has(ref) && !live.has(ref)) { live.add(ref); work.push(ref) } }
  const scan = (n) => walkAst(n, { enter: x => {
    if ((x[0] === 'call' || x[0] === 'return_call' || x[0] === 'ref.func') && typeof x[1] === 'string') mark(x[1])
  } })
  for (const f of sec.funcs) if (f.some(el => Array.isArray(el) && el[0] === 'export')) mark(f[1])
  for (const f of sec.start) scan(f)
  for (const part of [sec.elem, sec.globals, sec.tags, sec.table]) for (const n of part || []) {
    if (!Array.isArray(n)) continue
    for (const c of n) { if (typeof c === 'string' && c[0] === '$') mark(c); else scan(c) }
  }
  while (work.length) scan(byName.get(work.pop()))
  if (spans.every(s => live.has(s.fn))) { ctx.runtime.lazySpans = ctx.memory.shared ? spans : [] ; return }
  // Rebuild the tail (the spans are the last data appends, in order): truncate
  // to the first span's pre-pad start, re-append live tables, re-point their
  // base globals — both the scope entry and the already-pushed sec.globals IR.
  const setInit = (name, off) => {
    const g = ctx.scope.globals.get(name)
    if (g) g.init = off
    for (const node of sec.globals) if (Array.isArray(node) && node[1] === '$' + name) {
      const c = node[node.length - 1]
      if (Array.isArray(c) && c[0] === 'i32.const') c[1] = off
    }
  }
  // spans[0].start is ALREADY the exact byte length of the kept prefix — it was
  // captured by injectTable's own `dataLen()` read at push time. dataReset's
  // SECOND arg passes that known-good number straight through
  // instead of re-deriving it from the freshly-sliced string's OWN `.length`:
  // observed unreliable under self-compile specifically here — a `.slice()`
  // result taken from this same large (thousands of bytes), binary-content,
  // heap-allocated compiler-internal string (`dataString()`, the accumulated
  // static-data segment) read back `.length === 0` while still testing
  // truthy (a genuine non-empty string), a self-hosted-only inconsistency
  // reproduced with debug instrumentation (kernel: dataLen collapsed to 0
  // pre-realign; native: correct). Root-caused to the length-recompute step,
  // not to the byte content itself — spans[0].start was bit-identical
  // native/kernel throughout. dataString()'s own second call inside dataReset
  // still re-derives the STRING (cheap: dataParts is already collapsed to one
  // element by the first call above), only the LENGTH re-derivation is
  // skipped now that the caller already has it.
  dataReset(dataString().slice(0, spans[0].start), spans[0].start)
  for (const s of spans) {
    if (!live.has(s.fn)) { setInit(s.global, 0); continue }
    dataAlign(8)
    setInit(s.global, dataLen())
    dataPush(s.bytes)
  }
  // Shared memory needs the survivor list after this pass — the start-time
  // rebase (compile/index.js) re-points each surviving table global.
  ctx.runtime.lazySpans = ctx.memory.shared ? spans.filter(s => live.has(s.fn)) : []
}

/**
 * Phase: reclaim data-segment bytes a COARSE, pre-treeshake step interned
 * speculatively — a schema minted (and its key strings materialized) the
 * moment an opaque dispatch site was VISITED during emission (module/core.js's
 * emitLengthAccess et al, before narrowing/devirtualization resolve the real
 * receiver type), or a stdlib thunk's own string constants realized merely to
 * discover its call graph (src/ctx.js's resolveIncludes autoDepsOf). Both are
 * sound at the point they run — the program COULD still reach that dispatch —
 * but optimizeModule/treeshake can later prove the specific call site (or the
 * whole helper) unreachable, same class of over-approximation
 * stripDeadLazyTables already closes for the EL/Ryū tables and the jz:schema/
 * jz:errcls custom-section reconciliation (src/compile/index.js) already
 * closes for the host-facing schema listing. This is the runtime-data-segment
 * analog for the string pool: `ctx.runtime.reclaimSpans` (populated by
 * buildStartFn's schema-table construction and by any stdlib thunk that
 * interns its own constants, e.g. module/core.js's __throw_property_nullish)
 * records the exact byte range each such interning owns.
 *
 * Unlike lazySpans, a reclaimSpans entry can be addressed either by a global
 * (the schema table, indirected through `__schema_tbl`) OR by literal
 * NaN-boxed bit patterns baked directly into ONE function's body (a thunk's
 * own strBits constants — nothing else can reference them, since nothing else
 * ever calls ctx.core.emit['str'] with that exact text from that exact
 * template). The second shape has no global to repoint if shifted, so —
 * unlike stripDeadLazyTables's rebuild-and-repoint — this pass ONLY ever
 * truncates a dead run off the ABSOLUTE TAIL, walking spans in reverse append
 * order and stopping at the first still-live (or non-contiguous) one. A live
 * span is therefore NEVER moved, so no reference — global-indirected or
 * literal-baked — can ever desync. The cost of that safety is precision: a
 * dead span buried before a live one is left as harmless residual weight
 * rather than reclaimed (same accepted trade stripDeadLazyTables documents
 * for shared memory). Must run in the same window as stripDeadLazyTables —
 * after optimizeModule (real reachability is final) and before the data
 * segment is serialized into sec.data.
 */
export function stripDeadInternedSpans(sec) {
  const spans = ctx.runtime.reclaimSpans
  if (!spans || !spans.length) return
  const byName = new Map()
  for (const arr of [sec.funcs, sec.stdlib, sec.start])
    for (const f of arr || []) if (Array.isArray(f) && f[0] === 'func' && typeof f[1] === 'string') byName.set(f[1], f)
  const live = new Set(), liveGlobals = new Set(), work = []
  const mark = (ref) => { if (typeof ref === 'string' && byName.has(ref) && !live.has(ref)) { live.add(ref); work.push(ref) } }
  const scan = (n) => walkAst(n, { enter: x => {
    if ((x[0] === 'call' || x[0] === 'return_call' || x[0] === 'ref.func') && typeof x[1] === 'string') mark(x[1])
    else if ((x[0] === 'global.get' || x[0] === 'global.set') && typeof x[1] === 'string') liveGlobals.add(x[1].slice(1))
  } })
  for (const f of sec.funcs) if (f.some(el => Array.isArray(el) && el[0] === 'export')) mark(f[1])
  // An inline-exported global (`declGlobal(name, ty, init, { export: '…' })`) is a
  // host-facing root exactly like an exported func — live with no in-wasm
  // reference at all, same rule optimize/index.js's dead-global elimination
  // uses. `__schema_tbl` itself never carries one today, but a `global`-keyed
  // reclaimSpans entry must hold for whatever future span also uses this shape.
  for (const n of sec.globals || [])
    if (Array.isArray(n) && n[0] === 'global' && typeof n[1] === 'string' &&
        n.some(c => Array.isArray(c) && c[0] === 'export')) liveGlobals.add(n[1].slice(1))
  for (const f of sec.start) scan(f)
  for (const part of [sec.elem, sec.globals, sec.tags, sec.table]) for (const n of part || []) {
    if (!Array.isArray(n)) continue
    for (const c of n) { if (typeof c === 'string' && c[0] === '$') mark(c); else scan(c) }
  }
  while (work.length) scan(byName.get(work.pop()))
  let cut = dataLen()
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]
    if (s.end !== cut) break   // not contiguous with the true tail — something else already lives past it
    if (s.fn ? live.has(s.fn) : liveGlobals.has(s.global)) break
    cut = s.start
  }
  if (cut < dataLen()) dataReset(dataString().slice(0, cut), cut)
  ctx.runtime.reclaimSpans = []
}

/**
 * Phase: strip static-data prefix.
 */
export function stripStaticDataPrefix(sec) {
  if (!ctx.runtime.staticDataLen || ctx.core.includes.has('__static_str')) return
  const prefix = ctx.runtime.staticDataLen
  const SHIFTABLE = new Set([PTR.STRING, PTR.OBJECT, PTR.ARRAY, PTR.HASH, PTR.SET, PTR.MAP, PTR.BUFFER, PTR.TYPED, PTR.CLOSURE])
  const data = dataString()
  const buf = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) buf[i] = data.charCodeAt(i)
  const dv = new DataView(buf.buffer)
  if (ctx.runtime.staticPtrSlots) {
    // u32-half reads/writes — DataView's BigInt accessors are unfaithful in the
    // self-compile kernel; the offset lives entirely in the LE low word and the
    // tag/aux fields entirely in the high word, so plain number math suffices.
    for (const slotOff of ctx.runtime.staticPtrSlots) {
      if (slotOff < prefix) continue
      const hi = dv.getUint32(slotOff + 4, true)
      if (((hi >>> 16) & 0xFFF8) !== LAYOUT.NAN_PREFIX) continue
      const ty = (hi >>> 15) & 15
      if (!SHIFTABLE.has(ty)) continue
      if (ty === PTR.STRING && ((hi >>> (LAYOUT.AUX_SHIFT - 32)) & LAYOUT.SSO_BIT)) continue
      const off = dv.getUint32(slotOff, true)
      if (off < prefix) continue
      dv.setUint32(slotOff, off - prefix, true)
    }
  }
  // The intern index (buildInternTable) stores raw static-string ptrs as u32
  // slots — shift each occupied slot like every other static reference, and
  // re-declare the (already-declared) base global at its post-strip position.
  if (ctx.runtime.internTable) {
    const { base, size } = ctx.runtime.internTable
    for (let i = 0; i < size; i++) {
      const slot = base + i * 8 + 4
      const off = dv.getUint32(slot, true)
      if (off >= prefix) dv.setUint32(slot, off - prefix, true)
    }
    ctx.runtime.internTable.base = base - prefix
    declGlobal('__internBase', 'i32', base - prefix, { mut: false })
  }
  // Raw-i32 globals whose INIT is a static-data offset (static schema table, …):
  // shift the declared init by the stripped prefix, like every boxed slot above.
  if (ctx.runtime.staticI32GlobalInits) for (const name of ctx.runtime.staticI32GlobalInits) {
    const g = ctx.scope.globals.get(name)
    if (g && typeof g.init === 'number' && g.init >= prefix) g.init -= prefix
  }
  // Lazy-table spans (EL/Ryū) sit at the data tail — keep their recorded starts
  // in post-strip coordinates so stripDeadLazyTables truncates at the right base.
  if (ctx.runtime.lazySpans) for (const s of ctx.runtime.lazySpans)
    if (s.start >= prefix) s.start -= prefix
  // reclaimSpans (buildStartFn's schema table, a stdlib thunk's own interned
  // constants) — same re-coordination, both edges: stripDeadInternedSpans'
  // contiguity check (`s.end !== cut`) needs `end` in the same post-strip
  // basis as `dataLen()`, not just `start`.
  if (ctx.runtime.reclaimSpans) for (const s of ctx.runtime.reclaimSpans) {
    if (s.start >= prefix) s.start -= prefix
    if (s.end >= prefix) s.end -= prefix
  }
  let s = ''
  for (let i = prefix; i < buf.length; i++) s += String.fromCharCode(buf[i])
  // Explicit length, same rationale as stripDeadLazyTables's own dataReset call
  // above: the caller already knows the exact byte count
  // (`buf.length - prefix`, arithmetic on a plain i32 loop bound) — pass it
  // through instead of re-trusting `s`'s own `.length` on this build-up path.
  dataReset(s, buf.length - prefix)
  if (ctx.runtime.staticPtrSlots) ctx.runtime.staticPtrSlots = ctx.runtime.staticPtrSlots
    .filter(o => o >= prefix).map(o => o - prefix)
  const shift = (node) => {
    if (!Array.isArray(node)) return
    for (let i = 0; i < node.length; i++) {
      const child = node[i]
      if (!Array.isArray(child)) continue
      // Each arm below pattern-matches CODE for "this literal is plausibly a
      // pointer INTO the static-data segment that just got truncated by
      // `prefix` bytes" — `>= prefix` alone is not proof: a real static-data
      // address is ALSO necessarily `< buf.length` (the segment's own
      // pre-strip size), since nothing can point past the data it addresses.
      // Without the upper bound, an ARBITRARY pointer-shaped literal with a
      // large offset that has NOTHING to do with static data (e.g. a user/
      // test program calling the `__mkptr` intrinsic directly with its own
      // literal offset, as `test/pointers.js`'s nan-box round-trip tests do)
      // false-positives once `prefix` is nonzero and gets its offset silently
      // shifted down by `prefix` — reachable only once eager stdlib loading
      // (front.js, region-arena builds) makes `ctx.runtime.staticDataLen`
      // reliably nonzero for programs that would otherwise need no static
      // data at all. Same bug class as every other "code path assumes
      // module-loaded implies feature-used" fix in this campaign, one level
      // down: here it's "offset >= prefix implies static-data pointer".
      if (child[0] === 'call' && child[1] === '$__mkptr' &&
        Array.isArray(child[2]) && SHIFTABLE.has(child[2][1]) &&
        Array.isArray(child[4]) && child[4][0] === 'i32.const' &&
        typeof child[4][1] === 'number' && child[4][1] >= prefix && child[4][1] < buf.length) {
        const isSsoString = child[2][1] === PTR.STRING &&
          Array.isArray(child[3]) && child[3][0] === 'i32.const' &&
          typeof child[3][1] === 'number' && (child[3][1] & LAYOUT.SSO_BIT)
        if (!isSsoString) child[4][1] -= prefix
      } else if (typeof child[0] === 'string' && child[0].endsWith('.store') &&
        Array.isArray(child[1]) && child[1][0] === 'i32.const' &&
        typeof child[1][1] === 'number' && child[1][1] >= prefix && child[1][1] < buf.length) {
        child[1][1] -= prefix
      } else if (child[0] === 'f64.const' &&
        typeof child[1] === 'string' && child[1].startsWith('nan:0x')) {
        // Computed fresh, local to this arm (not captured from an outer scope):
        // self-compile kernel-source rewrite (BigInt retirement Slice 0) — a BigInt
        // value crossing the `shift` closure boundary as a captured NAME can't
        // be proven raw by the self-compile kernel's own fixpoint; recomputing
        // from LAYOUT (never itself BigInt) inside the closure keeps every use
        // local-to-body, the shape the fixpoint already proves raw.
        const bits = BigInt(child[1].slice(4)) | 0x7FF0000000000000n
        if (((bits >> 48n) & 0xFFF8n) === BigInt(LAYOUT.NAN_PREFIX)) {
          const ty = Number((bits >> BigInt(LAYOUT.TAG_SHIFT)) & BigInt(LAYOUT.TAG_MASK))
          if (SHIFTABLE.has(ty) &&
              !(ty === PTR.STRING && ((bits >> BigInt(LAYOUT.AUX_SHIFT)) & BigInt(LAYOUT.SSO_BIT)))) {
            const off = Number(bits & BigInt(LAYOUT.OFFSET_MASK))
            if (off >= prefix && off < buf.length) {
              const hi = bits & ~BigInt(LAYOUT.OFFSET_MASK)
              const newBits = hi | BigInt(off - prefix)
              // i64Hex, not newBits.toString(16) — newBits keeps the SAME
              // NaN-prefix+tag high bits the `ty`/SHIFTABLE checks above just
              // proved box-tag-shaped (only the low OFFSET bits changed), the
              // exact self-host hazard fixed identically in ir.js/optimize's
              // toString(16) sites (fix/i64hex-hazards). i64Hex reaches the
              // hex digits via shift/and/Number, never a `.toString()` call.
              child[1] = 'nan:' + i64Hex(newBits)
            }
          }
        }
      }
      shift(child)
    }
  }
  for (const s of [...sec.funcs, ...sec.stdlib, ...sec.start]) shift(s)
}
