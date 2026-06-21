#include "../_lib/bench.h"
#include <stdlib.h>
#include <string.h>

#define CIN     4
#define COUT    16
#define H       34
#define W       34
#define K       3
#define OH      (H - K + 1)   /* 32 */
#define OW      (W - K + 1)   /* 32 */
#define IN_LEN  (CIN * H * W)
#define WT_LEN  (COUT * CIN * K * K)
#define OUT_LEN (COUT * OH * OW)
#define SHIFT   11
#define N_ITERS 24
#define N_RUNS  21
#define N_WARMUP 5

static int8_t  inp[IN_LEN];
static int8_t  wt[WT_LEN];
static int32_t bias[COUT];
static uint8_t out[OUT_LEN];
static double  samples[N_RUNS];

static void fill_i8(int8_t* arr, int n, int32_t seed) {
    int32_t x = seed;
    for (int i = 0; i < n; i++) {
        x = (int32_t)((uint32_t)((int32_t)(((uint32_t)x * 1103515245u)) + 12345));
        arr[i] = (int8_t)(x >> 24);
    }
}

static void fill_bias(int32_t* arr, int n, int32_t seed) {
    int32_t x = seed;
    for (int i = 0; i < n; i++) {
        x = (int32_t)((uint32_t)((int32_t)(((uint32_t)x * 1103515245u)) + 12345));
        arr[i] = (x >> 20) & 1023;
    }
}

static void conv(const int8_t* restrict inp_, const int8_t* restrict wt_,
                 const int32_t* restrict bias_, uint8_t* restrict out_) {
    for (int oc = 0; oc < COUT; oc++) {
        int32_t b = bias_[oc];
        int ocBase = oc * OH * OW;
        for (int oy = 0; oy < OH; oy++) {
            for (int ox = 0; ox < OW; ox++) {
                int32_t acc = b;
                for (int ic = 0; ic < CIN; ic++) {
                    int inCh = ic * H * W;
                    int wCh  = ((oc * CIN) + ic) * K * K;
                    for (int ky = 0; ky < K; ky++) {
                        int irow = inCh + (oy + ky) * W + ox;
                        int wrow = wCh  + ky * K;
                        for (int kx = 0; kx < K; kx++) {
                            acc += (int32_t)inp_[irow + kx] * (int32_t)wt_[wrow + kx];
                        }
                    }
                }
                int32_t q = acc >> SHIFT;
                if (q < 0)   q = 0;
                if (q > 127) q = 127;
                out_[ocBase + oy * OW + ox] = (uint8_t)q;
            }
        }
    }
}

static uint32_t run_kernel(void) {
    uint32_t h = 0;
    for (int it = 0; it < N_ITERS; it++) {
        conv(inp, wt, bias, out);
        h = mix_u32(h, checksum_u8(out, OUT_LEN));
        int j = it % IN_LEN;
        inp[j] = (int8_t)(inp[j] + 1);
    }
    return h;
}

int main(void) {
    fill_i8(inp, IN_LEN, (int32_t)0x12345678);
    fill_i8(wt, WT_LEN, (int32_t)0x2bb3c1f7);
    fill_bias(bias, COUT, (int32_t)0x51e3a9d1);
    uint32_t cs = 0;
    for (int i = 0; i < N_WARMUP; i++) cs = run_kernel();
    for (int i = 0; i < N_RUNS; i++) {
        double t0 = now_ms();
        cs = run_kernel();
        samples[i] = now_ms() - t0;
    }
    print_result(median_us(samples, N_RUNS), cs,
                 COUT * OH * OW * CIN * K * K * N_ITERS, 1, N_RUNS);
}
