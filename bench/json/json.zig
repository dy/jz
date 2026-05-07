const std = @import("std");
const Io = std.Io;

const SRC = "{\"items\":[{\"id\":1,\"kind\":2,\"value\":10},{\"id\":2,\"kind\":3,\"value\":20},{\"id\":3,\"kind\":5,\"value\":30}],\"meta\":{\"scale\":7,\"bias\":11}}";
const N_ITERS = 512;
const N_RUNS = 21;
const N_WARMUP = 5;

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

fn parseInt(p: *usize) i32 {
    var v: i32 = 0;
    var neg = false;
    if (SRC[p.*] == '-') { neg = true; p.* += 1; }
    while (p.* < SRC.len and SRC[p.*] >= '0' and SRC[p.*] <= '9') : (p.* += 1) {
        v = v *% 10 +% @as(i32, SRC[p.*] - '0');
    }
    return if (neg) -v else v;
}

fn skipTo(p: *usize, ch: u8) void {
    while (p.* < SRC.len and SRC[p.*] != ch) : (p.* += 1) {}
}

fn parseAndWalk() u32 {
    var h: u32 = 0x811c9dc5;
    var iter: usize = 0;
    while (iter < N_ITERS) : (iter += 1) {
        var p: usize = 0;
        var ids: [3]i32 = .{ 0, 0, 0 };
        var kinds: [3]i32 = .{ 0, 0, 0 };
        var values: [3]i32 = .{ 0, 0, 0 };

        skipTo(&p, '['); p += 1;
        var j: usize = 0;
        while (j < 3) : (j += 1) {
            skipTo(&p, '{'); p += 1;
            skipTo(&p, ':'); p += 1;
            ids[j] = parseInt(&p);
            skipTo(&p, ':'); p += 1;
            kinds[j] = parseInt(&p);
            skipTo(&p, ':'); p += 1;
            values[j] = parseInt(&p);
            skipTo(&p, '}'); p += 1;
        }

        skipTo(&p, '{'); p += 1;
        skipTo(&p, ':'); p += 1;
        const scale = parseInt(&p);
        skipTo(&p, ':'); p += 1;
        const bias = parseInt(&p);

        var s: i32 = bias;
        j = 0;
        while (j < 3) : (j += 1) {
            s +%= ids[j] *% scale +% kinds[j] +% values[j];
        }
        h = mix(h, @as(u32, @bitCast(s)));
    }
    return h;
}

pub fn main(init_args: std.process.Init) !void {
    const io = init_args.io;
    var stdout_buffer: [256]u8 = undefined;
    var stdout_writer = Io.File.stdout().writer(io, &stdout_buffer);
    const stdout = &stdout_writer.interface;

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = parseAndWalk();

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = parseAndWalk();
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N_ITERS, 4, N_RUNS });
    try stdout.flush();
}
