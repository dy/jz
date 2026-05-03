const std = @import("std");

const BASE = "let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n";
const N_REPEAT = 512;
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

fn isAlpha(c: u8) bool {
    return (c >= 'A' and c <= 'Z') or (c >= 'a' and c <= 'z') or c == '_';
}

fn scan(src: []const u8) u32 {
    var h: u32 = 0x811c9dc5;
    var number: u32 = 0;
    var in_number = false;
    var in_ident = false;
    var tokens: u32 = 0;
    for (src) |c| {
        if (c >= '0' and c <= '9') {
            number = number *% 10 +% @as(u32, c - '0');
            in_number = true;
        } else {
            if (in_number) {
                h = mix(h, number);
                tokens += 1;
                number = 0;
                in_number = false;
            }
            if (isAlpha(c)) {
                if (!in_ident) {
                    h = mix(h, @as(u32, c));
                    tokens += 1;
                }
                in_ident = true;
            } else {
                if (c > 32) {
                    h = mix(h, @as(u32, c));
                    tokens += 1;
                }
                in_ident = false;
            }
        }
    }
    if (in_number) {
        h = mix(h, number);
        tokens += 1;
    }
    return mix(h, tokens);
}

pub fn main() !void {
    const allocator = std.heap.page_allocator;
    const len = BASE.len * N_REPEAT;
    const src = try allocator.alloc(u8, len);
    defer allocator.free(src);
    var i: usize = 0;
    while (i < N_REPEAT) : (i += 1) @memcpy(src[i * BASE.len .. (i + 1) * BASE.len], BASE);

    var cs: u32 = 0;
    i = 0;
    while (i < N_WARMUP) : (i += 1) cs = scan(src);
    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = scan(src);
        samples[i] = nowMs() - t0;
    }
    const stdout = std.io.getStdOut().writer();
    try stdout.print("median_us={} checksum={} samples={} stages={} runs={}\n", .{ medianUs(&samples), cs, len, 5, N_RUNS });
}
