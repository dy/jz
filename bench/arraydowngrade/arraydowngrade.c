// arraydowngrade.c – a plain array that starts numeric and stops being so: a
// quarter million integers pushed one by one, an object and a string stored in
// the middle, then 25 passes that add 1 to every numeric slot on both sides of
// them, ported from arraydowngrade.js (Perry's
// bench_numeric_array_downgrade.ts, https://github.com/PerryTS/perry,
// benchmarks/suite, MIT).
//
// A JS array of mixed values is a growable buffer of tagged unions (a number,
// an object, a string), its capacity doubled by realloc as push fills it; the
// object `{ value: 7 }` is a struct on the heap the array owns, the string a
// pointer and a length. `arr[i] = arr[i] + 1` is JS's `+` on a slot of any
// kind: a number adds, a string concatenates, an object concatenates its
// string form, so add_one tests the tag of every slot it updates and adds to a
// number in place; the passes never reach the string or the object, so the
// concatenations never run. Each run frees what it built, as the JS drops its
// array.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every run's result
// and every slot of one more run's array, as the JS folds them (a number as
// itself, the object by its field, the string by its length).
#include "../_lib/bench.h"
#include <math.h>
#include <stdlib.h>

#define SIZE         250000
#define ITERATIONS   25
#define OBJECT_INDEX 125000
#define STRING_INDEX 125001
#define N_RUNS       21
#define N_WARMUP     3

typedef struct { double value; } Obj;

typedef enum { NUM, OBJ, STR } Kind;

typedef struct {
  Kind kind;
  union {
    double num;                                  // NUM
    Obj *obj;                                    // OBJ
    struct { const char *s; size_t len; } str;   // STR: a literal, or a concatenation the array owns
  };
} Value;

typedef struct { Value *at; size_t len, cap; } Array;

static const char PAYLOAD[] = "numeric-array-downgrade-payload";
static const char OBJECT_STRING[] = "[object Object]";

static void push(Array *a, Value v) {
  if (a->len == a->cap) {
    a->cap = a->cap ? a->cap * 2 : 4;
    a->at = realloc(a->at, a->cap * sizeof *a->at);
    if (!a->at) { perror("realloc"); exit(1); }
  }
  a->at[a->len++] = v;
}

static Value num_value(double x) { return (Value){ .kind = NUM, .num = x }; }

static Value str_value(const char *s, size_t len) { return (Value){ .kind = STR, .str = { s, len } }; }

static int owned(Value v) { return v.kind == STR && v.str.s != PAYLOAD; }

// String(a) + "1"
static Value concat_one(const char *s, size_t len) {
  char *t = malloc(len + 2);
  if (!t) { perror("malloc"); exit(1); }
  memcpy(t, s, len);
  t[len] = '1';
  t[len + 1] = '\0';
  return str_value(t, len + 1);
}

// a slot overwritten: what the array owns there goes, as the JS's goes to its collector
static void set(Array *a, size_t i, Value v) {
  Value old = a->at[i];
  if (old.kind == OBJ) free(old.obj);
  else if (owned(old)) free((char *)old.str.s);
  a->at[i] = v;
}

// arr[i] = arr[i] + 1, JS's `+`
static void add_one(Array *a, size_t i) {
  Value *v = &a->at[i];
  switch (v->kind) {
    case NUM: v->num += 1; break;
    case STR: set(a, i, concat_one(v->str.s, v->str.len)); break;
    default:  set(a, i, concat_one(OBJECT_STRING, sizeof OBJECT_STRING - 1)); break;
  }
}

// a slot in a numeric sum: a number, or NaN (an undefined field, a string's concatenation never taken here)
static double num(Value v) { return v.kind == NUM ? v.num : NAN; }

static double field_value(Value v) { return v.kind == OBJ ? v.obj->value : NAN; }

static Array build_downgraded_array(void) {
  Array arr = { 0 };
  for (int i = 0; i < SIZE; i++) {
    push(&arr, num_value(i));
  }

  Obj *o = malloc(sizeof *o);
  if (!o) { perror("malloc"); exit(1); }
  o->value = 7;
  set(&arr, OBJECT_INDEX, (Value){ .kind = OBJ, .obj = o });
  set(&arr, STRING_INDEX, str_value(PAYLOAD, sizeof PAYLOAD - 1));
  return arr;
}

static double mutate_downgraded_array(Array *arr) {
  double checksum = 0;

  for (int iter = 0; iter < ITERATIONS; iter++) {
    for (size_t i = 0; i < OBJECT_INDEX; i++) {
      add_one(arr, i);
    }
    for (size_t i = STRING_INDEX + 1; i < arr->len; i++) {
      add_one(arr, i);
    }

    checksum = checksum + num(arr->at[0]) + num(arr->at[arr->len - 1]) + field_value(arr->at[OBJECT_INDEX]);
    Value s = arr->at[STRING_INDEX];
    if (!(s.kind == STR && s.str.len == 0)) {
      checksum = checksum + 3;
    }
  }

  return checksum + (double)arr->len;
}

static void free_array(Array *arr) {
  for (size_t i = 0; i < arr->len; i++) {
    if (arr->at[i].kind == OBJ) free(arr->at[i].obj);
    else if (owned(arr->at[i])) free((char *)arr->at[i].str.s);
  }
  free(arr->at);
}

static double run_downgraded_array(void) {
  Array arr = build_downgraded_array();
  double cs = mutate_downgraded_array(&arr);
  free_array(&arr);
  return cs;
}

// x | 0 for the integers these sums hold
static uint32_t i32(double x) { return (uint32_t)(int32_t)x; }

int main(void) {
  for (int i = 0; i < N_WARMUP; i++) run_downgraded_array();

  uint32_t h = 0x811c9dc5u;
  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    double cs = run_downgraded_array();
    samples[i] = now_ms() - t0;
    h = mix_u32(h, i32(cs));
  }

  Array arr = build_downgraded_array();
  h = mix_u32(h, i32(mutate_downgraded_array(&arr)));
  for (size_t i = 0; i < arr.len; i++) {
    Value v = arr.at[i];
    h = mix_u32(h, v.kind == NUM ? i32(v.num) : v.kind == STR ? (uint32_t)v.str.len : i32(v.obj->value));
  }
  print_result(median_us(samples, N_RUNS), h, SIZE, 2, N_RUNS);

  free_array(&arr);
  return 0;
}
