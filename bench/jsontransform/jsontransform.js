// jsontransform.js – an API gateway's JSON round trip: parse a page of order
// records from text, reshape it (sum each order's line items, apply its
// discount, round to cents, keep orders worth at least 20, flatten the
// customer, count tags), and stringify the response. The text arrives at run
// time, so nothing about its shape is known ahead of it: the parser builds
// generic objects, arrays, strings with escapes and non-ASCII text, integers
// and decimal fractions; the transform walks them by key; the writer escapes
// and formats them back. The shape of most server and tooling code: JSON in,
// JSON out, a little logic between.
//
// The document is generated once from XorShift32 (and serialized with
// JSON.stringify outside the timed region), identical per target. Decimal
// fractions parse to the nearest double and print as the shortest round trip,
// so every conforming engine produces the same response text; the checksum
// folds every UTF-16 code unit of the last run's response.
//
// Reports: median ms across N_RUNS, throughput in orders/µs, FNV-1a checksum
// over the response text.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 1024               // orders in the document
const N_RUNS = 21
const N_WARMUP = 5

const NAMES = ['Ada Lovelace', 'José Martí', 'Zoë Kravitz', 'Søren Kierkegaard', '李小龙',
  'Björk Guðmundsdóttir', 'Chloé "Coco" Dupont', 'Mikhail Bulgakov', 'Grace Hopper', 'Alan Turing']
const PRODUCTS = ['Desk lamp', 'Cable 2m\\5m', 'Mug "Hello"', 'Notebook, A5', 'Tea – Darjeeling',
  'Café crème', 'Gift card 🎁', 'Line1\nLine2', 'Tab\tSeparated', 'Ångström ruler', 'Pens (12)', 'Ruler 30cm']
const TAGS = ['bulk', 'express', 'fragile', 'gift', 'priority', 'return']
const DISCOUNTS = [0, 0.05, 0.1, 0.125, 0.15, 0.2, 0.25, 0.3]

let seed = 0x2545f491 | 0
const next = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed >>> 0
}

const makeDocument = () => {
  const orders = []
  for (let i = 0; i < N; i++) {
    const items = []
    const nItems = 1 + next() % 6
    for (let k = 0; k < nItems; k++) {
      items.push({ sku: 'SKU-' + (10000 + next() % 90000), name: PRODUCTS[next() % PRODUCTS.length],
        qty: 1 + next() % 9, price: (99 + next() % 19901) / 100 })
    }
    const tags = []
    const nTags = next() % 4
    for (let k = 0; k < nTags; k++) tags.push(TAGS[next() % TAGS.length])
    const r = next()
    orders.push({
      id: 1000000 + i,
      status: (r & 7) === 0 ? 'cancelled' : 'paid',
      customer: { id: 5000 + r % 3000, name: NAMES[(r >>> 4) % NAMES.length], vip: (r & 64) !== 0 },
      items,
      discount: DISCOUNTS[(r >>> 8) % DISCOUNTS.length],
      tags,
    })
  }
  return JSON.stringify({ page: 1, per: N, orders })
}

const transform = (text) => {
  const doc = JSON.parse(text)
  const orders = doc.orders
  const kept = []
  const tagCounts = { bulk: 0, express: 0, fragile: 0, gift: 0, priority: 0, return: 0 }
  let revenue = 0
  for (let i = 0; i < orders.length; i++) {
    const o = orders[i]
    if (o.status !== 'paid') continue
    let sub = 0
    const items = o.items
    for (let k = 0; k < items.length; k++) sub += items[k].qty * items[k].price
    const total = Math.round(sub * (1 - o.discount) * 100) / 100
    if (total < 20) continue
    revenue += total
    for (let k = 0; k < o.tags.length; k++) tagCounts[o.tags[k]]++
    kept.push({ id: o.id, customer: o.customer.name, vip: o.customer.vip, lines: items.length,
      first: items[0].name, total, tags: o.tags })
  }
  return JSON.stringify({ page: doc.page, count: kept.length, revenue: Math.round(revenue * 100) / 100, tagCounts, orders: kept })
}

const checksum = (s) => {
  let h = mix(0x811c9dc5 | 0, s.length)
  for (let j = 0; j < s.length; j++) h = mix(h, s.charCodeAt(j))
  return h >>> 0
}

export let main = () => {
  const text = makeDocument()
  let out = ''
  for (let i = 0; i < N_WARMUP; i++) out = transform(text)

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    out = transform(text)
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(out), N, 3, N_RUNS)
}
