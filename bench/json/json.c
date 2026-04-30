// json.c — minimal JSON parse+walk for fixed-format benchmark.
// No external libs. Hand-parses the known structure.

#include "../_lib/bench.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#define SRC "{\"items\":[{\"id\":1,\"kind\":2,\"value\":10},{\"id\":2,\"kind\":3,\"value\":20},{\"id\":3,\"kind\":5,\"value\":30}],\"meta\":{\"scale\":7,\"bias\":11}}"
#define N_ITEMS 3
#define N_ITERS 512
#define N_RUNS 21
#define N_WARMUP 5

static int parse_int(const char **p) {
    int v = 0, neg = 0;
    if (**p == '-') { neg = 1; (*p)++; }
    while (**p >= '0' && **p <= '9') { v = v * 10 + (**p - '0'); (*p)++; }
    return neg ? -v : v;
}

typedef struct { int id, kind, value; } Item;
typedef struct { int scale, bias; } Meta;

typedef struct {
    Item items[N_ITEMS];
    Meta meta;
} Doc;

static uint32_t parse_and_walk(void) {
    uint32_t h = 0x811c9dc5u;
    for (int i = 0; i < N_ITERS; i++) {
        const char *p = SRC;
        Doc d;
        memset(&d, 0, sizeof(d));

        // skip to items array
        while (*p != '[') p++;
        p++; // skip [

        for (int j = 0; j < N_ITEMS; j++) {
            // skip to {
            while (*p != '{') p++;
            p++;
            // parse "id":N
            while (*p != ':') p++; p++;
            d.items[j].id = parse_int(&p);
            // parse "kind":N
            while (*p != ':') p++; p++;
            d.items[j].kind = parse_int(&p);
            // parse "value":N
            while (*p != ':') p++; p++;
            d.items[j].value = parse_int(&p);
            // skip past }
            while (*p != '}') p++; p++;
            if (j < N_ITEMS - 1) { while (*p != '{') p++; p--; }
        }

        // parse meta
        while (*p != 's') p++; // skip to "scale"
        while (*p != ':') p++; p++;
        d.meta.scale = parse_int(&p);
        while (*p != 'b') p++; // skip to "bias"
        while (*p != ':') p++; p++;
        d.meta.bias = parse_int(&p);

        // walk
        int s = d.meta.bias;
        for (int j = 0; j < N_ITEMS; j++) {
            s += d.items[j].id * d.meta.scale + d.items[j].kind + d.items[j].value;
        }
        h = mix_u32(h, (uint32_t)s);
    }
    return h;
}

int main(void) {
    uint32_t cs = 0;
    for (int i = 0; i < N_WARMUP; i++) cs = parse_and_walk();

    double samples[N_RUNS];
    for (int i = 0; i < N_RUNS; i++) {
        double t0 = now_ms();
        cs = parse_and_walk();
        samples[i] = now_ms() - t0;
    }
    print_result(median_us(samples, N_RUNS), cs, N_ITERS, 4, N_RUNS);
}
