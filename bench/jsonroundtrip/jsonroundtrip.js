// jsonroundtrip.js – JSON.parse then JSON.stringify of one ~1 MB document, the
// round trip of every cache, queue and RPC layer that takes text in and gives
// it back. Perry's bench_json_roundtrip.ts (https://github.com/PerryTS/perry,
// benchmarks/suite, MIT): 10,000 records of an integer id, a string name, a
// float value, an array of two tag strings and a nested {x, y} object, written
// once by JSON.stringify, then parsed into generic values and written back.
// Perry's algorithm and data as it wrote them; the harness's timing (median of
// N_RUNS round trips after N_WARMUP) replaces its Date.now around 50.
//
// i * 3.14159 is a double with up to 17 significant digits, so the writer finds
// Number::toString's shortest digits for 9,999 of the values and the parser
// reads them back correctly rounded: the text comes back byte for byte, which
// the checksum asks of every target.
//
// Reports: median µs across N_RUNS, FNV-1a checksum over Perry's own sum (each
// run's parsed length and text length) and every UTF-16 code unit of the last
// run's text.

import { medianUs, mix, printResult } from '../_lib/benchlib.js'

const N = 10000              // records in the document
const N_RUNS = 21
const N_WARMUP = 5

const makeBlob = () => {
  const items = []
  for (let i = 0; i < N; i++) {
    items.push({
      id: i,
      name: 'item_' + i,
      value: i * 3.14159,
      tags: ['tag_' + (i % 10), 'tag_' + (i % 5)],
      nested: { x: i, y: i * 2 },
    })
  }
  return JSON.stringify(items)
}

const checksum = (count, s) => {
  let h = mix(0x811c9dc5 | 0, count)
  h = mix(h, s.length)
  for (let j = 0; j < s.length; j++) h = mix(h, s.charCodeAt(j))
  return h >>> 0
}

export let main = () => {
  const blob = makeBlob()
  let out = ''
  for (let i = 0; i < N_WARMUP; i++) out = JSON.stringify(JSON.parse(blob))

  let count = 0
  const samples = new Float64Array(N_RUNS)
  for (let i = 0; i < N_RUNS; i++) {
    const t0 = performance.now()
    const parsed = JSON.parse(blob)
    count += parsed.length
    out = JSON.stringify(parsed)
    count += out.length
    samples[i] = performance.now() - t0
  }
  printResult(medianUs(samples), checksum(count, out), N, 2, N_RUNS)
}
