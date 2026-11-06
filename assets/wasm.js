// The site's prebuilt wasm, as this engine runs it. A speed build may use relaxed SIMD, which
// Safari runs only behind a flag; beside each build that does is its portable twin,
// <name>.portable.wasm, compiled with optimize: { relaxedSimd: false } (scripts/portable.mjs).

// Whether the engine runs relaxed SIMD: the smallest module holding one relaxed opcode, i32x4.relaxed_trunc_f32x4_s
export const relaxedSimd = typeof WebAssembly === 'object' &&
  WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 6, 1, 96, 1, 123, 1, 123, 3, 2, 1, 0, 10, 9, 1, 7, 0, 32, 0, 253, 129, 2, 11]))

const bytes = async (response) => new Uint8Array(await response.arrayBuffer())

// → the bytes at `url` to compile: the build, or its portable twin where the engine lacks relaxed
// SIMD and the build uses it (the build itself where no twin answers, to fail as it fails)
export const fetchWasm = async (url) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`${url}: ${response.status}`)
  const wasm = await bytes(response)
  if (relaxedSimd || WebAssembly.validate(wasm)) return wasm
  const twin = await fetch(String(url).replace(/\.wasm(?=$|[?#])/, '.portable.wasm'))
  return twin.ok ? bytes(twin) : wasm
}
