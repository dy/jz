Parser is based on subscript/jessie.
If something is not supported by jessie, it needs to be fixed there, not worked around.
It should use API provided by subscript to define operators if needed.
Document any deviations from standard JS behavior in docs.md as appropriate.
Code changes should have comments updated, if code is not self-explanatory. JSDoc should be present for external functions. Any implemented features should have thorough tests in the test/ folder. For tests we use tst package.
Any JZ code must be valid JS code as well, except for a few quirks that must be documented.
For any file structure changes, update project structure section below.

## Project Structure (src/, ~10450 lines)

| File | Lines | Purpose |
|------|-------|---------|
| types.js | 215 | Type system, type predicates, memory constants, `wt` template |
| ops.js | 96 | WAT binary ops (f64.*, i32.*), MATH_OPS, GLOBAL_CONSTANTS |
| analyze.js | 1086 | Scope analysis: preanalyze(), extractParams(), analyzeScope() |
| context.js | 240 | Compilation state factory: createContext(), fork(), warn(), error() |
| assemble.js | 461 | WAT assembly: assemble() - combines sections into final WAT module |
| stdlib.js | 367 | Pure WASM math functions (sin, cos, pow, etc.) |
| normalize.js | 384 | AST preprocessing from parser |
| memory.js | 326 | Memory operations: mkString, arrGet, objGet, envGet/Set, genSubstringSearch, genPrefixMatch |
| loop.js | 51 | Loop codegen helpers: genLoop, genEarlyExitLoop |
| array.js | 529 | Array method codegen (map, filter, reduce, etc.) |
| string.js | 1386 | String method codegen (slice, indexOf, search, match, replace, split) |
| regex.js | 986 | Regex parser and WASM codegen (parseRegex, compileRegex) |
| typedarray.js | 891 | TypedArray method codegen (Float32Array, Int32Array, etc.) |
| closures.js | 126 | Closure codegen: genClosureCall, genClosureValue |
| destruct.js | 253 | Destructuring codegen: genArrayDestructDecl, genObjectDestructDecl |
| compile.js | 3051 | Core compiler: AST → WAT, operators, binOp helper |

Data Flow: index.js: parse(code) → normalize(ast) → compile(ast, {gc}) → assemble() → WAT


## Design Principles

- **No-overhead primitives**: Prefer compile-time solutions over runtime indirection. Static analysis enables direct calls, inline code, zero allocation.
- **Meaningful limitations**: Accept constraints that enable performance. Document them clearly. Example: static namespace pattern requires compile-time known schema.
- **Don't overcomplicate**: Simple working solution > complex generic solution. Add complexity only when concrete use case demands it.
- **Arrays as model**: f64 pointers work well - same pattern applies to objects when needed.

When implementing features, rely on watr ability to polyfill modern WASM features – you can use funcrefs, multiple values, tail calls. Also watr can optimize wat (tree-shake etc), so no need to prematurely optimize instructions in jz.
Don't add demo code that is not used.
