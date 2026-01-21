Parser is based on subscript/jessie.
If something is not supported by jessie, please let me know - we need to add it there first.
It should use API provided by subscript to define operators if needed.
Document any deviations from standard JS behavior in research.md as appropriate.
Code changes should have comments updated, if code is not self-explanatory. JSDoc should be present for external functions.
Any JZ code must be valid JS code as well. Try to fix JS quirks but don't introduce new ones.

## Project Structure (src/, ~4100 lines)

| File | Lines | Purpose |
|------|-------|---------|
| types.js | 120 | Type system, type predicates |
| ops.js | 96 | WAT binary ops (f64.*, i32.*), MATH_OPS, GLOBAL_CONSTANTS |
| analyze.js | 165 | Scope analysis: extractParams(), analyzeScope(), findHoistedVars() |
| context.js | 181 | Compilation state factory: createContext() - locals, globals, scopes |
| assemble.js | 231 | WAT assembly: assemble() - combines sections into final WAT module |
| stdlib.js | 400 | Pure WASM math functions (sin, cos, pow, etc.) |
| normalize.js | 326 | AST preprocessing from parser |
| array.js | 488 | Array method codegen (map, filter, reduce, etc.) |
| string.js | 296 | String method codegen (slice, indexOf, etc.) |
| compile.js | 1616 | Core compiler: AST → WAT, operators, closures |

## Data Flow

```
index.js: parse(code) → normalize(ast) → compile(ast, {gc}) → assemble() → WAT
```

## Key Patterns

- **Method modules**: array.js/string.js import `{ctx, opts, gen}` from compile.js

## Design Principles

- **No-overhead primitives**: Prefer compile-time solutions over runtime indirection. Static analysis enables direct calls, inline code, zero allocation.
- **Meaningful limitations**: Accept constraints that enable performance. Document them clearly. Example: static namespace pattern requires compile-time known schema.
- **Don't overcomplicate**: Simple working solution > complex generic solution. Add complexity only when concrete use case demands it.
- **Arrays as model**: f64 pointers work well - same pattern applies to objects when needed.
