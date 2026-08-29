#!/usr/bin/env node
// Frontier-trace breadcrumb splice — mirrors fa9fcc1a's own WAT-level method
// (module/core.js's region-arena intrinsics are edited post-build, in the
// decompiled WAT, never in JS source — JS-source edits in region code have
// historically heisenbugged per that session's own notes).
//
// Anchors verified against their EXACT expected original text before any
// mutation; edits applied bottom-to-top (descending line number, in EXECUTION
// order) so earlier-executed edits never shift the line numbers used by
// later-executed ones — same discipline fa9fcc1a's own script used.
import { readFileSync, writeFileSync } from 'fs'

const IN = '/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/frontier2/kernel.wat'
const OUT = '/private/tmp/claude-501/-Users-div-projects-jz/0482f00a-7cbc-475b-939a-b25b5ba26704/scratchpad/frontier2/kernel-instrumented.wat'

const src = readFileSync(IN, 'utf8')
const lines = src.split('\n')
// lines[i] corresponds to file line i+1 (1-based)

function expect(lineNo, text) {
  const got = lines[lineNo - 1]
  if (got !== text) {
    console.error(`ANCHOR MISMATCH at line ${lineNo}`)
    console.error('expected:', JSON.stringify(text))
    console.error('got     :', JSON.stringify(got))
    process.exit(1)
  }
}
function replaceLines(from, to, newLines) {
  lines.splice(from - 1, to - from + 1, ...newLines)
}
function insertAfter(lineNo, newLines) {
  lines.splice(lineNo, 0, ...newLines)
}

// log-event helper: writes (tag:i64, valueI64) at [$LOGCUR], [$LOGCUR+8],
// advances $LOGCUR by 16. Global 906 = $LOGCUR (i32). Self-contained,
// net-zero stack effect — safe to splice anywhere the stack is empty (or
// leaves an untouched value below it).
const logTagVal = (tag, valuePushExpr, indent = '    ') => [
  `${indent}global.get 906`,
  `${indent}i64.const ${tag}`,
  `${indent}i64.store`,
  `${indent}global.get 906`,
  `${indent}i32.const 8`,
  `${indent}i32.add`,
  ...valuePushExpr.map((l) => `${indent}${l}`),
  `${indent}i64.store`,
  `${indent}global.get 906`,
  `${indent}i32.const 16`,
  `${indent}i32.add`,
  `${indent}global.set 906`,
]

// ─── Edit 1 (highest line, execute first): export the new globals for post-trap reads ──
expect(4615073, '  (export "_clear" (func $_clear$exp))')
insertAfter(4615073, [
  '  (export "__dbg_logcur" (global 906))',
  '  (export "__dbg_sm_entered" (global 907))',
  '  (export "__dbg_sm_patched" (global 908))',
  '  (export "__dbg_sm_rebuilt" (global 909))',
  '  (export "__dbg_afe_calls" (global 910))',
])

// ─── Edit 2: append 5 new debug globals (906..910) ──
expect(4615060, '  (global (;905;) (mut i64) (i64.const 0))')
insertAfter(4615060, [
  '  (global (;906;) (mut i32) (i32.const 1325000))',
  '  (global (;907;) (mut i64) (i64.const 0))',
  '  (global (;908;) (mut i64) (i64.const 0))',
  '  (global (;909;) (mut i64) (i64.const 0))',
  '  (global (;910;) (mut i64) (i64.const 0))',
])

// ─── Edit 3/4: shift the shared __heap/__heap_reset init constant to free a
// 64 KiB scratch region [1325000, 1390536) for the event log — same technique
// fa9fcc1a used (nothing below __heap is ever touched by the bump allocator,
// confirmed directly against $__alloc's own bounds logic above). ──
expect(4614160, '  (global (;5;) (mut i32) (i32.const 1325000))')
replaceLines(4614160, 4614160, ['  (global (;5;) (mut i32) (i32.const 1390536))'])
expect(4614159, '  (global (;4;) (mut i32) (i32.const 1325000))')
replaceLines(4614159, 4614159, ['  (global (;4;) (mut i32) (i32.const 1390536))'])

// ─── Edit 5: $__region_exit tail — EXIT_FLOOR log + setmap cumulative snapshot ──
expect(1312027, '    global.get 4')
expect(1312028, '    local.get 3')
expect(1312029, '    i32.sub')
expect(1312030, '    local.set 7')
expect(1312031, '    local.get 2')
expect(1312032, '    local.get 3')
expect(1312033, '    local.get 7')
expect(1312034, '    memory.copy')
expect(1312035, '    local.get 2')
expect(1312036, '    local.get 7')
expect(1312037, '    i32.add')
expect(1312038, '    global.set 4')
expect(1312039, '    local.get 6)')
replaceLines(1312027, 1312039, [
  '    global.get 4',
  '    local.get 3',
  '    i32.sub',
  '    local.set 7',
  '    local.get 2',
  '    local.get 3',
  '    local.get 7',
  '    memory.copy',
  '    local.get 2',
  '    local.get 7',
  '    i32.add',
  '    global.set 4',
  ...logTagVal(4, ['global.get 4', 'i64.extend_i32_u']),
  ...logTagVal(5, ['global.get 907']),
  ...logTagVal(6, ['global.get 908']),
  ...logTagVal(7, ['global.get 909']),
  '    local.get 6)',
])

// ─── Edit 6: $__region_exit skip branch — SKIP log (16 MiB exit-skip fired) ──
expect(1311877, '    if  ;; label = @1')
expect(1311878, '      local.get 1')
expect(1311879, '      return')
expect(1311880, '    end')
replaceLines(1311877, 1311880, [
  '    if  ;; label = @1',
  ...logTagVal(3, ['local.get 17', 'i64.extend_i32_u'], '      '),
  '      local.get 1',
  '      return',
  '    end',
])

// ─── Edit 7: $__region_exit entry — EXIT_ENTRY (peak) log, +1 scratch local ──
expect(1311867, '  (func $__region_exit (type 20) (param f64 f64) (result f64)')
expect(1311868, '    (local i32 i32 i32 i64 f64 i32 i64 i32 i32 i32 f64 i32 i32 i32 i32)')
expect(1311869, '    local.get 0')
expect(1311870, '    i32.trunc_f64_u')
expect(1311871, '    local.set 2')
replaceLines(1311867, 1311871, [
  '  (func $__region_exit (type 20) (param f64 f64) (result f64)',
  '    (local i32 i32 i32 i64 f64 i32 i64 i32 i32 i32 f64 i32 i32 i32 i32 i32)',
  '    global.get 4',
  '    local.set 17',
  ...logTagVal(2, ['local.get 17', 'i64.extend_i32_u']),
  '    local.get 0',
  '    i32.trunc_f64_u',
  '    local.set 2',
])

// ─── Edit 8: $__region_mark — MARK log ──
expect(1311864, '  (func $__region_mark (type 31) (result f64)')
expect(1311865, '    global.get 4')
expect(1311866, '    f64.convert_i32_u)')
replaceLines(1311864, 1311866, [
  '  (func $__region_mark (type 31) (result f64)',
  '    (local i32)',
  '    global.get 4',
  '    local.set 0',
  ...logTagVal(1, ['local.get 0', 'i64.extend_i32_u']),
  '    local.get 0',
  '    f64.convert_i32_u)',
])

// ─── Edit 9: AFE-batch call counter, analyzeFuncForEmit entry ──
expect(1247278, '    (local f64 f64 f64 f64 f64 f64 f64 f64 f64 i32 i32 f64 f64 f64 f64 f64 f64 i32 f64 f64 f64 i32 i32 f64 f64 f64 f64 i32 i32 f64 f64 f64 f64 f64 i32 i32 f64 f64 i32 i32 f64 f64 i32 f64 i32 i32 f64 f64 f64 i32 f64 f64 i32 i32 f64 i32 f64 i32 i32 f64 f64 i32 i32 i32 f64 i32 i32 f64 f64 i32 i32 f64 f64 f64 f64 f64 f64 i32 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 i32 f64 f64 i32 i32 i32 i32 f64 f64 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 f64 f64 f64 f64 f64 i32 f64 f64 f64 f64 i64 f64 f64 f64 i32 f64 i32 f64 f64 f64 f64 i64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 i32 f64 f64 f64 f64 f64 f64 f64 f64 i32 f64 f64 i32 f64 i32 f64 f64 i32 f64 f64 f64 i32 i32 i32 i32 i32 f64 f64 f64 i32 i32 f64 f64 f64 i32 i32 i32 i32 i32 f64 f64 i32 f64 i32 f64 i32 f64 i32 f64 i32 f64 i32 f64 i32 f64 f64 f64 f64 f64 f64 f64 f64 f64 i32 f64 i32 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 i32 f64 f64 i32 f64 f64 f64 f64 f64 i64 i32 f64 f64 f64 f64 f64 i32 f64 i32 i32 f64 f64 f64 f64 i32 f64 f64 f64 f64 f64 i32 i32 i32 i32 f64 f64 f64 i32 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 f64 f64 f64 f64 f64 i64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 i32 f64 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 f64 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 f64 i32 i32 f64 f64 f64 f64 i32 i32 i32 i32 i32 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 f64 i32 i32 i32 i32 f64 f64 f64 f64 f64 i32 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 f64 f64 f64 f64 f64 f64 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 f64 i32 i32 f64 f64 i32 i32 i32 f64 f64 f64 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 i32 i32 i32 i32 i32 i32 i32 f64 f64 f64 i32 f64 f64 f64 i32 i32 f64 i32 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 f64 f64 f64 f64 f64 f64 f64 f64 i32 f64 f64 f64 f64 i32 i32 f64 i32 f64 i32 f64 f64 i32 f64 f64 f64 i32 i32 f64 i32 f64 i32 i32 f64 i32 i32 f64 f64 f64 i32 i32 f64 i32 f64 i32 f64 i32 f64 i32 f64 f64 f64 i32 i32 i32 f64 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 f64 f64 i32 i32 i32 f64 f64 i32 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 f64 i32 i32 i32 f64 f64 i32 f64 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 i32 f64 i32 f64)')
insertAfter(1247278, [
  '    global.get 910',
  '    i64.const 1',
  '    i64.add',
  '    global.set 910',
])

// ─── Edit 10: setmap REBUILT counter (before the shared __coll_order+reinsert rebuild call) ──
expect(99251, '      local.get 16')
expect(99252, '      call $__coll_order')
insertAfter(99251, [
  '      global.get 909',
  '      i64.const 1',
  '      i64.add',
  '      global.set 909',
])

// ─── Edit 11: setmap DURABLE-PATCHED counter (value-patch fast path, before its own early return) ──
expect(99217, '          end')
expect(99218, '          local.get 9')
expect(99219, '          return')
insertAfter(99217, [
  '          global.get 908',
  '          i64.const 1',
  '          i64.add',
  '          global.set 908',
])

// ─── Edit 12 (lowest line, execute last): setmap DURABLE-ENTERED counter ──
// after regionArmSetMap's durable stability-scan init ($stable=1;$i=0)
expect(99088, '        i32.const 1')
expect(99089, '        local.set 27')
expect(99090, '        i32.const 0')
expect(99091, '        local.set 12')
insertAfter(99091, [
  '        global.get 907',
  '        i64.const 1',
  '        i64.add',
  '        global.set 907',
])

writeFileSync(OUT, lines.join('\n'))
console.log('wrote', OUT, lines.length, 'lines')
