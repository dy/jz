#!/usr/bin/env node
// Runs a jz-built wasm with host imports for env.logResult and performance.now
// (mirrors AssemblyScript's env.perfNow/env.logLine approach for fair size comparison)
import fs from 'node:fs'
import { performance } from 'node:perf_hooks'

const file = process.argv[2]
if (!file) { console.error('usage: run-jz-host.mjs <case.wasm>'); process.exit(2) }

// Host imports use the i64 carrier ABI: every arg arrives as a BigInt holding
// the f64 NaN-box bits, and the result is i64 too. Numeric (NUMBER) args are
// just the f64 bits reinterpreted; pointer args are NaN-boxed pointers.
const _f64 = new Float64Array(1)
const _u64 = new BigUint64Array(_f64.buffer)
const i64ToNum = bits => { _u64[0] = bits; return _f64[0] }
const SSO_BIT = 0x4000n
const TAG_SHIFT = 47n, TAG_MASK = 0xFn, AUX_SHIFT = 32n, AUX_MASK = 0x7FFFn, OFFSET_MASK = 0xFFFFFFFFn

const bytes = fs.readFileSync(file)
let instance

// Decode a jz value carried as i64 NaN-box bits to a JS string (for host
// parseInt/parseFloat). Numbers stringify; non-strings come back as ''.
const jzStr = (val) => {
  if (!Number.isNaN(i64ToNum(val))) return String(i64ToNum(val))
  const type = Number((val >> TAG_SHIFT) & TAG_MASK)
  if (type !== 4) return ''
  const aux = Number((val >> AUX_SHIFT) & AUX_MASK)
  const offset = Number(val & OFFSET_MASK)
  if (aux & Number(SSO_BIT)) {
    const len = aux & 7, chars = []
    for (let i = 0; i < len; i++) chars.push(String.fromCharCode((offset >>> (i * 8)) & 0xFF))
    return chars.join('')
  }
  if (offset <= 4) return ''
  const mem = new Uint8Array(instance.exports.memory.buffer)
  const len = mem[offset - 4] | (mem[offset - 3] << 8) | (mem[offset - 2] << 16) | (mem[offset - 1] << 24)
  return new TextDecoder().decode(mem.slice(offset, offset + len))
}
const imports = {
  env: {
    logResult: (medianUs, checksum, samples, stages, runs) => {
      console.log(`median_us=${i64ToNum(medianUs)} checksum=${i64ToNum(checksum) >>> 0} samples=${i64ToNum(samples)} stages=${i64ToNum(stages)} runs=${i64ToNum(runs)}`)
      return 0n
    },
    __ext_prop: () => 0n,
    __ext_has: () => 0n,
    __ext_set: () => 0n,
    __ext_call: () => { throw new Error('__ext_call called in host-import bench') },
    parseInt: (val, radix) => parseInt(jzStr(val), radix || undefined),
    parseFloat: (val) => parseFloat(jzStr(val)),
    print: (val, fd, sep) => {
      if (i64ToNum(fd) !== 1 || i64ToNum(sep) !== 10) return 0n
      const type = Number((val >> TAG_SHIFT) & TAG_MASK)
      const aux = Number((val >> AUX_SHIFT) & AUX_MASK)
      const offset = Number(val & OFFSET_MASK)
      if (type === 4 && (aux & Number(SSO_BIT))) {
        const len = aux & 7
        const chars = []
        for (let i = 0; i < len; i++) chars.push(String.fromCharCode((offset >>> (i * 8)) & 0xFF))
        process.stdout.write(chars.join('') + '\n')
      } else if (type === 4 && offset > 4) {
        const mem = new Uint8Array(instance.exports.memory.buffer)
        const len = mem[offset - 4] | (mem[offset - 3] << 8) | (mem[offset - 2] << 16) | (mem[offset - 1] << 24)
        process.stdout.write(new TextDecoder().decode(mem.slice(offset, offset + len)) + '\n')
      }
      return 0n
    },
  },
  performance: {
    now: () => {
      _f64[0] = performance.now()
      return _u64[0]
    },
  },
}

instance = (await WebAssembly.instantiate(bytes, imports)).instance
if (typeof instance.exports.main !== 'function') {
  console.error('wasm has no exported main()')
  process.exit(2)
}
instance.exports.main()
