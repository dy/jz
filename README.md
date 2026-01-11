# jz ![stability](https://img.shields.io/badge/stability-experimental-black)

Tiny _JavaScript to WASM compiler_, supporting modern minimal functional JS subset.

## Usage

```js
import jz from 'jz'

const { mul } = jz`export mul = (a, b) => a * b`
mul(2, 3) === 6
```

## Reference

* Numbers: `0.1`, `1.2e+3`, `0xabc`, `0b101`, `0o357`
* Strings: `"abc"`, `'abc'`, `` `template ${literals}` ``
* Values: `true`, `false`, `null`, `NaN`, `Infinity`, ~~`undefined`~~
* Access: `a.b`, `a[b]`, `a(b)`, `a?.b`, `a?.(b)`
* Arithmetic:`+a`, `-a`, `a + b`, `a - b`, `a * b`, `a / b`, `a % b`, `a ** b`
* Comparison: `a < b`, `a <= b`, `a > b`, `a >= b`, `a == b`, `a != b`, `a === b`, `a !== b`
* Bitwise: `~a`, `a & b`, `a ^ b`, `a | b`, `a << b`, `a >> b`, `a >>> b`
* Logic: `!a`, `a && b`, `a || b`, `a ?? b`, `a ? b : c`
* Increments: `a++`, `a--`, `++a`, `--a`
* Assignment: `a = b`, `a += b`, `a -= b`, `a *= b`, `a /= b`, `a %= b`, `a **= b`, `a <<= b`, `a >>= b`, `a >>>= b`
* Logical Assignment: `a ||= b`, `a &&= b`, `a ??= b`
* Arrays: `[a, b]`, `...a`, `[a, ...b]`
* Objects: `{a: b}`, `{a, b}`, `{...obj}`
* Declarations: `let a, b`, `const c` (no `var`)
* Functions: `(a, b) => c`, `a => b`, `() => c`
* Comments: `// foo`, `/* bar */`
* Control Flow: `if (a) {...} else if (b) {...} else {}`, `for (a;b;c) {...}`, `while (a) {...}`
* Exceptions: `try {...} catch (e) {...}`, `throw expression`
* Modules: `import`, `export`


## API

```js
import { compile, evaluate, instantiate } from 'jz'

// Evaluate WAT expressions directly
const result = await evaluate('(f64.add (f64.const 1) (f64.const 2))')
console.log(result) // 3

// Compile to WASM binary (default)
const wasm = compile('(f64.add (f64.const 1) (f64.const 2))')
console.log('WASM size:', wasm.byteLength, 'bytes')

// Compile to WAT source text
const wat = compile('(f64.add (f64.const 1) (f64.const 2))', { format: 'wat' })
console.log('WAT source:', wat)

// Compile and instantiate separately
const instance = await instantiate(wasm)
const runResult = instance.run()
console.log(runResult) // 3

// Or use WebAssembly API directly
const module = await WebAssembly.compile(wasm)
const wasmInstance = await WebAssembly.instantiate(module)
console.log(wasmInstance.exports.main()) // 3
```

### CLI

```bash
# Install globally
npm install -g jz

# Evaluate WAT expressions
jz "(f64.add (f64.const 1) (f64.const 2))"
# Output: 3

# Compile to WASM binary (default)
jz compile program.wat -o program.wasm
# Creates: program.wasm

# Compile to WAT source text
jz compile program.wat --format wat -o program.wat
# Creates: program.wat (copy with stdlib)

# Run WAT files directly
jz run program.wat
# Output: [result]

# Show help
jz --help
```

## Examples

_Coming soon_.

<!--
* [ ] Microcontroller program
* [ ] Floatbeat
* [ ] Embed into website
 -->


## Why?

JS grew complex with legacy (`var`, OOP) and niche features (generators, async).
JZ is minimal modern subset that maps directly to WebAssembly.

* No classes/prototypes – use functions & closures.
* No old syntax – modern ES6+ only.
* No async – keep code plain & simple.

### Goals

* _Lightweight_ – embed anywhere, from websites to microcontrollers.
* _Fast_ – compiles faster than `eval` parses.
* _Tiny output_ – no runtime, no heap.

### Why not [porffor](https://github.com/CanadaHonk/porffor)?

Porffor is brilliant, but aligns to TC39. JZ stays small and flexible.

### Why not [assemblyscript](https://github.com/AssemblyScript/assemblyscript)?

AssemblyScript is TypeScript-based. JZ stays pure JS.

### Why _jz_?

JavaScript Zero – stripped to essentials. Also jazzy.

## Built With

* [subscript](https://github.com/dy/subscript) – parser
* [watr](https://www.npmjs.com/package/watr) – WAT to WASM

<p align=center><a href="https://github.com/krishnized/license/">🕉</a></p>
