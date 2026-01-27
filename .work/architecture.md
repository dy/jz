# jz Architecture v2

## Principle

**Minimal core + IR + registerable modules**

```
Source → Parse → AST → Lower → IR → Optimize → Emit → WAT
                         ↑          ↑
                      modules    passes
```

## Pipeline

```
┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌─────────┐
│  Parse  │ →  │ Analyze │ →  │  Lower  │ →  │Optimize │ →  │  Emit   │
│ (subscript)  │ (scope) │    │ (AST→IR)│    │  (IR)   │    │ (IR→WAT)│
└─────────┘    └─────────┘    └─────────┘    └─────────┘    └─────────┘
     ↑              ↑              ↑              ↑
   syntax        types         codegen        passes
  extensions   from modules   from modules   (pluggable)
```

## IR (Intermediate Representation)

**IR === watr's parsed tree format**

watr already uses S-expression arrays internally:
```js
['f64.add', ['local.get', '$x'], ['f64.const', 1]]
```

jz emits this directly → watr compiles to binary (no parsing step).

```js
// Old (wasteful)
jz: AST → WAT string → watr.parse() → tree → binary

// New (direct)
jz: AST → IR (=== watr tree) → binary
```

### IR Format (= watr format)

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
['i32.and', <left>, <right>]

// Unary ops
['f64.neg', <arg>]
['f64.sqrt', <arg>]
['i32.eqz', <arg>]

// Calls
['call', '$sin', <arg>, ...]

// Control flow
['if', ['result', 'f64'], <cond>, ['then', <expr>], ['else', <expr>]]
['block', '$b', <stmt>, ...]
['loop', '$l', <stmt>, ...]
['br', '$b']
['br_if', '$b', <cond>]
['return', <val>]

// Memory
['f64.load', ['i32.const', 0]]           // offset in nested expr
['f64.store', <addr>, <val>]

// Function definition
['func', ['export', '"f"'], ['param', '$x', 'f64'], ['result', 'f64'], <body>...]

// Module
['module', <func>, <func>, ...]
```

### Benefits

1. **No WAT text** - zero string concatenation
2. **No parsing** - watr.compile() takes tree directly
3. **Optimization is tree manipulation** - clean JS
4. **Same format as watr** - no translation layer
5. **Subscript-style** - familiar `[op, ...args]` pattern


### Why IR?

1. **Optimization passes work on IR tree**
   ```js
   // Constant folding pass
   function foldConstants([op, ...args]) {
     if (op === 'f64.add' && args[0][0] === 'f64.const' && args[1][0] === 'f64.const') {
       return ['f64.const', args[0][1] + args[1][1]]
     }
     return [op, ...args]
   }
   ```

2. **Modules emit IR, not strings**
   ```js
   // Clean
   lower('sin', (args) => ['call', '$__sin', ...args])
   
   // vs old way (string hell)
   compile: (args) => `(call $__sin ${args[0]})`
   ```

3. **Analysis is easy**
   ```js
   // Find all calls in IR
   const findCalls = ([op, ...args]) => 
     op === 'call' ? [args[0]] : args.flatMap(a => Array.isArray(a) ? findCalls(a) : [])
   ```

4. **No emit step** - IR IS the output format for watr

## jz:core Exports

What module authors import to extend the language:

```js
import { 
  // Syntax
  syntax,         // Add operators, literals
  
  // Types
  type,           // Declare type signatures
  
  // Lowering (AST → IR)
  lower,          // Custom AST → IR for a construct
  
  // Optimization
  pass,           // Register optimization pass
  
  // Assembly
  func,           // Declare stdlib function (IR form)
  import_,        // Declare host import
  
} from 'jz:core'
```

### syntax(pattern, handler)

Extend parser via subscript:

```js
// Add |> operator
syntax('|>', { prec: 1, assoc: 'left' }, (left, right) => 
  // Return AST node
  ['()', right, [left]]
)

// Add numeric suffix: 440hz
syntax(/\d+hz/, (match) => 
  ['*', parseFloat(match), ['/', 1, 44100]]
)
```

### type(name, signature)

Declare type for analysis:

```js
type('sin', '(f64) -> f64')
type('PI', 'f64')
type('map', '<T, U>(Array<T>, (T) -> U) -> Array<U>')
```

### lower(pattern, handler)

Custom AST → IR lowering:

```js
// How to lower sin(x) call
lower('sin', (args, ctx) => 
  ['call', '$__sin', ...args.map(a => ctx.lower(a))]
)

// How to lower PI constant
lower('PI', () => ['f64.const', Math.PI])

// How to lower array literal [a, b, c]
lower('[', (elements, ctx) => {
  const ptr = ctx.alloc(8 + elements.length * 8)
  return ['block', ['result', 'f64'],
    ['i32.store', ['i32.const', ptr], ['i32.const', elements.length]],
    ...elements.map((e, i) => 
      ['f64.store', ['i32.const', ptr + 8 + i*8], ctx.lower(e)]
    ),
    ['call', '$__mkptr', ['i32.const', 1], ['i32.const', ptr]]  // type=ARRAY
  ]
})
```

### pass(name, fn)

Register optimization pass (tree → tree):

```js
// Constant folding
pass('fold-constants', ([op, ...args]) => {
  if (op === 'f64.add' && args[0][0] === 'f64.const' && args[1][0] === 'f64.const') {
    return ['f64.const', args[0][1] + args[1][1]]
  }
  if (op === 'f64.mul' && args[0][0] === 'f64.const' && args[1][0] === 'f64.const') {
    return ['f64.const', args[0][1] * args[1][1]]
  }
  return [op, ...args]
})

// Dead code elimination
pass('dce', ([op, ...args]) => {
  if (op === 'if' && args[1][0] === 'i32.const') {
    return args[1][1] ? args[2] : args[3]  // then or else
  }
  return [op, ...args]
})

// Strength reduction
pass('strength-reduce', ([op, ...args]) => {
  // x * 2 → x + x
  if (op === 'f64.mul' && args[1][0] === 'f64.const' && args[1][1] === 2) {
    return ['f64.add', args[0], args[0]]
  }
  return [op, ...args]
})
```

### func(name, params, result, body)

Declare stdlib function (in IR form):

```js
// Sin function via Taylor series
func('$__sin', [['param', '$x', 'f64']], 'f64', [
  ['local', '$x2', 'f64'],
  ['local', '$r', 'f64'],
  // ... body as IR
])
```

### import_(module, name, signature)

Declare host import:

```js
import_('env', 'log', '(f64) -> void')
// Adds to module: ['import', '"env"', '"log"', ['func', '$__env_log', ['param', 'f64']]]
```

## Module Structure

```js
// module/math.js
import { type, lower, func } from 'jz:core'

// Type declarations
type('sin', '(f64) -> f64')
type('cos', '(f64) -> f64')
type('sqrt', '(f64) -> f64')
type('PI', 'f64')

// Lowering: how to compile each symbol
lower('sin', (args, ctx) => ['call', '$__sin', ...args.map(ctx.lower)])
lower('cos', (args, ctx) => ['call', '$__cos', ...args.map(ctx.lower)])
lower('sqrt', (args, ctx) => ['f64.sqrt', ctx.lower(args[0])])
lower('PI', () => ['f64.const', Math.PI])

// Stdlib functions (as IR, not WAT text)
func('$__sin', [['param', '$x', 'f64']], 'f64', [
  // Taylor series body...
])
func('$__cos', [['param', '$x', 'f64']], 'f64', [
  // Taylor series body...
])

// Exports (for import resolution)
export { sin, cos, sqrt, PI }
```

## File Structure

```
src/
  index.js          # compile(code, opts) → IR tree
  parse.js          # subscript + syntax extensions
  analyze.js        # scope, types
  lower.js          # AST → IR
  optimize.js       # run passes on IR tree
  
  core.js           # jz:core implementation
                    # (syntax, type, lower, pass, func, import_)
  
  module/           # standard modules
    math.js
    array.js
    string.js
    object.js
    console.js
    json.js
    ...
```

Note: No `emit.js` needed - IR IS watr's format.

## Compilation Flow

```js
// src/index.js
import { compile as watrCompile } from 'watr'

export function compile(code, opts = {}) {
  const modules = resolveModules(opts.modules)
  
  // 1. Collect extensions from modules
  const ctx = createContext(modules)
  
  // 2. Parse (with syntax extensions)
  const ast = parse(code, ctx.syntax)
  
  // 3. Analyze (with type info from modules)
  analyze(ast, ctx)
  
  // 4. Lower AST → IR (with lowerers from modules)
  const ir = lower(ast, ctx)
  
  // 5. Optimize IR (with passes)
  const optimized = optimize(ir, ctx.passes)
  
  // 6. Assemble module (add imports, memory, funcs)
  const moduleIR = assemble(optimized, ctx)
  
  // 7. watr compiles IR tree directly to binary (no parsing!)
  return watrCompile(moduleIR)
}
```

## Core Implementation

```js
// src/core.js - implements jz:core
const syntaxExtensions = []
const typeDeclarations = new Map()
const lowerers = new Map()
const passes = []
const funcs = []          // stdlib functions as IR
const hostImports = []

export function syntax(pattern, opts, handler) {
  syntaxExtensions.push({ pattern, opts, handler })
}

export function type(name, sig) {
  typeDeclarations.set(name, parseSignature(sig))
}

export function lower(name, handler) {
  lowerers.set(name, handler)
}

export function pass(name, fn) {
  passes.push({ name, fn })
}

export function func(name, params, result, body) {
  funcs.push(['func', name, ...params, ['result', result], ...body])
}

export function import_(mod, name, sig) {
  const parsed = parseSignature(sig)
  hostImports.push(['import', `"${mod}"`, `"${name}"`, 
    ['func', `$__${mod}_${name}`, ...parsed.params.map(p => ['param', p])]])
}

// Collect all registrations
export function getExtensions() {
  return { syntaxExtensions, typeDeclarations, lowerers, passes, funcs, hostImports }
}
```

## Optimizer

```js
// src/optimize.js
export function optimize(ir, passes) {
  let result = ir
  for (const { name, fn } of passes) {
    result = transform(result, fn)
  }
  return result
}

// Deep transform IR tree (bottom-up)
function transform(ir, fn) {
  if (!Array.isArray(ir)) return ir
  
  // Transform children first
  const [op, ...args] = ir
  const transformed = [op, ...args.map(arg => transform(arg, fn))]
  
  // Then apply pass to this node
  return fn(transformed)
}
```

## Assemble

```js
// src/assemble.js
export function assemble(bodyIR, ctx) {
  const sections = []
  
  // Host imports
  sections.push(...ctx.hostImports)
  
  // Memory (if any module needs it)
  if (ctx.needsMemory) {
    sections.push(['memory', ['export', '"memory"'], 1])
  }
  
  // Stdlib functions from modules
  sections.push(...ctx.funcs)
  
  // User functions (already in IR form)
  sections.push(...bodyIR)
  
  return ['module', ...sections]
}
```

What subscript compiles, but to WASM:

```js
// Literals
42, 3.14, true, false, null, undefined

// Operators
+, -, *, /, %, **, ==, !=, <, >, <=, >=, &&, ||, !, ?:

// Variables
let x = 1, const y = 2

// Functions
let f = (a, b) => a + b

// Control flow
if/else, while, for

// Exports
export let f = x => x * 2
```

**Output**: Pure numeric WASM. No memory, no heap, no strings.

```wat
(module
  (func (export "f") (param $x f64) (result f64)
    (f64.mul (local.get $x) (f64.const 2))))
```

~500 lines: parse → analyze → compile → assemble

## Module Interface

Each module is a JS file that registers capabilities:

```js
// module/math.js
export default {
  name: 'math',
  
  // What this module exports (for import resolution)
  exports: {
    sin:  { type: 'fn', params: ['f64'], returns: 'f64' },
    cos:  { type: 'fn', params: ['f64'], returns: 'f64' },
    sqrt: { type: 'fn', params: ['f64'], returns: 'f64' },
    PI:   { type: 'const', value: 3.141592653589793 },
  },
  
  // How to compile each export
  compile: {
    sin:  (ctx, args) => `(call $__sin ${args[0]})`,
    cos:  (ctx, args) => `(call $__cos ${args[0]})`,
    sqrt: (ctx, args) => `(f64.sqrt ${args[0]})`,
    PI:   () => `(f64.const 3.141592653589793)`,
  },
  
  // WAT code to include
  wat: `
    (func $__sin (param $x f64) (result f64) ...)
    (func $__cos (param $x f64) (result f64) ...)
  `,
}
```

## Module Categories

### 1. Pure (compile to WASM instructions)

```js
// module/math.js - WASM ops + stdlib
sin, cos, tan, sqrt, abs, floor, ceil, round, pow, log, exp, PI, E

// module/bitwise.js - i32 ops
&, |, ^, ~, <<, >>, >>>
```

### 2. Memory (require heap)

```js
// module/array.js - enables [], length, methods
[], .length, .map, .filter, .reduce, .forEach, .find, .some, .every, .push, .pop

// module/string.js - enables "", length, methods  
"", .length, .slice, .indexOf, .includes, .split, .toLowerCase, .toUpperCase

// module/object.js - enables {}, property access
{}, .keys, .values, .entries, Object.assign

// module/typedarray.js - typed views
Float64Array, Uint8Array, ...
```

### 3. Host (require imports from environment)

```js
// module/console.js - host bindings
log, warn, error → (import "env" "log" ...)

// module/json.js - parse/stringify
parse, stringify
```

### 4. Syntax (extend parser)

```js
// module/pipe.js - adds |> operator
syntax('|>', 1, (left, right) => ({ type: 'Call', callee: right, args: [left] }))

// module/nullish.js - adds ?? and ?.
syntax('??', 3, ...)
syntax('?.', 18, ...)
```

## File Structure

```
src/
  index.js          # compile(code, { modules: [...] })
  parse.js          # subscript wrapper
  analyze.js        # scope analysis (~200 lines)
  compile.js        # core codegen (~300 lines)
  assemble.js       # WAT assembly (~100 lines)
  
  module/           # registerable capabilities
    math.js         # sin, cos, sqrt, PI
    bitwise.js      # &, |, ^, <<, >>
    array.js        # [], .map, .filter
    string.js       # "", .slice, .indexOf
    object.js       # {}, .keys, .values
    typedarray.js   # Float64Array, etc
    console.js      # log (host)
    json.js         # parse, stringify
    set.js          # Set
    map.js          # Map
    regex.js        # /pattern/
    
    # Syntax extensions
    pipe.js         # |>
    nullish.js      # ??, ?.
    
    # Memory management (shared by array/string/object)
    _memory.js      # heap, allocator, NaN-boxing
    _types.js       # type predicates, constants
```

## API

```js
import { compile } from 'jz'

// Minimal: pure numeric (no modules)
compile(`export let f = x => x * 2`)

// With modules
compile(`
  import { sin, PI } from 'math'
  export let f = t => sin(t * PI)
`, { modules: ['math'] })

// All standard modules
compile(code, { modules: ['math', 'array', 'string', 'object', 'console'] })

// Shorthand for all standard
compile(code, { modules: 'std' })

// Autoimport (JS-compat mode)
compile(code, { autoimport: true })  // Math.sin works without import
```

## Module Registration

```js
// src/index.js
import mathModule from './module/math.js'
import arrayModule from './module/array.js'
// ...

const BUILTIN_MODULES = {
  math: mathModule,
  array: arrayModule,
  string: stringModule,
  object: objectModule,
  console: consoleModule,
  json: jsonModule,
  // ...
}

const STD_MODULES = ['math', 'array', 'string', 'object']

export function compile(code, opts = {}) {
  let modules = opts.modules || []
  if (modules === 'std') modules = STD_MODULES
  
  // Resolve module objects
  const resolved = modules.map(m => 
    typeof m === 'string' ? BUILTIN_MODULES[m] : m
  )
  
  // Build compilation context
  const ctx = createContext(resolved)
  
  // Parse → analyze → compile → assemble
  const ast = parse(code, ctx.syntax)
  const scope = analyze(ast, ctx)
  const wat = compileAST(ast, ctx, scope)
  return assemble(wat, ctx)
}
```

## Context Building

```js
// src/context.js
export function createContext(modules) {
  const ctx = {
    // From modules
    exports: {},      // name → { module, type, ... }
    compilers: {},    // name → (ctx, args) => wat
    wat: [],          // collected WAT code
    imports: [],      // host imports
    syntax: [],       // parser extensions
    
    // Memory management (enabled by first memory module)
    memory: null,     // { heap, allocate, ... }
    
    // Analysis state
    scope: null,
    types: new Map(),
  }
  
  for (const mod of modules) {
    // Register exports
    for (const [name, info] of Object.entries(mod.exports || {})) {
      ctx.exports[name] = { module: mod.name, ...info }
    }
    
    // Register compilers
    Object.assign(ctx.compilers, mod.compile || {})
    
    // Collect WAT
    if (mod.wat) ctx.wat.push(mod.wat)
    
    // Collect imports
    if (mod.imports) ctx.imports.push(...mod.imports)
    
    // Register syntax extensions
    if (mod.syntax) ctx.syntax.push(...mod.syntax)
    
    // Enable memory if needed
    if (mod.memory && !ctx.memory) {
      ctx.memory = mod.memory
    }
  }
  
  return ctx
}
```

## Compilation Flow

```
1. Parse (subscript + syntax extensions)
   ↓
2. Resolve imports
   - `import { sin } from 'math'` → lookup in ctx.exports
   - Error if not found
   ↓
3. Analyze scope
   - Track variables, types
   - Infer types from usage
   ↓
4. Compile AST → WAT
   - Literals, operators → direct WASM
   - Imported symbols → ctx.compilers[name](ctx, args)
   - Memory ops → ctx.memory.* if enabled
   ↓
5. Assemble
   - Combine: memory + imports + wat + funcs + exports
```

## Memory Module (shared infrastructure)

```js
// module/_memory.js
export default {
  name: '_memory',
  
  // Memory layout
  heap: {
    start: 1024,      // first 1KB reserved
    current: 1024,    // bump pointer
  },
  
  // Allocator
  allocate(ctx, bytes) {
    const ptr = ctx.memory.heap.current
    ctx.memory.heap.current += bytes
    return ptr
  },
  
  // NaN-boxing utilities
  types: { ARRAY: 1, STRING: 3, OBJECT: 4, ... },
  
  // WAT helpers
  wat: `
    (memory (export "memory") 1)
    (global $__heap (mut i32) (i32.const 1024))
    (func $__alloc (param $size i32) (result i32) ...)
    (func $__ptr_type (param $ptr f64) (result i32) ...)
    (func $__ptr_offset (param $ptr f64) (result i32) ...)
  `,
}
```

## Example: Array Module

```js
// module/array.js
import memory from './_memory.js'

export default {
  name: 'array',
  
  // Depends on memory
  depends: ['_memory'],
  
  // Syntax: enables [...] literals
  syntax: [
    ['[', 'ArrayExpression', parseArrayLiteral],
  ],
  
  // Exports (for method calls)
  exports: {
    // Array.prototype methods (called on arrays)
    'Array.prototype.map':    { type: 'method', params: ['fn'], returns: 'array' },
    'Array.prototype.filter': { type: 'method', params: ['fn'], returns: 'array' },
    'Array.prototype.length': { type: 'getter', returns: 'i32' },
    // ...
  },
  
  // Compilers
  compile: {
    // Array literal
    ArrayExpression: (ctx, elements) => {
      // Allocate and populate
      return genArrayLiteral(ctx, elements)
    },
    
    // .length
    'Array.prototype.length': (ctx, arr) => {
      return `(call $__arr_len ${arr})`
    },
    
    // .map
    'Array.prototype.map': (ctx, arr, fn) => {
      return genArrayMap(ctx, arr, fn)
    },
  },
  
  // WAT for array operations
  wat: `
    (func $__arr_len (param $ptr f64) (result i32) ...)
    (func $__arr_get (param $ptr f64) (param $i i32) (result f64) ...)
    (func $__arr_set (param $ptr f64) (param $i i32) (param $v f64) ...)
  `,
}
```

## Migration Path

### Phase 1: Core extraction (~500 lines)

Extract from current compile.js:
- Numeric literals
- Binary/unary operators
- Variables (let/const)
- Arrow functions
- Control flow (if/while/for)
- Exports

### Phase 2: Module extraction

Move from compile.js to module/:
- math.js: MATH_OPS, stdlib
- array.js: array codegen
- string.js: string codegen
- object.js: object codegen
- typedarray.js: typed array codegen
- regex.js: regex codegen
- console.js: host bindings

### Phase 3: Memory unification

Create _memory.js with shared:
- Heap management
- NaN-boxing
- Type predicates
- Allocation

### Phase 4: Test coverage

Each module has own tests:
- test/module/math.js
- test/module/array.js
- ...

## Size Targets

| Component | Lines | Purpose |
|-----------|-------|---------|
| Core | ~500 | parse → compile → assemble |
| _memory.js | ~200 | heap, NaN-boxing, alloc |
| _types.js | ~100 | type predicates |
| math.js | ~100 | sin, cos, sqrt, PI |
| array.js | ~400 | [], methods |
| string.js | ~500 | "", methods |
| object.js | ~300 | {}, methods |
| typedarray.js | ~400 | typed arrays |
| console.js | ~50 | host log |
| json.js | ~200 | parse, stringify |
| regex.js | ~400 | /pattern/ |
| **Total** | ~3000 | Full featured |

## User-Defined Modules

```js
// my-dsp.js
export default {
  name: 'dsp',
  
  exports: {
    lerp: { type: 'fn', params: ['f64', 'f64', 'f64'], returns: 'f64' },
  },
  
  compile: {
    lerp: (ctx, [a, b, t]) => `
      (f64.add ${a}
        (f64.mul (f64.sub ${b} ${a}) ${t}))
    `,
  },
}

// Usage
import dspModule from './my-dsp.js'
compile(code, { modules: ['math', dspModule] })
```

## jz:core (for module authors)

When writing modules in jz itself:

```js
// mymodule.jz
import { inline, wat, type } from 'jz:core'

type('lerp', '(f64, f64, f64) -> f64')

inline('lerp', (a, b, t) => `
  (f64.add ${a} (f64.mul (f64.sub ${b} ${a}) ${t}))
`)

export { lerp }
```

Compiles to a module object equivalent to the JS version.

## Benefits

1. **Core is minimal** - easy to understand, audit, maintain
2. **Modules are independent** - can be tested/developed separately
3. **Pay for what you use** - no array code if you don't import array
4. **Extensible** - users can write modules
5. **Clear dependencies** - modules declare what they need
6. **Same pattern everywhere** - builtins and user modules work the same

## Non-Goals

- Runtime module loading
- Dynamic imports
- Circular dependencies
- Tree-shaking within modules (whole module included)
