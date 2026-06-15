// lorenz.rs — Lorenz attractor RK4. Bit-identical to lorenz.js.
use std::time::Instant;
const N_SAMPLES: usize = 1 << 16;
const SUBSTEPS: usize = 16;
const DT: f64 = 0.002;
const SIGMA: f64 = 10.0; const RHO: f64 = 28.0; const BETA: f64 = 8.0 / 3.0;
const N_RUNS: usize = 21; const N_WARMUP: usize = 5;
fn mix(h:u32,x:u32)->u32{(h^x).wrapping_mul(0x0100_0193)}
fn checksum(o:&[f64])->u32{let mut h=0x811c_9dc5u32;for i in (0..o.len()*2).step_by(256){let b=o[i/2].to_le_bytes();let f=(i&1)*4;h=mix(h,u32::from_le_bytes([b[f],b[f+1],b[f+2],b[f+3]]));}h}
fn median_us(s:&mut[f64])->u64{for i in 1..s.len(){let v=s[i];let mut j=i;while j>0&&s[j-1]>v{s[j]=s[j-1];j-=1;}s[j]=v;}(s[(s.len()-1)>>1]*1000.0) as u64}
fn integrate(xs:&mut[f64]){
  let (h,sc)=(DT*0.5, DT/6.0); let (mut x,mut y,mut z)=(0.1,0.0,0.0);
  for s in 0..N_SAMPLES{
    for _ in 0..SUBSTEPS{
      let k1x=SIGMA*(y-x); let k1y=x*(RHO-z)-y; let k1z=x*y-BETA*z;
      let ax=x+k1x*h; let ay=y+k1y*h; let az=z+k1z*h;
      let k2x=SIGMA*(ay-ax); let k2y=ax*(RHO-az)-ay; let k2z=ax*ay-BETA*az;
      let bx=x+k2x*h; let by=y+k2y*h; let bz=z+k2z*h;
      let k3x=SIGMA*(by-bx); let k3y=bx*(RHO-bz)-by; let k3z=bx*by-BETA*bz;
      let cx=x+k3x*DT; let cy=y+k3y*DT; let cz=z+k3z*DT;
      let k4x=SIGMA*(cy-cx); let k4y=cx*(RHO-cz)-cy; let k4z=cx*cy-BETA*cz;
      x=x+sc*(k1x+2.0*k2x+2.0*k3x+k4x); y=y+sc*(k1y+2.0*k2y+2.0*k3y+k4y); z=z+sc*(k1z+2.0*k2z+2.0*k3z+k4z);
    }
    xs[s]=x+y+z;
  }
}
fn main(){
  let mut xs=vec![0.0;N_SAMPLES];
  for _ in 0..N_WARMUP{integrate(&mut xs);}
  let mut samples=[0.0f64;N_RUNS];
  for s in &mut samples{let t0=Instant::now();integrate(&mut xs);*s=t0.elapsed().as_secs_f64()*1000.0;}
  println!("median_us={} checksum={} samples={} stages={} runs={}",median_us(&mut samples),checksum(&xs),N_SAMPLES*SUBSTEPS,SUBSTEPS,N_RUNS);
}
