// json.zig — general JSON parser (std.json.parseFromSlice + ArenaAllocator) for benchmark.
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

// Get integer value from a std.json.Value (parsed as integer or float).
fn getInt(v: std.json.Value) i32 {
    return switch (v) {
        .integer => |n| @as(i32, @intCast(@as(i64, @truncate(n)))),
        .float   => |f| @as(i32, @intFromFloat(f)),
        else     => 0,
    };
}

fn parseAndWalk(arena: *std.heap.ArenaAllocator) !u32 {
    var h: u32 = 0x811c9dc5;
    var iter: usize = 0;
    while (iter < N_ITERS) : (iter += 1) {
        // Reset arena each iteration so memory doesn't accumulate.
        _ = arena.reset(.retain_capacity);
        const alloc = arena.allocator();

        const result = try std.json.parseFromSlice(std.json.Value, alloc, SRC, .{});
        const root = result.value;

        // Walk generically: key lookup via object.get (string comparison).
        const items_val = root.object.get("items") orelse continue;
        const meta_val  = root.object.get("meta")  orelse continue;

        const scale = getInt(meta_val.object.get("scale") orelse std.json.Value{ .integer = 0 });
        var s: i32  = getInt(meta_val.object.get("bias")  orelse std.json.Value{ .integer = 0 });

        for (items_val.array.items) |item| {
            const id    = getInt(item.object.get("id")    orelse std.json.Value{ .integer = 0 });
            const kind  = getInt(item.object.get("kind")  orelse std.json.Value{ .integer = 0 });
            const value = getInt(item.object.get("value") orelse std.json.Value{ .integer = 0 });
            s +%= id *% scale +% kind +% value;
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

    var arena = std.heap.ArenaAllocator.init(std.heap.page_allocator);
    defer arena.deinit();

    var cs: u32 = 0;
    var i: usize = 0;
    while (i < N_WARMUP) : (i += 1) cs = try parseAndWalk(&arena);

    var samples = [_]f64{0} ** N_RUNS;
    i = 0;
    while (i < N_RUNS) : (i += 1) {
        const t0 = nowMs();
        cs = try parseAndWalk(&arena);
        samples[i] = nowMs() - t0;
    }
    try stdout.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ medianUs(&samples), cs, N_ITERS, 4, N_RUNS });
    try stdout.flush();
}
