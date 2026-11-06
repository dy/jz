// A build the site serves and its portable twin. A speed build may use relaxed SIMD, which
// Safari runs only behind a flag: where it does, <name>.portable.wasm goes beside it, the
// same source compiled with optimize: { relaxedSimd: false }, and the site's loaders
// (assets/wasm.js) fetch that one where the engine lacks relaxed SIMD.
import { rmSync, writeFileSync } from 'node:fs'

// A relaxed opcode is 0xfd and 0x100-0x113 in LEB128, which watr writes minimal: a module
// without that run of bytes holds none, and needs no second compile to tell
const mayRelax = (wasm) => wasm.some((b, i) => b === 0xfd && wasm[i + 1] >= 0x80 && wasm[i + 1] <= 0x93 && wasm[i + 2] === 0x02)

const strict = (opts) => {
  const o = opts.optimize
  return { ...opts, optimize: { ...(o !== null && typeof o === 'object' ? o : o === undefined ? {} : { level: o }), relaxedSimd: false } }
}

/** Write `wasm` (compile(code, opts), unless given) to `file`, and its portable twin where the two differ. */
export function writeWasm(file, compile, code, opts = {}, wasm = compile(code, opts)) {
  writeFileSync(file, wasm)
  const twin = file.replace(/(\.wasm)?$/, '.portable.wasm'), portable = mayRelax(wasm) && compile(code, strict(opts))
  if (portable && Buffer.compare(wasm, portable)) writeFileSync(twin, portable)
  else rmSync(twin, { force: true })   // a twin an earlier build left
  return wasm
}
