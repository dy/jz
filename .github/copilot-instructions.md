Parser is based on subscript/jessie.
If something is not supported by jessie, it needs to be fixed there, not worked around.
It should use API provided by subscript to define operators if needed.
Document any deviations from standard JS behavior in docs.md as appropriate.
Code changes should have comments updated, if code is not self-explanatory. JSDoc should be present for external functions. Any implemented features should have thorough tests in the test/ folder. For tests we use tst package.
Any JZ code must be valid JS code as well, except for a few quirks that must be documented.
For any file structure changes, update project structure section below.

## Project Structure (src/, ~4600 lines)

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
| string.js | 1350 | String method codegen (slice, indexOf, search, match, replace, split) |
| regex.js | 450 | Regex parser and WASM codegen (parseRegex, compileRegex) |
| compile.js | 1700 | Core compiler: AST → WAT, operators, closures, regex methods |

Data Flow: index.js: parse(code) → normalize(ast) → compile(ast, {gc}) → assemble() → WAT


## Design Principles

- **No-overhead primitives**: Prefer compile-time solutions over runtime indirection. Static analysis enables direct calls, inline code, zero allocation.
- **Meaningful limitations**: Accept constraints that enable performance. Document them clearly. Example: static namespace pattern requires compile-time known schema.
- **Don't overcomplicate**: Simple working solution > complex generic solution. Add complexity only when concrete use case demands it.
- **Arrays as model**: f64 pointers work well - same pattern applies to objects when needed.

When implementing features, rely on watr ability to polyfill modern WASM features – you can use funcrefs, multiple values, tail calls. Also watr can optimize wat (tree-shake etc), so no need to prematurely optimize instructions in jz.
