# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

_Research on the topic_: JS syntax that compiles to pure WASM. No runtime, no GC, no overhead.

```js
import jz from 'jz'
import math from 'jz/module/math.js'

// JS → WASM, with Math module
const wasm = jz(`
  export let sine = (freq, t, i) =>
    Math.sin((t + i) * freq * Math.PI * 2 / 44100)
`, { modules: [math] })

const { sine } = (await WebAssembly.instantiate(wasm)).instance.exports
sine(440, 0, 0)  // Real-time audio at native speed
```

## Usage

```js
import jz from 'jz'

const wasm = jz(`export let add = (a, b) => a + b`)
const { add } = (await WebAssembly.instantiate(wasm)).instance.exports

add(2, 3)  // 5
```

### With Modules

```js
import jz from 'jz'
import math from 'jz/module/math.js'

const wasm = jz(`export let f = x => Math.sqrt(x)`, { modules: [math] })
```


### CLI

```bash
# Install globally
npm install -g jz

# Evaluate expression (requires watr)
jz "1 + 2"
# Output: 3

# Compile to WAT (default)
jz compile program.js -o program.wat

# Compile to WASM binary (requires watr)
jz compile program.js -o program.wasm

# Run compiled program (requires watr)
jz run program.js

# Show help
jz --help
```


## Reference

* Numbers: `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0o357`
* Strings: `"abc"`, `'abc'`
* Values: `true`, `false`, `null`, `NaN`, `Infinity`
* Math: `Math.PI`, `Math.E`, `Math.sin(x)`, `Math.sqrt(x)`, etc.
* Access: `a.b`, `a[b]`, `a(b)`, `a?.b`
* Arithmetic:`+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
* Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`
* Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
* Logic: `!a`, `a && b`, `a || b`, `a ?? b`, `a ? b : c`
* Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`
* Arrays: `[a, b]`, `arr[i]`, `arr[i] = x`, `arr.length`
* TypedArrays: `new Float32Array(n)`, `buf[i]`, `buf.length`, `buf.byteLength`
* Objects: `{a: b}`, `{a, b}`, `obj.prop`
* Boxed primitives: `Object.assign(42, {prop})`, `Object.assign("str", {prop})`, `Object.assign([arr], {prop})`
* Functions: `(a, b) => c`, `a => b`, `() => c`
* Currying: `add = x => y => x + y; add(5)(3)`
* Comments: `// foo`, `/* bar */`
* Declarations: `let`, `const`, block scope
* Strict equality: `===`, `!==`
* Closures: capture outer variables
* Rest/spread: `...args`, `[...arr]`
* Destructuring params: `({ x }) => x`
* Regex: `/pattern/.test(str)` - compile-time regex, native WASM matching
* More array/string methods


<!--

## Examples

### Color Space Conversion

```js
const { rgb2gray } = await jz.instantiate(jz.compile(`
  rgb2gray = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b
`))

rgb2gray(255, 128, 0)  // 161.279...
```

### Floatbeat

```js
const { floatbeat } = await jz.instantiate(jz.compile(`
  floatbeat = t => sin(t * 440 * PI * 2 / 8000) * 0.5
`))

// Generate audio samples
for (let t = 0; t < 8000; t++) {
  audioBuffer[t] = floatbeat(t)
}
```

## Used by

* [color-space]()
* [web-audio-api]()

-->

<!--
## Why?

JS grew complex with legacy (`var`, OOP) and niche features (generators, async).
JZ is minimal modern subset that maps to WebAssembly.

* No classes/prototypes – use functions & closures.
* No old syntax – modern ES6+ only.
* No async – keep code plain & simple.
* **Static typing** – all types resolved at compile-time, no runtime dispatch.

### Goals

* _Lightweight_ – embed anywhere, from websites to microcontrollers.
* _Fast_ – compiles to WASM faster than `eval` parses.
* _Tiny output_ – no runtime, no heap, no wrappers.
* _Zero overhead_ – no runtime type checks, functions monomorphized per call-site.
* _JS interop_ – export/import preserve func signatures at WASM boundary.
* _JS compat_ – any jz is valid js (with [limitations](./docs.md#limitations-divergences))
-->

<!--

### Why not [porffor](https://github.com/CanadaHonk/porffor)?

Porffor is brilliant, but aligns to TC39 and hesitant on full WASM. JZ stays small, fast and flexible.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

AssemblyScript is TypeScript-based. JZ stays pure JS.

### Why not [piezo](https://github.com/dy/piezo)?

Piezo offers extra features like groups, pipes, units, ranges and extra operators. JZ is a possible first step for it.
-->

<!--
### Why _jz_?

JavaScript Zero – a return to core, stripped to essentials. Also jazzy.
-->

## Built With

* [subscript](https://github.com/dy/subscript) – parser
* [watr](https://www.npmjs.com/package/watr) – WAT to WASM

## Similar

* [porffor](https://github.com/CanadaHonk/porffor)
* [jawsm](https://github.com/drogus/jawsm?tab=readme-ov-file)

<p align=center><a href="https://github.com/krishnized/license/">ॐ</a></p>
