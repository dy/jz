// stringify.c – JSON.stringify of realistic order records: an NDJSON log
// writer that serializes every record on one line and pretty-prints every 16th
// for a debug dump, ported from stringify.js.
//
// C has no JSON in its standard library, so the writer is written here: a
// growable byte buffer (128 bytes, doubled by realloc when full) under a
// streaming writer that places commas, line breaks and two-space indentation as
// JSON.stringify(x) and JSON.stringify(x, null, 2) do, keys in the JS's
// insertion order. Strings are escaped as ECMAScript's QuoteJSONString escapes
// them (`"` and `\`, \b \f \n \r \t, other bytes below 0x20 as \u00xx in
// lowercase hex); everything else, non-ASCII included, is copied as UTF-8.
// Numbers are written as Number::toString writes them: the shortest digits that
// read back as the same double, the closest to it among those (snprintf's
// correctly rounded digits, the fewest that strtod returns unchanged), laid out
// in integer, decimal or exponent form by ECMAScript's rules; an integral value
// below 2^53 is written by the integer routine, as cJSON writes integers.
//
// Records are structs built once from XorShift32 exactly as the JS builds them,
// integer fields as integers, the rest as doubles, items and tags as heap
// arrays of their exact length, short built strings (sku, email, zip) inline.
// Each line is a fresh heap string, as each JSON.stringify returns a new string;
// the next run frees it when it stores its own line in the slot. The timed
// region is the serialization alone.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over every line of the last
// run as the JS folds it, outside the timed region: the line's UTF-16 length,
// then its UTF-16 code units (the UTF-8 decoded, an astral character as a
// surrogate pair).
#include "../_lib/bench.h"
#include <float.h>
#include <math.h>
#include <stdlib.h>

#define N        1024                        // records per pass
#define DUMP     16                          // every DUMP-th record is also pretty-printed
#define N_LINES  (N + (N + DUMP - 1) / DUMP)
#define N_RUNS   21
#define N_WARMUP 5

#define COUNT(a) (sizeof(a) / sizeof *(a))

static const char *const NAMES[] = { "Ada Lovelace", "José Martí", "Zoë Kravitz", "Søren Kierkegaard", "李小龙",
  "Ngũgĩ wa Thiong'o", "Björk Guðmundsdóttir", "Chloé \"Coco\" Dupont", "Mikhail Bulgakov",
  "Ἀριστοτέλης", "Grace Hopper", "Alan Turing" };
static const char *const CITIES[] = { "Montréal", "Zürich", "København", "São Paulo", "東京", "Reykjavík", "Kraków", "Toronto" };
static const char *const PRODUCTS[] = { "Desk lamp", "Cable 2m\\5m", "Mug \"Hello\"", "Notebook, A5", "Tea – Darjeeling",
  "Café crème", "Gift card 🎁", "Line1\nLine2", "Tab\tSeparated", "Bell\a", "Ångström ruler",
  "naïve façade", "Résumé paper", "Pens (12)", "Stand/Arm", "Ruler 30cm" };
static const char *const TAGS[] = { "gift", "express", "fragile", "bulk", "return", "priority" };
static const char *const NOTES[] = { "Leave at door", "Call \"front desk\"", "Ring twice\r\nthen wait", "Back\\slash",
  "form\ffeed", "checked ✓", "ctrl\037char", "Merci beaucoup!" };
static const double DISCOUNTS[] = { 0, 0.05, 0.1, 0.125, 0.15, 0.2, 1.0 / 3, 0.07 };

typedef struct { const char *city; char zip[8]; } Address;
typedef struct { int32_t id; const char *name; char email[24]; int vip; Address address; } Customer;
typedef struct { char sku[10]; const char *name; int32_t qty; double price; } Item;
typedef struct { double lat, lon; } Geo;
typedef struct {
  int32_t id;
  int64_t created;
  Customer customer;
  Item *items;
  int n_items;
  double total, discount;
  const char **tags;
  int n_tags;
  const char *note;  // NULL is JSON null
  Geo geo;
  double rate;
} Record;

static uint32_t seed = 0x1234abcdu;

static uint32_t next(void) {
  seed ^= seed << 13;
  seed ^= seed >> 17;
  seed ^= seed << 5;
  return seed;
}

static Record make_record(int i) {
  Record rec;
  rec.n_items = 1 + (int)(next() % 5);
  rec.items = malloc((size_t)rec.n_items * sizeof *rec.items);
  double total = 0;
  for (int k = 0; k < rec.n_items; k++) {
    Item *it = &rec.items[k];
    it->qty = 1 + (int32_t)(next() % 9);
    it->price = (double)(99 + next() % 99901) / 100;
    total += it->qty * it->price;
    snprintf(it->sku, sizeof it->sku, "SKU-%u", (unsigned)(10000 + next() % 90000));
    it->name = PRODUCTS[next() % COUNT(PRODUCTS)];
  }
  rec.n_tags = (int)(next() % 4);
  rec.tags = rec.n_tags ? malloc((size_t)rec.n_tags * sizeof *rec.tags) : NULL;
  for (int k = 0; k < rec.n_tags; k++) rec.tags[k] = TAGS[next() % COUNT(TAGS)];
  uint32_t r = next();
  rec.id = 1000000 + i;
  rec.created = 1767225600000 + (int64_t)i * 61003;
  rec.customer.id = 5000 + (int32_t)(r % 3000);
  rec.customer.name = NAMES[r % COUNT(NAMES)];
  snprintf(rec.customer.email, sizeof rec.customer.email, "user%u@example.com", (unsigned)(r % 3000));
  rec.customer.vip = (r & 16) != 0;
  rec.customer.address.city = CITIES[(r >> 8) % COUNT(CITIES)];
  snprintf(rec.customer.address.zip, sizeof rec.customer.address.zip, "H%uX %uY%u",
           (unsigned)((r >> 12) % 10), (unsigned)((r >> 16) % 10), (unsigned)((r >> 20) % 10));
  rec.total = total;
  rec.discount = DISCOUNTS[(r >> 4) % COUNT(DISCOUNTS)];
  rec.note = (r & 3) == 0 ? NOTES[(r >> 6) % COUNT(NOTES)] : NULL;
  rec.geo.lat = (double)(next() % 180000000) / 1e6 - 90;
  rec.geo.lon = (double)(next() % 360000000) / 1e6 - 180;
  rec.rate = (1 + next() % 999) * 1.5e-7;
  return rec;
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

// ── Writer ──────────────────────────────────────────────────────────────────
typedef struct {
  Str out;
  int indent;  // spaces per level; 0 writes the compact form
  int depth;   // open containers
  int first;   // nothing written yet in the innermost open container
} Writer;

static void newline(Writer *w) {
  put_ch(&w->out, '\n');
  for (int i = 0; i < w->depth * w->indent; i++) put_ch(&w->out, ' ');
}

// before a member or an element: the comma, and in the pretty form a line break
static void w_sep(Writer *w) {
  if (!w->first) put_ch(&w->out, ',');
  w->first = 0;
  if (w->indent) newline(w);
}

static void w_begin(Writer *w, char c) {
  put_ch(&w->out, c);
  w->depth++;
  w->first = 1;
}

// an empty container stays `{}` or `[]` in the pretty form too
static void w_end(Writer *w, char c) {
  w->depth--;
  if (w->indent && !w->first) newline(w);
  put_ch(&w->out, c);
  w->first = 0;
}

// QuoteJSONString (ECMA-262)
static void w_str(Writer *w, const char *s) {
  static const char HEX[] = "0123456789abcdef";
  Str *b = &w->out;
  put_ch(b, '"');
  size_t start = 0, i = 0;
  for (; s[i]; i++) {
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
  put(b, s + start, i - start);
  put_ch(b, '"');
}

static void w_key(Writer *w, const char *k) {
  w_sep(w);
  w_str(w, k);
  if (w->indent) put(&w->out, ": ", 2);
  else put_ch(&w->out, ':');
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

// ── Records to JSON, keys in the JS's order ─────────────────────────────────
static void write_customer(Writer *w, const Customer *c) {
  w_begin(w, '{');
  w_key(w, "id");      w_int(w, c->id);
  w_key(w, "name");    w_str(w, c->name);
  w_key(w, "email");   w_str(w, c->email);
  w_key(w, "vip");     w_lit(w, c->vip ? "true" : "false");
  w_key(w, "address"); w_begin(w, '{');
  w_key(w, "city");    w_str(w, c->address.city);
  w_key(w, "zip");     w_str(w, c->address.zip);
  w_end(w, '}');
  w_end(w, '}');
}

static void write_item(Writer *w, const Item *it) {
  w_begin(w, '{');
  w_key(w, "sku");   w_str(w, it->sku);
  w_key(w, "name");  w_str(w, it->name);
  w_key(w, "qty");   w_int(w, it->qty);
  w_key(w, "price"); w_num(w, it->price);
  w_end(w, '}');
}

static void write_record(Writer *w, const Record *r) {
  w_begin(w, '{');
  w_key(w, "id");       w_int(w, r->id);
  w_key(w, "created");  w_int(w, r->created);
  w_key(w, "customer"); write_customer(w, &r->customer);
  w_key(w, "items");    w_begin(w, '[');
  for (int k = 0; k < r->n_items; k++) { w_sep(w); write_item(w, &r->items[k]); }
  w_end(w, ']');
  w_key(w, "total");    w_num(w, r->total);
  w_key(w, "discount"); w_num(w, r->discount);
  w_key(w, "tags");     w_begin(w, '[');
  for (int k = 0; k < r->n_tags; k++) { w_sep(w); w_str(w, r->tags[k]); }
  w_end(w, ']');
  w_key(w, "note");
  if (r->note) w_str(w, r->note);
  else w_lit(w, "null");
  w_key(w, "geo");      w_begin(w, '{');
  w_key(w, "lat");      w_num(w, r->geo.lat);
  w_key(w, "lon");      w_num(w, r->geo.lon);
  w_end(w, '}');
  w_key(w, "rate");     w_num(w, r->rate);
  w_end(w, '}');
}

static Str stringify(const Record *r, int indent) {
  Writer w = { .indent = indent };
  write_record(&w, r);
  return w.out;
}

static void store(Str *slot, Str line) {
  free(slot->s);
  *slot = line;
}

static int serialize(const Record *records, Str *out) {
  int n = 0;
  for (int i = 0; i < N; i++) {
    store(&out[n++], stringify(&records[i], 0));
    if (i % DUMP == 0) store(&out[n++], stringify(&records[i], 2));
  }
  return n;
}

// UTF-8 to UTF-16 code units; never more units than bytes.
static size_t utf16_units(const Str *line, uint16_t *u) {
  const unsigned char *s = (const unsigned char *)line->s;
  size_t n = 0;
  for (size_t i = 0; i < line->len;) {
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

static uint32_t checksum(const Str *out, int n) {
  uint32_t h = 0x811c9dc5u;
  for (int i = 0; i < n; i++) {
    uint16_t *u = malloc(out[i].len * sizeof *u);
    size_t m = utf16_units(&out[i], u);
    h = mix_u32(h, (uint32_t)m);
    for (size_t j = 0; j < m; j++) h = mix_u32(h, u[j]);
    free(u);
  }
  return h;
}

int main(void) {
  Record *records = malloc(N * sizeof *records);
  for (int i = 0; i < N; i++) records[i] = make_record(i);
  Str *out = calloc(N_LINES, sizeof *out);
  int n = 0;
  for (int i = 0; i < N_WARMUP; i++) n = serialize(records, out);

  double samples[N_RUNS];
  for (int i = 0; i < N_RUNS; i++) {
    double t0 = now_ms();
    n = serialize(records, out);
    samples[i] = now_ms() - t0;
  }
  print_result(median_us(samples, N_RUNS), checksum(out, n), N, 2, N_RUNS);

  for (int i = 0; i < N_LINES; i++) free(out[i].s);
  free(out);
  for (int i = 0; i < N; i++) { free(records[i].items); free(records[i].tags); }
  free(records);
  return 0;
}
