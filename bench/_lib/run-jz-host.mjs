#!/usr/bin/env node
// Runs a jz-built wasm with host imports for env.logResult and performance.now
// (mirrors AssemblyScript's env.perfNow/env.logLine approach for fair size comparison)
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

const file = process.argv[2]
if (!file) { console.error('usage: run-jz-host.mjs <case.wasm>'); process.exit(2) }

const bytes = fs.readFileSync(file)
let instance
const imports = {
  env: {
    logResult: (medianUs, checksum, samples, stages, runs) => {
      console.log(`median_us=${medianUs} checksum=${checksum >>> 0} samples=${samples} stages=${stages} runs=${runs}`)
    },
    __ext_prop: () => 0,
    __ext_has: () => 0,
    __ext_set: () => 0,
    __ext_call: () => { throw new Error('__ext_call called in host-import bench') },
    print: (val, fd, sep) => {
      if (fd !== 1 || sep !== 10) return
      const buf = new Float64Array(1)
      buf[0] = val
      const bits = new BigUint64Array(buf.buffer)
      const type = Number(BigInt.asUintN(32, bits[0] >> 47n) & 0xFn)
      const offset = Number(BigInt.asUintN(32, bits[0]) & 0xFFFFFFFFn)
      if (type === 5) {
        const chars = []
        for (let b = offset; b > 0; b = b >> 8) chars.push(String.fromCharCode(b & 0xFF))
        process.stdout.write(chars.reverse().join('') + '\n')
      } else if (type === 4 && offset > 4) {
        const mem = new Uint8Array(instance.exports.memory.buffer)
        const len = mem[offset - 4] | (mem[offset - 3] << 8) | (mem[offset - 2] << 16) | (mem[offset - 1] << 24)
        process.stdout.write(new TextDecoder().decode(mem.slice(offset, offset + len)) + '\n')
      }
    },
  },
  performance: {
    now: () => performance.now(),
  },
}

instance = (await WebAssembly.instantiate(bytes, imports)).instance
if (typeof instance.exports.main !== 'function') {
  console.error('wasm has no exported main()')
  process.exit(2)
}
instance.exports.main()
