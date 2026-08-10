#!/usr/bin/env node
// trace-inject.mjs — inject host-import `dbg.trace(tag, value)` calls into a WAT
// module's text at hand-identified points, without re-parsing the whole
// (potentially multi-hundred-MB) module: each NAMED function's own body is
// sliced out by line range, parsed via watr/parse, tee-wrapped around chosen
// subexpressions into fresh debug locals, re-printed via watr/print, and all
// edited regions are spliced back into the full text in one pass. A tiny
// top-level `(import "dbg" "trace" ...)` line is prepended once.
//
// Built for .work/carrier-representation-design.md §28→§29: the carrier
// kernel's `NULL_NAN`/`UNDEF_NAN`/`FALSE_NAN`/`TRUE_NAN` globals — each
// `atomNanHex(id)` tail-called into `i64Hex(bits)` — bake WRONG string
// content for the first two of every four back-to-back `$__start`
// invocations (ids 1/2) while the last two (ids 4/5) come out right, a
// kernel-scale, non-reproducible-in-isolation wall (§24-§28, all of which
// suspected `atomNanHex`'s own `LAYOUT.NAN_PREFIX_BITS` schema-slot deref).
// This script's FIRST pass instruments `atomNanHex` itself the way §24-§28
// framed the wall — and DISPROVES that framing: every one of atomNanHex's
// own 7 real invocations (this build has 2 independent call sites, not the
// 4 the prior framing led with) returns the mathematically correct raw i64
// bits, on every call, including ids 1/2. The SECOND pass instruments
// `i64Hex` — the tail-call target that actually turns those bits into the
// hex-string object baked into the global — which is where the real
// address-0-shaped misread lives (see the ledger's own §29 for the finding).
//
// The TRANSFORMS below are specific to each function's own compiled shape
// (node indices are asserted, not searched generically; the script THROWS
// if a shape doesn't match — a shape change in the compiler is a loud
// failure here, not a silent wrong trace). The SPLICING mechanics (slice N
// named functions' line ranges out of a huge WAT file, transform each in
// isolation, put them all back in one pass) are the reusable part for the
// next kernel-scale wall this chain hits.
//
// Usage: node scripts/trace-inject.mjs <in.wat> <out.wat>
import { readFileSync, writeFileSync } from 'node:fs'
import parseWat from 'watr/parse'
import print from 'watr/print'

const [, , inPath, outPath] = process.argv
if (!inPath || !outPath) { console.error('usage: trace-inject.mjs <in.wat> <out.wat>'); process.exit(1) }

const text = readFileSync(inPath, 'utf8')
const lines = text.split('\n')

// jz's own compiler-generated locals carry a U+E000 PUA marker in their name
// (src/ast.js's own `T` constant, src/front.js's own doc comment: "jz uses it
// for generated locals") — printers/terminals show it as nothing (no glyph),
// so two visually-identical names can be genuinely different idents. Strip it
// when COMPARING (structural asserts); never hand-type a bare name to
// REFERENCE an existing local — always reuse the exact string captured off
// the AST, or watr's assembler fails late with "Unknown local $x".
const bare = (s) => typeof s === 'string' ? s.replace(//g, '') : s

// ── locate a function's [startLine, endLine] (0-indexed, inclusive) by name ─
function findFunc(name) {
  const startLine = lines.findIndex(l => l.includes(`(func ${name}`))
  if (startLine < 0) throw new Error(`${name} not found`)
  let depth = 0, endLine = -1
  for (let i = startLine; i < lines.length; i++) {
    for (const ch of lines[i]) { if (ch === '(') depth++; else if (ch === ')') depth-- }
    if (i > startLine && depth <= 0) { endLine = i; break }
  }
  if (endLine < 0) throw new Error(`${name} body never closes`)
  return [startLine, endLine]
}

// parse a function's own line-range slice (wrapped in a throwaway module) and
// return its func AST node, ready for in-place mutation.
function parseFunc(startLine, endLine) {
  const slice = lines.slice(startLine, endLine + 1).join('\n')
  const wrapped = parseWat('(module\n' + slice + '\n)')
  return wrapped[1]
}

// index of the func node's first BODY instruction — i.e. right after its own
// param/result/local declarations. WASM requires every `(local ...)` decl to
// precede all instructions, so newly-added debug locals MUST be spliced in
// here, never at the tail (splicing new locals in front of just the LAST
// instruction is only safe when the whole body IS that one instruction,
// which silently worked for `atomNanHex` — one `return_call` — and just as
// silently corrupted `i64Hex` — many instructions — until this existed).
function firstBodyIdx(funcNode) {
  for (let i = 2; i < funcNode.length; i++) {
    const tag = funcNode[i][0]
    if (tag !== 'param' && tag !== 'result' && tag !== 'local') return i
  }
  throw new Error('func has no body instructions')
}

// re-print a mutated func AST node back to WAT text (module wrapper stripped).
function printFunc(funcNode) {
  const printedModule = print(['module', funcNode])
  const firstNl = printedModule.indexOf('\n')
  const lastParen = printedModule.lastIndexOf(')')
  return printedModule.slice(firstNl + 1, lastParen).replace(/\n$/, '')
}

const trace = (tag, valueNode) => ['call', '$dbgtrace', ['i64.const', String(tag)], valueNode]
const i64ext = (name) => ['i64.extend_i32_u', ['local.get', name]]
const i64rf = (name) => ['i64.reinterpret_f64', ['local.get', name]]

const regions = [] // { startLine, endLine, text } — sorted by startLine before splicing

// ═══ 1. atomNanHex — call-boundary + LAYOUT-deref instrumentation ══════════
{
  const FUNC_NAME = '$m61_layout$atomNanHex'
  const [funcStartLine, funcEndLine] = findFunc(FUNC_NAME)
  const funcNode = parseFunc(funcStartLine, funcEndLine)
  if (funcNode[0] !== 'func' || funcNode[1] !== FUNC_NAME) throw new Error('unexpected func node shape')

  const rcIdx = funcNode.length - 1
  const rc = funcNode[rcIdx]
  if (rc[0] !== 'return_call') throw new Error(`expected return_call as atomNanHex's sole body instruction, got ${rc[0]}`)
  const calleeName = rc[1]
  const ifNode = rc[2]
  if (ifNode[0] !== 'if') throw new Error('expected the return_call argument to be an if-expression')

  const orNode = ifNode[2]
  const eq1 = orNode[1]
  const outerTee = eq1[1][1]
  if (outerTee[0] !== 'local.tee' || bare(outerTee[1]) !== '$mbig0') throw new Error('outer $mbig0 tee not where expected')
  const combinedOr = outerTee[2][1]
  const tagIf = combinedOr[1]
  if (tagIf[0] !== 'if') throw new Error('tag-check if not where expected')

  const cond = tagIf[2]              // (i32.eq (i32.and (i32.wrap_i64 (i64.shr_u ... 47)) 15) 5)
  const andNode = cond[1]
  const wrapI64Node = andNode[1]
  const shrNode = wrapI64Node[1]
  const reinterpretNode = shrNode[1]
  const innerTee = reinterpretNode[1]
  if (innerTee[0] !== 'local.tee' || bare(innerTee[1]) !== '$mbig0') throw new Error('inner $mbig0 tee not where expected')
  const f64loadNode = innerTee[2]
  if (f64loadNode[0] !== 'f64.load') throw new Error('LAYOUT.NAN_PREFIX_BITS f64.load not where expected')
  const layoutBaseNode = f64loadNode[2]

  const thenC = tagIf[3]             // (then (i64.load (block (result i32) ...)))
  const iloadNode = thenC[1]
  if (iloadNode[0] !== 'i64.load') throw new Error('deref i64.load not where expected')
  const blockNode = iloadNode[1]

  const elseC = tagIf[4]             // (else (i64.reinterpret_f64 (local.get $mbig0)))
  const elseValNode = elseC[1]

  f64loadNode[2] = ['local.tee', '$dbgLayoutBase', layoutBaseNode]
  shrNode[1] = ['local.tee', '$dbgRawField', reinterpretNode]
  cond[1] = ['local.tee', '$dbgTag', andNode]
  iloadNode[1] = ['local.tee', '$dbgAddr', blockNode]
  thenC[1] = ['local.tee', '$dbgLoaded', iloadNode]
  elseC[1] = ['local.tee', '$dbgElseVal', elseValNode]

  const newLocals = [
    ['local', '$dbgLayoutBase', 'i32'], ['local', '$dbgRawField', 'i64'], ['local', '$dbgTag', 'i32'],
    ['local', '$dbgAddr', 'i32'], ['local', '$dbgLoaded', 'i64'], ['local', '$dbgElseVal', 'i64'], ['local', '$dbgResult', 'f64'],
  ]
  const newBody = [
    // captured FIRST, before anything else runs: the else-branch of the OUTER
    // if (box-store path) reuses $atomId itself as scratch, so it must be
    // read before the big if-expression below ever evaluates.
    trace(1, i64ext('$atomId')),
    ['local.set', '$dbgResult', ifNode],
    trace(10, i64ext('$dbgLayoutBase')),
    trace(11, ['local.get', '$dbgRawField']),
    trace(12, i64ext('$dbgTag')),
    trace(13, i64ext('$dbgAddr')),
    trace(14, ['local.get', '$dbgLoaded']),
    trace(15, ['local.get', '$dbgElseVal']),
    // must reuse the REAL (possibly U+E000-marked) name captured from the
    // AST, not a hand-typed '$mbig0' literal (see the `bare` doc comment).
    trace(16, i64rf(outerTee[1])),
    trace(17, i64rf('$dbgResult')),
    ['return_call', calleeName, ['local.get', '$dbgResult']],
  ]
  funcNode.splice(rcIdx, 1, ...newBody)          // replace the tail instruction first (rcIdx unaffected by this)
  funcNode.splice(firstBodyIdx(funcNode), 0, ...newLocals)  // then insert locals BEFORE the first instruction
  regions.push({ startLine: funcStartLine, endLine: funcEndLine, text: printFunc(funcNode) })
}

// ═══ 2. i64Hex — the ACTUAL hex-string-building i64.load(s) ════════════════
// atomNanHex's own return value is proven correct (pass 1, above) — i64Hex is
// where NULL_NAN/UNDEF_NAN's baked global content goes wrong. Its `$bits`
// param is expected to be a boxed BIGINT pointer (low 32 bits = heap address
// of the raw 8-byte payload); it unconditionally treats "$__poff0" as that
// address and `i64.load`s it TWICE (once shifted >>32 for the high hex
// digits, once masked for the low hex digits — both reads share the SAME
// address, read once each). If `$bits` is instead a RAW, unboxed sentinel
// (atomNanHex's own carrier-only "return raw, don't box" special case for
// NULL_NAN/UNDEF_NAN, §28 item 5) its own low 32 bits get treated as a
// memory address anyway — the suspected mechanism this pass is built to
// confirm or refute with real numbers.
{
  const FUNC_NAME = '$m61_layout$i64Hex'
  const [funcStartLine, funcEndLine] = findFunc(FUNC_NAME)
  const funcNode = parseFunc(funcStartLine, funcEndLine)
  if (funcNode[0] !== 'func' || funcNode[1] !== FUNC_NAME) throw new Error('unexpected func node shape')
  if (funcNode[2][0] !== 'param' || funcNode[2][1] !== '$bits') throw new Error('$bits param not where expected')

  const firstPoff = funcNode[10]     // (local.set $__poff0 (i32.wrap_i64 (i64.and (i64.reinterpret_f64 $bits) 0xFFFFFFFF)))
  if (firstPoff[0] !== 'local.set' || bare(firstPoff[1]) !== '$__poff0') throw new Error('initial $__poff0 set not where expected')

  const store1 = funcNode[11]
  if (store1[0] !== 'i32.store') throw new Error('alloc/store not where expected')
  const teeCo2 = store1[1]
  const allocCall = teeCo2[2]
  const addOuterPlus2 = allocCall[2]
  const addOuter = addOuterPlus2[1]
  const addInner = addOuter[2]

  const teeCl0 = addInner[1]         // high-32 half
  const strByteLen1 = teeCl0[2]
  const teeBshift = strByteLen1[2]
  const reinterp1 = teeBshift[2]
  const hx8call1 = reinterp1[1]
  const f64convert1 = hx8call1[2]
  const andExpr1 = f64convert1[1]
  const shrExpr1 = andExpr1[1]
  const iload1 = shrExpr1[1]
  if (iload1[0] !== 'i64.load') throw new Error('high-32 i64.load not where expected')
  const teePoff1 = iload1[1]
  if (teePoff1[0] !== 'local.tee' || bare(teePoff1[1]) !== '$__poff0') throw new Error('high-32 address tee not where expected')
  const ifNode1 = teePoff1[2]        // the tag-check/forwarding-resolve dispatch — same shape as atomNanHex's own
  if (ifNode1[0] !== 'if') throw new Error('tag-check if not where expected in i64Hex')
  const fwdCond = ifNode1[2]         // (i32.and (i32.shl 1 tagNibble) 898) — index 2: ['if', ['result',T], cond, then, else]
  const tagNibbleNode = fwdCond[1][2]

  const teeCl0Second = addInner[2]   // low-32 half
  const strByteLen2 = teeCl0Second[2]
  const teeCc6 = strByteLen2[2]
  const reinterp2 = teeCc6[2]
  const hx8call2 = reinterp2[1]
  const f64convert2 = hx8call2[2]
  const andExpr2 = f64convert2[1]
  const iload2 = andExpr2[1]
  if (iload2[0] !== 'i64.load') throw new Error('low-32 i64.load not where expected')
  const poffGet2 = iload2[1]
  if (poffGet2[0] !== 'local.get' || bare(poffGet2[1]) !== '$__poff0') throw new Error('low-32 address read not where expected')

  // tee-wrap every traced point in place (mutate parent slot, values unchanged)
  fwdCond[1][2] = ['local.tee', '$dbgTagNibble', tagNibbleNode]
  ifNode1[2] = ['local.tee', '$dbgFwdMask', fwdCond]
  iload1[1] = ['local.tee', '$dbgAddrHi', teePoff1]
  shrExpr1[1] = ['local.tee', '$dbgLoadedHi', iload1]   // wrap iload1 itself at its parent slot to capture the LOADED value
  iload2[1] = ['local.tee', '$dbgAddrLo', poffGet2]
  andExpr2[1] = ['local.tee', '$dbgLoadedLo', iload2]   // wrap iload2 itself at its parent slot

  // restructure the tail call so trailing traces can read the captured locals
  const rcIdx = funcNode.length - 1
  const rc = funcNode[rcIdx]
  if (rc[0] !== 'return_call') throw new Error('expected return_call as i64Hex\'s final instruction')
  const calleeName = rc[1]
  const argNode = rc[2]

  const newLocals = [
    ['local', '$dbgTagNibble', 'i32'], ['local', '$dbgFwdMask', 'i32'],
    ['local', '$dbgAddrHi', 'i32'], ['local', '$dbgLoadedHi', 'i64'],
    ['local', '$dbgAddrLo', 'i32'], ['local', '$dbgLoadedLo', 'i64'],
    ['local', '$dbgResult2', 'f64'],
  ]
  const newBody = [
    trace(20, i64rf('$bits')),
    trace(21, i64ext(firstPoff[1])),     // initial $__poff0 = low32(bits), BEFORE the tag-check may overwrite it
    ['local.set', '$dbgResult2', argNode],
    trace(22, i64ext('$dbgTagNibble')),
    trace(23, i64ext('$dbgFwdMask')),
    trace(24, i64ext('$dbgAddrHi')),
    trace(25, ['local.get', '$dbgLoadedHi']),
    trace(26, i64ext('$dbgAddrLo')),
    trace(27, ['local.get', '$dbgLoadedLo']),
    trace(28, i64rf('$dbgResult2')),
    ['return_call', calleeName, ['local.get', '$dbgResult2']],
  ]
  funcNode.splice(rcIdx, 1, ...newBody)
  funcNode.splice(firstBodyIdx(funcNode), 0, ...newLocals)
  regions.push({ startLine: funcStartLine, endLine: funcEndLine, text: printFunc(funcNode) })
}

// ═══ 3. $__start — call-boundary traces before every atomNanHex call site ══
{
  const [startStartLine, startEndLine] = findFunc('$__start')
  const startSlice = lines.slice(startStartLine, startEndLine + 1).join('\n')
  const callPattern = /\(call \$m61_layout\$atomNanHex \(i32\.const (\d+)\)\)/g
  let seq = 0
  const newStartSlice = startSlice.replace(callPattern, (m) => {
    seq++
    return `(call $dbgtrace (i64.const 0) (i64.const ${seq}))\n      ${m}`
  })
  if (seq < 4) throw new Error(`expected at least 4 atomNanHex call sites inside $__start, found ${seq}`)
  console.error(`found ${seq} atomNanHex call sites inside $__start (task's own framing named 4 — a second, independent module also calls it; tracing all of them)`)
  regions.push({ startLine: startStartLine, endLine: startEndLine, text: newStartSlice })
}

// ── splice every region back into the full file in one pass, then prepend the dbg import ─
regions.sort((a, b) => a.startLine - b.startLine)
for (let i = 1; i < regions.length; i++) {
  if (regions[i].startLine <= regions[i - 1].endLine) throw new Error('overlapping regions — cannot splice')
}
// NOTE: push(...hugeArray) blows the call stack at this scale (millions of
// lines) — concat() merges without spreading into arguments.
let parts = []
let cursor = 0
for (const r of regions) {
  parts = parts.concat(lines.slice(cursor, r.startLine), [r.text])
  cursor = r.endLine + 1
}
parts = parts.concat(lines.slice(cursor))
const out = parts.join('\n')

const DBG_IMPORT = '  (import "dbg" "trace" (func $dbgtrace (param i64 i64)))'
const firstNlOut = out.indexOf('\n')
const final = out.slice(0, firstNlOut + 1) + DBG_IMPORT + '\n' + out.slice(firstNlOut + 1)

writeFileSync(outPath, final)
console.error(`wrote ${outPath} (${(final.length / 1024 / 1024).toFixed(1)} MB), ${regions.length} regions instrumented`)
