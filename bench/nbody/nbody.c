/* nbody.c — direct-summation N-body. Bit-identical to nbody.js. */
#include "../_lib/bench.h"
#include <stdlib.h>
#include <math.h>
#define N 1024
#define STEPS 8
#define DT 0.01
#define EPS2 0.05
#define N_RUNS 21
#define N_WARMUP 5
static double px[N],py[N],pz[N],vx[N],vy[N],vz[N],m[N];
static void seed(void){
  int32_t s=0x1234abcd;
  #define R (s^=s<<13, s^=(int32_t)((uint32_t)s>>17), s^=s<<5, (double)(uint32_t)s/4294967296.0*2.0-1.0)
  for(int i=0;i<N;i++){ px[i]=R;py[i]=R;pz[i]=R; vx[i]=R*0.1;vy[i]=R*0.1;vz[i]=R*0.1; m[i]=R+1.5; }
}
static void step(void){
  for(int i=0;i<N;i++){
    double xi=px[i],yi=py[i],zi=pz[i],ax=0,ay=0,az=0;
    for(int j=0;j<N;j++){
      double dx=px[j]-xi,dy=py[j]-yi,dz=pz[j]-zi;
      double r2=dx*dx+dy*dy+dz*dz+EPS2;
      double inv=1.0/(r2*sqrt(r2));
      double f=m[j]*inv;
      ax+=dx*f;ay+=dy*f;az+=dz*f;
    }
    vx[i]+=ax*DT;vy[i]+=ay*DT;vz[i]+=az*DT;
  }
  for(int i=0;i<N;i++){px[i]+=vx[i]*DT;py[i]+=vy[i]*DT;pz[i]+=vz[i]*DT;}
}
int main(void){
  double samples[N_RUNS];
  for(int i=0;i<N_WARMUP;i++){seed();for(int s=0;s<STEPS;s++)step();}
  for(int i=0;i<N_RUNS;i++){seed();double t0=now_ms();for(int s=0;s<STEPS;s++)step();samples[i]=now_ms()-t0;}
  uint32_t cs=checksum_f64(px,N)^checksum_f64(vx,N);
  print_result(median_us(samples,N_RUNS),cs,N*N*STEPS,STEPS,N_RUNS);
  return 0;
}
