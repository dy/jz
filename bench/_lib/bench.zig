// Shared timing + result-print path for the .zig kernels — the zig sibling of
// _lib/bench.h.
//
// Two zig-0.16 facts force this to be shared rather than per-file boilerplate:
//
//  1. `Io.File.stdout().writer(...)` (the new std.Io path) writes NOTHING under
//     node:wasi — the wasm engine the harness runs every wasm rival in (V8,
//     apples-to-apples with jz). The program exits 0 having printed nothing, so
//     the `median_us=…` line never lands and the zig→wasm row silently drops.
//     The same wasm prints fine under wasmtime, which is how it went unnoticed.
//  2. Linking wasi-libc (`-lc`, needed by `std.c.clock_gettime`) ALSO swallows
//     all stdout under node:wasi — even a raw `fd_write`. So the wasm build must
//     avoid libc entirely.
//
// Fix: no libc on wasm. Time via the WASI `clock_time_get` import and print via
// the WASI `fd_write` import directly (both verified under node:wasi AND
// wasmtime). On native (the `zig` baseline target) keep libc — `clock_gettime`
// for timing, `write` for output. One import per case, like the C cases share
// bench.h.
const std = @import("std");
const builtin = @import("builtin");

const is_wasi = builtin.os.tag == .wasi;

extern "wasi_snapshot_preview1" fn fd_write(fd: i32, iovs: [*]const Iovec, iovs_len: usize, nwritten: *usize) callconv(.c) u16;
extern "wasi_snapshot_preview1" fn clock_time_get(clock_id: u32, precision: u64, timestamp: *u64) callconv(.c) u16;
const Iovec = extern struct { base: [*]const u8, len: usize };

// Monotonic clock in milliseconds — `CLOCK_MONOTONIC` natively, WASI clock id 1.
pub fn nowMs() f64 {
    if (is_wasi) {
        var ts: u64 = 0;
        _ = clock_time_get(1, 1, &ts);
        return @as(f64, @floatFromInt(ts)) / 1_000_000.0;
    } else {
        var ts: std.c.timespec = undefined;
        _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts);
        return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0;
    }
}

fn writeAll(bytes: []const u8) void {
    if (is_wasi) {
        var iov = Iovec{ .base = bytes.ptr, .len = bytes.len };
        var n: usize = 0;
        _ = fd_write(1, @ptrCast(&iov), 1, &n);
    } else {
        _ = std.c.write(1, bytes.ptr, bytes.len);
    }
}

// `{d}` accepts any integer width, so callers pass their case-native types
// (u64 median, u32 checksum, comptime-int sizes) without a cast at the call site.
pub fn printResult(median_us: anytype, checksum: anytype, samples: anytype, stages: anytype, runs: anytype) void {
    var buf: [256]u8 = undefined;
    const line = std.fmt.bufPrint(&buf, "median_us={d} checksum={d} samples={d} stages={d} runs={d}\n", .{ median_us, checksum, samples, stages, runs }) catch return;
    writeAll(line);
}
