// vm.js — a tiny bytecode interpreter: a fetch-decode-dispatch loop over a fixed
// register program that runs an integer mixing recurrence for many steps. The
// canonical interpreter kernel (the inner loop of every VM, regex engine, and
// scripting runtime): a hot dispatch chain over an opcode plus indirect operand
// fetches from a code array. It stresses branch-chain dispatch and dependent
// loads — a control-flow profile no other case in the suite covers. Pure 32-bit
// integer, so the program output is bit-identical across every engine and native
// target.
//
// Single source compiled by all targets (jz, porffor, jawsm) and run directly by
// the JS engines. Subset: const/let + arrows, Int32Array, Math.imul, if/else
// dispatch (no switch), no class/async/regex.
//
// Reports: median ms across N_RUNS, throughput in steps/µs, FNV-1a checksum over
// the per-iteration program results.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

// Opcodes: LOADI=0, MULI=1, ADDI=2, XORSHR=3, DEC=4, JNZ=5, HALT=6. Each
// instruction is three i32 cells: [op, a, b] (a=register, b=immediate/target).
const STEPS = 1 << 14        // inner loop trip count baked into the program
const NINSTR = 8             // instructions in the program
const N_ITERS = 64           // program runs per kernel pass
const N_RUNS = 21
const N_WARMUP = 5

// The program: r0 = seed; repeat STEPS times { r0 = (r0*A + C) ; r0 ^= r0>>>16 };
// the JNZ at instruction 6 loops back to instruction 2 until r1 hits zero.
const buildProgram = (code) => {
  const p = [
    0, 0, 0,            // 0 LOADI r0, seed   (b patched per run)
    0, 1, STEPS,        // 1 LOADI r1, STEPS
    1, 0, 1103515245,   // 2 MULI  r0, A
    2, 0, 12345,        // 3 ADDI  r0, C
    3, 0, 16,           // 4 XORSHR r0, 16
    4, 1, 0,            // 5 DEC   r1
    5, 1, 2,            // 6 JNZ   r1, 2
    6, 0, 0,            // 7 HALT
  ]
  for (let i = 0; i < p.length; i++) code[i] = p[i] | 0
}

const run = (code, reg) => {
  let pc = 0
  while (pc < NINSTR) {
    const o = pc * 3
    const op = code[o], a = code[o + 1], b = code[o + 2]
    if (op === 0) { reg[a] = b; pc = pc + 1 }
    else if (op === 1) { reg[a] = Math.imul(reg[a], b); pc = pc + 1 }
    else if (op === 2) { reg[a] = (reg[a] + b) | 0; pc = pc + 1 }
    else if (op === 3) { reg[a] = reg[a] ^ (reg[a] >>> b); pc = pc + 1 }
    else if (op === 4) { reg[a] = (reg[a] - 1) | 0; pc = pc + 1 }
    else if (op === 5) { if (reg[a] !== 0) pc = b; else pc = pc + 1 }
    else pc = NINSTR
  }
  return reg[0]
}

const runKernel = (code, reg) => {
  let h = 0x811c9dc5 | 0
  for (let it = 0; it < N_ITERS; it++) {
    code[2] = (0x12345678 + it) | 0     // patch the seed immediate → non-hoistable
    h = mix(h, run(code, reg) | 0)
  }
  return h >>> 0
}

export let main = () => {
  const code = new Int32Array(NINSTR * 3)
  const reg = new Int32Array(4)
  buildProgram(code)
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = runKernel(code, reg)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = runKernel(code, reg)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, STEPS * N_ITERS, NINSTR, N_RUNS)
}
