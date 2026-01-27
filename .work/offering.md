
# Offering Roadmap

## Goal
Metacircular jz: compiler that compiles itself to WASM.
But: minimal source, pluggable features, fits in head.

## Architecture: Plugin Model

```
┌─────────────────────────────────────────────────────┐
│  jz(code, { plugins: [arrays, strings, closures] }) │
└─────────────────────────────────────────────────────┘
                         │
    ┌────────────────────┼────────────────────┐
    ▼                    ▼                    ▼
┌────────┐         ┌──────────┐         ┌──────────┐
│  core  │         │ plugins  │         │  stdlib  │
│ ~1.5k  │         │  opt-in  │         │   WASM   │
└────────┘         └──────────┘         └──────────┘
```

### Core (~1500 lines)
What MUST be in core (can't be plugins):
- parse → normalize → compile → assemble pipeline
- context/scope management
- operators object (extension point)
- pointer encoding (NaN-boxing)
- basic codegen (literals, variables, calls)
- function definitions, exports

### Plugin Interface
```js
// plugin = { operators, analyze, stdlib }
const arrays = {
  operators: {
    '[]': (node, gen) => ...,      // array literal
    '.length': (node, gen) => ..., // property
  },
  analyze: (ast, ctx) => ...,      // pre-pass hooks
  stdlib: `(func $__arr_len ...)`, // WASM helpers
}
jz(code, { plugins: [arrays] })
```

### Plugin Candidates
| Plugin | Lines | For Metacircular? |
|--------|-------|-------------------|
| arrays | ~400 | ✓ AST is arrays |
| objects | ~300 | ✓ ctx is object |
| strings | ~500 | ✓ WAT output |
| closures | ~200 | ✓ scope capture |
| loops | ~100 | ✓ AST traversal |
| destructure | ~200 | nice-to-have |
| typedarray | ~800 | no (interop only) |
| regex | ~1000 | no |
| simd | ~400 | no |
| set-map | ~200 | maybe (interning) |
| exceptions | ~150 | no |

**Metacircular needs**: core + arrays + objects + strings + closures + loops
**Total**: ~1500 + 400 + 300 + 500 + 200 + 100 = ~3000 lines ✓

---

## Phase 0: Establish Plugin Architecture (3 days)

* [ ] **0.1** Define plugin interface
  ```js
  // Plugin shape
  interface Plugin {
    name: string
    operators?: Record<string, OperatorFn>
    preanalyze?: (ast, ctx) => void
    stdlib?: string | string[]
    init?: (ctx) => void
  }
  ```

* [ ] **0.2** Refactor compile.js operators to be injectable
  - Current: `const operators = { '+': ..., '-': ... }` hardcoded
  - Target: `const operators = { ...coreOps, ...plugins.flatMap(p => p.operators) }`

* [ ] **0.3** Refactor analyze.js hooks
  - Current: `preanalyze()` does everything
  - Target: `plugins.forEach(p => p.preanalyze?.(ast, ctx))`

* [ ] **0.4** Refactor assemble.js stdlib injection
  - Current: `stdlib.js` imports hardcoded
  - Target: `plugins.flatMap(p => p.stdlib).join('\n')`

* [ ] **0.5** Test: compile with zero plugins (numbers only)
  ```js
  jz`export let f = x => x + 1`  // works with core only
  ```

---

## Phase 1: Extract Plugins (5 days)

* [ ] **1.1** Extract `jz-plugin-arrays`
  - array literals, indexing, .length
  - methods: map, filter, reduce, find, indexOf, includes, slice
  - stdlib: $__arr_len, $__arr_get, $__arr_set, $__arr_new

* [ ] **1.2** Extract `jz-plugin-objects`
  - object literals, property access
  - schema inference, tagged pointers
  - stdlib: $__obj_get, $__obj_set

* [ ] **1.3** Extract `jz-plugin-strings`
  - string literals, template literals
  - .length, charCodeAt, slice, indexOf
  - SSO encoding
  - stdlib: string helpers

* [ ] **1.4** Extract `jz-plugin-closures`
  - closure capture analysis
  - env allocation, funcref
  - stdlib: $__closure_call

* [ ] **1.5** Extract `jz-plugin-loops`
  - for, while, do-while
  - break, continue
  - (tiny, maybe keep in core)

* [ ] **1.6** Verify core is ~1500 lines
  ```bash
  wc -l src/core/*.js  # target: <1500
  ```

---

## Phase 2: Metacircular Bootstrap (5 days)

* [ ] **2.1** Identify minimal jz subset for compiler
  - AST = arrays of arrays/objects
  - WAT output = string concatenation
  - Scope = object with properties
  - Required: arrays, objects, strings, closures, conditionals

* [ ] **2.2** Rewrite core in jz subset
  ```js
  // jz-in-jz: compile.jz
  let operators = { /* ... */ }
  let generate = node => {
    let [op, ...args] = node
    return operators[op](node, generate)
  }
  export let compile = ast => generate(ast)
  ```

* [ ] **2.3** Bootstrap test
  ```js
  // Stage 1: JS compiles jz-in-jz to WASM
  let stage1 = await jz(jzSource)

  // Stage 2: WASM compiler compiles itself
  let stage2 = stage1.compile(jzSource)

  // Verify: stage1 output === stage2 output
  assert(stage1.wat === stage2.wat)
  ```

* [ ] **2.4** Document minimal metacircular subset
  - This becomes the "blessed" jz dialect
  - What you need to write a compiler

---

## Phase 3: Ship Core (2 days)

* [ ] **3.1** Package structure
  ```
  jz/                    # core only, <1500 lines
  jz-plugin-arrays/      # ~400 lines
  jz-plugin-objects/     # ~300 lines
  jz-plugin-strings/     # ~500 lines
  jz-plugin-closures/    # ~200 lines
  jz-preset-standard/    # bundles common plugins
  jz-preset-meta/        # minimal for metacircular
  ```

* [ ] **3.2** npm publish
  ```bash
  npm publish jz@0.1.0
  npm publish jz-preset-standard@0.1.0
  ```

* [ ] **3.3** README: one screen
  ```markdown
  # jz
  JS syntax → WASM. Pluggable, metacircular.

  ## Minimal
  jz`export let f = x => x + 1`

  ## With plugins
  import arrays from 'jz-plugin-arrays'
  jz(code, { plugins: [arrays] })

  ## Presets
  import standard from 'jz-preset-standard'
  jz(code, standard)  // arrays, objects, strings, closures
  ```

---

## Phase 4: Demo (2 days)

* [ ] **4.1** Metacircular playground
  - Left: jz source code
  - Middle: WAT output
  - Right: run result
  - "Compile with WASM compiler" button

* [ ] **4.2** Floatbeat playground (uses jz-preset-standard)
  - Audio visualization
  - Formula editor
  - Share links

---

## Phase 5: One User (ongoing)

* [ ] Find someone who wants:
  - Metacircular compiler for education
  - Audio DSP without GC
  - Tiny WASM output for embedded
* [ ] Solve their problem publicly
* [ ] Document the win

---

## Success Criteria

- [ ] `wc -l src/core/*.js` < 1500
- [ ] `jz(code)` works with zero plugins (numbers/functions only)
- [ ] `jz(code, standard)` covers 90% of use cases
- [ ] Metacircular: compiler compiles itself
- [ ] One non-author user
- [ ] Fits in head: can explain full architecture in 10 minutes

---

## Key Insight

Metacircularity doesn't require ALL of JS.
It requires: **arrays + objects + strings + closures + conditionals**.

That's ~1500 lines of plugins on ~1500 lines of core = 3000 total.
Everything else (regex, SIMD, typed arrays, Set/Map) is *application-specific*, not *compiler-specific*.

The offering is not "JS subset compiler".
The offering is "minimal metacircular compiler you can understand and extend".
