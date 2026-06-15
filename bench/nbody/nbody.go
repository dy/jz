package main
import ("fmt";"math";"time")
const(N=1024;STEPS=8;DT=0.01;EPS2=0.05;N_RUNS=21;N_WARMUP=5)
func mix(h,x uint32)uint32{return (h^x)*0x01000193}
func checksumF64(o []float64)uint32{h:=uint32(0x811c9dc5);for i:=0;i<len(o)*2;i+=256{b:=math.Float64bits(o[i/2]);var w uint32;if i&1==0{w=uint32(b)}else{w=uint32(b>>32)};h=mix(h,w)};return h}
func medianUs(s []float64)uint64{for i:=1;i<len(s);i++{v:=s[i];j:=i-1;for j>=0&&s[j]>v{s[j+1]=s[j];j--};s[j+1]=v};return uint64(s[(len(s)-1)>>1]*1000.0)}
func seed(px,py,pz,vx,vy,vz,m []float64){
  s:=int32(0x1234abcd);r:=func()float64{s^=s<<13;s^=int32(uint32(s)>>17);s^=s<<5;return float64(uint32(s))/4294967296.0*2.0-1.0}
  for i:=0;i<N;i++{px[i]=r();py[i]=r();pz[i]=r();vx[i]=r()*0.1;vy[i]=r()*0.1;vz[i]=r()*0.1;m[i]=r()+1.5}
}
func step(px,py,pz,vx,vy,vz,m []float64){
  for i:=0;i<N;i++{
    xi,yi,zi:=px[i],py[i],pz[i];ax,ay,az:=0.0,0.0,0.0
    for j:=0;j<N;j++{
      dx:=px[j]-xi;dy:=py[j]-yi;dz:=pz[j]-zi;r2:=dx*dx+dy*dy+dz*dz+EPS2;inv:=1.0/(r2*math.Sqrt(r2));f:=m[j]*inv
      ax+=dx*f;ay+=dy*f;az+=dz*f
    }
    vx[i]+=ax*DT;vy[i]+=ay*DT;vz[i]+=az*DT
  }
  for i:=0;i<N;i++{px[i]+=vx[i]*DT;py[i]+=vy[i]*DT;pz[i]+=vz[i]*DT}
}
func main(){
  px:=make([]float64,N);py:=make([]float64,N);pz:=make([]float64,N);vx:=make([]float64,N);vy:=make([]float64,N);vz:=make([]float64,N);m:=make([]float64,N)
  for i:=0;i<N_WARMUP;i++{seed(px,py,pz,vx,vy,vz,m);for s:=0;s<STEPS;s++{step(px,py,pz,vx,vy,vz,m)}}
  samples:=make([]float64,N_RUNS)
  for i:=0;i<N_RUNS;i++{seed(px,py,pz,vx,vy,vz,m);t0:=time.Now();for s:=0;s<STEPS;s++{step(px,py,pz,vx,vy,vz,m)};samples[i]=float64(time.Since(t0).Nanoseconds())/1e6}
  fmt.Printf("median_us=%d checksum=%d samples=%d stages=%d runs=%d\n",medianUs(samples),checksumF64(px)^checksumF64(vx),N*N*STEPS,STEPS,N_RUNS)
}
