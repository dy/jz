// stringify.js – JSON.stringify of realistic order records: an NDJSON log
// writer that serializes every record on one line and pretty-prints every 16th
// for a debug dump. Each record nests a customer object with an address, an
// array of line items, a tag array, a nullable note and a geo point; strings
// carry quotes, backslashes, control characters (\n \r \t \f, \u0007, \u001f)
// and non-ASCII text (accents, Greek, CJK, an astral emoji); numbers are small
// integers, millisecond timestamps past 2^32, two-decimal prices, float sums,
// thirds, and rates small enough for exponent notation (1.5e-7). The writer
// side of every server, logger and exporter: in a JS engine a native builtin
// walking hidden classes, in an AOT compiler property enumeration, escaping and
// shortest round-trip number formatting compiled from scratch.
//
// Records are built once from XorShift32, identical per target; the timed
// region is the serialization alone. The checksum folds every UTF-16 code unit
// of every line of the last run (outside the timed region), so a different
// escape, key order or number format is a different checksum. ECMAScript fixes
// the output exactly (Number::toString's shortest digits, QuoteJSONString's
// escapes), so every conforming engine agrees bit for bit.
//
// Reports: median ms across N_RUNS, throughput in records/µs, FNV-1a checksum
// over the serialized text.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 1024               // records per pass
const DUMP = 16              // every DUMP-th record is also pretty-printed
const N_RUNS = 21
const N_WARMUP = 5

const NAMES = ['Ada Lovelace', 'José Martí', 'Zoë Kravitz', 'Søren Kierkegaard', '李小龙',
  'Ngũgĩ wa Thiong\'o', 'Björk Guðmundsdóttir', 'Chloé "Coco" Dupont', 'Mikhail Bulgakov',
  'Ἀριστοτέλης', 'Grace Hopper', 'Alan Turing']
const CITIES = ['Montréal', 'Zürich', 'København', 'São Paulo', '東京', 'Reykjavík', 'Kraków', 'Toronto']
const PRODUCTS = ['Desk lamp', 'Cable 2m\\5m', 'Mug "Hello"', 'Notebook, A5', 'Tea – Darjeeling',
  'Café crème', 'Gift card 🎁', 'Line1\nLine2', 'Tab\tSeparated', 'Bell\u0007', 'Ångström ruler',
  'naïve façade', 'Résumé paper', 'Pens (12)', 'Stand/Arm', 'Ruler 30cm']
const TAGS = ['gift', 'express', 'fragile', 'bulk', 'return', 'priority']
const NOTES = ['Leave at door', 'Call "front desk"', 'Ring twice\r\nthen wait', 'Back\\slash',
  'form\ffeed', 'checked ✓', 'ctrl\u001fchar', 'Merci beaucoup!']
const DISCOUNTS = [0, 0.05, 0.1, 0.125, 0.15, 0.2, 1 / 3, 0.07]

let seed = 0x1234abcd | 0
const next = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed >>> 0
}

const makeRecord = (i) => {
  const items = []
  const nItems = 1 + next() % 5
  let total = 0
  for (let k = 0; k < nItems; k++) {
    const qty = 1 + next() % 9
    const price = (99 + next() % 99901) / 100
    total += qty * price
    items.push({ sku: 'SKU-' + (10000 + next() % 90000), name: PRODUCTS[next() % PRODUCTS.length], qty, price })
  }
  const tags = []
  const nTags = next() % 4
  for (let k = 0; k < nTags; k++) tags.push(TAGS[next() % TAGS.length])
  const r = next()
  return {
    id: 1000000 + i,
    created: 1767225600000 + i * 61003,
    customer: {
      id: 5000 + r % 3000,
      name: NAMES[r % NAMES.length],
      email: 'user' + (r % 3000) + '@example.com',
      vip: (r & 16) !== 0,
      address: { city: CITIES[(r >>> 8) % CITIES.length], zip: 'H' + (r >>> 12) % 10 + 'X ' + (r >>> 16) % 10 + 'Y' + (r >>> 20) % 10 },
    },
    items,
    total,
    discount: DISCOUNTS[(r >>> 4) % DISCOUNTS.length],
    tags,
    note: (r & 3) === 0 ? NOTES[(r >>> 6) % NOTES.length] : null,
    geo: { lat: (next() % 180000000) / 1e6 - 90, lon: (next() % 360000000) / 1e6 - 180 },
    rate: (1 + next() % 999) * 1.5e-7,
  }
}

const serialize = (records, out) => {
  let n = 0
  for (let i = 0; i < records.length; i++) {
    out[n++] = JSON.stringify(records[i])
    if (i % DUMP === 0) out[n++] = JSON.stringify(records[i], null, 2)
  }
  return n
}

const checksum = (out, n) => {
  let h = 0x811c9dc5 | 0
  for (let i = 0; i < n; i++) {
    const s = out[i]
    h = mix(h, s.length)
    for (let j = 0; j < s.length; j++) h = mix(h, s.charCodeAt(j))
  }
  return h >>> 0
}

export let main = () => {
  const records = []
  for (let i = 0; i < N; i++) records.push(makeRecord(i))
  const out = []
  let n = 0
  for (let i = 0; i < N_WARMUP; i++) n = serialize(records, out)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    n = serialize(records, out)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(out, n), N, 2, N_RUNS)
}
