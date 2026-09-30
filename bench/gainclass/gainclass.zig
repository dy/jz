// gainclass.zig — Zig port of the unchanged JavaScript workload.
const std = @import("std");
const bench = @import("bench");
const N_RUNS = 21;
const N_WARMUP = 5;
fn next(s: *u32) u32 {
    s.* ^= s.* << 13;
    s.* ^= s.* >> 17;
    s.* ^= s.* << 5;
    return s.*;
}
fn mix(acc: u32, value: u32) u32 {
    return (acc ^ value) *% 0x01000193;
}
fn checksum(out: []const f64) u32 {
    var hash: u32 = 0x811c9dc5;
    var i: usize = 0;
    while (i < out.len * 2) : (i += 256) {
        const bits: u64 = @bitCast(out[i / 2]);
        const word: u32 = if (i & 1 == 0) @truncate(bits) else @truncate(bits >> 32);
        hash = mix(hash, word);
    }
    return hash;
}
fn medianUs(samples: *[N_RUNS]f64) u64 {
    var i: usize = 1;
    while (i < samples.len) : (i += 1) {
        const value = samples[i];
        var j = i;
        while (j > 0 and samples[j - 1] > value) : (j -= 1) {
            samples[j] = samples[j - 1];
        }
        samples[j] = value;
    }
    return @intFromFloat(samples[(samples.len - 1) >> 1] * 1000.0);
}
const N = 65536;
const N_NODES = 8;
const Gain = struct {
    buf: []f64,
    gain: f64,
    fn process(self: *Gain, input: []const f64) []const f64 {
        for (self.buf, 0..) |*v, i| v.* = input[i] * self.gain;
        return self.buf;
    }
};
fn render(input: []const f64, nodes: []Gain) []const f64 {
    var x = input;
    for (nodes) |*node| x = node.process(x);
    return x;
}
pub fn main() !void {
    const a = std.heap.page_allocator;
    const input = try a.alloc(f64, N);
    defer a.free(input);
    var s: u32 = 0x1234abcd;
    for (input) |*v| v.* = @as(f64, @floatFromInt(next(&s))) / 4294967296.0 * 2.0 - 1.0;
    const nodes = try a.alloc(Gain, N_NODES);
    defer a.free(nodes);
    for (nodes, 0..) |*node, k| {
        node.* = .{ .buf = try a.alloc(f64, N), .gain = 0.9 + @as(f64, @floatFromInt(k)) * 0.01 };
    }
    defer for (nodes) |node| a.free(node.buf);
    for (0..N_WARMUP) |_| {
        _ = render(input, nodes);
    }
    var samples: [N_RUNS]f64 = undefined;
    var out: []const f64 = input;
    for (&samples) |*sample| {
        const t = bench.nowMs();
        out = render(input, nodes);
        sample.* = bench.nowMs() - t;
    }
    bench.printResult(medianUs(&samples), checksum(out), N, N_NODES, N_RUNS);
}
