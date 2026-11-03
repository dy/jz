// jsontransform.c – an API gateway's JSON round trip: parse a page of order
// records from text, reshape it (sum each order's line items, apply its
// discount, round to cents, keep orders worth at least 20, flatten the
// customer, count tags), and stringify the response, ported from
// jsontransform.js.
//
// C has no JSON in its standard library, so both directions are written here.
// The parser is a recursive descent into a generic value tree, as JSON.parse
// builds generic objects from text of unknown shape: a tagged union (null,
// bool, number, string, array, object), arrays and objects as contiguous slots
// (an object's members as key/value pairs in insertion order), strings decoded
// to UTF-8 (\uXXXX escapes and surrogate pairs included; a lone surrogate,
// which UTF-8 cannot hold, is rejected), numbers checked against JSON's grammar
// and read with strtod. The tree lives in an arena of 64 KiB blocks that the
// run frees at its end; a container's slots double inside the arena as it
// fills. The transform walks the tree by key, a linear scan of an object's
// members, a missing member reading as null; kept orders point into the tree,
// as the JS's kept objects share its strings and tag arrays. The writer is
// stringify.c's in compact form: a growable byte buffer, QuoteJSONString's
// escapes, Number::toString's shortest digits from snprintf and strtod.
//
// The document is generated once from XorShift32 exactly as the JS generates
// it and written by the same writer, outside the timed region. The timed region
// is the transform: parse, reshape and write, freeing the previous response.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over the last run's
// response as the JS folds it, outside the timed region: its UTF-16 length,
// then its UTF-16 code units (the UTF-8 decoded, an astral character as a
// surrogate pair).
#include "../_lib/bench.h"
#include <float.h>
#include <math.h>
#include <stddef.h>
#include <stdlib.h>

#define N        1024  // orders in the document
#define N_RUNS   21
#define N_WARMUP 5

#define COUNT(a) (sizeof(a) / sizeof *(a))

static const char *const NAMES[] = { "Ada Lovelace", "José Martí", "Zoë Kravitz", "Søren Kierkegaard", "李小龙",
  "Björk Guðmundsdóttir", "Chloé \"Coco\" Dupont", "Mikhail Bulgakov", "Grace Hopper", "Alan Turing" };
static const char *const PRODUCTS[] = { "Desk lamp", "Cable 2m\\5m", "Mug \"Hello\"", "Notebook, A5", "Tea – Darjeeling",
  "Café crème", "Gift card 🎁", "Line1\nLine2", "Tab\tSeparated", "Ångström ruler", "Pens (12)", "Ruler 30cm" };
static const char *const TAGS[] = { "bulk", "express", "fragile", "gift", "priority", "return" };
static const double DISCOUNTS[] = { 0, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3 };

static uint32_t seed = 0x2545f491u;

static uint32_t next(void) {
  seed ^= seed << 13;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  return seed;
}

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

static const Value NULL_VALUE = { .kind = J_NULL };

static const Value *get(const Value *v, const char *key) {
  if (v->kind != J_OBJ) return &NULL_VALUE;
  size_t n = strlen(key);
  for (size_t i = 0; i < v->obj.len; i++) {
    const Member *m = &v->obj.at[i];
    if (m->key_len == n && memcmp(m->key, key, n) == 0) return &m->val;
  }
  return &NULL_VALUE;
}

static const Value *at(const Value *v, size_t i) {
  return v->kind == J_ARR && i < v->arr.len ? &v->arr.at[i] : &NULL_VALUE;
}

static size_t length(const Value *v) { return v->kind == J_ARR ? v->arr.len : 0; }

static double num(const Value *v) { return v->kind == J_NUM ? v->num : NAN; }

static int is_str(const Value *v, const char *s) {
  return v->kind == J_STR && v->str.len == strlen(s) && memcmp(v->str.s, s, v->str.len) == 0;
}

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
// the JS's makeDocument: an order's items and tags are drawn before r, which
// decides its first members, so they are held until the order is written
static char *make_document(void) {
  Writer w = { 0 };
  w_begin(&w, '{');
  w_key(&w, "page"); w_int(&w, 1);
  w_key(&w, "per");  w_int(&w, N);
  w_key(&w, "orders");
  w_begin(&w, '[');
  for (int i = 0; i < N; i++) {
    struct { char sku[10]; const char *name; uint32_t qty; double price; } items[6];
    int n_items = 1 + (int)(next() % 6);
    for (int k = 0; k < n_items; k++) {
      snprintf(items[k].sku, sizeof items[k].sku, "SKU-%u", (unsigned)(10000 + next() % 90000));
      items[k].name = PRODUCTS[next() % COUNT(PRODUCTS)];
      items[k].qty = 1 + next() % 9;
      items[k].price = (double)(99 + next() % 19901) / 100;
    }
    const char *tags[3];
    int n_tags = (int)(next() % 4);
    for (int k = 0; k < n_tags; k++) tags[k] = TAGS[next() % COUNT(TAGS)];
    uint32_t r = next();

    w_sep(&w);
    w_begin(&w, '{');
    w_key(&w, "id");       w_int(&w, 1000000 + i);
    w_key(&w, "status");   w_cstr(&w, (r & 7) == 0 ? "cancelled" : "paid");
    w_key(&w, "customer"); w_begin(&w, '{');
    w_key(&w, "id");       w_int(&w, 5000 + r % 3000);
    w_key(&w, "name");     w_cstr(&w, NAMES[(r >> 4) % COUNT(NAMES)]);
    w_key(&w, "vip");      w_lit(&w, (r & 64) != 0 ? "true" : "false");
    w_end(&w, '}');
    w_key(&w, "items");    w_begin(&w, '[');
    for (int k = 0; k < n_items; k++) {
      w_sep(&w);
      w_begin(&w, '{');
      w_key(&w, "sku");    w_cstr(&w, items[k].sku);
      w_key(&w, "name");   w_cstr(&w, items[k].name);
      w_key(&w, "qty");    w_int(&w, items[k].qty);
      w_key(&w, "price");  w_num(&w, items[k].price);
      w_end(&w, '}');
    }
    w_end(&w, ']');
    w_key(&w, "discount"); w_num(&w, DISCOUNTS[(r >> 8) % COUNT(DISCOUNTS)]);
    w_key(&w, "tags");     w_begin(&w, '[');
    for (int k = 0; k < n_tags; k++) { w_sep(&w); w_cstr(&w, tags[k]); }
    w_end(&w, ']');
    w_end(&w, '}');
  }
  w_end(&w, ']');
  w_end(&w, '}');
  put_ch(&w.out, '\0');
  return w.out.s;
}

// ── Transform ───────────────────────────────────────────────────────────────
// a kept order: its values point into the parsed tree
typedef struct {
  const Value *id, *customer, *vip, *first, *tags;
  size_t lines;
  double total;
} Kept;

static Str transform(const char *text) {
  Arena arena = { 0 };
  Value doc;
  if (!parse(text, &arena, &doc)) { fputs("jsontransform: invalid JSON\n", stderr); exit(1); }
  const Value *orders = get(&doc, "orders");
  Kept *kept = NULL;
  size_t n_kept = 0, cap_kept = 0;
  struct { const char *tag; int count; } tag_counts[] = {
    { "bulk", 0 }, { "express", 0 }, { "fragile", 0 }, { "gift", 0 }, { "priority", 0 }, { "return", 0 } };
  double revenue = 0;
  for (size_t i = 0; i < length(orders); i++) {
    const Value *o = at(orders, i);
    if (!is_str(get(o, "status"), "paid")) continue;
    double sub = 0;
    const Value *items = get(o, "items");
    for (size_t k = 0; k < length(items); k++) sub += num(get(at(items, k), "qty")) * num(get(at(items, k), "price"));
    // round: half away from zero, Math.round's half up on these positive totals
    double total = round(sub * (1 - num(get(o, "discount"))) * 100) / 100;
    if (total < 20) continue;
    revenue += total;
    // the six tags the document holds; the JS would add any other as a member
    const Value *tags = get(o, "tags");
    for (size_t k = 0; k < length(tags); k++)
      for (size_t t = 0; t < COUNT(tag_counts); t++)
        if (is_str(at(tags, k), tag_counts[t].tag)) { tag_counts[t].count++; break; }
    if (n_kept == cap_kept) {
      cap_kept = cap_kept ? cap_kept * 2 : 16;
      kept = realloc(kept, cap_kept * sizeof *kept);
      if (!kept) { perror("realloc"); exit(1); }
    }
    const Value *customer = get(o, "customer");
    kept[n_kept++] = (Kept){ .id = get(o, "id"), .customer = get(customer, "name"), .vip = get(customer, "vip"),
                             .lines = length(items), .first = get(at(items, 0), "name"), .total = total, .tags = tags };
  }

  Writer w = { 0 };
  w_begin(&w, '{');
  w_key(&w, "page");      w_value(&w, get(&doc, "page"));
  w_key(&w, "count");     w_int(&w, (int64_t)n_kept);
  w_key(&w, "revenue");   w_num(&w, round(revenue * 100) / 100);
  w_key(&w, "tagCounts"); w_begin(&w, '{');
  for (size_t t = 0; t < COUNT(tag_counts); t++) { w_key(&w, tag_counts[t].tag); w_int(&w, tag_counts[t].count); }
  w_end(&w, '}');
  w_key(&w, "orders");    w_begin(&w, '[');
  for (size_t i = 0; i < n_kept; i++) {
    const Kept *k = &kept[i];
    w_sep(&w);
    w_begin(&w, '{');
    w_key(&w, "id");       w_value(&w, k->id);
    w_key(&w, "customer"); w_value(&w, k->customer);
    w_key(&w, "vip");      w_value(&w, k->vip);
    w_key(&w, "lines");    w_int(&w, (int64_t)k->lines);
    w_key(&w, "first");    w_value(&w, k->first);
    w_key(&w, "total");    w_num(&w, k->total);
    w_key(&w, "tags");     w_value(&w, k->tags);
    w_end(&w, '}');
  }
  w_end(&w, ']');
  w_end(&w, '}');

  free(kept);
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

static uint32_t checksum(const Str *out) {
  uint16_t *u = malloc(out->len * sizeof *u);
  size_t m = utf16_units(out, u);
  uint32_t h = mix_u32(0x811c9dc5u, (uint32_t)m);
  for (size_t j = 0; j < m; j++) h = mix_u32(h, u[j]);
  free(u);
  return h;
}

int main(void) {
  char *text = make_document();
  Str out = { 0 };
  for (int i = 0; i < N_WARMUP; i++) { free(out.s); out = transform(text); }

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    free(out.s);
    out = transform(text);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum(&out), N, 3, N_RUNS);

  free(out.s);
  free(text);
  return 0;
}
