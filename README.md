<a href="https://jz.js.org/"><img src="jz.svg" alt="JZ logo" width="120"/></a>

![stability](https://img.shields.io/badge/stability-experimental-black) [![npm](https://img.shields.io/npm/v/jz?color=black)](https://www.npmjs.com/package/jz) [![test](https://github.com/dy/jz/actions/workflows/test.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/test.yml) [![bench](https://github.com/dy/jz/actions/workflows/bench.yml/badge.svg)](https://github.com/dy/jz/actions/workflows/bench.yml)

**JZ** (_javascript zero_) compiles JavaScript to fast, minimal WASM.

**[site](https://jz.js.org/)**  /  **[guide](https://jz.js.org/guide/)**  /  **[try it](https://jz.js.org/repl/)**  /  **[examples](https://jz.js.org/examples/)**  /  **[benchmarks](https://jz.js.org/bench/)**

| Good for | Not for |
|---|---|
| DSP, audio, synthesis | UI, DOM, frontend state |
| Images, video, pixels | Network, hot I/O, serving HTTP |
| Simulation, physics, games | Dynamic object models and monkey-patching |
| Parsers, codecs, compression | Allocation-heavy, long-lived object graphs |
| Scientific, numeric, edge ML | Security-sensitive cryptography and arbitrary-precision integers |
| Hashing, checksums, RNG | Tiny calls where the JS/WASM boundary dominates |


<sup>Used by: [color-space](https://github.com/colorjs/color-space), [audiojs](https://github.com/audiojs/)</sup>

## Usage

```sh
npm install jz
```

```js
import { compile } from 'jz'

const wasm = compile('export const dist = (x, y) => (x*x + y*y) ** 0.5')
const { instance } = await WebAssembly.instantiate(wasm)

instance.exports.dist(3, 4) // 5
```

A numeric module like this one needs no runtime. For strings, arrays and
objects use `jz()` (compile and instantiate in one step) or `jz/interop`
(instantiate prebuilt wasm); both marshal values across the boundary:

```js
import jz from 'jz'

const { exports, memory } = jz`
  export const sum = a => { let n = 0; for (const x of a) n += x; return n }
`
exports.sum(new Float64Array([1, 2, 3])) // 6
memory.reset()                            // drop what the call allocated
```

<details>
<summary><strong>Options</strong></summary><br>

`jz(source, opts)`, `compile(source, opts)` and `instantiate(wasm, opts)` share one option set:

| Option | Use |
|---|---|
| `modules` | Sources for static imports, `{ './dep.js': source }`. The CLI reads them from disk. |
| `imports` | Host modules for `import { fn } from "mod"`: functions, constants, or a whole namespace such as `Math`. |
| `define` | Compile-time constants injected as bindings, `{ DEBUG: false, N: 1024 }`. |
| `host` | `'js'` (default), `'wasi'` for standalone runtimes, `'native'` for the wasm2c lane. |
| `memory` | Initial pages, a `WebAssembly.Memory` or `jz.memory()` shared between modules, or `{ initial, maximum, shared, import }`. |
| `optimize` | `true` (default), `'speed'`, `'size'`, `false`, or an object: `{ level, simd, tailCall, exceptions, alloc }` for engines without SIMD or tail calls and for raw standalone modules. |
| `randomSeed` | Number for a reproducible `Math.random`. |
| `names` | Emit the wasm name section for profilers and debuggers. |
| `wat` | Return WAT text instead of bytes. |
| `warnings` | Sink `{ entries }` or callback for advisories: dynamic fallbacks, heap growth. |
| `why` | Also report each loop the vectorizer and each arena the rewind declined; a `warnings` sink alone reports each property read left dynamic, each class kept as closures and the first cause an object shape is lost by. |
</details>

## CLI

```sh
npm install -g jz

jz kernel.js                # → kernel.wasm
jz kernel.js --wat          # → kernel.wat
jz kernel.js -o out.wasm    # custom output, - for stdout
jz kernel.js -O3            # fastest code; -Os smallest; -O0 none
jz kernel.js --host wasi    # standalone WASI module
jz kernel.js --why          # what the optimizer declined, and why
```

`jz --help` lists the rest: `-D`, `--memory`, `--no-simd`, `--no-tail-call`, `--names`, and `-O '{…}'` for the optimize object.

## Examples

<table>
<tr>
<td width="33%"><a href="https://jz.js.org/examples/chladni/"><img src="examples/thumbs/chladni.webp" width="100%" alt="Chladni plate"></a><br><b>chladni</b></td>
<td width="33%"><a href="https://jz.js.org/examples/dwa/"><img src="examples/thumbs/dwa.webp" width="100%" alt="Dynamic Window Approach"></a><br><b>robot motion</b></td>
<td width="33%"><a href="https://jz.js.org/examples/hydrogen/"><img src="examples/thumbs/hydrogen.webp" width="100%" alt="Hydrogen orbital"></a><br><b>hydrogen</b></td>
</tr>
</table>

See [all examples](https://jz.js.org/examples/).

## FAQ

<details>
<summary><strong>What is not supported?</strong></summary>

- **Runtime code:** `eval`, `Function`, `with`.
- **Reflection:** `Proxy`, `Reflect`, property descriptors, prototype chains and `__proto__`.
- **Module dynamics:** top-level `await`, `import()`.
- **Platform:** DOM, Node modules, `Intl`, `Temporal`.

Modern JavaScript is supported: classes, generators, async/await, destructuring,
BigInt, typed arrays, Map/Set, RegExp, Date, JSON, timers and the Web codecs.

Where behaviour differs from JS:

- **No GC.** Heap values live until `memory.reset()`. `WeakMap`, `WeakSet` and `WeakRef` hold strongly.
- **BigInt is 64-bit.** It wraps past its range and has no `**`.
- **32-bit element indices.** Use finite integer array indices. Numeric index expressions can truncate to i32; `a[NaN]` can read `a[0]` instead of `undefined`.
- **Regexes compile at build time.** `new RegExp(pattern)` needs a literal; `\p{…}`, `d` and `v` flags are unsupported.
- **ASCII case, UTC dates.** No locale or timezone tables: case conversion is ASCII, `normalize` returns its input, Date getters use UTC.
- **Fixed shapes.** Object fields are slots resolved at compile time; `Object.freeze` does nothing and errors carry `name` and `message` only.
- **Class methods stay bound.** An extracted class method retains its instance. Object-literal methods use the call receiver.
- **Numeric export parameters.** A parameter an exported function never uses as a string is compiled as a number and converted at the boundary: `export let add = (a, b) => a + b` gives `add(1, '2')` as 3, where JavaScript concatenates.

</details>

<details>
<summary><strong>Why no type annotations?</strong></summary>

Ordinary code already carries useful type evidence: `let x = 0.5`,
`Float32Array`, an array index, a loop counter. JZ infers it instead of
turning the file into another language. Ambiguous values fall back to a
slower dynamic path, and `why` shows where.

</details>

<details>
<summary><strong>How do values cross the boundary?</strong></summary>

Numbers pass directly. Strings, arrays and typed arrays are copied in and
decoded on the way out; numeric writes to an array argument are copied back
after the call, other changes to it (length, non-numeric elements) are not. A
plain object passes by reference: the module reads, writes, lists and
serializes it through the host, so the caller sees its changes. A JZ buffer
(`memory.Float64Array(n)`) is the storage itself, so hand hot loops one of
those instead of copying per call.

```js
const { exports } = jz`
  export const greet = s => s.length
  export const point = (x, y) => ({ x, y })
  export const rgb = c => [c, c * 0.5, c * 0.2]
`
exports.greet('hello')   // 5
exports.point(3, 4)      // { x: 3, y: 4 }
exports.rgb(100)         // [100, 50, 20]
```

Host functions come in through `imports`; a tagged template inlines values and
functions at compile time:

```js
jz('import { log } from "host"; export const f = x => { log(x); return x }',
   { imports: { host: { log: console.log } } })

jz('import { sin, PI } from "math"; export const f = () => sin(PI / 2)',
   { imports: { math: Math } })

const scale = x => x * 10
jz`export const f = n => ${scale}(n) + ${[10, 20, 30]}[1]`   // f(2) → 40
```

Ship the `.wasm` and load it with `instantiate` from `jz/interop`, a 13 KB
gzipped runtime that marshals values and decodes errors; the compiler stays in
the build.

</details>

<details>
<summary><strong>How does memory work?</strong></summary>

Heap modules use a bump allocator: no free list, no garbage collector.
Allocations are dropped in batches with `memory.reset()`, which invalidates
every earlier pointer.

```js
for (let i = 0; i < 1000; i++) {
  exports.process(100)   // allocates on the WASM heap
  memory.reset()         // drop the batch
}
```

`jz.memory()` creates one memory for several modules, so one can read what
another allocated:

```js
const memory = jz.memory()
const a = jz('export const make = () => ({ x: 10, y: 20 })', { memory })
const b = jz('export const read = o => o.x + o.y', { memory })

b.exports.read(a.exports.make()) // 30
```

`memory: { shared: true }` compiles for threads, with `Atomics` lowering to
wasm atomics. Shared typed arrays and scalars cross; strings and objects stay
thread-local.

</details>

<details>
<summary><strong>Can I use npm packages and ES modules?</strong></summary>

Packages compile when their source fits the language. `import`/`export` bundle
into one module at compile time; there is no runtime module resolution. The CLI
reads relative and bare specifiers from disk; in a browser, pass sources through
`modules`. Circular imports fail at compile time.

```js
jz('import { add } from "./math.js"; export const f = (a, b) => add(a, b)',
   { modules: { './math.js': 'export const add = (a, b) => a + b' } })
```

</details>

<details>
<summary><strong>Is it fast? How small?</strong></summary>

Faster than V8 and AssemblyScript on almost every kernel we measure, about 2×
on average. Every number, and every loss, is on the
[bench page](https://jz.js.org/bench/).

Nothing ships that the program does not reach: a heap-free numeric module has
no memory, allocator or startup, and an empty program is an empty module.
Size-optimized JZ stays within 5% of AssemblyScript's geomean while keeping
JavaScript's bounds checks.

</details>

<details>
<summary><strong>How do I inspect or debug the output?</strong></summary>

- `jz kernel.js --wat` or `compile(src, { wat: true })` prints the WAT. Search
  for `v128` to confirm vectorization and for `__dyn_get` or `__ext_call` to find
  dynamic fallbacks.
- `--why` names the first operation that kept each loop scalar and each arena
  unreclaimed; `warnings` collects the same advisories from the API, with each
  property read left dynamic (`deopt-prop-read`), each class kept as closures
  (`class-generic`) and the first cause an object shape is lost by (`shape-lost`).
- Float loop counters, plain arrays and loop-carried dependencies are the common
  reasons a kernel stays scalar.

</details>

<details>
<summary><strong>How does JZ compare with Porffor, AssemblyScript, scriptc etc.?</strong></summary>

- **[Porffor](https://github.com/CanadaHonk/porffor)** targets broad engine
  coverage with an AOT JS→IR→C/native compiler; its current alpha line has no
  WASM target. JZ emits WASM first for an inferred typed subset. JZ may not lose
  to Porffor's native artifact on speed or size per case or by geomean.
- **[scriptc](https://github.com/vercel-labs/scriptc)** also AOT-compiles typed JS/TS without an engine (TS annotations → LLVM), embedding QuickJS only as an opt-in fallback for dynamic code. It is native-first with WASI as a target; JZ is WASM-first, infers types from idiomatic untyped JS, and keeps dynamic fallbacks inside the WASM module.
- **[AssemblyScript](https://github.com/AssemblyScript/assemblyscript)** produces lean WASM, but is not directly executable JavaScript.
- **Rust, C, Zig, Go, and MoonBit** compiled to wasm run behind JZ by geomean on
  the corpus: rustc, clang and zig about 2×, Go and MoonBit over 4×. As native
  binaries Rust, Zig and Go still trail and C is level, so a rewrite buys a
  second toolchain and test suite for slower wasm.
- **[Javy](https://github.com/bytecodealliance/javy)** and
  **[ComponentizeJS](https://github.com/bytecodealliance/ComponentizeJS)** accept
  broader JavaScript by shipping an interpreter or engine inside WASM.

</details>

<details>
<summary><strong>Is JZ production-ready?</strong></summary>

JZ is experimental and pre-1.0: pin a version and re-test upgrades. CI runs the
core suite, selected test262 tests, the benchmark gate and a self-compile
(`npm run test:self` builds `dist/jz.wasm`, the compiler compiled by itself).
The same WASM lowers to native through wasm2c; see the
[native pipeline](scripts/native/README.md).

Adoption is ejectable: remove the JZ build step and the source remains JavaScript.

</details>

## Stability

Pre-1.0. The package entry points `jz`, `compile`, `instantiate` and
`jz/interop`, the options above and the CLI flags are the contract; removing or
changing them takes a major version. Error classes and codes are stable within
a major. Accepted programs preserve JavaScript values, exceptions and
evaluation order at every optimization level, outside the differences listed
above. The raw wasm ABI (pointer layout, allocator exports, custom sections) is
not stable: load prebuilt modules with `jz/interop` from the same JZ version.
[CONTRIBUTING](CONTRIBUTING.md#public-contract-and-abi) has the details.

<p align="center">
  <a href="LICENSE">MIT</a>, <a href="https://github.com/krishnized/license/">ॐ</a>
</p>
