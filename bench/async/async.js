// async.js – a request handler written the way servers are: async functions
// awaiting async stages. Each request authorizes its user (an async cache
// lookup; an inactive user throws, and the handler's try/catch turns the
// rejection into a 403), loads the user's orders, prices every line with its
// own await, and applies a coupon looked up by another await. Requests arrive
// in batches served concurrently with Promise.all, then a tail of requests
// served one after another in an await loop. Every stage resolves at once (a
// warm cache), so the time is the async machinery itself: promise allocation,
// suspending and resuming each async function, the microtask queue, and
// rejection through try/catch.
//
// The requests and tables are built once from XorShift32, identical per
// target. Results are folded in request order (Promise.all keeps positions),
// which no conforming scheduling can change. The timing runs inside an async
// function: each sample spans awaits that settle as microtasks, so an engine
// drains its job queue within the timed region and the result line prints when
// the last job ends.
//
// Reports: median ms across N_RUNS, throughput in requests/µs, FNV-1a checksum
// over every response's status and total.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const NUSERS = 512
const NREQ = 2048            // requests per pass
const BATCH = 32             // requests served concurrently
const TAIL = 256             // requests served one at a time after the batches
const N_RUNS = 21
const N_WARMUP = 5

let seed = 0x3c6ef372 | 0
const next = () => {
  seed ^= seed << 13
  seed ^= seed >>> 17
  seed ^= seed << 5
  return seed >>> 0
}

const USERS = [], ORDERS = [], COUPONS = [0, 5, 10, 15, 20, 25, 50, 0]
for (let i = 0; i < NUSERS; i++) {
  const lines = []
  const n = 1 + next() % 6
  for (let k = 0; k < n; k++) lines.push({ qty: 1 + next() % 9, cents: 99 + next() % 9901 })
  USERS.push({ id: i, active: next() % 16 !== 0, tier: next() % 8 })
  ORDERS.push(lines)
}
const REQS = []
for (let i = 0; i < NREQ + TAIL; i++) REQS.push({ user: next() % NUSERS, coupon: next() % 8 })

const getUser = async (id) => USERS[id]
const getOrders = async (user) => ORDERS[user.id]
const priceOf = async (line) => line.qty * line.cents
const couponOf = async (code, tier) => COUPONS[(code + tier) % COUPONS.length]

const authorize = async (req) => {
  const user = await getUser(req.user)
  if (!user.active) throw new Error('inactive user ' + user.id)
  return user
}

const handle = async (req) => {
  try {
    const user = await authorize(req)
    const lines = await getOrders(user)
    let total = 0
    for (let k = 0; k < lines.length; k++) total += await priceOf(lines[k])
    const off = await couponOf(req.coupon, user.tier)
    return { status: 200, total: total - ((total * off / 100) | 0) }
  } catch (e) {
    return { status: 403, total: 0 }
  }
}

const serve = async () => {
  let h = 0x811c9dc5 | 0
  for (let b = 0; b < NREQ; b += BATCH) {
    const batch = []
    for (let i = b; i < b + BATCH; i++) batch.push(handle(REQS[i]))
    const res = await Promise.all(batch)
    for (let i = 0; i < res.length; i++) h = mix(mix(h, res[i].status), res[i].total)
  }
  for (let i = NREQ; i < NREQ + TAIL; i++) {
    const r = await handle(REQS[i])
    h = mix(mix(h, r.status), r.total)
  }
  return h >>> 0
}

const run = async () => {
  let cs = 0
  for (let i = 0; i < N_WARMUP; i++) cs = await serve()

  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    cs = await serve()
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), cs, NREQ + TAIL, 4, N_RUNS)
}

export let main = () => run()
