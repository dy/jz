# Changelog

## Unreleased — v1 preparation

- Rewrite only the holes of a value copy (`[';', a, ...items]`, `Array.from`, a spread into a call): the pass after the block copy tests each slot and stores `undefined` where it finds a hole, no call per element and no store for a present one. subscript's ASI layer spreads the statements it has read into each new list, 166k elements per jessie parse, each of which went through `__arr_value`.
- Add a sum whose operands the summary holds to numbers, booleans and missing values as numbers, each mixed side converted in line (true 1, false and null 0, undefined NaN): no ToPrimitive and no concatenation can come of it. subscript's `idx += l` (`l` a predicate's `true` or an escape's length) made 19k `__add_slow` calls per jessie parse, each with an object and a string test.
- Pop a known array by storing the new length through the header its forwarding hop already resolved, not through `__set_len`, which read the tag and chased the forward again: one call less per `pop()` of a work stack.
- Read an array pattern over a value the summary admits an array among other kinds (`let [kind, ...node] = n` over a tree of strings and arrays, a parameter of every kind) by position behind `Array.isArray`, the protocol kept for every other value: the cursor opens only where the test fails, a rest is a copy. A kernel destructuring such values runs 1.35× Node where it ran 3.07× (interleaved); watr's run opens 8.8k cursors and collects 0.8k rests instead of 17.9k and 5.8k.
- Compare a string's unit with a one-character literal (`s[i] === '$'`) by one inline unit read: the read answers 0 past either end, which no literal but NUL equals, so the length call and the char call go (one call at the size tier). A kernel of such tests runs 1.3× Node where it ran 5.2× (interleaved, loaded machine); watr's run makes 20k `__char_at` and 118k `__str_length` calls instead of 203k and 301k.
- Enumerate a receiver no layout or dictionary names (`Object.keys`/`values`/`entries` of an array or an unknown value) through one stdlib function per kind instead of the whole property walk at each site: a fifteen-line program calling such a helper fourteen times compiles in 1.7 s to 30 KB at level 2, where it took 8 s and 76 KB (and exhausted the hosted compiler's memory).
- Keep an element of one typed array past a store to another where every call passes each its own fresh array, sized by any primitive (`new Float64Array(N)` with `const N = 64`): the fft butterfly reads `im[a]` once.
- Lift an inner loop's typed-bounds guard over a counter that strides by a loop invariant (`for (i = 0; i < n; i += len)`), bounded by the last value its stride reaches, the inner loop's own counters words there too; drop the conjuncts of a version guard its operands' ranges decide. fftplan 0.76×, provenance 0.77×, fft 0.93× of their previous time (interleaved runs, checksums unchanged).
- Cross an exported parameter a closure reassigns as the number the summary reads it as: the host converts it (`f(true)` with `k = k + 1` in a closure returned `true` at levels 0 and 1).
- Load a string parameter's length at entry only where some `charCodeAt` tests it: a scan whose reads are all in bounds decodes the receiver without it (tokenizer 1577 → 1518 B at `'size'`).
- Keep the size tier's typed arrays on the heap: a static block's header segment and wide address constants outweighed the allocator call it saved on every bench case it touched (lz 1946 → 1870 B, glyfparse 2424 → 2355 B).
- Take watr 5.11.10, which keeps an exported global mutable (the host may write it), folds float constant comparisons and drops a low-word mask under a wrap; jz's own copies of those go.
- Give back each iteration's memory in a loop whose escapes the frame flags (a parser's driver loop, `for (…) { const ast = parse(src); cs = hash(ast) }`): at the next iteration's start the heap returns to the iteration's mark where the escape flag says nothing older took what it made, and otherwise to the end of what the walk from the escape log reaches, with receivers below the mark logged while the loop runs; a loop storing what an iteration made into a binding declared outside it, or into what such a binding holds, keeps it as before, and such a loop is no longer unrolled. A write of a number or a boolean to a function's property the compiler keeps in a global (`parse.semi = false`) is no escape. A function with a compacting loop no longer caches across it a global the compaction writes (its epochs, the escape log's count). The jessie case runs in 8.5 MB of Wasm memory instead of 34 MB.
- Keep a typed array a function makes at a literal length and keeps to itself in static memory (`const table = new Int32Array(256)` in `main`): one block, zeroed where the declaration runs, its address a constant every access folds, read at that constant in the helpers every call hands it to; only where the array goes nowhere but element reads and writes, its length and such parameters, and nothing between its declaration and its last use can enter the function again (a host import, a closure value, a callback, a suspension). A helper every call hands such an array takes its address at entry, so the engine reads a constant and the passes that reason about parameters (distinctness, vectorization, loop-invariant motion) still see the parameter. crc32 runs 0.90× its time.
- Index in words by a remainder and a truncated quotient of a runtime divisor (`a[(i % seg) * 2 + ~~(i / seg)]`, a deinterleave): ToInt32 of a quotient of two words is the hardware division, a zero divisor 0 and -1 the negation; a floor, ceiling or truncation of a word by a positive literal is a word where no -0 can come out (`Math.floor(len / 2)` a shift); the integral-loop copy holds such a divisor above zero; a counter declared ahead of its loop and one bounded by a length the walk typed get their hulls, and an element typed array's length is a word.
- Reclaim a call's allocations where it stores into a receiver it computes (`map.get(k).push(v)`, `xs[xs.length - 1].n = v`): the store keeps the receiver it evaluated and names that storage to the escape flag, which went to zero before, so the frame keeps its memory only where that storage is older; a binding given only fresh values and literals (`let idx = null … (idx ??= []).push(n)`) is the call's own.
- Vectorize a conditional of several assignments per arm, nested or behind a loop-invariant flag, each assignment kept where the arm's mask is off; store an integer element from float lanes with one vector truncation where every lane lies inside a word, the exact conversion lane by lane otherwise; a local one path of a conditional leaves unwritten is carried, not lane data (it miscompiled under SIMD).
- Keep a binding a closure assigns out of the summary's straight-line facts and proofs from the closure's creation on (a hoisted function declaration is made before the `let` it writes: `let called; function foo() { called = true } foo(); assert(called)` read `called` as absent), and keep a counter's element read checked where the loop's body runs code of the program's that may change the array's length: a call or a construction (a closure may rebind the array, a method may shrink it; `Math.*` of pure operands runs none), a read of a member a getter of its name may serve, or, where the program defines a `valueOf`/`toString`, an operator converting an operand that may be an object (that census is taken ahead of the first summary solve, which may be the last where the plan rewrites nothing).
- Keep `x % k` exact for a literal `k`: the inline `x - trunc(x / k) * k` only where `k` is an integer and |x| < 2^53 (or the dividend's magnitude is known below it), the exact remainder past it and for a fractional `k` (`1e23 % 7`, `9007199254740994 % 3.7` were wrong at every level). A quotient's magnitude is its dividend's only where the divisor is at least one in magnitude; an integer typed element is bounded by its type. The i64 remainder takes a word dividend by an integral divisor of no word, and an integral divisor of any magnitude.
- Throw a `TypeError` for `new Promise()` without an executor.
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
