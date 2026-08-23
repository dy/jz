# Stability — the v1 public surface

What v1 commits to, verified against this tree. Anything not listed here is
internal and may change without notice. Within a major version: stable items
change only additively; removals or meaning-changes require a major bump.

## The semantics contract

**Correct or reject.** Valid jz is valid JavaScript: an accepted program
computes the same answers JavaScript computes — including operand evaluation
order and effects — at every optimization level. Where the compiler cannot
guarantee that, it rejects loudly (compile-time error, or a typed runtime
`TypeError` naming the construct, the reason, and a remedy) rather than
returning a wrong value. Silent wrong values are release-blocking defects,
never accepted behavior. `JZ_BIGINT_STRICT=1` (reject-unprovable BigInt
flows) is an opt-in lint/deploy mode, never the default semantics.

## Package surface (`jz` on npm)

Entry points (package.json `exports`):

- `jz` — `jz(code, opts?)` default export → `{ exports, memory, instance,
  module }`; tagged-template form supported. Named: `compile(code, opts?)`
  → `Uint8Array` (or WAT `string` with `{wat: true}`; `{inspect: true}`
  wraps either as `{wasm|wat, inspect}` — the `inspect` payload shape is
  NOT stable), `compileModule`, `instantiate`, `transform`,
  `resolveWatrOpts`.
- `jz/interop` — the host bridge: `wrap`, `instantiate`, `memory` (its
  object exposes `String`, `Array`, `Object`, `Hash`, `Buffer`, `BigInt`,
  `External`, `read`, `wrapVal`, `write`, `alloc`, `allocTyped`), `coerce`,
  the NaN-box constants (`TRUE_NAN`, `FALSE_NAN`, `NULL_NAN`, `UNDEF_NAN`)
  and the `ptr`/`aux`/`type`/`offset` bit helpers.
- `jz/wasi`, `jz/transform` — as documented in README.
- TypeScript types via `index.d.ts`.

Marshalling policy at the host boundary: plain BigInt values cross only at
slots with compiler-emitted evidence (see ABI below); everywhere else they
reject with a typed `TypeError` — never a silent string or bit
reinterpretation.

## CLI (`jz`, bin → cli.js)

Stable commands and flags: `jz <file.js>`, `--strict`, `--jzify`, `-e`,
`--output/-o` (`.wat`, `.wasm`, `-`), `-O0..3`/`-Os`/`-Ofast`/`--optimize`,
`--define/-D K=V` (repeatable), `--host js|wasi|native`, `--memory <pages>`,
`--max-memory <pages>`, `--import-memory`, `--no-alloc`, `--no-simd`,
`--why-not-simd`, `--stencil`, `--outer-strip`, `--no-tail-call`,
`--no-eh-abort`, `--names`, `--stats`, `--help/-h`. New flags may be added;
listed flags keep their meaning.

## Custom-section ABI (embedder contract)

Emitted wasm modules carry two jz custom sections. Both are versioned ABI:
additive evolution only within a major version.

- **`jz:hostabi`** — JSON array, one entry per export needing host-BigInt
  policy: `{ name, tag: [paramIdx...], raw: [paramIdx...], rest?: 1 }`.
  `tag` = slots with proven may-BigInt evidence (host boxes a plain BigInt
  via `memory.BigInt`; wasm dispatches by tag). `raw` = slots proven
  always-BigInt crossing as bare i64 — real and dispatched but **always
  empty today** (reserved: exported params are host-callable with any
  value, so the plan can never close them; a future closed-world analysis
  fills it without an interop redesign). `rest` = tagged rest-element
  policy — omitted today (reserved). Absence from both lists means
  no evidence: a plain BigInt at that slot rejects.
- **`jz:i64exp`** — the i64 carrier map for the host wrapper: `p` = param
  indices carried as i64, `r` = results the host must reinterpret and
  `memory.read`.

## Error contract

Error **classes and codes** are stable; message **text** is not (messages
may keep improving — pin behavior, not prose). Registration-time integrity
is guarded: a module silently overwriting another's flat emitter
registration is a loud error at compile-tool startup, not a latent
miscompile.

## Explicitly not stable

`_setCompileTarget` and any `_`-prefixed export; the `inspect` payload;
compiled-module internal layout (NaN-box bit patterns, schema ids, function
names beyond exported ones — the name section is opt-in via `--names`);
`.work/` documents; kernel (`dist/jz.wasm`) byte identity between releases.

## Known limitations at v1

- **In-wasm self-compilation of jz itself** (jz.wasm compiling jz's own
  6.4 MB source inside wasm32) exceeds the 4 GiB address space and traps.
  The supported build path for jz's own kernel is the native (Node)
  toolchain, which is how `dist/` ships. Measured attribution and the
  scoped path to closing this (result-kind provenance) live in
  `.work/research.md`; user programs do not approach this wall.
- **Ambiguous `boolean∪number` locals** whose stored identity would escape
  reject at compile time (truthiness-only uses compile fine); full support
  needs a tagged Boolean carrier plan.
- **Rest-parameter BigInt elements** have no reachable evidence today and
  reject per the marshalling policy.
