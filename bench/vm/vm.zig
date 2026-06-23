// vm.zig — a tiny bytecode interpreter: a fetch-decode-dispatch loop over a fixed
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
const std = @import("std");
const Io = std.Io;

// Opcodes: LOADI=0, MULI=1, ADDI=2, XORSHR=3, DEC=4, JNZ=5, HALT=6. Each
// instruction is three i32 cells: [op, a, b] (a=register, b=immediate/target).
const STEPS: i32 = 1 << 14;       // inner loop trip count baked into the program
const NINSTR: usize = 8;           // instructions in the program
const N_ITERS: usize = 64;         // program runs per kernel pass
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;

fn nowMs() f64 {
    var ts: std.c.timespec = undefined;
    _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
    return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0;
}

fn mix(h: u32, x: u32) u32 {
    return (h ^ x) *% 0x01000193;
}

fn medianUs(samples: *[N_RUNS]f64) u64 {
    var i: usize = 1;
    while (i < samples.len) : (i += 1) {
        const v = samples[i];
        var j = i;
        while (j > 0 and samples[j - 1] > v) : (j -= 1) samples[j] = samples[j - 1];
        samples[j] = v;
    }
    return @as(u64, @intFromFloat(samples[(samples.len - 1) >> 1] * 1000.0));
}

// The program: r0 = seed; repeat STEPS times { r0 = (r0*A + C) ; r0 ^= r0>>>16 };
// the JNZ at instruction 6 loops back to instruction 2 until r1 hits zero.
fn buildProgram(code: []i32) void {
    const p = [_]i32{
        0, 0, 0,           // 0 LOADI r0, seed   (b patched per run)
        0, 1, STEPS,       // 1 LOADI r1, STEPS
        1, 0, 1103515245,  // 2 MULI  r0, A
        2, 0, 12345,       // 3 ADDI  r0, C
        3, 0, 16,          // 4 XORSHR r0, 16
        4, 1, 0,           // 5 DEC   r1
        5, 1, 2,           // 6 JNZ   r1, 2
        6, 0, 0,           // 7 HALT
    };
    var i: usize = 0;
    while (i < p.len) : (i += 1) code[i] = p[i];
}

fn run(code: []i32, reg: []i32) i32 {
    var pc: usize = 0;
    while (pc < NINSTR) {
        const o = pc * 3;
        const op = code[o];
        const a: usize = @intCast(code[o + 1]);
        const b = code[o + 2];
        if (op == 0) {
            reg[a] = b;
            pc = pc + 1;
        } else if (op == 1) {
            reg[a] = @bitCast(@as(u32, @bitCast(reg[a])) *% @as(u32, @bitCast(b)));
            pc = pc + 1;
        } else if (op == 2) {
            reg[a] = @bitCast(@as(u32, @bitCast(reg[a])) +% @as(u32, @bitCast(b)));
            pc = pc + 1;
        } else if (op == 3) {
            const shift: u5 = @intCast(@as(u32, @bitCast(b)) & 31);
            reg[a] = reg[a] ^ @as(i32, @bitCast(@as(u32, @bitCast(reg[a])) >> shift));
            pc = pc + 1;
        } else if (op == 4) {
            reg[a] = @bitCast(@as(u32, @bitCast(reg[a])) -% 1);
            pc = pc + 1;
        } else if (op == 5) {
            if (reg[a] != 0) {
                pc = @intCast(b);
            } else {
                pc = pc + 1;
            }
        } else {
            pc = NINSTR;
        }
    }
    return reg[0];
}

fn runKernel(code: []i32, reg: []i32) u32 {
    var h: u32 = 0x811c9dc5;
    var it: usize = 0;
    while (it < N_ITERS) : (it += 1) {
        // patch the seed immediate: (0x12345678 + it) | 0
        code[2] = @bitCast(@as(u32, @truncate(0x12345678 + it)));
        h = mix(h, @bitCast(run(code, reg)));
    }
    return h;
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    const allocator = std.heap.page_allocator;
    const code = try allocator.alloc(i32, NINSTR * 3);
    const reg = try allocator.alloc(i32, 4);
    defer allocator.free(code);
    defer allocator.free(reg);

    buildProgram(code);

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = runKernel(code, reg);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = runKernel(code, reg);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{
        medianUs(&samples), cs,
        @as(usize, @intCast(STEPS)) * N_ITERS,
        NINSTR, N_RUNS,
    });
    try stdout.flush();
}
