// json.c — general JSON parser (tagged-union + bump arena) for benchmark.
// No external libs. Parses arbitrary JSON into a generic value graph.

#include "../_lib/bench.h"
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

static const char SRC[] = "{\"items\":[{\"id\":1,\"kind\":2,\"value\":10},{\"id\":2,\"kind\":3,\"value\":20},{\"id\":3,\"kind\":5,\"value\":30}],\"meta\":{\"scale\":7,\"bias\":11}}";
#define N_ITERS 512
#define N_RUNS 21
#define N_WARMUP 5

// ── Arena ─────────────────────────────────────────────────────────────────────
#define ARENA_SIZE (1 << 20)  // 1 MB — enough for the test JSON repeated 512x
static char g_arena[ARENA_SIZE];
static size_t g_arena_off;

static void arena_reset(void) { g_arena_off = 0; }

static void *arena_alloc(size_t n) {
    // 8-byte align
    size_t off = (g_arena_off + 7u) & ~7u;
    g_arena_off = off + n;
    return g_arena + off;
}

static char *arena_strdup(const char *s, size_t len) {
    char *p = arena_alloc(len + 1);
    memcpy(p, s, len);
    p[len] = '\0';
    return p;
}

// ── Value ─────────────────────────────────────────────────────────────────────
typedef enum { JNull, JBool, JNum, JStr, JArr, JObj } JType;

typedef struct JVal JVal;

typedef struct { char *key; JVal *val; } JPair;

struct JVal {
    JType type;
    union {
        int     b;      // JBool
        double  n;      // JNum
        char   *s;      // JStr
        struct { JVal **items; int len; } arr;  // JArr
        struct { JPair *pairs; int len; } obj;  // JObj
    };
};

// ── Parser ────────────────────────────────────────────────────────────────────
typedef struct { const char *p; const char *end; } Parser;

static void skip_ws(Parser *ps) {
    while (ps->p < ps->end && (*ps->p == ' ' || *ps->p == '\t' ||
                                *ps->p == '\n' || *ps->p == '\r'))
        ps->p++;
}

static JVal *parse_value(Parser *ps);  // forward

static JVal *make_val(JType t) {
    JVal *v = arena_alloc(sizeof(JVal));
    v->type = t;
    return v;
}

static JVal *parse_string_val(Parser *ps) {
    // ps->p points at opening "
    ps->p++; // skip "
    const char *start = ps->p;
    // scan for closing " (no escape handling needed for our JSON, but handle \)
    while (ps->p < ps->end && *ps->p != '"') {
        if (*ps->p == '\\') ps->p++; // skip escaped char
        ps->p++;
    }
    size_t len = (size_t)(ps->p - start);
    JVal *v = make_val(JStr);
    v->s = arena_strdup(start, len);
    if (ps->p < ps->end) ps->p++; // skip closing "
    return v;
}

static JVal *parse_number(Parser *ps) {
    const char *start = ps->p;
    if (*ps->p == '-') ps->p++;
    while (ps->p < ps->end && *ps->p >= '0' && *ps->p <= '9') ps->p++;
    if (ps->p < ps->end && *ps->p == '.') {
        ps->p++;
        while (ps->p < ps->end && *ps->p >= '0' && *ps->p <= '9') ps->p++;
    }
    if (ps->p < ps->end && (*ps->p == 'e' || *ps->p == 'E')) {
        ps->p++;
        if (ps->p < ps->end && (*ps->p == '+' || *ps->p == '-')) ps->p++;
        while (ps->p < ps->end && *ps->p >= '0' && *ps->p <= '9') ps->p++;
    }
    // parse double from the range [start, ps->p)
    char buf[64];
    size_t n = (size_t)(ps->p - start);
    if (n >= sizeof(buf)) n = sizeof(buf) - 1;
    memcpy(buf, start, n); buf[n] = '\0';
    JVal *v = make_val(JNum);
    v->n = strtod(buf, NULL);
    return v;
}

static JVal *parse_array(Parser *ps) {
    ps->p++; // skip [
    // collect into a small growable list on the arena; we over-allocate slots
    // by building a slab of pointers.  We use a two-pass approach: collect
    // pointers into a temporary stack array then copy to arena.
    JVal *tmp_items[1024];
    int len = 0;
    skip_ws(ps);
    if (ps->p < ps->end && *ps->p == ']') { ps->p++; goto done; }
    while (ps->p < ps->end) {
        tmp_items[len++] = parse_value(ps);
        skip_ws(ps);
        if (ps->p >= ps->end || *ps->p == ']') { ps->p++; break; }
        ps->p++; // skip ','
        skip_ws(ps);
    }
done:;
    JVal *v = make_val(JArr);
    v->arr.len = len;
    if (len > 0) {
        v->arr.items = arena_alloc(sizeof(JVal *) * (size_t)len);
        memcpy(v->arr.items, tmp_items, sizeof(JVal *) * (size_t)len);
    } else {
        v->arr.items = NULL;
    }
    return v;
}

static JVal *parse_object(Parser *ps) {
    ps->p++; // skip {
    JPair tmp_pairs[64];
    int len = 0;
    skip_ws(ps);
    if (ps->p < ps->end && *ps->p == '}') { ps->p++; goto done; }
    while (ps->p < ps->end) {
        skip_ws(ps);
        // parse key string
        const char *ks = ps->p + 1; // after "
        ps->p++; // skip "
        while (ps->p < ps->end && *ps->p != '"') {
            if (*ps->p == '\\') ps->p++;
            ps->p++;
        }
        size_t klen = (size_t)(ps->p - ks);
        char *key = arena_strdup(ks, klen);
        if (ps->p < ps->end) ps->p++; // skip "
        skip_ws(ps);
        ps->p++; // skip ':'
        skip_ws(ps);
        JVal *val = parse_value(ps);
        tmp_pairs[len].key = key;
        tmp_pairs[len].val = val;
        len++;
        skip_ws(ps);
        if (ps->p >= ps->end || *ps->p == '}') { ps->p++; break; }
        ps->p++; // skip ','
        skip_ws(ps);
    }
done:;
    JVal *v = make_val(JObj);
    v->obj.len = len;
    if (len > 0) {
        v->obj.pairs = arena_alloc(sizeof(JPair) * (size_t)len);
        memcpy(v->obj.pairs, tmp_pairs, sizeof(JPair) * (size_t)len);
    } else {
        v->obj.pairs = NULL;
    }
    return v;
}

static JVal *parse_value(Parser *ps) {
    skip_ws(ps);
    char c = *ps->p;
    if (c == '"') return parse_string_val(ps);
    if (c == '{') return parse_object(ps);
    if (c == '[') return parse_array(ps);
    if (c == 'n') { ps->p += 4; return make_val(JNull); }
    if (c == 't') { JVal *v = make_val(JBool); v->b = 1; ps->p += 4; return v; }
    if (c == 'f') { JVal *v = make_val(JBool); v->b = 0; ps->p += 5; return v; }
    return parse_number(ps);
}

// ── Walk helpers ──────────────────────────────────────────────────────────────
// Linear scan for object key — general, no schema knowledge.
static JVal *obj_get(JVal *v, const char *key) {
    if (!v || v->type != JObj) return NULL;
    for (int i = 0; i < v->obj.len; i++)
        if (strcmp(v->obj.pairs[i].key, key) == 0)
            return v->obj.pairs[i].val;
    return NULL;
}

static int32_t num_i32(JVal *v) {
    if (!v || v->type != JNum) return 0;
    return (int32_t)(int64_t)v->n;  // truncate double → int like JS |(0)
}

// ── Bench ─────────────────────────────────────────────────────────────────────
static uint32_t parse_and_walk(void) {
    uint32_t h = 0x811c9dc5u;
    for (int i = 0; i < N_ITERS; i++) {
        arena_reset();

        Parser ps;
        ps.p = SRC;
        ps.end = SRC + strlen(SRC);

        JVal *root = parse_value(&ps);

        // Walk: mirror the JS reference exactly.
        JVal *items = obj_get(root, "items");
        JVal *meta  = obj_get(root, "meta");
        int32_t scale = num_i32(obj_get(meta, "scale"));
        int32_t s     = num_i32(obj_get(meta, "bias"));

        int n = (items && items->type == JArr) ? items->arr.len : 0;
        for (int j = 0; j < n; j++) {
            JVal *it = items->arr.items[j];
            int32_t id    = num_i32(obj_get(it, "id"));
            int32_t kind  = num_i32(obj_get(it, "kind"));
            int32_t value = num_i32(obj_get(it, "value"));
            s += id * scale + kind + value;
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
