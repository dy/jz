Parser is based on subscript/jessie.
If something is not supported by jessie, it needs to be fixed there, not worked around.
It should use API provided by subscript to define operators if needed.
Document any deviations from standard JS behavior in docs.md as appropriate.
Code changes should have comments updated, if code is not self-explanatory. JSDoc should be present for external functions. Any implemented features should have thorough tests in the test/ folder. For tests we use tst package.
Any JZ code must be valid JS code as well, except for a few quirks that must be documented.
Do not change tha signature or semantic of JS compat functions.
For any file structure changes, update project structure section below.

## Project Structure (src/ + module/, ~800 lines)

| File | Lines | Purpose |
|------|-------|---------|
| src/parse.js | 17 | subscript/jessie wrapper |
| src/analyze.js | 136 | scope analysis |
| src/emit.js | 200 | AST → IR (watr format) |
| src/optimize.js | 107 | IR passes (tree transforms) |
| src/assemble.js | 34 | combine sections into module |
| src/context.js | 18 | createContext() factory |
| src/compile.js | 61 | compile() entry point |
| module/_core.js | 128 | module extension API: type, emit, op, optimize, func, extern |
| module/math.js | 80 | sin, cos, tan, sqrt, pow, PI, E |
| index.js | 20 | package entry + register modules |

Data Flow: index.js: parse(code) → analyze(ast) → emit(ast) → optimize(ir) → assemble() → watr

Important project decisions are documented in .work/research.md in particular style:

```md
## [ ] question (with alternatives) -> decision
  0. core option
    + argument for 1
    + argument for 2
    ...
    - against 1
    - against 2
    ...
  1. alternative
    + pro
    - cons
  ...
## [ ] question (just decision) -> decision
  * Point 1
  * Point 2
  ...
```

Be frugal with descriptions, don't get too verbose or detailed - show key insights/points.

## Design Principles

- **No-overhead primitives**: Prefer compile-time solutions over runtime indirection. Static analysis enables direct calls, inline code, zero allocation.
- **Static typing, no runtime dispatch**: All types must be resolved at compile-time. No runtime type checks, no polymorphic dispatch. Functions are monomorphized per call-site types. This is a principal limitation for zero-overhead guarantee.
- **Meaningful limitations**: Accept constraints that enable performance. Document them clearly. Example: static namespace pattern requires compile-time known schema. Goal for compiler not to introduce runtime overhead just for marginal js compatibility.
- **Don't overcomplicate**: Simple working solution > complex generic solution. Add complexity only when concrete use case demands it.
- **Arrays as model**: f64 pointers work well - same pattern applies to objects when needed.

When implementing features, rely on watr ability to polyfill modern WASM features – you can use funcrefs, multiple values, tail calls. Also watr can optimize wat (tree-shake etc), so no need to prematurely optimize instructions in jz.
