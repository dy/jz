// jsonroundtrip.c – JSON.parse then JSON.stringify of one ~1 MB document,
// ported from jsonroundtrip.js (Perry's bench_json_roundtrip.ts,
// https://github.com/PerryTS/perry, benchmarks/suite, MIT): 10,000 records of
// an integer id, a string name, a float value, an array of two tag strings and
// a nested {x, y} object, written once, then parsed into a generic tree and
// written back.
//
// C has no JSON in its standard library, so both directions are written here,
// jsontransform.c's parser and writer unchanged: a recursive descent into a
// tagged-union tree in an arena of 64 KiB blocks (objects as members in
// insertion order, numbers read with strtod), and a writer of QuoteJSONString's
// escapes and Number::toString's shortest digits (snprintf and strtod, the
// first of 15, 16 and 17 digits that reads back). The writer walks the tree as
// JSON.stringify walks the parsed value.
//
// The document is generated once exactly as the JS generates it, written by
// the same writer, outside the timed region. The timed region is one round
// trip: parse, write, free the tree and the previous text. Perry's sum adds the
// parsed array's length and the text's length; the text is ASCII, so its byte
// length is its UTF-16 length.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over that sum, then the
// last run's text as the JS folds it: its UTF-16 length, then its UTF-16 code
// units.
#include "../_lib/bench.h"
#include <float.h>
#include <math.h>
#include <stddef.h>
#include <stdlib.h>

#define N        10000  // records in the document
#define N_RUNS   21
#define N_WARMUP 5

// ── Output buffer ───────────────────────────────────────────────────────────
typedef struct { char *s; size_t len, cap; } Str;

static void reserve(Str *b, size_t n) {
  if (b->len + n <= b->cap) return;
  size_t cap = b->cap ? b->cap : 128;
  while (cap < b->len + n) cap *= 2;
  b->s = realloc(b->s, cap);
  if (!b->s) { perror("realloc"); exit(1); }
  b->cap = cap;
}

static void put(Str *b, const char *p, size_t n) {
  reserve(b, n);
  memcpy(b->s + b->len, p, n);
  b->len += n;
}

static void put_ch(Str *b, char c) {
  reserve(b, 1);
  b->s[b->len++] = c;
}

// ── Value tree ──────────────────────────────────────────────────────────────
typedef enum { J_NULL, J_BOOL, J_NUM, J_STR, J_ARR, J_OBJ } Kind;

typedef struct Value Value;
typedef struct Member Member;

struct Value {
  Kind kind;
  union {
    int b;                                       // J_BOOL
    double num;                                  // J_NUM
    struct { const char *s; size_t len; } str;   // J_STR: UTF-8, NUL-terminated
    struct { Value *at; size_t len; } arr;       // J_ARR
    struct { Member *at; size_t len; } obj;      // J_OBJ: members in insertion order
  };
};

struct Member { const char *key; size_t key_len; Value val; };

static size_t length(const Value *v) { return v->kind == J_ARR ? v->arr.len : 0; }

// ── Arena ───────────────────────────────────────────────────────────────────
#define BLOCK (64 * 1024)

typedef struct Block { struct Block *next; size_t used, size; max_align_t data[]; } Block;
typedef struct { Block *head; } Arena;

// every allocation rounded to 8 bytes, a double's alignment
static void *arena_alloc(Arena *a, size_t n) {
  n = (n + 7) & ~(size_t)7;
  Block *b = a->head;
  if (!b || b->size - b->used < n) {
    size_t size = n > BLOCK ? n : BLOCK;
    b = malloc(sizeof *b + size);
    if (!b) { perror("malloc"); exit(1); }
    b->next = a->head;
    b->used = 0;
    b->size = size;
    a->head = b;
  }
  void *p = (char *)b->data + b->used;
  b->used += n;
  return p;
}

static void arena_free(Arena *a) {
  while (a->head) {
    Block *b = a->head;
    a->head = b->next;
    free(b);
  }
}

// a container's slots, doubled: the outgrown block stays in the arena until it is freed
static void *grow(Arena *a, void *old, size_t len, size_t *cap, size_t size) {
  *cap = *cap ? *cap * 2 : 4;
  void *p = arena_alloc(a, *cap * size);
  if (len) memcpy(p, old, len * size);
  return p;
}

// ── Parser ──────────────────────────────────────────────────────────────────
// Each parse function returns 0 on text that is not JSON; the text ends at a NUL.
typedef struct {
  const char *p;  // the next unread byte
  Arena *arena;
} Parser;

static int parse_value(Parser *ps, Value *v);

static int is_digit(char c) { return c >= '0' && c <= '9'; }

static void skip_ws(Parser *ps) {
  while (*ps->p == ' ' || *ps->p == '\t' || *ps->p == '\n' || *ps->p == '\r') ps->p++;
}

static int hex4(const char *p, uint32_t *out) {
  uint32_t x = 0;
  for (int i = 0; i < 4; i++) {
    char c = p[i];
    uint32_t d;
    if (is_digit(c)) d = (uint32_t)(c - '0');
    else if (c >= 'a' && c <= 'f') d = (uint32_t)(c - 'a' + 10);
    else if (c >= 'A' && c <= 'F') d = (uint32_t)(c - 'A' + 10);
    else return 0;
    x = x << 4 | d;
  }
  *out = x;
  return 1;
}

static char *put_utf8(char *o, uint32_t cp) {
  if (cp < 0x80) *o++ = (char)cp;
  else if (cp < 0x800) {
    *o++ = (char)(0xc0 | cp >> 6);
    *o++ = (char)(0x80 | (cp & 0x3f));
  } else if (cp < 0x10000) {
    *o++ = (char)(0xe0 | cp >> 12);
    *o++ = (char)(0x80 | (cp >> 6 & 0x3f));
    *o++ = (char)(0x80 | (cp & 0x3f));
  } else {
    *o++ = (char)(0xf0 | cp >> 18);
    *o++ = (char)(0x80 | (cp >> 12 & 0x3f));
    *o++ = (char)(0x80 | (cp >> 6 & 0x3f));
    *o++ = (char)(0x80 | (cp & 0x3f));
  }
  return o;
}

// A string, decoded into the arena: never longer than its raw text, so the raw
// length (found first) sizes the copy. UTF-8 holds no lone surrogate, so a
// \uXXXX escape of one is rejected.
static int parse_string(Parser *ps, const char **s, size_t *len) {
  const char *p = ++ps->p, *q = p;
  while (*q != '"') {
    if ((unsigned char)*q < 0x20) return 0;  // a control character, or the end of the text
    if (*q == '\\' && *++q == '\0') return 0;
    q++;
  }
  char *start = arena_alloc(ps->arena, (size_t)(q - p) + 1), *o = start;
  while (p < q) {
    if (*p != '\\') { *o++ = *p++; continue; }
    p++;
    switch (*p++) {
      case '"':  *o++ = '"'; break;
      case '\\': *o++ = '\\'; break;
      case '/':  *o++ = '/'; break;
      case 'b':  *o++ = '\b'; break;
      case 'f':  *o++ = '\f'; break;
      case 'n':  *o++ = '\n'; break;
      case 'r':  *o++ = '\r'; break;
      case 't':  *o++ = '\t'; break;
      case 'u': {
        uint32_t cp, lo;
        if (!hex4(p, &cp)) return 0;
        p += 4;
        if (cp >= 0xdc00 && cp < 0xe000) return 0;
        if (cp >= 0xd800 && cp < 0xdc00) {
          if (p[0] != '\\' || p[1] != 'u' || !hex4(p + 2, &lo) || lo < 0xdc00 || lo >= 0xe000) return 0;
          p += 6;
          cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
        }
        o = put_utf8(o, cp);
        break;
      }
      default: return 0;
    }
  }
  *o = '\0';
  *s = start;
  *len = (size_t)(o - start);
  ps->p = q + 1;
  return 1;
}

// -?(0|[1-9][0-9]*)(.[0-9]+)?([eE][+-]?[0-9]+)?, then strtod reads that token
static int parse_number(Parser *ps, double *x) {
  const char *q = ps->p;
  if (*q == '-') q++;
  if (*q == '0') q++;
  else if (is_digit(*q)) while (is_digit(*q)) q++;
  else return 0;
  if (*q == '.') {
    if (!is_digit(*++q)) return 0;
    while (is_digit(*q)) q++;
  }
  if (*q == 'e' || *q == 'E') {
    q++;
    if (*q == '+' || *q == '-') q++;
    if (!is_digit(*q)) return 0;
    while (is_digit(*q)) q++;
  }
  *x = strtod(ps->p, NULL);
  ps->p = q;
  return 1;
}

static int parse_literal(Parser *ps, const char *word) {
  size_t n = strlen(word);
  if (strncmp(ps->p, word, n) != 0) return 0;
  ps->p += n;
  return 1;
}

static int parse_array(Parser *ps, Value *v) {
  Value *slots = NULL;
  size_t len = 0, cap = 0;
  ps->p++;  // [
  skip_ws(ps);
  if (*ps->p == ']') ps->p++;
  else for (;;) {
    if (len == cap) slots = grow(ps->arena, slots, len, &cap, sizeof *slots);
    if (!parse_value(ps, &slots[len])) return 0;
    len++;
    skip_ws(ps);
    if (*ps->p == ',') { ps->p++; continue; }
    if (*ps->p != ']') return 0;
    ps->p++;
    break;
  }
  *v = (Value){ .kind = J_ARR, .arr = { slots, len } };
  return 1;
}

static int parse_object(Parser *ps, Value *v) {
  Member *slots = NULL;
  size_t len = 0, cap = 0;
  ps->p++;  // {
  skip_ws(ps);
  if (*ps->p == '}') ps->p++;
  else for (;;) {
    if (len == cap) slots = grow(ps->arena, slots, len, &cap, sizeof *slots);
    Member *m = &slots[len];
    skip_ws(ps);
    if (*ps->p != '"' || !parse_string(ps, &m->key, &m->key_len)) return 0;
    skip_ws(ps);
    if (*ps->p != ':') return 0;
    ps->p++;
    if (!parse_value(ps, &m->val)) return 0;
    len++;
    skip_ws(ps);
    if (*ps->p == ',') { ps->p++; continue; }
    if (*ps->p != '}') return 0;
    ps->p++;
    break;
  }
  *v = (Value){ .kind = J_OBJ, .obj = { slots, len } };
  return 1;
}

static int parse_value(Parser *ps, Value *v) {
  skip_ws(ps);
  switch (*ps->p) {
    case '{': return parse_object(ps, v);
    case '[': return parse_array(ps, v);
    case '"': v->kind = J_STR; return parse_string(ps, &v->str.s, &v->str.len);
    case 't': *v = (Value){ .kind = J_BOOL, .b = 1 }; return parse_literal(ps, "true");
    case 'f': *v = (Value){ .kind = J_BOOL, .b = 0 }; return parse_literal(ps, "false");
    case 'n': *v = (Value){ .kind = J_NULL }; return parse_literal(ps, "null");
    default:  v->kind = J_NUM; return parse_number(ps, &v->num);
  }
}

static int parse(const char *text, Arena *arena, Value *doc) {
  Parser ps = { text, arena };
  if (!parse_value(&ps, doc)) return 0;
  skip_ws(&ps);
  return *ps.p == '\0';
}

// ── Writer ──────────────────────────────────────────────────────────────────
typedef struct {
  Str out;
  int first;  // nothing written yet in the innermost open container
} Writer;

// before a member or an element
static void w_sep(Writer *w) {
  if (!w->first) put_ch(&w->out, ',');
  w->first = 0;
}

static void w_begin(Writer *w, char c) { put_ch(&w->out, c); w->first = 1; }
static void w_end(Writer *w, char c) { put_ch(&w->out, c); w->first = 0; }

// QuoteJSONString (ECMA-262)
static void w_str(Writer *w, const char *s, size_t n) {
  static const char HEX[] = "0123456789abcdef";
  Str *b = &w->out;
  put_ch(b, '"');
  size_t start = 0;
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c >= 0x20 && c != '"' && c != '\\') continue;
    put(b, s + start, i - start);
    start = i + 1;
    switch (c) {
      case '"':  put(b, "\\\"", 2); break;
      case '\\': put(b, "\\\\", 2); break;
      case '\b': put(b, "\\b", 2); break;
      case '\f': put(b, "\\f", 2); break;
      case '\n': put(b, "\\n", 2); break;
      case '\r': put(b, "\\r", 2); break;
      case '\t': put(b, "\\t", 2); break;
      default: {
        char e[6] = { '\\', 'u', '0', '0', HEX[c >> 4], HEX[c & 15] };
        put(b, e, 6);
      }
    }
  }
  put(b, s + start, n - start);
  put_ch(b, '"');
}

static void w_cstr(Writer *w, const char *s) { w_str(w, s, strlen(s)); }

static void w_key(Writer *w, const char *k) {
  w_sep(w);
  w_cstr(w, k);
  put_ch(&w->out, ':');
}

static void w_lit(Writer *w, const char *s) { put(&w->out, s, strlen(s)); }

static void w_int(Writer *w, int64_t v) {
  char d[20];
  int i = 20;
  uint64_t u = v < 0 ? -(uint64_t)v : (uint64_t)v;
  do { d[--i] = (char)('0' + u % 10); u /= 10; } while (u);
  if (v < 0) d[--i] = '-';
  put(&w->out, d + i, (size_t)(20 - i));
}

// The shortest digits d1..dk, x = 0.d1..dk × 10^n, that read back as x > 0,
// and the closest to x among them (ECMAScript's choice). snprintf gives the
// p-digit decimal nearest x (ties to even) and strtod tells whether it reads
// back; the first p that does is k. Fifteen digits always suffice for a normal
// double, so the search starts there, and the nearest decimal is the closest
// one that reads back, except:
// - below DBL_MIN a double has fewer significant bits, so fewer digits can
//   suffice: the search starts at 1;
// - an exact power of two reads back from only half as far below it as above,
//   so when the nearest p digits fall short below it, the next p-digit decimal
//   up may still read back.
static int shortest(double x, char *d, int *n) {
  int e2;
  int pow2 = frexp(x, &e2) == 0.5;
  for (int p = x < DBL_MIN ? 1 : 15; p <= 17; p++) {
    char e[32];  // d.ddde±xx
    snprintf(e, sizeof e, "%.*e", p - 1, x);
    double y = strtod(e, NULL);
    int k = 0;
    const char *s = e;
    for (; *s != 'e'; s++) if (*s != '.') d[k++] = *s;
    *n = atoi(s + 1) + 1;
    if (y < x && pow2) {
      int i = k - 1;  // one unit up in the last digit
      while (i >= 0 && d[i] == '9') d[i--] = '0';
      if (i >= 0) d[i]++;
      else { d[0] = '1'; ++*n; }
      snprintf(e, sizeof e, "%.*se%d", k, d, *n - k);
      y = strtod(e, NULL);
    }
    if (y == x) {
      while (d[k - 1] == '0') k--;
      return k;
    }
  }
  return 17;  // not reached: 17 digits always read back
}

// Number::toString (ECMA-262): x = 0.d1..dk × 10^n written as an integer while
// k <= n <= 21, as a decimal while -6 < n <= 21, else in exponent form (1.5e-7,
// 1e+21).
static void w_num(Writer *w, double x) {
  if (!isfinite(x)) { w_lit(w, "null"); return; }  // as JSON.stringify writes NaN and Infinity
  if (x == floor(x) && fabs(x) < 9007199254740992.0) { w_int(w, (int64_t)x); return; }  // -0 too, as 0

  char d[17];
  int n, k = shortest(fabs(x), d, &n);
  Str *b = &w->out;
  if (x < 0) put_ch(b, '-');
  if (k <= n && n <= 21) {
    put(b, d, (size_t)k);
    for (int i = k; i < n; i++) put_ch(b, '0');
  } else if (0 < n && n <= 21) {
    put(b, d, (size_t)n);
    put_ch(b, '.');
    put(b, d + n, (size_t)(k - n));
  } else if (-6 < n && n <= 0) {
    put(b, "0.", 2);
    for (int i = n; i < 0; i++) put_ch(b, '0');
    put(b, d, (size_t)k);
  } else {
    put_ch(b, d[0]);
    if (k > 1) { put_ch(b, '.'); put(b, d + 1, (size_t)(k - 1)); }
    put_ch(b, 'e');
    put_ch(b, n >= 1 ? '+' : '-');
    w_int(w, n >= 1 ? n - 1 : 1 - n);
  }
}

// any value, as JSON.stringify walks one
static void w_value(Writer *w, const Value *v) {
  switch (v->kind) {
    case J_NULL: w_lit(w, "null"); break;
    case J_BOOL: w_lit(w, v->b ? "true" : "false"); break;
    case J_NUM:  w_num(w, v->num); break;
    case J_STR:  w_str(w, v->str.s, v->str.len); break;
    case J_ARR:
      w_begin(w, '[');
      for (size_t i = 0; i < v->arr.len; i++) { w_sep(w); w_value(w, &v->arr.at[i]); }
      w_end(w, ']');
      break;
    case J_OBJ:
      w_begin(w, '{');
      for (size_t i = 0; i < v->obj.len; i++) {
        const Member *m = &v->obj.at[i];
        w_sep(w);
        w_str(w, m->key, m->key_len);
        put_ch(&w->out, ':');
        w_value(w, &m->val);
      }
      w_end(w, '}');
      break;
  }
}

// ── Document ────────────────────────────────────────────────────────────────
// the JS's items, written by JSON.stringify
static char *make_blob(void) {
  Writer w = { 0 };
  w_begin(&w, '[');
  for (int i = 0; i < N; i++) {
    char name[16];
    snprintf(name, sizeof name, "item_%d", i);
    char tag10[8], tag5[8];
    snprintf(tag10, sizeof tag10, "tag_%d", i % 10);
    snprintf(tag5, sizeof tag5, "tag_%d", i % 5);
    w_sep(&w);
    w_begin(&w, '{');
    w_key(&w, "id");     w_int(&w, i);
    w_key(&w, "name");   w_cstr(&w, name);
    w_key(&w, "value");  w_num(&w, i * 3.14159);
    w_key(&w, "tags");   w_begin(&w, '[');
    w_sep(&w); w_cstr(&w, tag10);
    w_sep(&w); w_cstr(&w, tag5);
    w_end(&w, ']');
    w_key(&w, "nested"); w_begin(&w, '{');
    w_key(&w, "x");      w_int(&w, i);
    w_key(&w, "y");      w_int(&w, (int64_t)i * 2);
    w_end(&w, '}');
    w_end(&w, '}');
  }
  w_end(&w, ']');
  put_ch(&w.out, '\0');
  return w.out.s;
}

// ── Round trip ──────────────────────────────────────────────────────────────
// JSON.stringify(JSON.parse(text)); *len is the parsed array's length
static Str round_trip(const char *text, size_t *len) {
  Arena arena = { 0 };
  Value doc;
  if (!parse(text, &arena, &doc)) { fputs("jsonroundtrip: invalid JSON\n", stderr); exit(1); }
  *len = length(&doc);
  Writer w = { 0 };
  w_value(&w, &doc);
  arena_free(&arena);
  return w.out;
}

// UTF-8 to UTF-16 code units; never more units than bytes.
static size_t utf16_units(const Str *text, uint16_t *u) {
  const unsigned char *s = (const unsigned char *)text->s;
  size_t n = 0;
  for (size_t i = 0; i < text->len;) {
    uint32_t c = s[i];
    if (c < 0x80) i += 1;
    else if (c < 0xe0) { c = (c & 0x1f) << 6 | (s[i + 1] & 0x3fu); i += 2; }
    else if (c < 0xf0) { c = (c & 0x0f) << 12 | (s[i + 1] & 0x3fu) << 6 | (s[i + 2] & 0x3fu); i += 3; }
    else { c = (c & 0x07) << 18 | (s[i + 1] & 0x3fu) << 12 | (s[i + 2] & 0x3fu) << 6 | (s[i + 3] & 0x3fu); i += 4; }
    if (c < 0x10000) u[n++] = (uint16_t)c;
    else {
      c -= 0x10000;
      u[n++] = (uint16_t)(0xd800 | c >> 10);
      u[n++] = (uint16_t)(0xdc00 | (c & 0x3ff));
    }
  }
  return n;
}

static uint32_t checksum(uint32_t count, const Str *out) {
  uint16_t *u = malloc(out->len * sizeof *u);
  size_t m = utf16_units(out, u);
  uint32_t h = mix_u32(mix_u32(0x811c9dc5u, count), (uint32_t)m);
  for (size_t j = 0; j < m; j++) h = mix_u32(h, u[j]);
  free(u);
  return h;
}

int main(void) {
  char *blob = make_blob();
  Str out = { 0 };
  size_t len;
  for (int i = 0; i < N_WARMUP; i++) { free(out.s); out = round_trip(blob, &len); }

  uint32_t count = 0;
  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    free(out.s);
    out = round_trip(blob, &len);
    count += (uint32_t)len;
    count += (uint32_t)out.len;
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum(count, &out), N, 2, N_RUNS);

  free(out.s);
  free(blob);
  return 0;
}
