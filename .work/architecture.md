# jz Architecture v2

## Status: WORKING ✓

Minimal core (~700 lines) + modules (~100 lines each)

```
Source → Parse → Analyze → Lower → Optimize → Assemble → watr
                              ↑         ↑
                          modules    passes
```

## Current Files

| File | Lines | Purpose |
|------|-------|---------|
| src/parse.js | 17 | subscript/jessie wrapper |
| src/analyze.js | 136 | scope analysis |
| src/emit.js | 200 | AST → IR (watr format) |
| src/optimize.js | 107 | IR passes |
| src/assemble.js | 34 | combine into module |
| src/context.js | 18 | createContext() factory |
| src/compile.js | 61 | compile() entry point |
| module/_core.js | 128 | module extension API |
| module/math.js | 80 | sin, cos, sqrt, PI, etc. |
| index.js | 20 | package entry + register modules |

**Total: ~801 lines**

## Working Features

- [x] Export function declarations
- [x] Arrow functions with single/multiple params
- [x] Binary ops: `+`, `-`, `*`, `/`, `**`
- [x] Unary ops: `-`, `!`
- [x] Built-in WASM ops: sqrt, abs, floor, ceil, min, max
- [x] Module system with emitters
- [x] Stdlib functions: sin, cos, tan, pow
- [x] Constants: PI, E
- [x] Optimization passes (constant folding, strength reduction)

## IR Format (= watr format)

```js
// Literals
['f64.const', 42]
['i32.const', 1]

// Locals
['local.get', '$x']
['local.set', '$x', <ir>]

// Binary ops
['f64.add', <left>, <right>]
['f64.mul', <left>, <right>]

// Unary ops
['f64.neg', <arg>]
['f64.sqrt', <arg>]

// Calls
['call', '$sin', <arg>, ...]

// Control flow
['if', ['result', 'f64'], <cond>, ['then', <expr>], ['else', <expr>]]
['block', '$b', <stmt>, ...]
['loop', '$l', <stmt>, ...]
['br', '$b']
['return', <val>]

// Function definition
['func', ['export', '"f"'], ['param', '$x', 'f64'], ['result', 'f64'], <body>...]

// Module
['module', <func>, <func>, ...]
```

### Why IR?

1. **Optimization passes work on IR tree** - clean tree manipulation
2. **Modules emit IR, not strings** - no string concatenation hell
3. **Analysis is easy** - just traverse arrays
4. **No emit step** - IR IS the watr input format

## module/_core.js API

Module extension API for language authors:

```js
import {
  type,           // Declare type signatures
  emit,           // Custom IR emission for a construct
  op,             // Direct WASM op mapping
  optimize,       // Register optimization pass
  func,           // Declare stdlib function (WAT string)
  extern,         // Declare host import
  needsMemory,    // Mark memory requirement
  createContext,  // Context factory
} from './module/_core.js'
```

### type(ctx, name, signature)

Declare type for analysis:

```js
type(ctx, 'sin', 'f64 -> f64')
type(ctx, 'PI', 'f64')
type(ctx, 'atan2', '(f64, f64) -> f64')
```

Signature formats:
- `'f64 -> f64'` - single param, single return
- `'(f64, f64) -> f64'` - multi param
- `'f64 -> (f64, i32)'` - multi return
- `'f64'` - constant (no arrow)

### emit(ctx, name, handler)

Custom IR emission (receives pre-lowered args):

```js
emit(ctx, 'PI', () => ['f64.const', Math.PI])
emit(ctx, '**', (args) => ['call', '$__pow', ...args])
```

### op(ctx, name, wasmOp)

Direct WASM instruction mapping:

```js
op(ctx, 'sqrt', 'f64.sqrt')
op(ctx, 'abs', 'f64.abs')
op(ctx, 'floor', 'f64.floor')
```

### optimize(ctx, name, fn)

Register optimization pass (tree → tree):

```js
optimize(ctx, 'fold-constants', ([op, ...args]) => {
  if (op === 'f64.add' && args[0]?.[0] === 'f64.const' && args[1]?.[0] === 'f64.const') {
    return ['f64.const', args[0][1] + args[1][1]]
  }
  return [op, ...args]
})
```

### func(ctx, name, wat)

Declare stdlib function (WAT string, parsed by watr):

```js
func(ctx, 'sin', `
  (func $__sin (param $x f64) (result f64)
    (local $x2 f64) (local $x3 f64)
    ;; Taylor series...
    (f64.add (local.get $x) ...))
`)
```

Auto-registers emitter: `sin(x)` → `['call', '$__sin', <x>]`

### extern(ctx, mod, name, signature)

Declare host import:

```js
extern(ctx, 'env', 'log', 'f64 -> void')
// Adds: ['import', '"env"', '"log"', ['func', '$__env_log', ['param', 'f64']]]
```

## Context Structure

```js
// src/context.js
export function createContext() {
  return {
    types: new Map(),      // name → { params, returns }
    emitters: new Map(),   // name → (args, ctx) => IR
    passes: [],            // [{ name, fn }]
    funcs: [],             // [IR tree, ...]
    imports: [],           // [IR tree, ...]
    needsMemory: false,
  }
}
```

Module functions mutate ctx directly - no return values, no global state.

## Module Structure

```js
// module/math.js
import { type, emit, op, func } from './_core.js'

export function register(ctx) {
  // Types
  type(ctx, 'sin', 'f64 -> f64')
  type(ctx, 'sqrt', 'f64 -> f64')
  type(ctx, 'PI', 'f64')

  // Direct WASM ops
  op(ctx, 'sqrt', 'f64.sqrt')
  op(ctx, 'abs', 'f64.abs')

  // Custom emission
  emit(ctx, 'PI', () => ['f64.const', Math.PI])
  emit(ctx, '**', (args) => ['call', '$__pow', ...args])

  // Stdlib functions (WAT strings)
  func(ctx, 'sin', `(func $__sin (param $x f64) (result f64) ...)`)
}
```

## File Structure

```
src/
  parse.js          # subscript wrapper
  analyze.js        # scope, types
  emit.js           # AST → IR
  optimize.js       # run passes on IR tree
  assemble.js       # combine into module
  context.js        # createContext() factory
  compile.js        # compile() entry point

module/
  _core.js          # module extension API
  math.js           # sin, cos, sqrt, PI, etc.

index.js            # package entry + register modules
```

## Compilation Flow

```js
// src/compile.js
import { compile as watrCompile } from 'watr'

export function compile(code, ctx) {
  // 1. Parse
  const ast = parse(code)

  // 2. Analyze
  analyze(ast, ctx)

  // 3. Emit AST → IR
  const ir = emit(ast, ctx)

  // 4. Optimize IR
  const optimized = optimize(ir, ctx.passes)

  // 5. Assemble module
  const moduleIR = assemble(optimized, ctx)

  // 6. watr compiles IR tree directly to binary
  return watrCompile(moduleIR)
}
```

## Optimizer

```js
// src/optimize.js
export function optimize(ir, passes) {
  let result = ir
  for (const { fn } of passes) {
    result = transform(result, fn)
  }
  return result
}

// Deep transform IR tree (bottom-up)
function transform(ir, fn) {
  if (!Array.isArray(ir)) return ir
  const [op, ...args] = ir
  const transformed = [op, ...args.map(arg => transform(arg, fn))]
  return fn(transformed)
}
```

## Assemble

```js
// src/assemble.js
export function assemble(bodyIR, ctx) {
  const sections = []
  sections.push(...ctx.imports)
  if (ctx.needsMemory) {
    sections.push(['memory', ['export', '"memory"'], 1])
  }
  sections.push(...ctx.funcs)
  sections.push(...bodyIR)
  return ['module', ...sections]
}
```
