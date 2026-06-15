// nbody.rs — direct-summation N-body. Bit-identical to nbody.js.
use std::time::Instant;
const N: usize = 1024;
const STEPS: usize = 8;
const DT: f64 = 0.01;
const EPS2: f64 = 0.05;
const N_RUNS: usize = 21;
const N_WARMUP: usize = 5;
fn mix(h:u32,x:u32)->u32{(h^x).wrapping_mul(0x0100_0193)}
fn checksum(o:&[f64])->u32{let mut h=0x811c_9dc5u32;for i in (0..o.len()*2).step_by(256){let b=o[i/2].to_le_bytes();let f=(i&1)*4;h=mix(h,u32::from_le_bytes([b[f],b[f+1],b[f+2],b[f+3]]));}h}
fn median_us(s:&mut[f64])->u64{for i in 1..s.len(){let v=s[i];let mut j=i;while j>0&&s[j-1]>v{s[j]=s[j-1];j-=1;}s[j]=v;}(s[(s.len()-1)>>1]*1000.0) as u64}
fn seed(px:&mut[f64],py:&mut[f64],pz:&mut[f64],vx:&mut[f64],vy:&mut[f64],vz:&mut[f64],m:&mut[f64]){
  let mut s=0x1234abcdi32;
  let mut r=||{s^=s<<13;s^=((s as u32)>>17) as i32;s^=s<<5;(s as u32) as f64/4294967296.0*2.0-1.0};
  for i in 0..N{px[i]=r();py[i]=r();pz[i]=r();vx[i]=r()*0.1;vy[i]=r()*0.1;vz[i]=r()*0.1;m[i]=r()+1.5;}
}
fn step(px:&mut[f64],py:&mut[f64],pz:&mut[f64],vx:&mut[f64],vy:&mut[f64],vz:&mut[f64],m:&[f64]){
  for i in 0..N{
    let (xi,yi,zi)=(px[i],py[i],pz[i]);let(mut ax,mut ay,mut az)=(0.0,0.0,0.0);
    for j in 0..N{
      let dx=px[j]-xi;let dy=py[j]-yi;let dz=pz[j]-zi;
      let r2=dx*dx+dy*dy+dz*dz+EPS2;let inv=1.0/(r2*r2.sqrt());let f=m[j]*inv;
      ax+=dx*f;ay+=dy*f;az+=dz*f;
    }
    vx[i]+=ax*DT;vy[i]+=ay*DT;vz[i]+=az*DT;
  }
  for i in 0..N{px[i]+=vx[i]*DT;py[i]+=vy[i]*DT;pz[i]+=vz[i]*DT;}
}
fn main(){
  let mut px=vec![0.0;N];let mut py=vec![0.0;N];let mut pz=vec![0.0;N];
  let mut vx=vec![0.0;N];let mut vy=vec![0.0;N];let mut vz=vec![0.0;N];let mut m=vec![0.0;N];
  for _ in 0..N_WARMUP{seed(&mut px,&mut py,&mut pz,&mut vx,&mut vy,&mut vz,&mut m);for _ in 0..STEPS{step(&mut px,&mut py,&mut pz,&mut vx,&mut vy,&mut vz,&m);}}
  let mut samples=[0.0f64;N_RUNS];
  for s in &mut samples{seed(&mut px,&mut py,&mut pz,&mut vx,&mut vy,&mut vz,&mut m);let t0=Instant::now();for _ in 0..STEPS{step(&mut px,&mut py,&mut pz,&mut vx,&mut vy,&mut vz,&m);}*s=t0.elapsed().as_secs_f64()*1000.0;}
  println!("median_us={} checksum={} samples={} stages={} runs={}",median_us(&mut samples),checksum(&px)^checksum(&vx),N*N*STEPS,STEPS,N_RUNS);
}
