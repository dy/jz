const std = @import("std");
const Io = std.Io;
const N_SAMPLES: usize = 1 << 16;
const SUBSTEPS: usize = 16;
const DT: f64 = 0.002;
const SIGMA: f64 = 10.0; const RHO: f64 = 28.0; const BETA: f64 = 8.0 / 3.0;
const N_RUNS = 21; const N_WARMUP = 5;
fn nowMs() f64 { var ts: std.c.timespec = undefined; _ = std.c.clock_gettime(std.c.CLOCK.MONOTONIC, &ts); return @as(f64, @floatFromInt(ts.sec)) * 1000.0 + @as(f64, @floatFromInt(ts.nsec)) / 1_000_000.0; }
fn mix(h: u32, x: u32) u32 { return (h ^ x) *% 0x01000193; }
fn checksumF64(o: []const f64) u32 { var h: u32 = 0x811c9dc5; var i: usize = 0; while (i < o.len*2) : (i += 256) { const b: u64 = @bitCast(o[i/2]); const w: u32 = if ((i&1)==0) @truncate(b) else @truncate(b>>32); h = mix(h, w); } return h; }
fn medianUs(s: *[N_RUNS]f64) u64 { var i: usize=1; while (i<s.len):(i+=1){const v=s[i];var j=i;while(j>0 and s[j-1]>v):(j-=1)s[j]=s[j-1];s[j]=v;} return @intFromFloat(s[(s.len-1)>>1]*1000.0); }
var xs: [N_SAMPLES]f64 = undefined;
fn integrate() void {
  const h=DT*0.5; const sc=DT/6.0; var x: f64=0.1; var y: f64=0.0; var z: f64=0.0;
  var s: usize=0;
  while (s<N_SAMPLES):(s+=1){
    var i: usize=0;
    while (i<SUBSTEPS):(i+=1){
      const k1x=SIGMA*(y-x); const k1y=x*(RHO-z)-y; const k1z=x*y-BETA*z;
      const ax=x+k1x*h; const ay=y+k1y*h; const az=z+k1z*h;
      const k2x=SIGMA*(ay-ax); const k2y=ax*(RHO-az)-ay; const k2z=ax*ay-BETA*az;
      const bx=x+k2x*h; const by=y+k2y*h; const bz=z+k2z*h;
      const k3x=SIGMA*(by-bx); const k3y=bx*(RHO-bz)-by; const k3z=bx*by-BETA*bz;
      const cx=x+k3x*DT; const cy=y+k3y*DT; const cz=z+k3z*DT;
      const k4x=SIGMA*(cy-cx); const k4y=cx*(RHO-cz)-cy; const k4z=cx*cy-BETA*cz;
      x=x+sc*(k1x+2.0*k2x+2.0*k3x+k4x); y=y+sc*(k1y+2.0*k2y+2.0*k3y+k4y); z=z+sc*(k1z+2.0*k2z+2.0*k3z+k4z);
    }
    xs[s]=x+y+z;
  }
}
pub fn main(proc: std.process.Init) !void {
  const io=proc.io; var buf:[256]u8=undefined; var w=Io.File.stdout().writer(io,&buf); const out=&w.interface;
  var samples=[_]f64{0}**N_RUNS;
  var i: usize=0; while(i<N_WARMUP):(i+=1)integrate();
  i=0; while(i<N_RUNS):(i+=1){const t0=nowMs();integrate();samples[i]=nowMs()-t0;}
  try out.print("median_us={d} checksum={d} samples={d} stages={d} runs={d}\n",.{medianUs(&samples),checksumF64(&xs),N_SAMPLES*SUBSTEPS,SUBSTEPS,N_RUNS});
  try out.flush();
}
