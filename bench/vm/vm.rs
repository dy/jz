// vm.rs — a tiny bytecode interpreter: a fetch-decode-dispatch loop over a fixed
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
use std::time::Instant;

// Opcodes: LOADI=0, MULI=1, ADDI=2, XORSHR=3, DEC=4, JNZ=5, HALT=6. Each
// instruction is three i32 cells: [op, a, b] (a=register, b=immediate/target).
const STEPS: i32 = 1 << 14;       // inner loop trip count baked into the program
const NINSTR: usize = 8;          // instructions in the program
const N_ITERS: usize = 64;        // program runs per kernel pass
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn mix(h: i32, x: i32) -> i32 {
    (h ^ x).wrapping_mul(0x0100_0193u32 as i32)
}

fn median_us(samples: &mut [f64]) -> u64 {
    for i in 1..samples.len() {
        let v = samples[i];
        let mut j = i;
        while j > 0 && samples[j - 1] > v {
            samples[j] = samples[j - 1];
            j -= 1;
        }
        samples[j] = v;
    }
    (samples[(samples.len() - 1) >> 1] * 1000.0) as u64
}

// The program: r0 = seed; repeat STEPS times { r0 = (r0*A + C) ; r0 ^= r0>>>16 };
// the JNZ at instruction 6 loops back to instruction 2 until r1 hits zero.
fn build_program(code: &mut [i32]) {
    let p: [i32; 24] = [
        0, 0, 0,             // 0 LOADI r0, seed   (b patched per run)
        0, 1, STEPS,         // 1 LOADI r1, STEPS
        1, 0, 1103515245,    // 2 MULI  r0, A
        2, 0, 12345,         // 3 ADDI  r0, C
        3, 0, 16,            // 4 XORSHR r0, 16
        4, 1, 0,             // 5 DEC   r1
        5, 1, 2,             // 6 JNZ   r1, 2
        6, 0, 0,             // 7 HALT
    ];
    for i in 0..p.len() {
        code[i] = p[i];
    }
}

fn run(code: &[i32], reg: &mut [i32]) -> i32 {
    let mut pc: usize = 0;
    while pc < NINSTR {
        let o = pc * 3;
        let op = code[o];
        let a = code[o + 1] as usize;
        let b = code[o + 2];
        if op == 0 {
            reg[a] = b;
            pc += 1;
        } else if op == 1 {
            reg[a] = reg[a].wrapping_mul(b);
            pc += 1;
        } else if op == 2 {
            reg[a] = reg[a].wrapping_add(b);
            pc += 1;
        } else if op == 3 {
            // >>> is unsigned right shift: treat reg[a] as u32
            reg[a] = reg[a] ^ ((reg[a] as u32) >> b as u32) as i32;
            pc += 1;
        } else if op == 4 {
            reg[a] = reg[a].wrapping_sub(1);
            pc += 1;
        } else if op == 5 {
            if reg[a] != 0 {
                pc = b as usize;
            } else {
                pc += 1;
            }
        } else {
            pc = NINSTR;
        }
    }
    reg[0]
}

fn run_kernel(code: &mut [i32], reg: &mut [i32]) -> u32 {
    let mut h: i32 = 0x811c9dc5u32 as i32;
    for it in 0..N_ITERS {
        code[2] = (0x12345678i32).wrapping_add(it as i32);
        h = mix(h, run(code, reg));
    }
    h as u32
}

fn main() {
    let mut code = vec![0i32; NINSTR * 3];
    let mut reg = vec![0i32; 4];
    build_program(&mut code);

    let mut cs = 0u32;
    for _ in 0..N_WARMUP {
        cs = run_kernel(&mut code, &mut reg);
    }

    let mut samples = [0.0f64; N_RUNS];
    for s in &mut samples {
        let t0 = Instant::now();
        cs = run_kernel(&mut code, &mut reg);
        *s = t0.elapsed().as_secs_f64() * 1000.0;
    }

    println!(
        "median_us={} checksum={} samples={} stages={} runs={}",
        median_us(&mut samples),
        cs,
        STEPS as usize * N_ITERS,
        NINSTR,
        N_RUNS
    );
}
