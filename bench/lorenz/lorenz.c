/* lorenz.c — Lorenz attractor RK4. Bit-identical to lorenz.js. */
#include "../_lib/bench.h"
#define N_SAMPLES (1<<16)
#define SUBSTEPS 16
#define DT 0.002
#define SIGMA 10.0
#define RHO 28.0
#define BETA (8.0/3.0)
#define N_RUNS 21
#define N_WARMUP 5
static double xs[N_SAMPLES];
static void integrate(void){
  const double H=DT*0.5, S=DT/6;
  double x=0.1,y=0.0,z=0.0;
  for(int s=0;s<N_SAMPLES;s++){
    for(int i=0;i<SUBSTEPS;i++){
      double k1x=SIGMA*(y-x), k1y=x*(RHO-z)-y, k1z=x*y-BETA*z;
      double ax=x+k1x*H, ay=y+k1y*H, az=z+k1z*H;
      double k2x=SIGMA*(ay-ax), k2y=ax*(RHO-az)-ay, k2z=ax*ay-BETA*az;
      double bx=x+k2x*H, by=y+k2y*H, bz=z+k2z*H;
      double k3x=SIGMA*(by-bx), k3y=bx*(RHO-bz)-by, k3z=bx*by-BETA*bz;
      double cx=x+k3x*DT, cy=y+k3y*DT, cz=z+k3z*DT;
      double k4x=SIGMA*(cy-cx), k4y=cx*(RHO-cz)-cy, k4z=cx*cy-BETA*cz;
      x=x+S*(k1x+2*k2x+2*k3x+k4x);
      y=y+S*(k1y+2*k2y+2*k3y+k4y);
      z=z+S*(k1z+2*k2z+2*k3z+k4z);
    }
    xs[s]=x+y+z;
  }
}
int main(void){
  double samples[N_RUNS];
  for(int i=0;i<N_WARMUP;i++)integrate();
  for(int i=0;i<N_RUNS;i++){double t0=now_ms();integrate();samples[i]=now_ms()-t0;}
  print_result(median_us(samples,N_RUNS),checksum_f64(xs,N_SAMPLES),N_SAMPLES*SUBSTEPS,SUBSTEPS,N_RUNS);
  return 0;
}
