# Floatbeat/Bytebeat Analysis for JZ

## Goal
Enable JZ to run floatbeat and bytebeat formulas - algorithmic music generation where `t` is the sample number.

## Core Formula Types

### Classic Bytebeat (C-compatible)
```js
t*(2&t>>13?7:5)*(3-(3&t>>9)+(3&t>>8))>>(3&-t>>(t&4096|(t>>11)%32>28?2:16))|t>>3
```
**Features needed:**
- `t` variable (input parameter)
- Arithmetic: `*`, `+`, `-`
- Bitwise: `&`, `|`, `^`, `~`
- Shifts: `>>`, `<<`
- Comparison: `>`, `<`, `>=`, `<=`
- Ternary: `? :`
- Modulo: `%`
- Grouping: `()`

### Floatbeat (JS with Math)
```js
sin(t * PI / 128) * 0.5
```
**Additional features needed:**
- Math functions: `sin`, `cos`, `tan`, `asin`, `acos`, `atan`
- Math functions: `sqrt`, `cbrt`, `pow`, `exp`, `log`
- Math functions: `floor`, `ceil`, `round`, `int` (alias for floor/trunc)
- Math functions: `abs`, `min`, `max`, `sign`
- Math functions: `tanh`
- Constants: `PI`, `E`
- Float literals with scientific notation: `1e3`, `1.5e-2`
- `random()` (stateful but often used)

---

## Operator Priority for JZ

### ✅ Already Implemented (in codegen.js)
| Category | Operators | Type |
|----------|-----------|------|
| Arithmetic | `+`, `-`, `*`, `/`, `%` | i32/f64 |
| Unary | `u+`, `u-`, `!`, `~` | varies |
| Comparison | `==`, `===`, `!=`, `!==`, `<`, `<=`, `>`, `>=` | i32 |
| Bitwise | `&`, `\|`, `^` | i32 |
| Shifts | `<<`, `>>`, `>>>` | i32 |
| Logical | `&&`, `\|\|`, `??` | value |
| Ternary | `? :` | conciliated |
| Exponent | `**` | f64 (stub) |

### 🔴 Must Implement (Essential for Floatbeats)

#### 1. Input Variable: `t` (sample counter)
Currently JZ has no way to reference `t`. This is THE essential missing piece.
```js
// Need: `t` references parameter $t
(module (func $main (param $t f64) (result f64) ...))
```

#### 2. Math Functions (via WASM intrinsics + stdlib)
| Function | WASM | Frequency in corpus |
|----------|------|---------------------|
| `sin` | f64.sin (proposal) or stdlib | **VERY HIGH** |
| `cos` | f64.cos (proposal) or stdlib | High |
| `tan` | stdlib (sin/cos) | Medium |
| `sqrt` | f64.sqrt (native!) | High |
| `abs` | f64.abs (native!) | High |
| `floor` | f64.floor (native!) | High |
| `ceil` | f64.ceil (native!) | Medium |
| `min` | f64.min (native!) | High |
| `max` | f64.max (native!) | High |
| `pow` | stdlib | **VERY HIGH** |
| `exp` | stdlib | Medium |
| `log` | stdlib | Medium |
| `asin` | stdlib | Medium |
| `acos` | stdlib | Low |
| `atan` | stdlib | Medium |
| `tanh` | stdlib | Medium |
| `cbrt` | stdlib | Medium |
| `sign` | stdlib | Low |
| `random` | import from JS | Medium |

#### 3. Constants
| Constant | Value |
|----------|-------|
| `PI` | 3.141592653589793 |
| `E` | 2.718281828459045 |

#### 4. `int()` function (common alias)
```js
int(x) === Math.floor(x)  // or trunc() depending on convention
```

### 🟡 Nice to Have (Extended Floatbeats)

#### Assignment & Variables (for complex beats)
```js
tune = 1.3,
speed = 1.375,
tt = t * tune,
...
```

#### Array Indexing (for sequences)
```js
[0, 2, 4, 7, 9][t >> 13 & 7]
```

#### String parsing (for note sequences)
```js
parseInt('16ADID269E9EILQL'[x >> 11 & 31], 36)
```

---

## Implementation Plan

### Phase 1: Core Floatbeat Support (Minimal Viable)
1. **`t` parameter** - Pass sample number to WASM
2. **`PI` constant** - Inline f64.const
3. **Math natives** - `sqrt`, `abs`, `floor`, `ceil`, `min`, `max` (already in WASM)
4. **`pow` function** - Implement in stdlib
5. **`sin`/`cos`** - Import from JS or use WASM SIMD proposal

### Phase 2: Full Math Library
1. **Trig** - `tan`, `asin`, `acos`, `atan`, `atan2`
2. **Hyperbolic** - `tanh`, `sinh`, `cosh`
3. **Exponential** - `exp`, `log`, `log2`, `log10`
4. **Root** - `cbrt`
5. **Misc** - `sign`, `round`, `trunc`

### Phase 3: Variables & Arrays
1. **Comma expressions** - `a = 1, b = 2, a + b`
2. **Let/const bindings** - Store in WASM locals
3. **Array literals** - Store in linear memory
4. **Array indexing** - Memory load

---

## Sample Formulas to Test

### Tier 1: Basic (must work first)
```js
// Sierpinski
t & t >> 8

// Simple sine
sin(t * PI / 128) * 0.5

// Classic
t * ((t >> 12 | t >> 8) & 63 & t >> 4)
```

### Tier 2: Intermediate
```js
// With modulo and floor
sin(floor(t / 128) * PI / 4) * 0.3

// With pow and comparisons
pow(sin(t * 0.01), 2) * (t % 8192 < 4096 ? 1 : 0)
```

### Tier 3: Advanced
```js
// Sequence-based
p = [2, 4, 5, 9][t >> 13 & 3],
sin(t * pow(2, p / 12) * PI / 256)
```

---

## Test Case Proposals

```js
// Add to test/core.js or test/floatbeat.js

test('floatbeat - t variable', async t => {
  // t=0 should return 0 for sin(t*...)
  t.equal(await evaluate('t', { t: 0 }), 0)
  t.equal(await evaluate('t', { t: 100 }), 100)
  t.equal(await evaluate('t + 1', { t: 5 }), 6)
})

test('floatbeat - PI constant', async t => {
  t.closeTo(await evaluate('PI'), 3.14159, 0.001)
  t.closeTo(await evaluate('PI / 2'), 1.5708, 0.001)
})

test('floatbeat - native math', async t => {
  t.equal(await evaluate('sqrt(4)'), 2)
  t.equal(await evaluate('abs(-5)'), 5)
  t.equal(await evaluate('floor(3.7)'), 3)
  t.equal(await evaluate('ceil(3.2)'), 4)
  t.equal(await evaluate('min(1, 2)'), 1)
  t.equal(await evaluate('max(1, 2)'), 2)
})

test('floatbeat - sin/cos', async t => {
  t.closeTo(await evaluate('sin(0)'), 0, 0.001)
  t.closeTo(await evaluate('sin(PI/2)'), 1, 0.001)
  t.closeTo(await evaluate('cos(0)'), 1, 0.001)
  t.closeTo(await evaluate('cos(PI)'), -1, 0.001)
})

test('floatbeat - pow', async t => {
  t.equal(await evaluate('pow(2, 3)'), 8)
  t.equal(await evaluate('2 ** 3'), 8)
  t.closeTo(await evaluate('pow(2, 0.5)'), 1.414, 0.001)
})

test('floatbeat - classic sierpinski', async t => {
  t.equal(await evaluate('t & (t >> 8)', { t: 256 }), 1)
  t.equal(await evaluate('t & (t >> 8)', { t: 512 }), 2)
})

test('floatbeat - simple sine', async t => {
  const v = await evaluate('sin(t * PI / 128)', { t: 64 })
  t.closeTo(v, 1, 0.001) // sin(π/2) = 1
})
```

---

## WASM Module Structure

```wat
(module
  ;; Imports for transcendentals (if not using WASM proposals)
  (import "env" "sin" (func $sin (param f64) (result f64)))
  (import "env" "cos" (func $cos (param f64) (result f64)))
  (import "env" "random" (func $random (result f64)))

  ;; Constants
  (global $PI f64 (f64.const 3.141592653589793))
  (global $E f64 (f64.const 2.718281828459045))

  ;; Stdlib functions
  (func $pow (param f64 f64) (result f64) ...)
  (func $tan (param f64) (result f64) ...)

  ;; Main expression - takes t, returns sample value
  (func $main (export "main") (param $t f64) (result f64)
    ;; Generated expression goes here
  )
)
```
