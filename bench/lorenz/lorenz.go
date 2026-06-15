package main
import ("fmt";"math";"time")
const(N_SAMPLES=1<<16;SUBSTEPS=16;DT=0.002;SIGMA=10.0;RHO=28.0;BETA=8.0/3.0;N_RUNS=21;N_WARMUP=5)
func mix(h,x uint32)uint32{return (h^x)*0x01000193}
func checksumF64(o []float64)uint32{h:=uint32(0x811c9dc5);for i:=0;i<len(o)*2;i+=256{b:=math.Float64bits(o[i/2]);var w uint32;if i&1==0{w=uint32(b)}else{w=uint32(b>>32)};h=mix(h,w)};return h}
func medianUs(s []float64)uint64{for i:=1;i<len(s);i++{v:=s[i];j:=i-1;for j>=0&&s[j]>v{s[j+1]=s[j];j--};s[j+1]=v};return uint64(s[(len(s)-1)>>1]*1000.0)}
func integrate(xs []float64){
  h,sc:=DT*0.5,DT/6.0;x,y,z:=0.1,0.0,0.0
  for s:=0;s<N_SAMPLES;s++{
    for i:=0;i<SUBSTEPS;i++{
      k1x:=SIGMA*(y-x);k1y:=x*(RHO-z)-y;k1z:=x*y-BETA*z
      ax:=x+k1x*h;ay:=y+k1y*h;az:=z+k1z*h
      k2x:=SIGMA*(ay-ax);k2y:=ax*(RHO-az)-ay;k2z:=ax*ay-BETA*az
      bx:=x+k2x*h;by:=y+k2y*h;bz:=z+k2z*h
      k3x:=SIGMA*(by-bx);k3y:=bx*(RHO-bz)-by;k3z:=bx*by-BETA*bz
      cx:=x+k3x*DT;cy:=y+k3y*DT;cz:=z+k3z*DT
      k4x:=SIGMA*(cy-cx);k4y:=cx*(RHO-cz)-cy;k4z:=cx*cy-BETA*cz
      x=x+sc*(k1x+2*k2x+2*k3x+k4x);y=y+sc*(k1y+2*k2y+2*k3y+k4y);z=z+sc*(k1z+2*k2z+2*k3z+k4z)
    }
    xs[s]=x+y+z
  }
}
func main(){
  xs:=make([]float64,N_SAMPLES)
  for i:=0;i<N_WARMUP;i++{integrate(xs)}
  samples:=make([]float64,N_RUNS)
  for i:=0;i<N_RUNS;i++{t0:=time.Now();integrate(xs);samples[i]=float64(time.Since(t0).Nanoseconds())/1e6}
  fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",medianUs(samples),checksumF64(xs),N_SAMPLES*SUBSTEPS,SUBSTEPS,N_RUNS)
}
