// The size column counts what a release ships: an artifact without its debug
// info and symbol names, as strip(1) leaves a native binary and a toolchain's
// own strip (rustc -C strip=symbols, zig -fstrip, wasm-ld --strip-all) a wasm
// module, in a component's nested modules too. It measures a copy, so the
// binary a row times stays the one it built.
import { execFileSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, readSync, rmSync, statSync } from 'node:fs'

const leb = (b, i) => {
  let n = 0, shift = 0, byte
  do { byte = b[i++]; n += (byte & 0x7f) * 2 ** shift; shift += 7 } while (byte & 0x80)
  return [n, i]
}
const lebLength = n => { let len = 1; while (n >= 0x80) { n = Math.floor(n / 0x80); len++ } return len }

// The custom sections those strips drop: debug info, names and toolchain
// metadata. Any other custom section stays: a runtime may read it (jz's ABI
// sections are read by its interop).
const DEBUG = new Set(['name', 'producers', 'target_features', 'sourceMappingURL', 'external_debug_info'])
const isDebug = (b, at) => {
  const [n, from] = leb(b, at), name = b.toString('latin1', from, from + n)
  return DEBUG.has(name) || name.startsWith('.debug')
}

/** Bytes of the wasm module or component in `b[start, end)` without debug info and names. */
export const wasmStrippedBytes = (b, start = 0, end = b.length) => {
  // A component's preamble reads layer 1 where a core module's version has zeros.
  const component = b[start + 6] === 1
  let size = 8
  for (let i = start + 8; i < end;) {
    const id = b[i], [len, at] = leb(b, i + 1)
    i = at + len
    if (id === 0 && isDebug(b, at)) continue
    // A component nests core modules (section 1) and components (section 4).
    const kept = component && (id === 1 || id === 4) ? wasmStrippedBytes(b, at, i) : len
    size += 1 + lebLength(kept) + kept
  }
  return size
}

// ELF, then 64- and 32-bit Mach-O, then a universal Mach-O.
const NATIVE = [0x7f454c46, 0xcffaedfe, 0xcefaedfe, 0xcafebabe]

/** Release size of the artifact at `path`; `tmp` is a scratch path for strip(1)'s copy. */
export const releaseBytes = (path, tmp) => {
  const head = Buffer.alloc(4), fd = openSync(path, 'r')
  try { readSync(fd, head, 0, 4, 0) } finally { closeSync(fd) }
  const magic = head.readUInt32BE(0)
  if (magic === 0x0061736d) return wasmStrippedBytes(readFileSync(path))
  // Sources and scripts are what they are.
  if (!NATIVE.includes(magic)) return statSync(path).size
  // Stripping a stripped Mach-O re-signs it, which can add a few bytes.
  try {
    execFileSync('strip', ['-o', tmp, path], { stdio: 'pipe' })
    return Math.min(statSync(tmp).size, statSync(path).size)
  } finally { rmSync(tmp, { force: true }) }
}
