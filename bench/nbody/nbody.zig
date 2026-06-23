const std = @import("std");
const bench = @import("bench");
const N: usize = 1024;
const STEPS: usize = 8;
const DT: f64 = 0.01;
const EPS2: f64 = 0.05;
const N_RUNS = 21;
const N_WARMUP = 5;
fn mix(h: u32, x: u32) u32 { return (h ^ x) *% 0x01000193; }
fn checksumF64(o: []const f64) u32 {
    var h: u32 = 0x811c9dc5; var i: usize = 0;
    while (i < o.len * 2) : (i += 256) { const b: u64 = @bitCast(o[i / 2]); const w: u32 = if ((i & 1) == 0) @truncate(b) else @truncate(b >> 32); h = mix(h, w); }
    return h;
}
fn medianUs(s: *[N_RUNS]f64) u64 { var i: usize = 1; while (i < s.len) : (i += 1) { const v = s[i]; var j = i; while (j > 0 and s[j-1] > v) : (j -= 1) s[j] = s[j-1]; s[j] = v; } return @intFromFloat(s[(s.len-1)>>1] * 1000.0); }
var px: [N]f64 = undefined; var py: [N]f64 = undefined; var pz: [N]f64 = undefined;
var vx: [N]f64 = undefined; var vy: [N]f64 = undefined; var vz: [N]f64 = undefined; var m: [N]f64 = undefined;
fn seed() void {
    var s: i32 = 0x1234abcd;
    const r = struct { fn f(sp: *i32) f64 { sp.* ^= sp.* << 13; sp.* ^= @bitCast(@as(u32, @bitCast(sp.*)) >> 17); sp.* ^= sp.* << 5; return @as(f64, @floatFromInt(@as(u32, @bitCast(sp.*)))) / 4294967296.0 * 2.0 - 1.0; } }.f;
    var i: usize = 0;
    while (i < N) : (i += 1) { px[i]=r(&s); py[i]=r(&s); pz[i]=r(&s); vx[i]=r(&s)*0.1; vy[i]=r(&s)*0.1; vz[i]=r(&s)*0.1; m[i]=r(&s)+1.5; }
}
fn step() void {
    var i: usize = 0;
    while (i < N) : (i += 1) {
        const xi=px[i]; const yi=py[i]; const zi=pz[i]; var ax: f64=0; var ay: f64=0; var az: f64=0;
        var j: usize = 0;
        while (j < N) : (j += 1) {
            const dx=px[j]-xi; const dy=py[j]-yi; const dz=pz[j]-zi;
            const r2=dx*dx+dy*dy+dz*dz+EPS2; const inv=1.0/(r2*@sqrt(r2)); const f=m[j]*inv;
            ax+=dx*f; ay+=dy*f; az+=dz*f;
        }
        vx[i]+=ax*DT; vy[i]+=ay*DT; vz[i]+=az*DT;
    }
    i = 0; while (i < N) : (i += 1) { px[i]+=vx[i]*DT; py[i]+=vy[i]*DT; pz[i]+=vz[i]*DT; }
}
pub fn main() !void {
    var samples = [_]f64{0} ** N_RUNS;
    var i: usize = 0; while (i < N_WARMUP) : (i += 1) { seed(); var s: usize = 0; while (s < STEPS) : (s += 1) step(); }
    i = 0; while (i < N_RUNS) : (i += 1) { seed(); const t0 = bench.nowMs(); var s: usize = 0; while (s < STEPS) : (s += 1) step(); samples[i] = bench.nowMs() - t0; }
    bench.printResult(medianUs(&samples), checksumF64(&px) ^ checksumF64(&vx), N*N*STEPS, STEPS, N_RUNS);
}
