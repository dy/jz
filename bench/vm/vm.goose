// vm.goose: Goose port of vm.js (same program, seeds and checksum): a tiny
// bytecode interpreter, an if/else opcode chain over a flat code array of
// [op, a, b] cells. Registers and cells are u32, so the arithmetic wraps as
// Math.imul and `| 0` do.

import bench from "../_lib";

// Opcodes: LOADI=0, MULI=1, ADDI=2, XORSHR=3, DEC=4, JNZ=5, HALT=6.
let STEPS = 1 << 14;        // inner loop trip count baked into the program
let NINSTR = 8;             // instructions in the program
let N_ITERS = 64;           // program runs per kernel pass
let N_RUNS = 21;
let N_WARMUP = 5;

// r0 = seed; repeat STEPS times { r0 = r0 * A + C; r0 ^= r0 >> 16 };
// the JNZ at instruction 6 loops back to instruction 2 until r1 hits zero.
fn build_program(code: u32[NINSTR * 3]&) {
    code = [
        0, 0, 0,            // 0 LOADI r0, seed   (b patched per run)
        0, 1, STEPS,        // 1 LOADI r1, STEPS
        1, 0, 1103515245,   // 2 MULI  r0, A
        2, 0, 12345,        // 3 ADDI  r0, C
        3, 0, 16,           // 4 XORSHR r0, 16
        4, 1, 0,            // 5 DEC   r1
        5, 1, 2,            // 6 JNZ   r1, 2
        6, 0, 0,            // 7 HALT
    ];
}

fn run(code: u32[NINSTR * 3]&, reg: u32[4]&) -> u32 {
    var pc = 0;
    while pc < NINSTR {
        let o = pc * 3;
        let op = code[o];
        let a = code[o + 1];
        let b = code[o + 2];
        if op == 0 { reg[a] = b; pc = pc + 1; }
        else if op == 1 { reg[a] = reg[a] * b; pc = pc + 1; }
        else if op == 2 { reg[a] = reg[a] + b; pc = pc + 1; }
        else if op == 3 { reg[a] = reg[a] ^ (reg[a] >> b); pc = pc + 1; }
        else if op == 4 { reg[a] = reg[a] - 1; pc = pc + 1; }
        else if op == 5 { if reg[a] != 0 { pc = b; } else { pc = pc + 1; } }
        else { pc = NINSTR; }
    }
    return reg[0];
}

fn run_kernel(code: u32[NINSTR * 3]&, reg: u32[4]&) -> u32 {
    var h: u32 = 0x811c9dc5;
    for it in N_ITERS {
        code[2] = 0x12345678 + it as u32;     // patch the seed immediate: non-hoistable
        h = mix(h, run(code, reg));
    }
    return h;
}

fn main() {
    var code: u32[NINSTR * 3] = [0; NINSTR * 3];
    var reg: u32[4] = [0; 4];
    build_program(code);
    var cs: u32 = 0;
    for i in N_WARMUP { cs = run_kernel(code, reg); }

    var samples = [0.0; N_RUNS];
    for &s in samples {
        let t0 = now_ms();
        cs = run_kernel(code, reg);
        s = now_ms() - t0;
    }
    print_result(median_us(samples), cs, STEPS * N_ITERS, NINSTR, N_RUNS);
}
