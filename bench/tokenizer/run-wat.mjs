#!/usr/bin/env node
import { runWatBench } from '../_lib/run-wat.mjs'

const BASE = 'let alpha_12 = beta + 12345; if (alpha_12 >= 99) { total = total + alpha_12; }\n'
const N_REPEAT = 512
const SRC_PTR = 0

let len = 0
let cs = 0

await runWatBench({
  name: 'tokenizer',
  setup: (_exp, inst) => {
    const srcBytes = new TextEncoder().encode(BASE.repeat(N_REPEAT))
    new Uint8Array(inst.exports.memory.buffer).set(srcBytes, SRC_PTR)
    len = srcBytes.length
  },
  run: (exp, _inst, i) => { cs = exp.scan(SRC_PTR, len - (i & 7)) >>> 0 },
  checksum: () => cs,
  samples: len,
  stages: 5,
})
