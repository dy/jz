// vm.c — a tiny bytecode interpreter: a fetch-decode-dispatch loop over a fixed
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
#include "../_lib/bench.h"

// Opcodes: LOADI=0, MULI=1, ADDI=2, XORSHR=3, DEC=4, JNZ=5, HALT=6. Each
// instruction is three i32 cells: [op, a, b] (a=register, b=immediate/target).
#define STEPS   (1 << 14)   // inner loop trip count baked into the program
#define NINSTR  8            // instructions in the program
#define N_ITERS 64           // program runs per kernel pass
#define N_RUNS  21
#define N_WARMUP 5

static void build_program(int32_t *code) {
  int32_t p[NINSTR * 3] = {
    0, 0, 0,             // 0 LOADI r0, seed   (b patched per run)
    0, 1, STEPS,         // 1 LOADI r1, STEPS
    1, 0, 1103515245,    // 2 MULI  r0, A
    2, 0, 12345,         // 3 ADDI  r0, C
    3, 0, 16,            // 4 XORSHR r0, 16
    4, 1, 0,             // 5 DEC   r1
    5, 1, 2,             // 6 JNZ   r1, 2
    6, 0, 0,             // 7 HALT
  };
  for (int i = 0; i < NINSTR * 3; i++) code[i] = p[i];
}

static int32_t run(int32_t *code, int32_t *reg) {
  int pc = 0;
  while (pc < NINSTR) {
    int o = pc * 3;
    int32_t op = code[o], a = code[o + 1], b = code[o + 2];
    if      (op == 0) { reg[a] = b; pc = pc + 1; }
    else if (op == 1) { reg[a] = (int32_t)((uint32_t)reg[a] * (uint32_t)b); pc = pc + 1; }
    else if (op == 2) { reg[a] = (int32_t)((uint32_t)reg[a] + (uint32_t)b); pc = pc + 1; }
    else if (op == 3) { reg[a] = reg[a] ^ (int32_t)((uint32_t)reg[a] >> (uint32_t)b); pc = pc + 1; }
    else if (op == 4) { reg[a] = (int32_t)((uint32_t)reg[a] - 1u); pc = pc + 1; }
    else if (op == 5) { if (reg[a] != 0) pc = b; else pc = pc + 1; }
    else pc = NINSTR;
  }
  return reg[0];
}

static uint32_t run_kernel(int32_t *code, int32_t *reg) {
  uint32_t h = 0x811c9dc5u;
  for (int it = 0; it < N_ITERS; it++) {
    code[2] = (int32_t)((uint32_t)(0x12345678 + it));  // patch the seed immediate
    h = mix_u32(h, (uint32_t)run(code, reg));
  }
  return h;
}

int main(void) {
  int32_t code[NINSTR * 3];
  int32_t reg[4];
  double samples[N_RUNS];
  build_program(code);
  uint32_t cs = 0;
  for (int i = 0; i < N_WARMUP; i++) cs = run_kernel(code, reg);
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    cs = run_kernel(code, reg);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), cs, STEPS * N_ITERS, NINSTR, N_RUNS);
}
