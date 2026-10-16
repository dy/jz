# Changelog

## Unreleased — v1 preparation

- Vectorize a conditional of several assignments per arm, nested or behind a loop-invariant flag, each assignment kept where the arm's mask is off; store an integer element from float lanes with one vector truncation where every lane lies inside a word, the exact conversion lane by lane otherwise; a local one path of a conditional leaves unwritten is carried, not lane data (it miscompiled under SIMD).
- Add `jz/strict`, with a separate browser bundle and TypeScript definitions.
- Type a parameter's earlier reads apart from its reassignment in a sequence body, and `Object.create(null)` as an empty literal; subscript's parser dispatch reads its operator table by slot.
- Follow a conditional's and a loop's exit in the summary: a defaulted bag property (`if (ptr == null) ptr = 0`, `if (typeof mem === 'number') mem = new Array(mem)`) keeps its number or array through the per-sample loop, a field that held a number before the array keeps the array's cell, and the loop over such a history runs under an `Array.isArray` guard as a typed loop. Read a proven array's element without the tag test. Add the library-idiom bench cases `sosfilter`, `movavg`, `upfirdn`, `pcmconvert` with native C references.
- Version the statements after a declaration under integer guards for the numbers their loops index by or divide by (a bag's write index, a ratio a division made): the copy's cursor is an int32 the summary keeps below the array it indexes, so a ring buffer reads and stores its element without a key test or growth and steps with a hardware remainder; a counter an array's length bounds is an index; an integral dividend of bounded magnitude takes an i64 remainder by a divisor word or an integral divisor of no word (`i % seg` under `seg = Math.floor(len / ch)`), behind a zero test where the divisor may be zero, the magnitudes read off the words, counters, lengths and roundings they are made of; a quotient under a test of its remainder is an integer, and the integral-loop plan holds its names to words; the plan reads a bound declared in the loop head and copies a loop whose inner loops leave its names alone. An array a loop stores into only at proven indices is saved for the reset once before the loop, its hop read from the binding so the loop's hoist lifts it; `new Array(n).fill(v)` has no hole, a store the guard bounds opens none, a construction of a literal count has that length, `target = new Array(n)` followed by the loop `for (i < n) target[i] = v` is filled, a counter under `i < n` stays inside a cell constructed with `n` (reads present, stores open nothing), and a hole-free cell reads without the tomb test; a counter bounded by an array's own length reads present elements where the loop leaves the length alone, the binding reassigned elsewhere or not. The library-idiom cases are pinned under V8 in the bench gate (`sosfilter`, `upfirdn`, `pcmconvert` wins, `movavg` a tie).
- Add source maps for unoptimized builds through the JavaScript API and CLI.
- Run Floatbeat audio in an AudioWorklet, with saved formulas and compressed sharing.
- Preserve retained values across calls while reclaiming temporary allocations where safe.
- Restore object fields that point into discarded memory during reset, preserving numeric and BigInt state.
- Correct array resizing and aliasing, typed-array numeric indices, BigInt record returns,
  postfix updates, and method receivers in grouped optional chains.
- Correct builtin feature detection, own method/getter dispatch, computed deletion,
  and argument evaluation for inherited methods.
- Preserve writable parameters, locals and closure captures during cleanup and expression inlining.
- Preserve argument evaluation order through defaults, coercions, branches and loops.
- Preserve callbacks and mode arguments read or written by parameter defaults and nested closures.
- Keep unsigned helper results, SIMD arguments and mutable captured values correctly typed.
- Preserve missing elements when converting checked array reads to strings.
- Keep nullable-string conversion compact and retain live static strings through final data cleanup.
- Preserve unsigned clamping, object coercion and assignment values in typed-array stores.
- Recognize held builtin functions consistently while respecting local constructor names.
- Preserve constant primitive-constructor aliases and fold proven primitive wrapper probes.
- Respect imported builtin-name shadows and keep mixed-domain call errors at runtime.
- Keep loop kernels outlined when partial inlining would allocate in the caller loop.
- Hoist lowered scratch temporaries together with invariant unrolled calculations.
- Reduce snapshot allocation for Map entries whose identity is unobservable.
- Preserve signed zeros and infinite quadrants when folding `Math.atan2`.
- Inline scalar allocation helpers while preserving pointer-factory boundaries and retained state.
- Preserve namespace key evaluation, lexical shadowing and live exports, including quoted export names.
- Preserve class and iterator return values through null-receiver checks.
- Preserve class-method and expression-continuation boundaries, and reject malformed object property names.
- Preserve injected constants' negative zero, quoted keys and trailing array elements; reject cyclic or nonliteral definitions.
- Copy accessor values through dynamic spreads; reject accessor definitions that need a runtime property layout.
- Keep optional-method receiver handling consistent in the Wasm-hosted compiler.
- Avoid quadratic store-forwarding traversal in expressions without memory candidates.
- Reduce compiler analysis memory by sharing module facts, definition scans, and direct call edges.
- Build summary fingerprints with linear storage, reuse closure unions and the export census, and avoid unused analysis allocations.
- Preserve the defining load and assignment order when recognizing shared SIMD reduction inputs.
- Copy long template fragments from the string pool instead of emitting thousands of literal stores.
- Handle Unicode identifiers, whitespace and line terminators without changing literal contents.
- Preserve element shapes through custom iterator protocols and report valid layout names in diagnostics.
- Expand regression coverage for library workloads and the Wasm-hosted compiler.
- Keep a per-pixel loop body that leaves its loop out of the vectorizer's copies.
- Meet a binding's two integer-hull proofs instead of asserting their order.
- Throw each constant runtime error from one shared helper.
- Keep the catch around a spread of a value that may not iterate.
- Compact what the module keeps as an outermost call returns, so state replaced call after call stays bounded.
- Compact what a loop keeps in place within a call, so a value replaced iteration after iteration stays bounded.
- Trigger a compaction by what the last one walked, so a module holding a large structure compacts churn beside it once per twice its size, not once per page.
- Root a loop's compaction in the locals live at it, so a function of hundreds of locals stays its size.
- Compact as the heap nears `memory.maximum` or the address space, once per eighth of the live data, instead of failing to grow.
- Compact the loops of closures, and keep a caller's alias of a container its callee's loop grew.
- Keep the undefined arm of an optional chain through its continuation, so `o?.a.b ?? x` answers `x`.

Release validation is still in progress. This is not a released v1, and the
standing performance claims still require fresh reference measurements.
