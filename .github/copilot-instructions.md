The goal of the project is to be JavaScript as it should be: clean, functional, modern, compiling to WebAssembly with zero runtime overhead.

Parser is based on subscript/jessie.
Data Flow: index.js: parse(code) → prepare(ast) → emit(ast) → watr
Prepare does AST normalization, validation and analysis.
Each compilation can import modules from module/ folder, extending jz capabilities.

Document any deviations from standard JS behavior in docs.md as appropriate.

**JSDoc Requirements** (types are generated from JSDoc):
- All exported functions MUST have JSDoc with @param and @returns
- Use @typedef for complex types (define once, reference via import())
- Keep descriptions short, user-focused and clear
- Include @example for public API functions

Code changes should have comments updated, if code is not self-explanatory. Any implemented features should have thorough tests in the test/ folder. For tests we use tst package.
Any JZ code must be valid JS code as well, except for a few quirks.
Do not change the signature or semantic of JS compatible functions.
For any file structure changes, update project structure section below.

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
- **Static typing, no runtime dispatch**: All types must be resolved at compile-time. No runtime type checks, no polymorphic dispatch. Functions are monomorphized per call-sites. This is a principal limitation for zero-overhead guarantee.
- **Meaningful limitations**: Accept constraints that enable performance. Document them clearly. Example: static namespace pattern requires compile-time known schema. Goal for compiler not to introduce runtime overhead just for marginal js compatibility.
- **Don't overcomplicate**: Simple working solution > complex generic solution. Add complexity only when concrete use case demands it.
- **Arrays as model**: f64 pointers work well - same pattern applies to objects when needed.

Reuse existing patterns and structure as much as possible, instead of introducing new abstractions or layers.
