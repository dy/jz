// vm.as.ts — AssemblyScript translation of bench/vm/vm.js.
//
// A tiny bytecode interpreter: a fetch-decode-dispatch loop over a fixed
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

@external("env", "perfNow")
declare function perfNow(): f64

@external("env", "logLine")
declare function logLine(medianUs: i32, checksum: u32, samples: i32, stages: i32, runs: i32): void

// Opcodes: LOADI=0, MULI=1, ADDI=2, XORSHR=3, DEC=4, JNZ=5, HALT=6. Each
// instruction is three i32 cells: [op, a, b] (a=register, b=immediate/target).
const STEPS: i32 = 1 << 14        // inner loop trip count baked into the program
const NINSTR: i32 = 8             // instructions in the program
const N_ITERS: i32 = 64           // program runs per kernel pass
const N_RUNS: i32 = 21
const N_WARMUP: i32 = 5

// The program: r0 = seed; repeat STEPS times { r0 = (r0*A + C) ; r0 ^= r0>>>16 };
// the JNZ at instruction 6 loops back to instruction 2 until r1 hits zero.
function buildProgram(code: Int32Array): void {
  unchecked(code[0]  = 0);  unchecked(code[1]  = 0);  unchecked(code[2]  = 0)         // 0 LOADI r0, seed   (b patched per run)
  unchecked(code[3]  = 0);  unchecked(code[4]  = 1);  unchecked(code[5]  = STEPS)     // 1 LOADI r1, STEPS
  unchecked(code[6]  = 1);  unchecked(code[7]  = 0);  unchecked(code[8]  = 1103515245)// 2 MULI  r0, A
  unchecked(code[9]  = 2);  unchecked(code[10] = 0);  unchecked(code[11] = 12345)     // 3 ADDI  r0, C
  unchecked(code[12] = 3);  unchecked(code[13] = 0);  unchecked(code[14] = 16)        // 4 XORSHR r0, 16
  unchecked(code[15] = 4);  unchecked(code[16] = 1);  unchecked(code[17] = 0)         // 5 DEC   r1
  unchecked(code[18] = 5);  unchecked(code[19] = 1);  unchecked(code[20] = 2)         // 6 JNZ   r1, 2
  unchecked(code[21] = 6);  unchecked(code[22] = 0);  unchecked(code[23] = 0)         // 7 HALT
}

function run(code: Int32Array, reg: Int32Array): i32 {
  let pc: i32 = 0
  while (pc < NINSTR) {
    const o: i32 = pc * 3
    const op: i32 = unchecked(code[o])
    const a: i32  = unchecked(code[o + 1])
    const b: i32  = unchecked(code[o + 2])
    if (op === 0) { unchecked(reg[a] = b); pc = pc + 1 }
    else if (op === 1) { unchecked(reg[a] = <i32>Math.imul(unchecked(reg[a]), b)); pc = pc + 1 }
    else if (op === 2) { unchecked(reg[a] = unchecked(reg[a]) + b); pc = pc + 1 }
    else if (op === 3) { unchecked(reg[a] = unchecked(reg[a]) ^ (<i32>(<u32>unchecked(reg[a]) >>> <u32>b))); pc = pc + 1 }
    else if (op === 4) { unchecked(reg[a] = unchecked(reg[a]) - 1); pc = pc + 1 }
    else if (op === 5) { if (unchecked(reg[a]) !== 0) pc = b; else pc = pc + 1 }
    else pc = NINSTR
  }
  return unchecked(reg[0])
}

// mix: FNV-1a style, matches benchlib.js mix(h, x) = Math.imul(h ^ (x | 0), 0x01000193)
@inline
function mix(h: i32, x: i32): i32 {
  return <i32>Math.imul(h ^ x, 0x01000193)
}

function runKernel(code: Int32Array, reg: Int32Array): u32 {
  let h: i32 = <i32>0x811c9dc5
  for (let it: i32 = 0; it < N_ITERS; it++) {
    unchecked(code[2] = (0x12345678 + it))     // patch the seed immediate → non-hoistable
    h = mix(h, run(code, reg))
  }
  return <u32>h
}

export function main(): void {
  const code = new Int32Array(NINSTR * 3)
  const reg = new Int32Array(4)
  buildProgram(code)
  let cs: u32 = 0
  for (let i: i32 = 0; i < N_WARMUP; i++) cs = runKernel(code, reg)

  const samples = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) {
    const t0 = perfNow()
    cs = runKernel(code, reg)
    unchecked(samples[i] = perfNow() - t0)
  }

  const sorted = new Float64Array(N_RUNS)
  for (let i: i32 = 0; i < N_RUNS; i++) unchecked(sorted[i] = samples[i])
  for (let i: i32 = 1; i < N_RUNS; i++) {
    const v = unchecked(sorted[i])
    let j = i - 1
    while (j >= 0 && unchecked(sorted[j]) > v) {
      unchecked(sorted[j + 1] = sorted[j])
      j--
    }
    unchecked(sorted[j + 1] = v)
  }
  const medianMs = unchecked(sorted[(N_RUNS - 1) >> 1])
  logLine(<i32>(medianMs * 1000.0), cs, STEPS * N_ITERS, NINSTR, N_RUNS)
}
