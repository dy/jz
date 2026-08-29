import { ctx, declGlobal } from '../ctx.js'
import { dataAlign, dataPush, dataLen } from '../static-data.js'

// Static-string intern index (the `internStrings` pass). Open-addressing table
// over the deduped static string literals (5–32 bytes): [hash u32][ptr u32]
// pairs appended to the data segment, FNV-1a matching __str_hash's heap branch.
// __str_slice/__str_slice_view probe it so a runtime substring whose content
// equals any source literal returns the CANONICAL static pointer — string
// equality then short-circuits on bit-eq instead of walking bytes (a compiler
// or parser compares each token against tag literals many times; ~25% of
// self-compile compile time was __str_eq/__eq/__str_hash volume). Built before
// pullStdlib (the slice thunks emit the probe only when `__internBase` exists);
// stripStaticDataPrefix shifts the stored ptr slots like every other static
// reference. Misses cost one FNV + one probe per slice; the table is read-only.
export function buildInternTable() {
  const cfg = ctx.transform.optimize
  if (!cfg || cfg.internStrings === false) return
  if (ctx.memory.shared || !ctx.runtime.dataDedup?.size) return
  const enc = new TextEncoder()
  const entries = []
  // buildStartFn's schema-table construction (the only reclaimSpans producer that
  // can have already run by this point — __throw_property_nullish/__err_prop's
  // spans are pushed later, inside pullStdlib, well after this function returns)
  // may have interned strings that stripDeadInternedSpans later truncates off the
  // data-segment tail once real reachability is known. This probe table is raw
  // bytes baked straight into the data segment — there is no going back to edit a
  // slot out of it once written — so a reclaimable string must never earn one: a
  // stale slot's candidate offset would sit past the (now correspondingly
  // shrunk) memory bound, and the in-wasm probe (module/string.js's
  // internProbeWat) reads the candidate's length header before it ever compares
  // bytes, so a hash COLLISION alone — no matching runtime string required —
  // would be a genuine out-of-bounds trap, not just a wasted probe.
  const inReclaimSpan = (off) => (ctx.runtime.reclaimSpans || []).some(s => off >= s.start && off < s.end)
  for (const [str, off] of ctx.runtime.dataDedup) {
    if (inReclaimSpan(off)) continue
    const b = enc.encode(str)
    if (b.length < 5 || b.length > 32) continue
    let h = 0x811c9dc5 | 0
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i], 0x01000193) | 0
    if (h <= 1) h = (h + 2) | 0   // mirror __str_hash's empty/tombstone clamp
    entries.push([h >>> 0, off + 8])
  }
  if (!entries.length) return
  let size = 4
  while (size < entries.length * 2) size = (size * 2) | 0
  const mask = size - 1
  const slots = new Uint32Array(size * 2)
  for (let e = 0; e < entries.length; e++) {
    const h = entries[e][0], off = entries[e][1]
    let i = h & mask
    while (slots[i * 2 + 1] !== 0) i = (i + 1) & mask
    slots[i * 2] = h
    slots[i * 2 + 1] = off
  }
  dataAlign(8)
  const base = dataLen()
  // Parts-array + single join, NOT `s += chunk`: a member-free `+=` still
  // fresh-copies the whole accumulated string per iteration in the kernel
  // (no rope strings), and `slots.length` runs into the tens of thousands on
  // a self-compile — measured 207.6 MB / 39,216 $__str_concat_raw calls of
  // Window-A churn (.work/evidence.md §elephant attribution). Same
  // remediation class as the ctx.runtime.data parts-array and the dedup
  // rolling-hash fixes.
  const parts = []
  for (let i = 0; i < slots.length; i++) {
    const v = slots[i]
    parts.push(String.fromCharCode(v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF))
  }
  dataPush(parts.join(''))
  ctx.runtime.internTable = { base, size }
  declGlobal('__internBase', 'i32', base, { mut: false })
  declGlobal('__internMask', 'i32', mask, { mut: false })
}
