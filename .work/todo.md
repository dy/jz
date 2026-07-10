# jz — TODO

## V1

* [ ] Beat all bench cases, all examples - pinned
  * [x] 10 more bench cases - each area covered
  * STATE 2026-07-09 (JSC leg measured): quiet-machine full table, 49 cases ran.
    GEOMEAN: jz beats every engine — V8 1.89x, deno 1.83x, JSC 1.50x, bun 1.52x
    slower than jz. Headline-corpus violations (engine beats jz): dispatch 0.29
    (JSC only — its call-IC crushes our call_indirect fan-out; V8 1.07 beaten),
    immutable 0.51 (V8/bun; JSC 1.08 ok), wordcount 0.63 (all), strbuild 0.74
    (all), crc32/dict/colorconv 0.76 (JSC-only; V8 beaten), shapes 0.89
    (V8-only; JSC 2.6x beaten), json 0.96 (JSC, borderline). Lab probes (out of
    geomean): jessie 0.42-0.60 standing worst (residual: .loc sidecar churn,
    closure8 descriptor walk); colorpq 0.84 vs V8. jz self-host lab case was
    DNF (env.globalThis import — dead-guard-arm reads; fixed via prep dead-arm
    fold + watr cntOracle guard) — now RUNS and BEATS every engine ~2x on the
    full-pipeline compile workload (jz.wasm 21.98ms vs jsc 39.9 / bun 44.0 /
    v8 46.7). Fastest-wasm race (tokenizer/qoi/crc32 vs c/as, CI-jitter band)
    + Sierpinski floatbeat unchanged. Evidence: /tmp/bench-table.txt.
  * dispatch lever 1 (2026-07-09): devirt arms now INLINE tiny pure bodies
    (inlinePureCallExpr grew callee-local renaming — a caller/callee name
    collision self-assigned tees, pinned in test/closures.js) + static const
    arrays fold base/len to literals under new never-resized/never-aliased
    program facts (arrResized/nameEscapes; base derives from global.get — the
    static-prefix-strip rebases AFTER the fold, a baked offset trapped OOB,
    pinned in minimal-output + closures). Interleaved A/B: +4.5% only —
    residual is the br_table mispredict + the f64↔i32 serial chain through
    loop-carried x (arms are int-pure; guards+converts survive because closure
    ABI args are untyped). Next levers, in order: (a) peepholes
    `trunc_sat(convert_i32(X))→extend(X)` and `f64.ne(convert_i32(X), NaN/inf
    -const)→1` — kills the k-arm chain outright; (b) loop-carried f64→i32
    local narrowing when all defs are convert(i32) and all uses trunc — kills
    the x-arm chain; (c) branchless select-tree lowering when ALL arms inline
    int-pure and tiny — what JSC does (2.29ms ≈ beats native C's fn-ptr
    dispatch 4.94; jz 7.91, V8 8.54 — we beat V8, JSC needs (a)+(b)+(c)).
  * dispatch lever 2 (2026-07-09): (a) LANDED as watr identities (28942bd):
    trunc∘convert exact round-trips + f64 eq/ne of convert_i32 vs impossible
    const; jz devirt spills i32 args as i32 and re-materializes the convert at
    each use (syntactic → identities fire); inliner false-positive leak fixed
    (caller arg named like a callee local — injected-identity set). Interleaved
    A/B +12.8% over levers-off. TRIED-AND-REVERTED: dispatch-site arg lattice
    merged into element bodies' paramTypes/minArgc (kills their guards) — prep
    pre-evals `ops[1]` to the closure ref before program facts see the read, so
    no AST gate proves the tagged sites are the only callers; the trusted body
    truncated raw box bits on a string through the alias. Any revival needs a
    PREP-time escape record at the fold site, not AST counters. Discovered
    pre-existing gap (control-verified): string arg through an element-value
    alias skips ToNumber (pick("3",1) → 1 not 2) — untyped generic-call
    coercion family, noted in test/closures.js. Remaining (b) loop-carried
    f64→i32 local narrowing (watr-side generic: all defs convert(i32) → retype,
    wrap stray gets; would let x's ToInt32 guard + trunc die) and (c) branchless
    select-tree — both still needed for JSC's 2.29ms.
  * dispatch lever 3 (2026-07-09): (b) LANDED — dispatch arms are now RAW INT
    OPS (`get x; get k; i32.xor; br`), the entire ToInt32 guard/convert layer
    dead. Chain: watr `narrowLocals` (f64 local written only by exact converts
    retypes i32; PROFIT-GATED — unconditional narrowing tripped the buf/nest
    op-count ratchets +24/+11, reads now classify by consumer with tees value-
    transparent) + watr `intguard` (counted ToInt32-guard-select collapse) +
    watr identity block-hoist (trailing convert out of LABEL-LESS blocks — emit
    wrapper blocks hid convert defs from narrow) + jz devirt i32 BLOCK-NARROW
    (facts-gated static table + every candidate body convert-topped → arms br
    raw i32, call arms trunc_sat-wrapped, one convert re-boxes; x's def then
    syntactic-convert). PASS ORDER LOAD-BEARING: narrow after identity, before
    intguard/merge — merge unifies identical-valued guard temps in-round, then
    the one-reader gate never passes (watr PASSES comment). A/B vs levers-off:
    1.12x — UNCHANGED from guards-alive: the br_table MISPREDICT shadows all
    arm micro-ops on unpredictable streams. ⇒ (c) branchless select-tree is
    THE remaining dispatch lever: all arms now tiny+pure+int (the exact
    precondition), compute all 8 + 3-level select tree ≈ 9-12 cycles vs
    mispredict ~15-20; needs trap-free arm gate + in-range fast path; closure0
    (impure `+` body) must inline for 8/8 — its str-concat guard survives
    foldStrDispatchF64, investigate there first.
  * dispatch lever 4 (2026-07-09): (c) BUILT AND LANDED, verdict humbling.
    watr `seltree` (dense 4-8-arm br_table ladder of speculable arms → select
    tree behind ONE in-range branch; arm gates: pure never-trapping whitelist,
    arm-local tee/set writes only, ≤96 tokens; the index keeps its exact
    unconditional evaluation). Enablers: devirt inlines from the UNFILTERED
    candidate map (arm position preserves execution conditions — closure0's
    impure `+` body inlines; ONE fn-wide inline-temp counter — a per-site
    counter minted duplicate locals when a const-folded receiver spilled
    nothing, pinned in closures); guardRefine `foldStrProbes` folds the whole
    `if (is_str(a)||is_str(b)) concat else add` dispatch to the numeric arm
    under provably-int args (matched whole-if PRE-order — per-probe folding
    leaves or/if shapes nothing const-folds through; operand tees kept as
    drops). PASS ORDER extended: narrow → guardRefine → intguard so the
    dispatch resolves fully in ROUND 1 (coalesce at round end shares temp
    slots across arms; counted locality gates die on round-2 shapes).
    RESULT: br_table fully eliminated on dispatch, checksum exact, all suites
    green — but interleaved A/B = 0.993 (NEUTRAL): the fixed 16K-entry stream
    repeats, and the CPU's indirect-branch predictor LEARNS it — the
    mispredict the tree buys back wasn't being paid. seltree ships DEFAULT-OFF
    (a predictable stream makes br_table ~free while the tree pays every arm),
    speed-profile opt-in; QUIET-MACHINE verdict + a genuinely-unpredictable
    stream variant still owed before declaring it dead or alive. JSC's 2.29ms
    edge therefore is NOT (only) branchlessness — next probe: total op-count
    per iteration + JSC's actual codegen. watr commits pending publish:
    59b0ef5, 28942bd, cbf2d72, cc22b89, ea09930.
  * provenance leg 1 (2026-07-09): the NEW audio cases (fftplan 10.9x behind
    JSC / 6.8x V8 — worst in corpus; provenance 8.9x) name the structural gap:
    typed-array KIND LOSS through non-local provenance (inference was
    RHS-syntactic only). LANDED (test/provenance-inference.js, 8 pins): (1)
    ctx.schema.slotTypedCtors — the elem-ctor sibling of slotTypes, censused in
    observeProgramSlots; (2) slotTypedCtorAt/BySid readers, gated on the prop
    NEVER being written program-wide (writtenProps, fail-closed); (3) field
    evidence in the module-let ctor fixpoint + a LATE re-run (after
    narrowSignatures — return sids + censuses only exist then) + body-cache
    invalidation; (4) refineFieldProvenance binds module-const sids from
    ABI-backed return schemas; (5) narrow's typedCtor arg lattice gets
    per-caller sid maps (module-const seeds, locals shadow, assignments
    poison) so `sum(P.wre, n)` types the callee param. Edges now TYPED:
    ret, field (bound + inline), paramViaField. TRIED-AND-REVERTED: value-
    level "kind or nullish" return facts (fnReturnTypedElem/Sid) + @map:
    Map-value nodes + {}-literal sid evidence — an unguarded typed unbox on a
    nullish/dyn-undefined value reads GARBAGE MEMORY (composite-route OOB at
    O0, control returns undefined; regression in degree). Revival needs a
    GUARDED unbox (tag-checked pointer materialization, hoistable out of hot
    loops) or non-null flow proofs — THE design item for memo/map edges and
    the fftplan composite (its plan flows through memo global + Map cache +
    a local closure param — closure-param kind flow is the other missing
    link). fftplan/provenance rows unchanged until those land; machine was
    load-13 all leg, quiet-machine numbers owed.
  * provenance leg 2 (2026-07-09, b788388): the guarded design LANDED as
    speculative typed-param specialization — the engines' own move (guard
    tags at the call, specialize the callee) rather than per-read unbox.
    speculateTypedParams (narrow) + emitSpeculativeCall (emit) +
    slotTypedCtorByProp (schema census, guardedSlotOf contract). Weak
    recursive evidence lattice: proven | field census | single-binding init
    | enclosing-arrow param met over the arrow's own call sites | return
    census with nullish SKIPPED (Map/memo getters census through — the
    guard eats the nulls at runtime). Evidence-less sites NEUTRAL;
    conflicts kill; cycle guard path-local (backtracks — inlined-duplicate
    sites re-resolve). RESULT: fftplan 28.2→2.44ms LEADS JSC 2.72/V8 3.97;
    provenance 19.5→2.00ms LEADS JSC 2.13/V8 3.20; checksums exact; suite
    2730/2730, selfhost 20/20+5/5 fresh kernel. BONUS root fix: nullish
    module-let decl init now records nullable on the global rep — the memo
    idiom (`let last = null; if (last === null) last = make()`) was folding
    its guard to a constant at EVERY optimize level and silently never
    memoizing (strictSentinel non-nullable fold). TRIED-AND-REVERTED: jz-IR
    read-only loop unswitch (doubled every unknown-source ctor-copy loop,
    +92B golden, no bench win). Numbers still load-13-machine; quiet owed.
  * violations leg (2026-07-09, a87baee): re-measured queue — immutable
    1.85x v8 (worst), wordcount 1.43x v8, shapes 1.24x v8, json 1.24x jsc,
    strbuild 1.17x jsc. immutable profiled to three costs: (1) second dyn
    element read at the in-place store — FIXED (sweep records the tracked
    alias; ptr-narrowed alias discharges the guard statically: store = bare
    slot overwrites, -0.5kB); (2) ToInt32-NaN-guards per field read — the
    slot-int census self-poisons on the rebuild-from-own-read idiom; made
    it a greatest fixpoint (optimistic slot reads, flip→re-derive) but the
    kernel's `p = ps[i]` receiver is unresolvable at census time (elem-sid
    knowledge is narrow/emit-late) so immutable itself didn't move —
    NEXT INCREMENT: late census re-run with body-local elem-sid resolution
    (facts.arrElemSchemas + paramReps route, as inplace-sweep's elemInfo),
    needs a FRESH rebuild (not monotone re-run) after narrowSignatures;
    (3) STRUCTURAL residual: fields stored as f64 boxes vs V8's SMIs — the
    named lever is i32 SLOT STORAGE for intCertain slots (schema-slot
    representation change, the big one); plus per-iteration __ptr_offset
    call LICM once stores can't relocate (raw in-place store enables it —
    hoistInvariantPtrOffset doesn't recognize it yet), plus watr
    foldImmutableGlobals (immutable const global.get → const inline).
  * wordcount profiled (1.43x v8): per-token path is __is_str_key +
    __str_hash (hcache HITS — the lazy hash cell works) + __hash_get_local
    + __dyn_get_expr + __hash_set_local + TWO __durable_slot_log barriers.
    Get and set are SEPARATE probes: tryHashRmwFusion never fires because
    `const counts = {}` registers an (empty) schema → valTypeOf = OBJECT,
    and the gate wants HASH/unknown; the object then does keyed access via
    its dyn-prop SIDECAR hash anyway — worst of both. LEVERS (next leg):
    (a) dyn-keyed-only empty-literal objects (dynKeyVars census exists)
    should LOWER TO HASH outright — dictionary-mode objects, the engines'
    own move; then RMW fusion fires and halves the probes; (b) audit the
    per-store __durable_*_log write barriers (two per token); (c) dedupe
    the doubled __is_str_key per access. strbuild/shapes/json unprofiled.
  * violations leg 2 (2026-07-09, 158abe7/4a77ad2/de52447): three cases
    flipped or moved, all engine-level levers:
    - strbuild 2.29→1.18ms LEADS JSC 1.39 + V8 1.82: (1) string concat-
      CHAIN fusion (emit '+') — a ≥3-leaf chain lowers to ONE measure→
      alloc→copy pass instead of per-+ pairwise (triangular prefix
      re-copy gone); node joins the chain only when a side is statically
      STRING (BOOL/OBJECT as node-qualifiers broke bool addition — caught
      by destruct pins); self-accum head stays pairwise (bump-extend
      lives); result MUST route __sso_norm — a ≤6-char heap result breaks
      the SSO-canonicality invariant and representation-keyed lookups
      MISS (caught by watr-metacircular type-dedup pins). (2)
      $__str_byteLen added to PURE_CALL_I32 (strings immutable; the
      bump-extend mutator only fires on provably-dead old values) —
      `j < line.length` hoists out of char loops.
    - shapes 3.65→2.59ms LEADS V8 3.21: emitSchemaSlotGuarded stamps
      guardedNumSlot when its ONE schema censuses the slot NUMBER +
      writtenProps-clean; toNumF64 SINKS the coercion into the arms
      (guard-hit raw load passes bare, only the dyn-miss arm pays
      __to_num). The 8-schema measure(o) dispatch drops a __to_num call
      per field per record. REMAINING shapes levers (profiled, valuable):
      dead zero-init stores per record (~24/record — WATR-side DSE: kill
      local.set x (const 0) when set-before-read on all paths; watr repo
      work), .prop CSE within one expression (o.r read twice).
    - wordcount RMW fusion FIXED (never fired): dictionary-mode {} reps
      VAL.HASH but the decl-site flow overlay stamps the literal's OBJECT
      kind — the receiver gate now honors the rep; single probe per token
      (5.51→4.04ms absolute; ratio ~1.45x vs faster-idle V8). REMAINING:
      per-token __durable_*_log barrier audit; the fused path had ZERO
      test coverage — value pins added (test/objects.js).
    - json PROFILED (agents, full diagnosis in workflow journal): levers =
      SWAR wide-word key compares in the schema-directed inline parser
      (module/json.js), parser cursor state (__jppos/__jpstr/__jplen)
      globals→locals/params, __jp_num inlining into the specialized path,
      whitespace-skip fusion, per-iteration arena scoping. UNIMPLEMENTED.
  * SELF-HOST RECOVERY (2026-07-09, e621c53): kernel-target suite was
    silently broken 172 fails since 1f36c9d (nanPrefixMaskHex) — the
    kernel could not compile Map/Set/static-object programs AT ALL.
    Roots: (1) i64Hex routed through BigInt toString(16); under self-host
    BigInts are raw SIGNED i64 bits, so the first bit-63-set caller
    rendered "-8000…" and the kernel emitted unparseable i64 consts
    (surfaced as "Bad int"/"Error: 0"/compile-OOB). Now formatted via
    logical-shifted 32-bit halves; host-byte-identical (pinned in
    invariants). (2) __set_add embedded durableEntryLogIR's
    $__durable_slot_log call with NO explicit deps edge (hasVal=false
    skips slotLogDeps) — the kernel's auto-dep scan silently yields
    nothing (the documented selfhost-includes class) so every
    `new Set(...)` died. test/selfhost-includes.js tightened from
    union-reachability to PER-TEMPLATE transitive closure — immediately
    surfaced + fixed 4 more latent holes (__static_str→__mkstr,
    __map_new→__alloc_hdr_n, __jput_str→__jput, __jput_num→__jput_str).
    Kernel leg now 2422/2446 (18 fails). RESIDUE (open, repro'd):
    - alternating-round durable-heal OOB: compiling
      `const g = m.get('a'); g.mut` poisons the NEXT kernel round
      (rounds 1,3 fail / 0,2 pass — scratchpad/kern-seq.mjs); trap in a
      (i64)→i32 helper hashing a dangling key — the zombie/heal machinery.
    - byte-parity DIFF (loop/closure/data probes): kernel's resolveIncludes
      autoDepsOf realize/scan yields nothing for __alloc's template →
      __memgrow reaches includes late → the global-snapshot sweep misses
      __heap_end → watr inline drift (+bytes, behavior EQUAL). All sweep
      CONSTRUCTS probe equal now (scratchpad/sweep-probe.mjs) — remaining
      root is WHY autoDepsOf's realize/matchAll diverges in-kernel.
    - 18 kernel-leg fails: multi-module 'Unknown module' shapes (arguably
      mis-classified for the kernel leg — it has no module resolver by
      construction), destructure-assignment `({a,b} = obj)` internal.
  * violations leg 3 (2026-07-09, 5807563/3073247 + watr 7ad05df):
    - immutable 1.06→0.73ms (−31%): analyzeSchemaSlotIntCertain gains a
      LATE mode (plan's post-narrowing block) — FRESH census rebuild with
      per-body element-alias sids (`const p = ps[i]` through the param's
      arrayElemSchema / local arrElemSchemas facts, knowledge that exists
      only after narrowSignatures). Sound to rebuild (not just widen):
      every consumer reads at emit. Residual vs V8 0.42 (1.7x): f64-boxed
      slots vs SMIs — i32 SLOT STORAGE stays the named big lever.
    - json 0.23→0.13ms LEADS JSC 0.15 (1.11x) + V8 0.26 (1.92x): SWAR key
      matching in the shaped parser — expectText compares 8/4/2/1-byte
      chunks against packed LE constants (one load+compare+branch per
      CHUNK, one pos advance); in-bounds by the existing len+8 alloc with
      8-byte 0xFF sentinel (sentinel-overlap fails into generic reparse ✓
      bit-exact). Remaining json levers recorded (cursor globals→locals,
      __jp_num inline, ws-skip fusion) — now BELOW the lead, optional.
    - watr `deadset` (7ad05df, PENDING PUBLISH): drop const local.set
      overwritten on every path before any read — the inliner zero-init
      shape (shapes' ~24/record). First-x-op scan, ITERATIVE (the CPS
      draft + the naive continuation unwinding each blew the stack on
      kernel-size functions — three rewrites: fork-only recursion,
      depth-cap 512, in-loop continuation unwinding); runs ONCE
      pre-rounds (post-coalesce slot sharing aliases per-name liveness —
      a real "x"+1→"x0" miscompile caught during development by jz's
      preeval pins). watr suites 256+590 green; jz suite/selfhost green
      against the local copy; shapes number ~neutral on V8 (its regalloc
      absorbs dead stores) — ships as codegen-quality/size.
    - foldImmutableGlobals CROSSED OFF: V8 constant-folds immutable
      global.get at wasm-compile time; watr's `globals` pass is size-
      gated by design. Non-lever.
    - wordcount RE-VERIFIED fused pre-watr (hash_slot+slot_write; the
      census noise earlier was stdlib text). 3.89ms vs V8 2.63 (1.5x) —
      residual is probe-structural (str_hash+bucket+str_eq per token vs
      dictionary ICs); next named lever: key-pointer interning for the
      probe loop + the durable-barrier audit.
    QUEUE STATE after leg 3: fftplan/provenance/fft/strbuild/shapes/json
    LEAD both engines; sort/mat4/raytrace/hashjoin lead; wordcount 1.5x,
    immutable 1.7x behind V8 (both with named structural levers);
    dispatch 1.07x-beaten V8 / JSC-only gap stands (predictor-bound).
  * violations leg 4 (2026-07-10, aa77000/9adc984/ca6986a/a343424 on
    published watr 5.3.6): IMMUTABLE FLIPPED + a census soundness audit.
    - $__mkptr → NON_MUTATING_CALLS (one line, aa77000): the in-place
      store's re-boxed result was the ONE call pinning hoistInvariantLoop's
      purity gate — the immutable/wordcount loops re-ran the full
      __ptr_offset forwarding+bounds dance per iteration. Hoist now fires
      (pinned: inner loop has zero ptr_offset calls).
    - SLOT-CENSUS SOUNDNESS AUDIT (9adc984): probing the extern-write
      question (JSON parsers writing into censused sids) surfaced FIVE
      probed-live miscompile families — dyn keyed writes vs floor-elision
      AND vs slotVT NUMBER (raw arithmetic on a string box → NaN), `.prop=`
      through unresolvable receivers, compound assigns (`o.x += 0.5` never
      censused), plain writes (slotTypes observed ONLY literals — `o.x =
      'oops'; o.x + 1` skipped concat dispatch), const-JSON floats into
      literal-shared sids. Repair: collectSlotWriteHazards — one
      program-wide write-family scan (keyed/delete/destructure/spread/
      assign/JSON shapes) applied at every census (re)build + gated in
      every reader (schema.js belts, kind.js shapeOf-arm census deferral);
      hazards RECOMPUTE post-narrowing (paramReps type receivers — early
      pass had poisoned the world off fftplan's `re[j]=tr` on a
      then-unnarrowed param) and slotTypes gained the late fresh rebuild
      the int census already had. JSON shaped/const sids are KIND-SAFE
      (any shape divergence falls back to the generic parser, whose sids
      are DISJOINT by construction — __schema_next seeds past the
      compile-time table): slotTypes observes sample kinds, json keeps its
      shaped fast path; value-facts (intCertain/ctors) fail closed.
      Compound writes now OBSERVE their effective value (`o.n++` → `o.n+1`
      through the optimistic fixpoint — int compound counters keep
      certainty). 7 regression pins (test/slot-hazards.js).
    - STRICT-I32 SLOT LATTICE (ca6986a) — the "i32 slot storage" lever
      landed WITHOUT a layout change: the int census graduated to 3 levels
      (0 / 1 integral / 2 strict-int32: bitwise minus `>>>`, in-range
      literals, bools, comparisons, imul/clz32 — never -0, trunc-exact),
      one monotone-down fixpoint (type.js intLevelMap) with boolean
      projections for all existing callers. Strict slots load as
      `i32.trunc_sat_f64_s` directly in i32 (guard-free), exprType types
      their ternary locals i32, and emit re-derives the locals slice after
      inferLocals binds elem-alias sids (the analyzeBody-before-
      analyzeValTypes ordering hole). immutable 0.75→0.31ms: LEADS V8
      (0.44, 1.4x) and JSC (0.73, 2.3x) — was 1.74x BEHIND. Range-edge
      pins: 3e9 / >>>0 / % / u- slots stay level 1.
    - wordcount discharges (a343424): fused-RMW statically-numeric result
      → bare i64.store (durable barrier provably dead, __is_eph_bits call
      dies); generic __to_num sites test f64.eq(v,v) inline (non-NaN IS
      its ToNumber; optimize-gated); fusion's unknown-key arm inlines the
      6-op NaN+tag test. 1.49x → ~1.3x behind V8. REMAINING (named): the
      per-token __ptr_offset(words) — needs cross-function neverGrown for
      PARAMS. NOT body-local-only: callee-reachable aliases can grow the
      array mid-call, and arrResized/nameEscapes are NAME-keyed (the
      builder's `words.push` collides with the kernel's read-only param of
      the same name) — needs an escape-aware caller fixpoint feeding the
      existing localReps.neverGrown consumer at array.js:831; then
      __str_hash SSO-arm inline.
  * violations leg 5 (2026-07-10, e36668c/394ab5b): wordcount to V8 PARITY.
    - cross-function neverGrown for array PARAMS (e36668c): the
      activation-scoped proof — during any call of f the param's array can
      only relocate if code RUNNING WITHIN the activation grows an array it
      can reach. neverGrown iff safeReads(body, p) + f and every transitive
      callee ARRAY-GROWTH-FREE (no resize/.length=/non-literal-key indexed
      write on a possibly-ARRAY receiver; OBJECT/HASH/TYPED receivers exempt
      — keyed writes there land in slots/dict tables, arena-bump never moves
      arrays; unknown callees / computed calls / writtenProps-shadowable
      methods / bare func-ref args poison). Poison fixpoint over the direct
      call graph; receiver kinds via body valTypes overlay + paramReps (the
      dictionary `{}` decl and TYPED params resolve) — name-keyed
      arrResized/nameEscapes could NOT express this (builder's `words.push`
      collides with the kernel's same-named read-only param). Consumer:
      module/array.js raw-base read (skips __ptr_offset per element). Pins:
      test/never-grown.js incl. all three fail-closed directions.
    - tiered $__str_hash in genSlotUpsert (394ab5b): SSO mix + hcache-cell
      load inline at the fused probe; cold shapes call the helper. FOUND
      DURING: $__str_hash's final clamp is i32.le_s — it shifts every
      NEGATIVE hash by 2, not just the 0/1 empty/tombstone guards (and pre-
      clamp -2/-1 → 0/1 COLLIDE with empty/tombstone, a 1-in-2G pre-existing
      quirk, noted); the untailed transcription re-inserted every
      negative-hash key — caught by dictionary RMW value pins + a
      divergence trap.
    - wordcount: 1.36x → 1.10x (neverGrown) → 1.04x (tiered hash) vs V8;
      JSC beaten. Remaining ~4%: probe-loop micro-structure — V8-parity
      band, machine-noise dominated.
    - jessie DIAGNOSED (agent, quantified per-parse helper counts): NOT two
      residuals but three — parse$space char-scan __ptr_offset 27% of
      helper traffic (module-global receiver blocks hoisting; strings are
      stable pointees — a per-loop base hoist tolerant of global rewrites
      is the lever), closure8 call_indirect volume 11.3% (lever: same-BODY
      indirect devirt — prove every table value shares one closure.make
      body → direct call with env arg; existing devirtConstFnArrayCalls
      requires capture-free const literals, subscript's table is neither),
      .loc dyn-set 2.6% (lever: array-expando header slot — the array
      analogue of static-object schema tier 2). Dyn-prop READ chain already
      collapsed 46% → 8.4% by prior legs. Agent's 'jessie crashes under
      default memory' claim NOT reproduced through the real bench harness
      (6/6 clean) — likely its raw-instantiate harness artifact; watch.
    - jessie levers GROUND OUT (2026-07-10, two worktree agents, both
      verdicts humbling and precise):
      * 27% base-hoist lever: hoistLoopGlobalPtrOffset LANDED (e3c6d38,
        merged) — per-loop stable-pointee global base hoist, callee
        cleanliness via the existing collectReachableGlobalWrites fixpoint,
        fail-closed on call_indirect/call_ref; positive ablation + two
        fail-closed pins (test/hoist-loop-global.js, wat-invariants). Jessie
        BYTE-IDENTICAL though: subscript's `cur` global is assigned only
        INSIDE parse()'s body and recordGlobalRep observes depth-0 module
        assignments only → `cur` never proves STRING → the durable-receiver
        override probe keeps its OWN call_indirect inside every scan loop →
        the hoist correctly declines. THE REAL LEVER: module-global valType
        inference from an ALL-WRITERS program scan (observeProgramSlots
        analogue for globals) — prove `cur` STRING, the override probe
        leaves the loops, THEN the hoist (already landed) fires.
      * 11.3% same-body devirt lever: REFUTED BY PROOF — the agent built the
        full write-family scan (dyn closure tables → constFnArrays reuse) and
        it correctly refuses subscript's table: ≥8 distinct closure bodies
        write into it (string/module/number/template.js each register their
        own), genuinely polymorphic, NOT the same-body shape the profiling
        assumed. Machinery left on branch worktree-agent-aca96e30f3fea719d
        (byte-identical on jessie = zero present value; take it if a
        monomorphic dyn table ever shows up in a bench).
  * pow leg (2026-07-10, 07f6346, agent-ported in a worktree + merged):
    $math.pow's non-integer tail (single-precision exp(y·log x), relative
    error ~|y·ln x| ulps) replaced with the fdlibm e_pow core (FreeBSD msun
    + musl scalbn, cited — the same algorithm V8 ports). Special cases +
    integer binary-exponentiation fast path bit-unchanged. Differential vs
    host Math.pow: 651/672 grid bit-exact + 21 at 1 ulp, 64/64 random ≤1
    ulp, 42k-case sweep zero >1 ulp (test/pow-ulp.js). test/math.js's
    constant-exponent fold pin relaxed to tolerance (that fold is a
    separate deliberately-cheap path, no longer bit-identical to the
    now-correct pow).
    colorpq UNMOVED by design finding: its exponents are compile-time
    CONSTANTS routed through the scalar const-exponent exp∘log fold
    (module/math.js ~396) + its vectorized twin (vectorize.js:3180) —
    $math.pow is never called. colorlch (fifthroot algebraic path) and
    colorlog (exp2) likewise carry pre-existing engine-checksum DIFFs from
    the same FAST-TRANSCENDENTAL-FOLD ACCURACY family. Named residual: a
    compensated (double-double log) const-exponent fold — scalar AND
    vectorized — would close the parity family; a naive de-vectorization
    would close parity but lose the SIMD lead (colorlch leads V8 1.5x,
    colorlog 1.8x today). Also noted pre-existing: integer fast path
    overflows to 0 for pow(huge, -3) (squaring hits Inf before the
    reciprocal); kernel-leg 5 worktree failures were worktree artifacts.
    COMPENSATED-FOLD VERDICT (2026-07-10, worktree agent, NOT merged):
    the double-double const-exponent fold was built ($math.pow_fold +
    SIMD repack twin) and CLOSED THE ULP GAP (≤1 ulp on colorpq's actual
    exponents) but full checksum parity is UNREACHABLE — fdlibm is
    "nearly rounded", not correctly-rounded (even $math.pow_core is
    651/672 bit-exact vs host), and the strided-hash checksums need
    bit-exactness at every sample. Speed: the correct algorithm costs
    ~4x a scalar V8 Math.pow call → colorpq 3.76x SLOWER (vs 1.20x
    today) — accuracy at that price loses the V1 bench mandate; branch
    worktree-agent-a645ccd97ec575d12 holds it (incl. two latent fixes to
    take with any revival: PPC_CALL2 call-lift hardcodes unary/binary
    arity, LATE_VEC_HELPERS allowlist misses new SIMD helper names).
    CHERRY-PICKED from it: fifthroot fold pow(-Inf, k/5) → +Infinity
    (was NaN; f800b0c). colorpq/colorlch/colorlog parity stays a
    recorded ULP-family DIFF — closing it needs a CORRECTLY-ROUNDED pow
    (e.g. CORE-MATH's two-phase scheme), a different, larger project.
    STATE 2026-07-10 (full 52-case table, jz/v8/jsc): svg geomean —
    V8 2.09x slower than jz (was 1.89x at leg 3). 43/52 cases jz LEADS
    BOTH engines outright. V8 beats jz on only THREE: wordcount 1.36x
    (named lever above), colorpq 1.20x (lab; jz checksum ULP-differs from
    both engines — jz's Math.pow, pre-existing float note), jessie 1.51x
    (standing worst lab case — .loc sidecar churn, closure8 descriptor
    walk). JSC-only-beaten six (V8 beaten in all): dispatch 3.8x (call-IC,
    predictor-bound — recorded), crc32/dict/colorconv (recorded JSC-only
    class), synth 1.11x, json 1.14x (CI-jitter band — LED JSC 0.13 vs
    0.15 in this session's quiet runs). Self-host row: jz.wasm 24.2ms
    BEATS V8 40.0 (1.66x) and JSC 35.0 (1.45x) full-pipeline; parity
    column still DIFF (the recorded autoDepsOf byte-parity OPEN item).
    All 66 examples compile clean. Gates at close: suite 2742/2748,
    ratchet 6/6, selfhost 20/20+5/5, size geomean vs binaryen 0.964.
    bench-compile.mjs NOTE: its jessie lab case fails on subscript
    node_modules path resolution (bench-harness module resolution, the
    known 'Unknown module' class — NOT a compile regression; the main
    bench table's jessie compiles and runs).
* [ ] compiler architecture perfection
  * [ ] How to reduce the size of jz.js (eg. twice)? Is there any structures that can be folded or which don't add any value?
    * [x] dead-pass ablation sweep (2026-07-09): specializePtrBase,
      sortStrPoolByFreq, deadStoreElim, csePureExprLoop + the vestigial 'post'
      phase DELETED — byte-identical outputs proven across 50 benches + 66
      examples + the self-host kernel at all watr tiers (~900 lines, dist/jz.js
      -9.5KB, dist/jz.wasm -370KB). Kept-with-evidence: cseScalarLoad (aos 25%),
      hoistInvariantPtrOffset (shapes).
    * next: value-unknown group needs corpus bench-timing (hoistAddrBase -2KB
      when off!, hoistInvariantLoop vs watrLicm double-LICM, promoteGlobals,
      internStrings, propagateSingleUse — disabling it is smaller AND faster to
      compile). THE fold that halves jz.js: migrate src/optimize (vectorize.js
      369KB + index.js 229KB) INTO watr — one optimizer, one walker infra.
  * [ ] How to increase the compilation speed of jz.js? Is there pipeline optimizations, streamlining or better abstraction altogether to make compilation speed multiple times faster? Some folding or waste cutout possible - what can be killed of merged without effect?
    * measured: watr's generic walkers = ~30% of compile (walk 679ms/profile);
      tallyLocals specialized upstream (watr e83c858); dead-pass deletions bought
      ~5-8%/corpus. Next: specialize writesOf/cseFactsOf/hashFunc callbacks or
      arrays-only walker variants (half of nodes are leaves).
  * [x] How to shave off the size of produced wasms? Attain level better than wasm-opt for produced wasms? We have three options - own post-watr wat optimize pass, watr/optimize or wasm-opt, but ideally we'd internalize the optimizer so that's more efficient than wasm-opt, as well as fast.
    * DONE 2026-07-09: watr-as-optimizer vs binaryen-as-optimizer on IDENTICAL
      pre-opt input = 0.998 geomean (8 cases; beats on crc32/json/dict/
      tokenizer/mandelbrot, json 0.991). Landed: watr `ifset` (one-armed
      if→select, speed profile + jz size tier; nqueens -6% as a speed bonus)
      and watr `zeroinit` (drop set-of-spec-zero; float -0 excluded — a real
      sign-flip bug caught by the sort pin during development). The optimizer
      is fully internal (no wasm-opt anywhere in the pipeline). Remaining
      binaryen edge if we ever want more margin: ~40 extra tiny-helper inlines
      + br/br_if forms (recorded, optional).
* [ ] jz.wasm beats v8
  * I need your expertize to make jz.wasm faster than v8. I suspect there's too many string ops, or strings are too complex and could be done simpler OR not versatile enough, or there's some internal structure missing or redundant, or some internal optimizations possible, to reach the level of jz.wasm performing faster than jz.js. Now it's seemingly slower and we need to beat V8 and JSC. The point is not optimizing the source, but making current structures more efficient, so that generally any compiled WASM is faster than V8.
  * STATE 2026-07-09: warm self-host compile = 1.004x jz.js GEOMEAN (sort 0.97,
    mandelbrot 0.98, crc32 1.00 BEAT it; mat4 1.06 lags), fresh-instance 1.097x.
    The item reduces to: mat4-shape warm gap + fresh-instance init cost. Not a
    strings problem — the string-ops suspicion was refuted by the parity data.
  * BENCH EVIDENCE (JSC leg): the bench jz lab case (full pipeline, process-per
    -run = cold-start methodology) has jz.wasm at 23.1ms vs jz.js on jsc 32.5 /
    bun 35.1 / node 39.2 / deno 43.4 — jz.wasm beats V8 AND JSC 1.4-1.9x cold,
    at warm parity (1.004x). Coherent: wasm needs no JIT warmup; engines pay
    parse+tier-up of 2.4MB compiler JS every fresh process.
  * OPEN (fidelity, not correctness): kernel output is behavior-equal but NOT
    byte-equal to host output (bench jz row parity column shows DIFF; kernel cs
    4208029189 vs engines 2693214886, each side internally deterministic).
    Narrowed 2026-07-09: divergence is PRE-watr, in assemble.js's global-
    snapshot sweep — host emits `(global.set $__heap_end (i32.const 0))` in
    __clear, kernel omits it (then watr inline decisions drift downstream:
    host inlines __memgrow, kernel keeps it → +1 type, ±bytes). Harmless:
    stale __heap_end is a monotonic memory-size cache, still valid after
    _clear. NOT a regex bug (matchAll char-class probe equal host/kernel).
    Suspect: kernel-side behavior of the sweep's Set-iteration + dynamic
    stdlib[name] bracket reads + globals.get(...).mut chain. Repro:
    scratchpad/self-parity.mjs (3 probes: bytes DIFF, behavior EQUAL).
    Goal when picked up: byte-exact self-host → bench parity column 'ok'.
    Narrowed further 2026-07-10: __alloc's manual deps edge __memgrow
    EXISTS (module/core.js:40) so the fixpoint edge isn't the miss; jz-
    compiled probes of BOTH scan constructs — matchAll group extraction
    (m[1]) and the sweep's `\\(global\\.set \\$([A-Za-z0-9_.$]+)` with $
    and . inside the char class — are EQUAL host/kernel at O0+O2. The
    divergence is therefore kernel-EXECUTION state, most likely a thunked
    template's expansion-time ctx reads differing in-kernel (the sweep
    memoizes `stdlib[name] = src()` at line ~739 — heapResetWat()-style
    ctx.scope.globals reads at that moment) or a bracket-read timing
    difference. NEXT: instrumented dist (resolveIncludes/sweep records a
    diagnostic readable through the kernel boundary — e.g. a '2diag'
    optimize-flag path returning the diagnostic string instead of wasm),
    run self-parity.mjs against it, compare the three record sets.
  * INSTRUMENTED-KERNEL SESSION (2026-07-10, 9888cbd/281afc5): the channel
    (scripts/self.js compileDiag — diagSink snapshots in resolveIncludes +
    the assemble sweep, JSON through the kernel boundary, diffed
    host-vs-kernel) landed and IMMEDIATELY paid: TWO real host-side
    miscompile roots found and fixed, both suite-green with pins.
    - ROOT 1 (9888cbd): the kernel's own `autoCache.get(name) !==
      undefined` compiled to an UNCONDITIONAL return — mayBeNullish only
      flagged nullish literals/ternaries, sound while opaque sources had
      no value kind; the Map/element value-kind inference broke that and
      emit's strictSentinel fold erased the miss guard AT EVERY LEVEL
      (dist builds at optimize:false). Fix: fail-closed mayBeNullish
      (anything not structurally non-nullish is nullable — the flag only
      suppresses sentinel folds + capture propagation). Pinned via the
      dedupe-cache memo idiom (hit-count, both levels).
    - ROOT 2 (281afc5): the sweep's `src.matchAll(...)` on the typeof-
      continue-narrowed receiver silently scanned NOTHING — matchAll had
      only a `.string:` emitter, so the runtime string-fork (needs BOTH
      keys) never armed; untyped receivers fell to the dyn-prop probe →
      undefined → for-of swallowed it. Fix: generic `.matchAll` twin
      (ES ToString-coerces the receiver) → the same anchored scan.
      Host-level repro of the exact sweep shape pinned at both levels.
    - RESOLVED (2026-07-10, dbd3293/367b151): the "per-export clone" suspicion
      was WRONG — the mother bug was BOOLEAN IDENTITY LOSS. Chain: kernel's
      resolveOptimize gets JSON.parse('1') = NUMBER 1; jz lowered `opt === true`
      on an unknown operand to NUMERIC equality → 1 === true → TRUE → level-2
      branch; there `{...LEVEL_PRESETS[2]}` read UNDEFINED (Object.freeze
      wrapper blinded the literal's schema → untyped element dispatch, no
      OBJECT arm) → spread {} → empty cfg → every `cfg.pass !== false` gate ran
      + watr off → level-'1' kernel output drifted (csePureExpr/foldSetToTee
      fired). Also: fromEntries preset values stored as raw 0/1 (`false` read
      back as number 0 — `0 !== false` true). Fixes, all landed with pins
      (test/bool-identity.js, 6 tests):
      * carrierF64 ingress — bools cross EVERY untyped carrier as TRUE/FALSE
        atoms: array literal elems + push/fill/unshift, Map/Set keys+values
        (bridge 'I' casts + .set/.get), dyn-keyed writes, closure + direct call
        args (narrow stamps settled p.val; val-known params keep raw 0/1 ABI).
      * emitStrictEq: unknown-vs-bool-literal compares ATOM BITS (1===true
        false); both-BOOL compares truth values (carriers vary by source).
      * Mixed ?:/&&/||/?? merges box the BOOL arm (watr's `i ? true : [from,
        len]` rec marker — metacircular type-dedup pin); VT['?:'] carries only
        BOOL∪NUMBER (both-arms-are-the-value ⇒ a carried pointer-kind claim let
        strict-eq const-fold wrongly); &&/|| keep the full guard-idiom carry.
      * '+' string-dispatch numeric arm: inline atom ladder coerces NaN-boxed
        operands (true+1=2, null+1=1) — no __to_num (formatter tree stays out
        of the dyn-object golden); isNumArm/typed-load valKind evidence skips
        guards in numeric kernels; foldStrDispatchF64 unwraps the guard so
        plasma still folds+vectorizes. nest ratchet re-baselined 8559→8834
        (guards on '+' over unknown-param array elems are load-bearing).
      * Object.freeze folds to its operand in prepare (jz never modeled
        frozenness; the wrapper only blinded schema dispatch). __typed_set_idx
        ToNumbers NaN-boxes (spec). JSON.parse const-bool claims BOOL. Export
        wrappers extract the result bit via __is_truthy (bare f64.ne(v,0) read
        FALSE_NAN as truthy — JSON.parse("false") exported true).
      RESULT: kernel-vs-host parity levels 0 AND 1 byte-IDENTICAL; dist
      kernel -163 kB (freeze-fold made jz's own preset tables static);
      benches re-verified no-regression (wordcount 1.008x parity, immutable/
      json/dict/shapes/fftplan/strbuild/mandelbrot all still lead, checksums
      exact). REMAINING level-2 residual, sharply narrowed: watr-IN-KERNEL
      makes a different `inlineOnce` decision (__memgrow spliced by host, kept
      by kernel; ±bytes, behavior EQUAL) — jz-side emission parity-proven by
      the L0/L1 identity, so the divergence is inside watr's optimizer running
      under the kernel; watr's own source carries a prior self-host workaround
      note in exactly that region (optimize.js ~4442 "KEEP THIS EXTRACTED").
      NEXT: instrument watr's inlineOnce/inline decision inputs (candidate
      sets, size counts) through the kernel boundary, diff host-vs-kernel.
      kern-seq durable-heal OOB is NOT this bug (still reproduces post-fix;
      focused agent hunting it — trap in the zombie/heal machinery on warm
      instances after compiling `const g = m.get('a'); g.mut`).
    - for-of over nullish: DECIDED + LANDED (8f7b380) — throws per ES
      (catchable $__jz_err), guard only in __iter_arr's unknown-receiver arm
      (typed receivers pay nothing). Pinned in test/iteration.js.
* [ ] sourcemaps
* [ ] jzify
* [ ] floatbeat
* [ ] color-space
* [ ] audiojs
* [ ] unplugin
* [ ] hsluv wasm https://www.hsluv.org/implementations/

## Floatbeat (what's a good name?)

* I want an environment like codepen, codesandbox etc, but specifically for sharing floatbeats with different visualizations;
* Search - to find floatbeats across different platforms (scraper? live pull? cache?)
* Various visualizers (via JZ or shaders)
  * Classic notes staff
  * Xenakis
  * log/mel spectrogram
* Interactivity - synth, midi, randomization, simulations
* An agent to help driving creation
* Music theory integration
* Audio metrics
* Output mastering params (maybe drop into wavearea for fragment editing?)
* Download a slice / fragment


## Ship — flagship (the one compounding "make-world-know" move)
- [ ] **Floatbeat playground** — type a formula, hear music; AudioWorklet, compiled live.
  Vibecoder + audio + live-coding proof in one. Needs: syntax highlight, waveform
  renderer, recipe-book/DB, samples collection, 1st class waveform, spectrogram etc renderers, artistic renderer (Chladni etc). Should be very easy way to share - likely compressed code in URL. Have to persist samples somehow (github gist like d3 blocks? Anything else?). The point is - audiovis playground.
- [x] **Playground site** = WAT-showing REPL; every item a shareable
  permalink. The demo *is* the marketing. Greenfield (no playground/ yet).
- [x] **Finish selfcompile** — template tag separate from main jz (real selfcompile); 3×
  cross-AI optimizer passes; **release 0.6.0**.
- [x] Main page
  - [x] Demo
  - [x] JZ/JS switch with fps
  - [x] Minirepl
  - [x] Mobile version
  - [x] Light theme?
  - [ ] Sponsor call
  - [ ] Used by (projects list)
- [ ] Examples
  - [ ] Each example must be presentable to authors: lovely code editor, lovely settings panel,
  - [ ] Instead of myriads better have a few powerful boosted examples
  - [ ] Nice settings-panel side-menu
  - [ ] All math examples: educative, entertaining
  - [ ] Open in repl



## Reach — perception/proof (highest external leverage)
- [ ] **AudioWorklet + live in-browser REPL** — single highest-leverage move. Demos ship
  pre-built .wasm (looks like AssemblyScript's gallery); the differentiator (compiles
  in-browser) is invisible. rfft demo already has a source panel; ~30 lines (textarea →
  debounce → jz(src) → postMessage(bytes) → instantiate in worklet).
- [ ] **unplugin-jz** — one plugin covers Vite/Rollup/webpack/esbuild/Rspack. `import { fib }
  from './fib.js?jz'` → WASM at build time. ~100 lines. Leapfrogs AS's rollup-plugin + as-loader.
- [ ] **Dogfood own libs** — color-space, digital-filter biquad, web-audio-api,
  fourier-transform. Highest-trust bench. biquad: bench proves jz 1.23× faster than Node;
  the "Used internally by" README credit is commented-out (false) → make it true.
- [~] **REPL** — ~~engine choice (porffor/awasm/jco)~~; download wasm; show produced WAT; auto
  var→let / function→arrow on paste; auto-import implicit globals; resolve npm packages (url);
  document interop.
- [ ] **Extism plugin path** — author Extism plugins in plain JS; underserved niche.
- [ ] **WASM-4 fantasy console** — supports AS/C/Rust/Zig/Go but no plain-JS path; cartridge
  = wasm start/update over a framebuffer = jz's shape. Viral, direct AS territory.
- [ ] **Subtractive subset spec** — a written acceptance criterion (PARSE-2 is exactly what
  one would have caught).
- [ ] (later) live-coding hosts (Hydra/Strudel/p5/canvas-sketch) — jz as the
  compile-your-hot-loop escape hatch. Pitch: warm kernel speed + tiny portable wasm, NOT
  cold-start (bench:startup: jz cold-start 200–1400× slower than `new Function`).
- [ ] vec4 package (unlocks SIMD); stdlib.io integration; glsl-transpiler.
- [ ] (later) dithering/convolution filters; water sim; text-layout algo; pinterest/fb-reels
  soundvis; math-formula soundvis; floatbeat reproductions.
- [ ] Enhance: settings-panel, palettes, meaningful UI/automation, inputs (file drops). Jukebox: more floatbeats, rotate (not random).
- [ ] https://github.com/thejustinwalsh/zzfx-studio

## Useful tools — returnable, not just demos
Wedge: compute behind an upload/paywall/install → run it local, free, private, instant.
jz = compute core, JS = thin UI shell. (full reasoning § ecosystem-audit.md "2A")
- [ ] **Audio workbench** (Tier 0 — own every piece) — decode → EQ/filter → effects →
  resample/convert/LUFS → export, AudioWorklet on jz kernels. Reuses audio-decode /
  digital-filter / audio-effect / pcm-convert / web-audio-api. **The useful flagship.**
- [ ] **QR generator/decoder** — Reed-Solomon + masking = pure integer, jz's floor.
- [ ] **Local image converter/optimizer** (PNG/JPEG/WebP/QOI + dithering) — Squoosh-class
  privacy wedge; reuses color-space.
- [ ] **Function plotter** ("compile your math") — `f(x,t)` → compiled → plotted.
- [ ] **Color/palette tool** (OKLCH↔hex, extraction, contrast/CVD sim) — reuses color-space.
- [ ] (niche) Voronoi stippler→SVG · bitmap→SVG tracer · pixel-art upscalers (EPX/xBRZ) ·
  cymatics/harmonograph/guilloché · WFC tile generator. (verticals, build on pull) quant
  (Black-Scholes/MC) · GIS (simplify/MVT) · fabrication (G-code/STL) · sci kernels
  (RK4/FFT/least-squares) · bioinformatics (alignment).
- [ ] **Demoscene / js13k / Genuary** — tiny wasm = sizecoding hook; same-source JS↔WASM =
  prototype-then-compile. Pouët, Dwitter/tixy.land, Lovebyte, JS13k, Genuary starter.

## Embedded — jz → native MCU (AOT, no interpreter — the honest differentiator)
Path: `jz → wasm2c/w2c2 → C → arm-none-eabi-gcc / esp-idf / avr-gcc → flash`. Unlike Espruino
/ Moddable XS / wasm3-arduino (interpreters on-device), jz is AOT-compiled to native.
- [ ] **Target matrix + f64 reality** — best on FPU MCUs (M4F/M7: ESP32, RP2040, STM32,
  Teensy 4, Daisy Seed); M7 has a double-precision FPU ⇒ f64 unpenalized; AVR no FPU ⇒
  i32-only kernels or out of scope. Document it.
- [ ] **Pure-compute proof** — `alloc:false`, no WASI, scalar kernel → C → flash → verify.
- [ ] **Flagship: biquad on hardware** — digital-filter biquad → jz → C → Daisy/Teensy audio out.
- [ ] **Heap + RAM budget** — pick a memory region; document RAM budget; w2c2 (~150 KB) runtime.

## Language coverage / correctness
- [ ] **Extension-surface plan (2026-07-10)** — full evidence map in
  `.work/extension-surface.md` (gates, rings 0–3, async/workers verdicts, test262 pool
  math, permanently-out reasons). Measured this session: language 1462/0/21924 (floor
  1453 ✓), builtins **719/12 RED** (floor 722). Work ALL of it, in order:
  * [~] **RING 0 — truth debt** — LEG 1 LANDED 2026-07-10 (see extension-surface.md
    §Landed): hypot n-ary, parseInt/parseFloat spec edges, regex trio, normalize,
    `**=`, clean roles for function*/yield*/new.target/#x-in-o/String.raw, void text,
    + FOUR unblanketing-surfaced fixes (defaults-on-null, numeric pattern keys,
    var pattern declarators, for-of cover-grammar patterns). Language 262:
    1462 → 2205 / 0 fail, CI floor 2205. REMAINING below (0.2 let-capture,
    0.3 bigint-mixed, 0.4/0.5 bind/call/apply, 0.7 unknown-method, 0.13
    strict-switch, 0.17 reviver, 0.18 freeze [blocked: concurrent object.js],
    0.20/0.21) + NEW: isArray-of-derived-promoted (12 xfail), catch-param
    patterns, var-pattern for-of heads, member for-of targets, const-reassign
    guard absent, arguments.js `??` param default.
  * [ ] RING 0 remaining items (original list):
    - [ ] builtins gate RED: `Math.hypot()`/`1/Math.hypot(0)`/`parseInt(" 1")` return
      **boxed null** (non-canonical NaN escaping as ATOM — suspect pow/str-hash legs);
      parseInt radix 1/37/i32-wrap + parseInt(Infinity)→Infinity; String.indexOf
      position-ToInteger; Array.isArray.length; prune 3 unexpected-passes.
    - [ ] for-head `let` capture: `for(let i…) fs.push(()=>i)` → [3,3,3] not [0,1,2]
      (every -O; for-of/body-let correct) — jzify copy-in/copy-out, only-when-captured.
    - [ ] mixed BigInt⊕Number: `1n+1` = f64-bits-as-i64 garbage, `5n>3` = false —
      arith must TypeError, compares must coerce (emit.js cmpOp unconditional asI64).
    - [ ] `fn.bind` → table-OOB trap; `fn.call/apply` → silent undefined — jzify-lower
      static shapes, reject dynamic.
    - [ ] silent-wrong family: Symbol computed key no-ops; regex `\p{…}` matches literal
      "p{L}" (regex.js:188); `/y` scans like `/g` (:864); matchAll non-global no TypeError
      (:1123); tagged `.raw` undefined; Object.freeze no-op + isFrozen(freeze(x))=false
      (object.js:202/232 — bonus: freeze as immutable-schema optimizer fact).
    - [ ] leaky→clean rejects: `function*` w/o yield + `yield*` ("Unknown op"), new.target
      (watr leak), `#x in o` — op-policy entries; `**=` missing from ASSIGN_OPS
      (ast.js:77) — support; strict-mode switch+break broken (route strict through
      jzify/switch.js, delete native twin); `.normalize()` crash (autoload tuple) —
      implement as ASCII identity; **unknown method on KNOWN receiver**
      (`[].toSorted()` → runtime TypeError) must compile-error in default mode too.
    - [ ] JSON.parse `reviver` silently dropped (json.js:1529) + runtime `replacer` —
      implement, kills the xfail family.
    - [ ] `({a,b} = obj)` assignment-form internal error — fix (kernel-leg + main).
    - [ ] for-of over nullish silently 0-iterates (masked two kernel roots) — decide:
      throw (leaning) vs documented-permissive.
  * [~] **RUNNER HONESTY** — skip-split LANDED 2026-07-10: stale blankets removed
    (for-of dir rule, destructuring content rules, this/class/super/WeakMap/
    new.target/for-of EXCLUDED patterns), allowlist grew 'outside jz scope' +
    'requires source with known schema', TypeError/ReferenceError-synthesis rule
    scoped to dstr corpora, bool-carrier family xfail-tracked (flips to xpass on
    carrier landing — prune then), 26 residuals precisely skip-classified.
    REMAINING: track implemented-but-untracked pools (TypedArray 2184, RegExp
    1877, WeakMap/WeakSet 226, Error family, global); count the 4389 verified
    negative-rejects as their own pass-class; add language/import (182).
  * [ ] **STDLIB batch** (module/, pay-per-use): Array toSorted/toReversed/with/
    copyWithin/of (TypedArray has all four — port); ES2025 Set ops (7, over existing
    tables); Object/Map.groupBy; String.raw; RegExp.escape + named backrefs; Float16Array
    + f16round; structuredClone (arena deep-copy); Date toJSON/toDateString slices;
    Ryū shortest-round-trip String(number) lazily-included (JSON float round-trip — the
    big trust win); insertion-order Map/Set decision via bench gate.
  * [ ] **WORKERS v1** (before async; philosophy-aligned; toolchain ready — watr encodes
    all atomics + shared memtype): emit real `(memory … shared)`+max (assemble.js:883
    lacks keyword); atomic `__alloc` bump (core.js:350 races); module/atomics.js →
    wasm atomics; ~100-line interop pool helper. v1 CONTRACT: shared typed arrays +
    scalars only (SPMD tiles — whole bench corpus shape); strings/objects thread-local —
    dodges the stdlib single-writer audit (forwarding ptrs, STR_HCACHE, enum caches =
    shared-everything later). Headline: N×cores × SIMD, same JS file.
  * [ ] **GENERATORS** (pivotal; NOT coroutines — regenerator state machine): jzify
    lowering (switch.js precedent; locals→env cells, mutable captures shipped;
    next() = closure call); try/finally-across-yield = EH handler re-entry design;
    **local fusion**: statically-consumed for-of SROAs the machine → plain loop =
    zero-cost lazy sequences (V8 allocates, jz compiles them out); unlocks iterator
    protocol + Symbol.iterator + ES2025 iterator helpers AS FUSED LOOPS (514-pool).
  * [ ] **PARKED, designs recorded** (extension-surface.md): async/await — verdict:
    NOT an architectural hit (state machine + module/promise.js on a free NaN-box tag
    (5,12–15 free) + the shipped timer-pump pattern; sync pays zero; asyncify REJECTED,
    JSPI watch — watr already encodes stack-switching); open design item = memory.reset()
    vs in-flight continuations (nursery arena or contract). Relaxed-SIMD opt-in (watr has
    relaxed_madd FMA — biquad/fft native floor; breaks bit-exact → flag only).
    js-string-builtins deepening; memory64/multi-memory YAGNI.
  * [x] **Permanently-out documented** — README FAQ entry with reasons + site link
    (2026-07-10); keep the divergence list in sync as Ring-0 items land.
- [ ] **Date** — deterministic spec slices first; local-tz/Intl later. (deferred: object
  ToPrimitive coercion order; Date.parse until value-objects + UTC stringify exist. out of
  scope: local-time getters/setters, getTimezoneOffset, locale methods, toJSON, subclassing.)
- [ ] **Intl**; **test262** (know every fail by face — jzify or error cleanly, never fail
  unknowingly); **all AssemblyScript tests**; warn/error on memory-limit.
- [x] Tighten test coverage — randomly mutate features, see if tests break.
- [ ] **jzify** — converting script for any JZ; auto-import stdlib globals (Math.* → import
  math); then make jz core require explicit stdlib imports (remove auto-import); Crockford align.
- [ ] **Source maps** (blocked on watr upstream) — meanwhile add a WASM name section.
- [ ] **Math-kernel precision** — sin/cos/exp ~1e-9 absolute vs libm (~30-bit); filter-design
  math amplifies it (biquad `(1−cosω)/2` cancellation → ~1.3e-6 relative coefficient error at
  fc=1000/fs=44100; high-Q/low-fc pole placement sensitive). Lever: compile-time rational
  simplification (research.md) — carry `2πfc/fs` exactly, emit the cancellation-free form.
- [x] **Metacircularity** — extract a minimal jz parser from subscript (jz-jessie fork: no
  class/async/regex, ~30 lines); jzify uses jessie, pure jz uses the internal parser; true bootstrap.

## Bench-vs-V8+JSC matrix (2026-07-08 full-corpus sweep, all checksums identical)
vs V8 — trailing: jessie 5.4x (hard tail), immutable 1.83x, wordcount 1.63x,
shapes 1.08x (borderline). EVERY other case wins (40+ corpus).
vs JSC (new axis — jsc runs the whole corpus incl. compiler-class cases after
a43f8c0): trailing: jessie 6.9x, dispatch 3.1x (JSC's call_indirect tier is
far ahead — the br_table IC that beat V8 doesn't beat JSC), json 1.43x,
dict 1.34x, crc32 1.30x (JSC's int-loop wasm tier beats V8's AND jz's),
immutable 1.28x, strbuild 1.20x, synth 1.09x, qoi 1.02x.
jessie profile re-verified post-all-levers (counters): 3.7M dyn_get_t =
STRING-keyed dynamic reads (subscript tables keyed by token/op strings;
devirt can't fire — receivers are dict/unproven, not schema objects), each
paying dyn_get→dyn_get_t(str_hash 3.9M)→dyn_get_t_h(durable global-probe
ihash 2.1M + sidecar probe) + 8.1M ptr_offset inside those bodies. Levers:
(a) prove subscript's tables VAL.HASH at emit (direct __hash_get_local, kills
the 3-frame chain + durable double-probe) — needs cross-module type flow on
the table bindings; (b) shrink dyn_get_t_h's durable path (the
dynPropsFilterMissIR bloom already gates it — the 2.1M ihash hits mean the
filter passes; investigate why); (c) helper-internal fwd-free extracts.
WATR guardRefine BUG — FIXED UPSTREAM (watr 52b8c2c, needs publish):
restore() aliased the snapshot's inner neFact Sets into the live map;
an arm's addFacts mutated the snapshot; the second restore resurrected
the arm-local fact past the join → sibling tag compares folded on
one-arm facts (the vo valueOf miscompile). Fix: restore hands out fresh
Set copies. Regression test pins the leak shape. Cost of correctness:
kernel A/B 1.0097, jessie +2-4% (the bogus folds were deleting reachable
code). jz's AND-mask guard spelling (280e8f5) can revert to ptrTypeEq
after the watr publish if desired — both are correct now.
FALLBACK-ARM PROBE — REFUTED as a lever (probe-doubling on quiet machine:
±2% wash): the 473k fallback probes cost ~nothing; closure-props flat
table NOT worth building. cpu-prof leaf self-time confirmed misleading
for ihash (29ms 'self' vs ~0 causal marginal cost).
FRESH PROFILE (quiet machine, 4.3ms median, 3.12x V8 = V8 1.38/jz 4.30):
remaining time is GENUINE dispatch — closure8 19ms + trampolines 16ms
(~25% = jz's closure calling convention on the Pratt operator chain:
`(fn = lookup[c]) && fn(a, p)` indirect calls), __ptr_offset 8ms
distributed. NEXT CAMPAIGN: closure-call convention (devirt the
lookup-table dispatch: monomorphic-ish per charcode → inline cache or
direct-index call table; trampoline elision for arity-exact calls).
That is deep-structure work — start fresh with the harness+profile here.
RESTRUCTURE DONE (watr cd4f576 + jz f559b00): the table-entry-native-ftN
design landed as OPTIMIZER POLICY — watr `inlineWrappers` dissolves
adapter frames (closure-ABI trampolines, thin dispatch heads) by inlining
the target at the wrapper site; rides cfg.inlineFns at L3/speed. dispatch
+1-2% (3/3), jessie WASH, size +2%. KEY FINDING (3rd sampler correction):
trampoline 'self time' = irreducible f64<->i32 ABI CONVERSIONS + real
work, not frame cost. jessie's residual dispatch tax therefore lives in
the CLOSURE ABI ITSELF (uniform f64 slots force trunc/convert per arg per
call) — the next deep lever is typed closure ABIs (per-arity/per-type ftN
variants or i32-typed slots proven by the emitter), plus closure8's
genuine descriptor-walk work. The emit.js trampoline string-builder
(~3832-3896) stays as the fn-as-value ENTRY generator (still needed to
mint table entries; elision happens downstream) — its deletion is no
longer load-bearing for perf, only for taste.
TYPED CLOSURE ABI — REFUTED by measurement (4th sampler correction,
2026-07-08 night leg) BEFORE building it. Static: across ALL 85
call_indirect sites in jessie only 3 param-truncs + 2 call-site converts
are ABI-induced (the 140 trunc_sats are string/array INDEX conversions,
inherent to f64 numbers). Dynamic: 2.03M dispatches per bench run = 78k
per parse (arity histo: 0-arg 413k / 1-arg 900k / 2-arg 293k / 3-arg 93k
/ 4-arg 336k; W=8 => ~6.5 UNDEF pads per dispatch). Calibrated micro
(this machine, V8): monomorphic 10-arg call_indirect == 2-arg direct
(padding 0.013ns, indirection 0.008ns/call); POLYmorphic 8-target:
wide-indirect 2.24ns vs narrow-indirect 2.33ns vs br_table+direct
2.06ns. ANY per-dispatch mechanic saving is bounded +-0.2ns => 78k *
0.2ns = 0.02ms/parse; zeroing ALL dispatch = 0.17ms of the 2.9ms gap.
closure8/trampoline 'self time' is the work INSIDE (descriptor walks,
char loops), not call mechanics. V8 wasm call_indirect is ~2ns even
mispredicted. Do NOT build per-arity/typed-slot ftN variants for perf.
COMMENT-WRAPPER DISCOVERY (same leg): nulling subscript's comment.js
space wrapper (measurement-only arm-null, corpus has no comments) took
jessie 4462us -> 2451us: the wrapper was 45% OF TOTAL RUNTIME. Cause:
`for (s in parse.comment)` per space() call (15.3k/parse) — jz rebuilt
the key enumeration EVERY loop entry: receiver is a shadow-mirrored
schema OBJECT (cm[s] computed reads mirror schema into sidecar), so
emitEnumerateObject ran ihash global-probe + __coll_order(alloc+scan+
sort) + out-array alloc_hdr + dedup walk per token.
FOR-IN ENUM CACHE — LANDED (V8 EnumCache analog, all generic):
(a) core.js __hash_keys_ro: for-in over runtime HASH serves a 1-slot
cached boxed key array keyed (table off, live len); (b) object.js
emitEnumerateObject ro-mode: tier-1 returns the STATIC schema key array
(mkptr of __schema_tbl[sid] row) when both dyn sources are empty — zero
alloc, zero state; tier-2 caches the merged walk keyed (sidecar off,
sidecar len), checked BEFORE the ihash probe so a hit skips it too.
Invalidation (all cold sites): inserts miss naturally via len; HASH
genDelete clears unconditionally; __dyn_set global-arm insert +
__dyn_move + array headerPropsToGlobal clear; __clear resets (assemble
injection, gated includes.has). ro (for-in __keys_ro) ONLY — its result
is read-only by lowering contract; Object.keys keeps fresh arrays.
Shared memory: ro forced off (per-instance globals + no reset injection).
RESULT: jessie -16.5% (4471 -> 3750us, 5/5 interleaved under load-14);
counters: coll_order 15.5k/parse -> 0, alloc_hdr:space 15.3k -> 0,
ihash probes 36.9k -> 24.9k/parse. Suite 2712/0 (+5 enum-cache tests
incl. delete-then-insert stale-hole, 1-slot thrash, alloc-free pin);
opt0/opt3/wasi failure sets byte-identical to HEAD; _clear ABA test
(ephemeral dict at reused offsets across rounds) clean.
BONUS FIX riding along: emitEnumerateObject's durable-arm off-16 read
was UNMASKED (bit0 runtime-shadowed marker => misaligned sidecar reads
when enumerating a durable receiver with runtime props) — masked now,
matching collection.js's i64.and -2 protocol everywhere else.
PRE-EXISTING GAP FOUND (not mine, on HEAD too, noted for later): a LATE
literal-key write (`o['zz']=3` after construction) on a schema object is
INVISIBLE to for-in — the write lands somewhere enumeration doesn't
read. Repro in test/forin-deopt.js comment.
JESSIE NEXT LEVERS (by residual profile): (1) `parse.comment` read
itself — 15.3k/parse __dyn_get_any_t_h(parse-closure, 'comment' heap-str
key) through the t_h chain w/ 16.4k ihash probes (~0.3-0.6ms); note the
emitter picked the ANY variant for a LITERAL key (entry-point gap worth
a look) and a receiver+key->value 1-slot read cache would kill the rest;
(2) .loc sidecar alloc churn (hash_set 9.3k/parse on ephemeral nodes ->
slot-in-header idea); (3) closure8 descriptor walk (genuine work —
leaf-op costs only).
BEAT-WASM-OPT LEG (2026-07-09, fourth leg): DONE — geomean 0.998.
Two more watr passes landed on top of ifset:
- zeroinit (watr 59a0e3a): drop `local.set X (T.const 0)` when X provably
  still holds its spec zero (no earlier set/tee in program order incl.
  flat sibling forms, not inside a loop, params excluded). 42 sites on
  crc32 alone. BUG CAUGHT DURING DEV: float -0 === 0 in JS — an equality
  zero-test dropped `f64.const -0` sets and flipped the sign (jz's sort
  -0-before-+0 pin caught it); fixed with Object.is for f32/f64.
- ifset enabled at jz's SIZE tier (jz 32e32b8, watrIfset preset key):
  select IS a size win; wasm-opt -Oz does it too. Speed keeps it via
  boolConvertToSelect; DEFAULT stays branchy (pins).
Three stale codegen pins re-anchored PRE-watr (slice-view, Map/Set
refinement dispatch): the pinned DECISIONS are jz's, and watr's
inlineOnce now legitimately dissolves the single-caller helpers whose
names they grepped (zeroinit shrank bodies under the threshold).
WRAPPER PROBE-HOIST DESCOPED (analysis recorded): asi/comment scanners
call baseSpace through `parse._baseSpace ??= parse.space` — a
CONDITIONAL init write, so single-value closure devirt can't prove the
callee set and transitive-global-writes goes top. Would need ??=-aware
init-once facts (the value IS fixed post-init) — plan-phase work, ~0.1-
0.2ms of jessie at stake.
WALKER SWEEP RESULT: writesOf already memoized direct recursion;
remaining micro-specializations wash at wall-clock on this machine
(twice measured) — the real lever stays arrays-only walker variants /
per-pass fusion (design-level, recorded).
IFSET + PROBE-HOIST LEG (2026-07-09, third night):
WATR IFSET (watr 1f9b22c, jz 7fae21c): one-armed conditional update
(if C (then (set X V))) -> set X (select V (get X) C) — THE dominant
if-shape wasm-opt still converted in watr output. Speed-profile pass
(default off; jz maps it to boolConvertToSelect tiering — NOTE jz's
DEFAULT tier passes watrProfile:'speed' for outline/tailmerge, so the
explicit per-pass flag is load-bearing in both directions). nqueens -6%
(3/3). Gates: pure/trap-free/mem-free/typed-numeric V, ≤12 TOKENS
(count() counts tokens — a 2-op expr is ~8; the two-arm form's cap 6
was why it never fired on real arms), impure-cond clash check.
HEAD-TO-HEAD RE-MEASURE (the honest V1 metric): watr-as-optimizer vs
binaryen-as-optimizer on the SAME pre-opt input = 1.008 geomean (8
cases; watr BEATS wasm-opt on json 0.999). Chasing "wasm-opt finds
nothing on jz output" is a treadmill (smaller output gives binaryen
better input — measured 1.025->1.027 while jz shrank). Remaining
binaryen edge decomposed on crc32: ~90 stack-threaded local.sets
(SimplifyLocals-class dataflow) + ~40 extra inlined tiny-helper calls +
br/br_if forms. Those are the two named watr projects to flip <1.0.
PROBE-HOIST (jz 1da7b20): sidecar override probe hoisted to the entry
prologue for stable-global receivers (same proof as shape-1b); per-site
cost = one predictable i32 branch. jessie: 6 sites qualify (base
space/peek/linebreak scanners — the per-CHAR 3-frame probe is gone
there); asi/comment WRAPPER scans call baseSpace() so the conservative
only-charCodeAt-calls gate excludes them — EXTENSION: call-graph
"callee never writes global G" facts available at emit time (
collectReachableGlobalWrites has them but post-emit; needs a plan-phase
equivalent). jessie -2% directional (load-noisy); checksum exact.
PRE-EXISTING GAP FOUND (control tree too): `let cur = 0; cur = s;
cur.charCodeAt(i)` — a number-typed-by-init var later holding a string
mis-dispatches (vt=NUMBER wins over runtime NaN-box dispatch) →
charCodeAt yields undefined. Type-lattice unsoundness class; repro in
this note.
COMPACTION LEG (2026-07-09, second night): PASS-ABLATION METHOD — for
each optimizer pass, compile 50 benches + 66 examples + self-host kernel
with it disabled at speed/size/2 tiers; byte-identical output = dead.
DELETED (commits 0278309, 768748a): specializePtrBase (100% identical
everywhere — watr's inlining/offset folding subsumed it), sortStrPoolByFreq
(100% identical — its LEB128-ordering effect evaporated), deadStoreElim
(identical at size/2; speed: only nqueens ±8B and FASTER without it 3/3),
csePureExprLoop + the whole vestigial 'post' phase (unreachable: one
caller, always 'pre'). ~900 lines, dist/jz.js -9.5KB, dist/jz.wasm
-370KB, compile ~5-8% faster per corpus. KEPT with evidence:
cseScalarLoad (aos -25% without), hoistInvariantPtrOffset (shapes).
DEFERRED (need corpus bench-timing gates): hoistAddrBase (output 2KB
SMALLER when off — suspicious), hoistInvariantLoop-vs-watrLicm double
LICM, promoteGlobals, internStrings, propagateSingleUse (smaller AND
faster-compile when off), specializeMkptr, narrowLoopBound.
CHARCODEAT SHAPE-1B (274852e, 0a5e413): entry decomposition extended to
stable module-global receivers (parser shape `cur.charCodeAt(idx)`) with
an AST stability proof (never assigned in fn + only .charCodeAt calls in
body + no yield/await/new); probe fallback arm re-references bare-name
receivers so the ABI op sees the global.get. Honest: bench corpus
byte-identical (no bench has the shape), jessie WASH — the per-char
METHOD-OVERRIDE PROBE dominates that site now; its answer is loop-
invariant under the same proof → HOIST THE PROBE is the named jessie
lever. Learned: self-host kernel compiles the compiler's own source —
structuredClone in abi/string.js broke the kernel build (fixed).
V1 ARCHITECTURE CAMPAIGN — MEASURED STATE (2026-07-09 leg; all four
selected items now have causal numbers + ranked levers):
(A) jz.wasm vs V8: warm self-host geomean 1.004x jz.js (sort 0.97,
mandelbrot 0.98, crc32 1.00 already BEAT; mat4 1.06 lags), fresh 1.097x.
The V1 item is a mat4+fresh-instance problem, not a strings problem.
(B) produced-wasm size: jz size-tier is 1.026x geomean of wasm-opt -Oz
APPLIED ON TOP (8-case corpus) — i.e. 97.4% of binaryen's ceiling.
Residual decomposed (crc32 disassembly diff): ~60 if->select conversions
(wasm-opt: if 240->180, select 5->37 — most of the bytes, also a speed
win) + ~87 locals stack-threaded away (set 293->206). Both are
well-defined watr passes: `ifToSelect` (arms pure+cheap+non-trapping)
and cross-block set/get threading. Land those upstream -> jz output
BEATS wasm-opt and 'internalize the optimizer' is done.
(C) compile speed: bottleneck MOVED — emit phase now dominates
(base64: emit 43ms vs watr 16ms of 68ms; blur 37/33). CPU profile
(30x base64): watr's generic tree walkers = walk 679ms self + walkPost
356ms ≈ 30% of ALL compile time (megamorphic callback per node incl.
leaves); biggest single callback was tallyLocals (329ms) — SPECIALIZED
upstream (watr e83c858, direct monomorphic recursion, outputs
byte-identical on the 48-bench corpus) — wall-clock wash under load,
keep and re-measure quiet. NEXT: same specialization for the remaining
hot pass callbacks (writesOf 83ms, cseFactsOf 92ms, hashFunc 138ms,
substGets), or the deeper fix — arrays-only walker variants (half of
all nodes are leaf strings/numbers that most callbacks reject first
thing). jz-side emit: ir.js walk 95ms + countsOf/writesIn ~106ms.
(D) jz.js size /2: dist/jz.js = 1.59MB minified (3.5MB source).
Composition: src/optimize/ = 629KB source (vectorize.js 369KB +
optimize/index.js 251KB) — the single biggest block, ~19% of dist.
THE architectural fold matching the V1 item text: migrate jz's
post-watr WAT passes + vectorizer INTO watr (one optimizer, one walker
infra, one convergence loop) — deletes ~600KB source from jz, ends the
duplicated pass machinery, and consolidates where (B)'s new passes land
anyway. Next-biggest: emit.js 218KB, collection.js 169KB (WAT-string
stdlib — candidate for extraction to a precompiled artifact?).
PRE-EXISTING FIXED EN ROUTE: examples/bench.mjs interference harness
called removed update() (frame() since 5e7df87).
LEVER (1) SOLVED AT THE ROOT (next leg, same night): not a cache — the
existing fn-namespace SROA (flattenFuncNamespaces) was promoting ONLY
multiProp slots (prepare's registry = top-level `f.prop = arrow`
re-lifts). parse.comment (single ??= dict write), parse.newline/semi
(reassigned only INSIDE arrows — invisible to prepare) therefore stayed
on the __dyn_get/__dyn_set probe chain per token. The `any` variant for
a literal key was a red herring — _h IS the prehashed literal-key entry.
FIX (scope.js decision loop): every prop of a non-disqualified namespace
dissolves into a module global EXCEPT the single-top-level-lifted-arrow
shape (kept as-is: its calls lower to direct `call $f$prop`, a global
would demote them to call_indirect; never-value-read ones still drop).
RESULT: jessie 3700 -> 2210us (-40%, 3/3 interleaved; checksum equal).
SESSION TOTAL with enum cache: 4430 -> 2210us (-50%); at the recorded
quiet-machine V8 1.38ms this is ~1.6x V8 (was 3.12x). The asi/comment
wrapper state (newline/semi/comment) is now plain global get/set.
TRAMPOLINE TAIL-CALL — probed, WASH (3/3 interleaved ±1%): return_call on
the plain-f64 forwarders doesn't move jessie because the HOT trampolines
(tramp_parse$space$5 12ms) are the i32-RESULT case — they rebox
(f64.convert_i32_s (call ...)) and cannot tail-call. THE REAL FIX doubles
as the architecture simplification the trampoline deserves: compile
function-as-value TABLE ENTRIES natively against the uniform ftN ABI
(one compilation with the ftN head: read params from slots, rebox result
inline in the body's return) instead of tramp-forwarding — deletes the
60-line trampoline string-builder in emit.js (~3832-3896), removes the
extra frame for ALL result types, and unifies closures + fn-as-value
under one table-entry convention. Direct-call sites keep the exact-sig
entry; whichever is unused treeshakes. Substantial emit restructure —
own session. closure8's 19ms self is genuine descriptor-walk work
(subscript dispatch()) — only leaf-op cost reduction helps there.

JESSIE CAMPAIGN STATE (end of 2026-07-08 leg): 5.4x -> 2.88x V8
(same-thermal-window pairs; V8 2.09ms, jz 6.01ms). Landed, all generic:
array-index element semantics (7c42b30), string-primitive props semantics +
durable runtime-shadowed bit (70585fd), primitive-receiver method-override
probe skip (280e8f5, -13.5%). Next levers by current profile: residual
ihash 39ms (428k legit shadowed probes + 473k fallback-arm closure-prop
reads -> closure-props flat table keyed by fn index), .loc sidecar alloc
churn (115k __hash_new_small/run -> slot-in-header), closure8/trampoline
dispatch (22ms self, genuine Pratt work -> devirt/inline-cache territory).
WATR BUG ROOT-CAUSED TO MECHANISM (2026-07-08 late leg, upstream-pending):
guardRefine ALONE miscompiles (not a composition — {guardRefine:true} on
defaults flips the vo repro to tag=1). Mechanism: its tagAlias/neFact maps
mis-associate across REUSED/COALESCED locals — bisected to fold #7
(i32.eq($..._type,ARRAY) -> 0) whose neFact was derived from cond
i32.eq($__inl19_arr0, 1) where arr0 is a coalesced slot holding a TAG at
that point but tagAlias bound it to a source local ($__inl18_a) that was
REASSIGNED in between; the fact then applied to the new occupant. Suspect
surface: restore(pre)/killLocal(writes) discipline around if-arms vs
walk-order of coalesced defs. Artifacts: scratchpad/vo.prewatr.wat
(deterministic 176KB repro: optimize({guardRefine:true}) -> exports.f()
tag 1 instead of 4), scratchpad/vo-run.mjs (tag checker + minus-one-pass
bisector), scratchpad/pre-gr.wat (pre-guardRefine stage, fold site at
line ~5077). Instrumentation recipe: cap folds via WATR_GR_MAX + log via
WATR_DBG_GRN/WATR_DBG_FACT (patch shapes in the session transcript).
jz-side: the AND-mask tag-compare spelling (280e8f5) avoids the trigger.
TIME PROFILE (2026-07-08, --cpu-prof on names:true jessie wasm — the call
COUNTS above were misleading; counts ≠ time): __ihash_get_local self=94ms
of ~270ms total wasm self-time (35%!), __dyn_get_t_h 24ms, __str_hash 14ms.
The dyn_get_t key chain was eliminated (array-index element arms, 7c42b30 —
attribution shows ZERO chain calls) and jessie wall time did NOT move: the
chain was calls, not time. THE REAL SINK: subscript stores parse.space/
step/enter/exit/id AS PROPERTIES ON THE PARSE FUNCTION (a CLOSURE), and
closures have no off-16 header sidecar — every parse.step/space read
(1.6M+/run, const-key _h path) probes the global __dyn_props int-hash
(CLOSURE → global-table arm in __dyn_get_t_h; the 1-slot dyn_get cache
thrashes between parse's ~6 hot props receivers/keys). NEXT LEVER (the
generic-baseline fix): give closure receivers a header props slot (allocate
env with an off-16 sidecar like OBJECT/ARRAY, or a dedicated props cell in
the closure env) so closure-prop reads take the header-sidecar path — kills
the global probe + its cache pressure. Alternatively a receiver+key inline
cache at _h const-key call sites (monomorphic in this workload). Expected:
the full 94ms ihash + part of dyn_get_t_h 24ms ≈ ~40% of jessie runtime.
Note: .loc writes (115k/run) allocate a per-node __hash_new_small — the
allocation churn is the secondary sink to check after closure props.
RECEIVER IDENTITY SOLVED (offset histogram, self-learning slots): the
durable-arm receivers are STATIC-DATA objects at offsets 33..126 (the
preeval'd subscript tables — NOT closures, NOT strings) plus a long tail:
first-8 slots each saw count=1 with 1.96M in "other" ⇒ hot-set cardinality
≫ 8 (why the 4-way shared cache lost). A STRING+'length' short-circuit in
__dyn_get_t_h (landed below in this tree? NO — measured a wash, keys are
NOT 'length'; kept anyway? see commit) did not reduce the 1.07M probes.
THE DESIGN THAT FITS ALL FACTS — per-receiver "runtime-shadowed" bit:
reads on durable receivers must probe the GLOBAL table first only because
a runtime write may shadow the init-time sidecar. Mark shadowing AT THE
RECEIVER: __dyn_set's durable-global route ORs bit0 into the receiver's
off-16 props word (HASH ptr offsets are 8-aligned ≥16 — bit0 is free; a
0 slot becomes 0x1 = shadowed-no-sidecar). The read path loads off-16
ONCE (it needs it for the sidecar anyway): bit0 clear → sidecar only,
ZERO global probes (the 1.07M reads are exactly this class); bit0 set →
global probe (guard __dyn_props root ≠ 0 first — after _clear the root
is 0 and a stale marker must not probe a null root) then sidecar. _clear:
markers go stale (global wiped) — harmless with the root≠0 guard (one
wasted branch until re-shadowed); no healing needed. Exact, per-receiver,
no aliasing, no shared-cache eviction, O(1). Also verify whether the
1.07M probes are HITS or MISSES first (one counter): if mostly HITS the
runtime writes genuinely live in the global table and the win is smaller —
then attack the WRITE side instead (why do subscript's tables take runtime
writes? parse.js:86 \`prec[op] = ...\` placement decides).
CAUSAL CONFIRMATION (probe-doubling, 3/3 interleaved): duplicating the
durable-arm __ihash_get_local call costs +2.7-3.0ms median (+30%) — the
1.07M probes really are ~31% of jessie runtime; the cpu-prof self-time was
RIGHT and the 4-way cache loss (below) is a mechanism failure, not a
mis-attribution. Open puzzle for the next design: why did a 4-entry cache
lose while the probes cost 2.8ms? First measure receiver CARDINALITY
(histogram $off in the durable arm) — if the hot set is >4 (e.g. many
durable receivers with NO global props each caching a 0-sentinel and
evicting each other), the cache needs to be receiver-SIDE instead: cache
the global-table resolution in the durable receiver's own off-16 header
slot at first runtime read (headers are durable; the cached ptr is
ephemeral → needs _clear healing via the existing __durable_slot_log
machinery). That converts the probe to one header load, per receiver, no
shared-cache eviction at all.
4-WAY RECEIVER CACHE — REFUTED (built + interleaved-measured): extending
the 1-slot dyn_get cache to 4 slots (both arms, rotate-evict, dyn_set
matching-slot update, _clear resets) made jessie +8-11% SLOWER, 3/3
interleaved pairs. The 1-slot cache already serves the hot closure receiver
in one compare; the durable-arm __ihash probes are evidently far cheaper
than the cpu-prof self-time suggested. CAVEAT for the whole 94ms reading:
V8 sampling attribution for tiny hot leaf wasm functions is suspect —
re-verify with a counted-cycles harness (helperCounters + wall-time deltas
from selectively nulling arms) BEFORE the next dyn-path surgery. Exact
ihash call split (jessie-attrib3): 1.07M durable-arm + 473k fallback-arm
cache-miss + 398k direct (space_5 Map op) + 127k dyn_set.
LEVER-(a) SCOPING (2026-07-08 probe, scratchpad/dict-micro.mjs): a LOCAL
module-level `let d = {}` with only-dynamic uses ALREADY lowers to
__hash_get_local_h/__hash_set_local — the dict inference exists for simple
bindings. So the 3.7M dyn_get_t receivers are NOT the prec/operators dicts
in the simple case; they're either (i) the EXPORTED table bindings
(subscript `export let prec = {}` — export/cross-module refs may defeat the
inference; verify with the real jessie module graph), or (ii) schema'd
objects taking dynamic reads through the durable __dyn_props global. NEXT
STEP is attribution, not new inference: compile the jessie bench with
helperCallsites:'dyn_get_t' (or helperCounters + per-fn callsite filter)
and read WHICH functions/receivers drive the 3.7M — then pick (a) vs (b).

## Bench-vs-V8 campaign (2026-07-08 state — from 7 losers to 2 modest + 1 hard)
Cool-machine sweep 2026-07-08: shapes 1.11x, immutable 1.69x, wordcount 1.77x,
strbuild 1.07x, dispatch 0.89x WIN, dict 0.85x WIN, json 0.60x WIN,
jessie 5.3x (the hard tail: helper-internal probe bodies). colorpq's parity
column is NOT a regression signal — its checksum hashes raw f64 bits of
Math.pow outputs, jz's own pow polynomial can never bit-match V8's
transcendentals (no gate assertion exists for it; perf ~1.18x).
Landed this leg: 5c2de02 (lazy per-string hash cache: wordcount 1.91->1.7x,
kernel A/B 0.986), d35bba1 (devirt sid-cache + discriminant collapse + tee
hoist: shapes 3.9->1.11x, immutable rode along), 2365e36 (in-place
replace-stores via whole-program alias sweep: immutable 3.2->1.7x).
WASM_TODO in test/bench.js carries the per-case lever notes (vs wasm rivals);
this list is the V8-specific gate.
- **colorpq — CLOSED to 1.20x** (f9caa74): fractional const-global reads now fold
  to literals at readVar (only ints were cached), so emitPow's constant-exponent
  arm fires (pow → inline exp(c·log x)) and the PPC vectorizer pairs into TRUE
  2-lane log_v/exp_v. 38 runtime-pow calls → 0; 113.6→69.9ms, checksum unchanged.
  Residual 20%: scalar tail + sign-select; possible fused exp2_v(y·log2_v x)
  kernel saves the ×ln2 round-trips. Note: watr cse can't dedupe across INLINED
  copies (per-splice temp names differ) — rename-aware GVN is the general answer.
- **strbuild — flipped to 0.978x** (rode the const-fold).
- **dispatch 1.17x** — one call_indirect over a CONST 8-arrow table, data index.
  The AOT answer: watr devirt resolving f64.load(static_addr + idx*8) against the
  DATA SEGMENT (const fn-array = baked closure boxes) → br_table over 8 direct
  calls (bounds+sig checks gone; tiny bodies then inline). Seed machinery: the
  5.2.2 hoisted-index devirt. Same class as `shapes` tag-switch.
- **dispatch — CLOSED to 0.925x** (d9418b7): const-fn-array indexed calls lower
  to br_table of direct calls (AOT polymorphic IC), call_indirect default arm.
- **wordcount 3.8x — DESIGNED, ready to build**: helper-counter profile shows the
  RMW `counts[w] = (counts[w]|0)+1` pays EVERYTHING twice (str_hash 14.0M = 2/op,
  dyn_get 6.8M + dyn_set 6.8M, str_eq 6.6M). Fix the CLASS: fuse `o[k] = f(o[k])`
  (hash-typed receiver, pure o/k, rhs reads same key) into ONE probe:
  1. kernel: `__hash_slot(coll i64, key i64) -> i32` — genUpsert's exact machinery
     (grow + zombie probe + insert-on-miss, value seeded UNDEF) returning the VALUE
     SLOT ADDRESS. Sound because the BOX never changes across growth (forwarding
     header; __ptr_offset_fwd resolves) — genUpsert already returns coll unchanged.
     Return 0 on type-guard fail -> caller falls back to generic dyn_set.
  2. emit-assign arm: detect `['=', ['[]', o, k], rhs]` with rhs containing
     structurally-equal PURE `['[]', o, k]`; emit kT/oT once, slotT = __hash_slot,
     bind old = f64.load(slot) to a temp, substitute the rhs reads with the temp
     NAME (readVar picks the local; `|0` ToInt32 of UNDEF box -> 0, semantics
     preserved), store result to slot, yield it. Expect ~2x -> ratio ~1.9.
  Then: heap-string hash memo (words recur 6.8M times over 512 objects).
- **wordcount — CLOSED to 1.77x** (b013782 then 5c2de02): dictionary-mode {} +
  fused RMW `o[k]=f(o[k])`, then the lazy per-string hash cache
  (STR_HCACHE_BIT: concat/append/slice-materialized strings allocate
  [hash=0][len][bytes], __str_hash fills the cell on first hash — 2.19M cache
  hits / 183 cold fills per run; bump-extend mutators zero the cell).
  jessie counter-verified INDIFFERENT (hit=0 — all its non-SSO hashing is
  interned statics). Residual vs V8: probe-loop + str_eq constant factors.
- **shapes 3.6x — DESIGNED**: schema-set devirt at property reads. New
  program-facts lattice: per-param/binding CANDIDATE SCHEMA SET (monotone union,
  bounded <=16, poison on overflow — extends the existing single-sid
  inferSchemaId/arrayElemSchema facts). Emit `o.x` with a schemaSet fact as:
  sid = aux bits of the box -> br_table over candidate sids -> arm = direct
  f64.load(off + slotOf(schema_k,'x')*8) or UNDEF when schema_k lacks x ->
  default arm = generic __dyn_get (alien schema, always sound). Same toolkit as
  the dispatch devirt (d9418b7): bounded candidates + br_table + generic default.
  ~6 ops/read vs the ~50-op megamorphic __dyn_get_any_t_h probe; 23 sites in the
  bench. Bench guards reads by `o.k`, so arms are dead-branch-prunable later
  (flow refinement), but the flat switch alone should close most of 3.6x.
- **shapes — CLOSED to 1.11x** (2159fa6 then d35bba1): schemaId br_table devirt,
  then receiver-stable sid cache (a never-written receiver's sid is constant —
  compute `sid|-1` once, entry-hoisted select for ≥2 reads / inline for 1;
  -1 wraps u32-huge into br_table's default so the tag guard is free) +
  discriminant-field collapse (prop at the SAME slot in every schema →
  `(u32)sid < count ? load : generic`, no dispatch — o.k was a full
  megamorphic probe 37.7M times/run, THE dominant cost) + pure-tee hoisting
  (foldSetToTee/cse tees in call operands extracted to standalone sets so the
  hottest read no longer bails the purity check). kernel A/B 0.997.
- **immutable — CLOSED to 1.69x** (2365e36): in-place replace-stores landed
  exactly per the spec below; residual is the guarded load + V8's young-gen
  cache warmth. Sweep + emit as designed, plus two spec deltas discovered
  in the field: (a) node identity AND enclosing-function name don't survive
  plan→emit (body transforms + emit-time inlining splice frames), so sites
  are content-keyed `receiver|flat-literal` with a program-wide meet;
  (b) exported functions have no paramReps — elem facts derive from internal
  call sites (zero internal callers ⇒ host-only ⇒ marshaled copies can't
  alias). Pinned in test/inplace-store.js (fires+bit-match, alias-after-store
  rejected, leaked-element rejected, runtime-alien falls back).
  ORIGINAL SPEC (implemented): in-place replace-store
  `arr[i] = {lit}` overwrites the old element's slots instead of allocating,
  when a whole-program sweep proves no alias can observe it. Design:
  (1) SWEEP (new src/compile/inplace-store.js, called post-narrow from
  compile/index.js when facts are final): walk every function; for each
  element-read site R on an array whose elem could be a schema object (skip
  NUMBER/typed-elem arrays via arrayElemValType/typedCtor facts): classify R
  as (a) immediate `.prop` receiver (atomic, safe), (b) init RHS of a
  single-decl binding whose uses are ALL MEMBER_R (field reads — record
  (fn, sid) alias), (c) anything else = LEAK -> poison sid (unknown sid ->
  poison all). Candidate stores: statement `arr[i] = {staticLit}` where
  repOf(arr).arrayElemSchema == sid(lit) and all lit values NUMBER (durability:
  no eph pointers stored into durable receivers). Candidate valid iff sid
  unpoisoned, every recorded alias (fn', sid) has fn' == candidate's fn
  (a cross-function alias could live across the call into the store's fn), and
  within fn every alias binding's LAST use precedes the store statement
  (positional walk; aliases are per-iteration block-scoped so next-iteration
  reuse is fresh). Emit `ctx.schema.inplaceStores = WeakSet<literalNode>`.
  (2) EMIT (emit-assign.js, new arm before arm 7): spill lit field values to
  f64 temps IN SOURCE ORDER (they may read the old element: swap case); spill
  eT = emit(arr[idx]) box; guard `(bits(eT) & HI_MASK) == OBJ|sid prefix`
  (OBJECT_SCHEMA_HI_MASK pattern, emitSchemaSlotGuarded, module/core.js):
  fast arm -> f64.store old slots from temps, result eT (same box IS the new
  object — array store elided, identity preserved); else arm -> __alloc_hdr +
  slot stores + mkPtrIR(OBJECT,sid) from the SAME temps + existing
  storeArrayPayload (OOB/UNDEF/alien-schema elements all land here ->
  bit-exact generic semantics). Wins: kills 131k allocs/pass (6.3MB heap
  churn -> 0, cache-warm 4096 objects); identity change unobservable because
  the sweep proved no live alias.
- **jessie 5.0x — PROFILED** (per run: 8.1M ptr_offset, 4.1M dyn_get_t_h chain
  + 3.9M str_hash, 2.1M ihash_get, 1.1M alloc each ENTERING __memgrow). Chain-
  frame flattening (skip __dyn_get/__dyn_get_t for proven-string keys) measured
  ZERO — V8 wasm calls are cheap; the cost is INSIDE: probe+eq bodies, per-read
  str_hash, and __ptr_offset's forwarding-follow branch 8.1M times. Real levers,
  in order: (1) receiver-stable offset caching — subscript's dispatch tables
  never move; hoist __ptr_offset out of read sites per receiver (the existing
  hoistGlobalPtrOffset class, extended to locals/params); (2) string hash memo
  for heap keys + prehash literals at parse-table BUILD time; (3) __memgrow
  call-per-alloc — move the grow check inline into __alloc's fast path.
  Each is kernel-wide (helps jz.wasm compile times too, not just the bench).
  LEVER 3 DONE (a633659): __heap_end byte watermark — jessie 8765->8500us,
  kernel A/B 0.976. Lever 1 refined: the 8.1M ptr_offset calls live INSIDE
  helper bodies (dyn_get_t_h's receiver+sidecar resolves) — jz-site hoisting
  can't reach them; needs either a generation-stamped receiver cache in the
  helpers (extend __dyn_get_cache_*) or fwd-free inline extracts for the
  never-forwarded kinds (OBJECT, string keys) with the follow only for HASH.
  Lever 2 refined: __str_hash already caches interned heap strings (off-8) and
  fast-mixes SSO; the gap is runtime-BUILT heap strings never get interned —
  intern-on-first-hash (insert into the intern table when STR heap key first
  hashes) gives every later hash the cached read. jessie keys are mostly SSO,
  so this lever belongs to wordcount's 7-8 char words more than jessie.


## Arch analysis triage (compile time / size 2x — RE-RE-RANKED on 2026-07-08 frozen-sim evidence)
MEASURED (crc32 @speed, warm, 9-run median): full compile 95.3ms; with
optimize:{watr:false} 23.1ms — **watr's optimizer is 72ms = 76% of compile**.
jz-side optMod:optimizeFuncs is 14ms (secondary), pullStdlib parse 1.3ms,
watrCompile encode 2.9ms, everything else ≤3ms.
(1) **build-time-compiled stdlib — REFUTED by direct simulation.** Two probes
    (scratchpad sim-bake.mjs / JZ_SIM_FROZEN crude-frozen hack): (a) splicing
    stdlib bodies pre-optimized to watr's function-local fixpoint changed
    watOptimize 72.1→67.2ms (1.07x) with near-byte-identical output; (b) a
    full "frozen" sim (dirty-seeded rounds + module/finish passes skipping
    std funcs) saved only ~4-9ms on crc32 AND json. Root cause: the cost is
    WALK+user-work, not std-work — inlineOnce dissolves stdlib bodies INTO
    user funcs, so their nodes get optimized under user labels regardless
    (json frozen profile: r1-r3 propagate:USER = 28ms). Identical input
    bodies ≠ skippable work; the work product is program-specific. Compile
    ÷4 does not exist here; ceiling ≈1.2x for heavy bake+frozen machinery.
    (Bundle ÷2 via template replacement is a separate, weaker, still-open
    size idea.) Foundation facts kept for the record: pre-watr stdlib bodies
    ARE 34/36 cross-program byte-identical (116KB); post-watr only 22/26.
(2) **watr optimizer engine is the re-ranked lever** (frozen-sim profiles,
    instrumentation patch: scratchpad/watr-prof-instrumentation.patch):
    - [x] propagate walk fusion — LANDED watr bbcb318: substGets logs writes
      during its own recursion, killing the 4 extra full-subtree walks per
      statement (clone+equal, sibling staleness, known-map staleness,
      writesMemory). Output byte-identical corpus-wide + kernel.
    - [x] size-guard encodes — LANDED watr bbcb318 (`guard: false` opt) + jz
      speed presets (`watrGuard: false` → watrOpts.guard). L2/size keep the
      never-inflate guard. Byte-identical on the corpus (guard never unwound).
    - Combined measured: watOptimize crc32 78→58ms, json 110→97, raytrace
      74→61, wordcount 114→96; END-TO-END compile crc32 99→85ms (1.17x),
      json 158→140 (1.13x), raytrace 130→112 (1.16x), wordcount 163→136
      (1.20x). Kernel A/B 0.9949 (kernel embeds watr → compiles faster too).
      Activates when watr >5.2.3 publishes (option is a no-op on 5.2.3).
    - [x] cse memoized bottom-up facts — LANDED watr da24c0e. O(n·depth)→O(n)
      collection; byte-identical; kernel-module optimize ~1%, medium neutral.
    - [x] inline simdOnly prefilter — LANDED watr b06ff0c (2-5ms/module).
    - [x] SELFHOST BUILD: watrGuard:false in scripts/selfhost-build.mjs —
      kernel watOptimize is 70s of the 83s build; the guard's two encodes of
      the 6.6MB kernel = ~12s (CPU profile: instrSize 7.4s + localidx 2.2s +
      codeItemSize 1.0s + idx helpers). Build 83.4s→69.6s. Kernel +3.7KB
      (+0.06%, the inflation the guard used to revert); kernel A/B 1.0055 =
      sub-noise; selfhost 20/20, pins/goldens green.
    - [x] convergence hash — LANDED watr 7c5a093: hashNode (53-bit rolling
      structural hash, zero allocation) replaces hashFunc's full serialized
      string in runRounds; token stream replicates hashFunc exactly (export
      skip, L-canonicalization) and was differentially verified (zero verdict
      mismatches, kernel + corpus). +2-5% medium modules.
    - dedupe per-round key memo — REFUTED: WeakMap(contentHash→canonKey)
      memo was neutral-to-worse on kernel AND medium modules; funcs churn
      every round (propagate/coalesce rename), so the memo misses and pays
      hashNode on top. Same churn argument likely kills the tallyLocals
      memo idea. NOTE: kernel byte drift across watr edits is EXPECTED —
      the kernel embeds watr's optimize.js as module m122; only behavior
      divergence matters (differential harness pattern in scratchpad).
    Remaining (kernel profile, self-time — the honest column; totals for
    recursive fns are analyzer-inflated):
    - walk/walkPost visitor overhead 17s/70s kernel — the structural floor;
      specialization territory (per-pass fused walkers). Diminishing-returns
      territory: remaining kernel cost is genuine work on ~6k churning funcs.
    - tallyLocals (countLocalUses) 2.9s kernel — per-func recount each
      propagate entry per round; see churn caveat above.
    - coalesceLocals in rounds ≈24ms/module — REFUTED removing it from
      rounds (crc32 −4.5ms but json/wordcount +6ms, size wobbles): it earns
      its keep mid-rounds. Win must come from making it cheaper, not rarer.
    - inlineOnce candidate scan 7-9ms/module.
    These are generic engine fixes (help every watr user + every jz tier).
(3) watr encoder local-decl grouping — DONE jz-side (sortLocalsByUse).
csePureExprLoop/cseScalarLoad stay — prototypes for the watr CSE port
(pure-call CSE landed upstream 6e659de; local-alloc gap vs wasm-opt open).

## Compiler backlog — deferred-on-no-workload (YAGNI: build when a real bench surfaces the shape)
All ranked-ROI optimizer items shipped (Archive); since then extending-add (`f5213cb`),
scalarization cap 32→64 (`087dc56`), and the dead-code/interop hygiene tail also landed —
moved to the 2026-06-16 drain entry in Archive. What remains is speculative — adds
correctness risk for zero measured benefit:
- [ ] **Stdlib-pull audit** — walk `module/*.js` for builtins emitting a polyfill where
  wasm-v1 has a native op / cheap fold (the `**0.5→sqrt` win, generalized). Gate on the
  builtin actually appearing in a kernel. Owner: module/math.js (+ siblings), test/math.js.
- [ ] **Representation carriers** (design: .work/research.md) — jsstring internal-locals flow;
  boundary string cache (interop.js, by identity); schema-object field packing (i32/ptr, not
  f64-tag); typed-array element rep (auto Int32Array backing); closure-capture narrowing (i32
  cell, not nanbox). Each blocked on a converging carrier fact + no current workload;
  regression risk > theoretical win.
- [ ] **form-normalization folds** (lint) — `parseInt(intLit)` fold; `x=x` drop; `s+""` drop
  (only when statically STRING); `no-useless-return`. DCE-adjacent; defer until one is hot.
- DON'T chase (refuted/calibrated): PS-3 wasm-opt slack gate (matches measured); OPT-B/C
  (watr-off only fires when optimize==null; vectorize is L2-default + opt-out-able). Size
  reality: hand-WAT 3–8× smaller is structural (generic helpers); realistic ≈1.5–2× with
  `alloc:false`+`optimize:'size'`, NOT byte-parity.

## Future
- [ ] Component interface (wit).
- [ ] **threads/atomics** — lower `Atomics.*` on shared typed arrays → wasm atomic ops;
  `memory:{shared:true}` → shared Memory + `(memory … shared)`; worker spawn stays host-side
  (same boundary discipline as I/O). Large; verify a real workload first. Vectorizer +
  shared-memory substrate already exist. SCOPED 2026-07-10: v1 plan + missing-pieces +
  single-writer audit list in `.work/extension-surface.md` §Workers (promoted into the
  Language-coverage plan — typed-array-SPMD v1 dodges the stdlib audit).
- [ ] memory64 (>4GB); relaxed SIMD; WebGPU compute shaders.
- [ ] **wasm-gc backend** (`host:'gc'`) — orthogonal multi-month backend rewrite (engine GC +
  typed refs); benefits memory-model / externref / debugging, NOT boolean discrimination
  (landed carrier resolves that in wasm-v1). Reserved error today (index.js:315).
- [ ] **Insertion-order Set/Map** — open-addressing iterates slot-order; ES mandates insertion
  order. Needs a per-entry `seq` or sibling order-list. Documented divergence in test262 xfail.

## Ideas
  - [ ] webpack/esbuild/unplugin — extract & compile fast pieces with jz.
  - [x] jz as a compilation target — DSLs emitting jz-compatible code get WASM for free.
  - [x] template tag as a build tool — jz`code` in a Node script replaces a build step.
  - [ ] AS integrations/plugins (assemblyscript.org/built-with);
  - [ ] potrace playground.
  - [x] dithering algorithms — `examples/dithering` (threshold/Bayer/Floyd–Steinberg/Atkinson over a shaded sphere).
  - [ ] EdgeJS test/harness entry — only if it runs in their CI without large/optional deps.

## Demos / visualizers: ideas for no-gpu graphical uses

  - [ ] Screensavers
  - [ ] NFT
  - [ ] Instagram minimalism/etc renderers
  - [ ] xor shaders
  - [ ] Demoscene
  - [ ] winamp visualizers
  - [ ] Various (classic) audio visualizers
  - [ ] Wave osc visualizers
  - [ ] DAW play visualizers (pitch bend etc)
  - [ ] Musical visgens (windchimes, physical etc)
  - [ ] ASCII renderers
  - [ ] SVG visualizer?


---

## Archive

### Verifier-surfaced deopts (absence-of-overhead gates, not benches)
The structural-invariant verifier (`test/wat-invariants.js`) sweeps the fuzzer's
i32-disciplined sublanguage and flags any f64 / un-hoisted pointer op inside a loop —
waste the net-output bench can't see. Two real gaps it surfaced, now ratcheted so they
can't worsen and visibly shrink when fixed:
- [x] **Nested-conditional int narrowing + dead `__static_str` pull** — CLOSED (13 → 0).
  Two fixes: (1, prior) toI32 distributes ToInt32 through `(if result f64)` recursively, so
  nested integer `?:` chains narrow to `(if result i32)` (13→2). (2, this round) the last 2
  residuals (typed-int seeds 28, 73) were NOT user-loop deopts — a mixed number/boolean
  ternary `(c ? num : num>k)` lost type precision (`VT['?:']` returned null when branch
  kinds differed), so the enclosing `+` emitted the polymorphic string-concat dispatch on
  pure-numeric operands, pinning the whole number→string formatter (`__str_concat` →
  `__to_str` → `__static_str`, all f64 dtoa loops). A pure-int program ballooned 1 → ~19
  funcs. Fix: `VT['?:']` (src/kind.js) now mirrors the `&&`/`||`/`??` BOOL-coercion rule —
  a boolean branch coerces in numeric context, so `num ? : bool` carries the non-bool type.
  Repro `a[i] = ((a[i]-((a[i]<=2)?a[i]:a[i])) + ((a[i]===255)?a[i]:(a[i]>2)))|0`: 19 → 1 func,
  no `__static_str`. Verified: scalar fuzz 4000 / typed-int 1000 / typed-map 600 × opt{0,1,2,3}
  all 0 divergence. Gated: test/wat-invariants.js `absence:` (no number→string formatter in a
  pure-int program) + typed-int sweep promoted to hard-zero.
- [x] **Param typed-array base re-decode** — DONE (speed tier). A typed array passed as a
  PARAM (`(buf,n)=>{ for(i<n) buf[i]=f(buf[i],i) }`, JZ's flagship DSP shape) re-decoded
  its NaN-box base every iteration because the polymorphic store reassigns `buf`, marking
  it unsafe to hoist. `unswitchTypedParamLoop` now tests `is buf Float64Array?` ONCE before
  the loop → a base-hoisted f64.load/store fast loop the lane vectorizer lifts to f64x2;
  every other type falls back bit-exact (test/unswitch-typed-param.js). Speed-only (it
  duplicates the body — size↔speed). NB: the perf-ratchet `buf` baseline (3861) measures
  optimize:2, where the param path stays dynamic by design — it does NOT drop when the
  speed-tier win lands (vectorization RAISES static op count); the win is pinned
  structurally, not by op count. At 'speed', 34/40 buf-corpus programs vectorize (0/40 at opt2).
- [x] **narrowLoopBound `i <= n`** — DONE. Surfaced by the AS-canon bias audit; factorial
  (`for i=2; i<=n; i++`) kept a per-iteration `f64.le(convert(i), n)`. Now snaps the bound
  via floor with a NaN→I32_MIN guard (`trunc_sat(floor(NaN))=0` would wrongly run i=0;
  JS `i<=NaN` is false → 0 iters). First hardened test/fuzz.js with `fuzzLoopBound`
  (param-bounded loops over NaN/±Inf/-0/fractional — the CONSTANT-bound generators never
  covered this), THEN extended the pass (src/optimize/index.js). Pinned:
  test/wat-invariants.js `<= narrowed` ablation + fuzzLoopBound (3000 seeds green).
- [x] **narrowLoopBound: SCEV-shaped counters (bench/sieve `i*i`)** — DONE. `for (i=2; i*i<LIMIT;
  i++) for (j=i*i; j<LIMIT; j+=i) …`: `i*i` is f64 (the integer-overflow contract), making the
  outer bound, the inner counter `j`, and the index chain f64. New plan-phase pass
  `narrowBoundedSquare` (src/compile/loop-square.js) rewrites `i*i` → `Math.imul(i,i)` (→ i32.mul)
  when the guard is `i*i </≤ CONST` with CONST ≤ 2³⁰ (literal OR a module const via
  ctx.scope.constInts — the bench's `1<<20`) and the IV is +1-incremented and not otherwise
  mutated. The inner `j` cascades to i32 on its own. SOUND incl. the EXIT-OVERSHOOT trap (i*i
  computed before the `<` test can exceed 2³¹ for larger bounds): ≤ 2³⁰ keeps the exit product
  < 2³¹, so `Math.imul == i*i`. Verified bit-exact vs JS incl. the 2³⁰ boundary (iteration-count
  loops, no 4GB array) + 100k-sieve (9592 primes); soundness boundaries pinned (bound 2³⁰+1 /
  variable / non-+1 step / mutated IV all stay f64). Pinned: test/loop-square.js. The AS-canon
  audit now PASSES (sieve cleared). Off at L0 / `loopSquare:false`.
- [x] **Pipeline under-converges on vectorized reductions** — DONE (hot-path). The post-phase
  lane vectorizer (runs AFTER fusedRewrite's memarg fold) emitted `v128.load/store (i32.add
  base K)` for the unrolled multi-accumulator reduction, keeping a per-iteration i32.add per
  accumulator. Fix: `foldV128Memargs` runs right after `vectorizeLaneLocal`
  (src/optimize/index.js), folding K into `offset=` — same logic/soundness as the scalar
  MEMOP fold. dot loop-body 84→72, sum 94→88; the fixpoint audit is now 10/10 LOOP-body
  fixpoints. A REJECTED global cleanup-pass alternative (don't re-try) over-reshaped loops +
  cost compile time; the targeted fold is surgical. The residual whole-module deltas the
  audit shows (dot −6, clamp −8) are watr `brif` (block+br_if→if/then, SPEED-NEUTRAL) +
  module-level inlineOnce that jz deliberately skips — not hot-path waste (audit now
  classifies real-vs-neutral loop ops). Stencil test made robust to the fold (test/simd.js:
  `!/v128.store/` instead of the stale `!/v128.load offset/`). Verified: all typed fuzzer
  modes × opt{0,2,3} 0 divergence; full suite green.

### Examples polish pass + 2 new demos + a per-pixel-color miscompile fix (2026-06-19)

A sweep through the gallery for correctness, interaction and perception, plus the one real
compiler bug it surfaced. Each example bit-exact JS⇆jz where applicable; browser-verified.

* [x] **domain-color rendered solid black under jz** — root cause was a `tryPerPixelColor`
  miscompile, NOT the example: `let fx=0; if(denom>ε){fx=…}` lifted `fx` to an f64x2 lane local
  (splat 0) while the statement-form `if` landed in the SCALAR epilogue, so the lifted
  `hypot(fx,…)` — emitted before the epilogue — read the stale splat(0) → all-zero. Fix:
  `tryPerPixelColor` now bails to scalar when a lane local is re-written in the epilogue AND
  consumed by another lane (`src/optimize/vectorize.js`); rewrote the kernel to an unconditional
  safe-denominator divide (vectorizes correctly + poles flare white); de-vacuumed the example test
  (it called `frame(0)` where both paths were coincidentally zero). Regression pinned in
  `test/simd.js` (`COMPLEX_FIELD`, proven to fail without the bail).
* [x] **Stale wasm** — fern / attractors / bifurcation shipped `.wasm` from before the last
  compiler commit; rebuilt (fern is actually faster in jz). **bifurcation** also had auto-SIMD
  *hurting* its memory-bound `Math.log` tonemap → replaced with a precomputed LUT (bit-exact, par
  with V8, no harmful lift). **ising** "looked like noise" — dynamics were fine, the default T just
  sat at/above Tc; retuned to start cold and breathe across Tc so domains nucleate visibly.
* [x] **Fractal family pan/zoom** — julia drag→pan + c auto-morphs on the 0.7885 circle; newton
  gained view params, drag-pan and an auto-swirling `a`; buddhabrot uses a decaying accumulator so
  the nebula refines into the new view instead of flashing black; apollonian fixed a genuine
  geometry bug (central Soddy circle's curvature wrongly folded in the outer circle → it *crossed*
  the inner circles; now `k₁(3+2√3)`) + its dead pan (double-normalized `ptr.x`).
* [x] **Misc** — cradle: positional rigid-chain constraint so dragging a middle ball *pushes* its
  neighbours; phyllotaxis: smaller dots; ulam: re-walks the whole spiral per frame (meaningful ms,
  ~30× faster reveal); wireworld: randomized layout from canonical parts, pure-black bg, **pencil
  tool** (drag to draw per-pixel conductor wire, right-click sparks an electron); chladni: framed
  with green x/y standing-wave strips (the components it superposes) + note readout.
* [x] **Two new examples** — `dithering` (one shaded sphere, four 1-bit dithers) and `hydrogen`
  (|ψₙₗₘ|² electron clouds in phase color, cross-dissolving 1s→…→4f). Registered in `examples.js`
  with thumbs + wiki links.


## Marketing / landing-page — audience-driven (full research → `.work/marketing.md`)
Goal = **real adoption** (kernels shipped with jz), channel = **page + repo only** (README/npm/page
ARE the distribution). Personas to optimize the page for: **#1 Web-Audio/DSP authors (highest fit,
currently invisible on the page)**, #2 JS-library authors (blocked by "fits my build?"), #3 creative
coders (already over-served — don't add more). Ignore for the page: edge/JS13K/Porffor/compiler-curious
(reachable but low real-adoption conversion). Verified: hero toggle is an honest **11.8×** jz win
(grid-current frame, 6×2000 @1360×560) — safe to lead with it as proof.

Done this pass:
- [x] **Meta description bug fixed** (`index.html`) — was "beats Rust and Zig → wasm" but bench
  targets are NATIVE (`rustc -C target-cpu=native`/`zig -O ReleaseFast`) and jz loses 7/20 Rust cases.
  → "Over 2× faster than V8, trades blows with native Rust and Zig". (drops the drift-prone 2.4× too.)
- [x] **`<title>` → SEO-first** — "jz — JS→WASM compiler for numeric code (DSP, audio, math)".
- [x] **H1 → benefit/persona-first** — "Your numeric JS, compiled AoT to WASM" (kept your `<br class="hb">`
  + AoT; avoided "native-speed" as a slight overclaim — let the metrics/live demo prove speed).
- [x] **FAQ +3 entries** — "Does it fit my build pipeline?" (honest no-plugin-yet), "What JS semantics
  differ?" (f64 / UTF-8 bytes / no-GC + link), "Can I debug it?" (console.log / --names / --why-not-simd).
- [x] **Footer copy de-duplicated** (FIXME resolved) — "The slow 10% … the other 90% stays the JS you wrote."
- [x] **npm `description` + keywords** broadened (numeric, signal-processing, audio-worklet, math,
  js-to-wasm, performance) — `jz` is unsearchable, so metadata carries discovery.
- [x] **README first-screen hook** — use-cases + no-annotations/no-lock-in above the fold.
- [x] **GitHub repo** — description set; topics filled to the 20-cap (+numeric, signal-processing,
  audio-worklet, js-to-wasm, math, performance, functional). Social-preview image still TODO (manual).
- [x] **bench/README.md credibility fixes** (verified from results.json): callback 27.56×→2.26× (was
  10× off), tokenizer "AS wins" (FALSE — jz now 0.84×), aggregate "smaller than AS" (FALSE — jz ~1.1×
  larger) + V8 0.41→0.43 / AS 0.40→0.36, audio showcase refreshed (blur 9.4×, bytebeat 3.7×, synth→2.0kB),
  poly 6.2→12.9×, json 1.7→1.3×, summary ranges, watr "only case"→+jessie, +alpha honesty bullet.
- NOTE: **hero sub left as-is** (your terser rewrite + `.sb` hook) — NOT overridden. Recommendation
  stands: foreground "valid jz is valid JS / no lock-in" + name DSP in the sub; your call.

Next — page LAYOUT (yours; ready-to-paste markup handed over in chat):
- [x] **Caption the JS/JZ toggle**: "Same source. Flip to compile it to WASM." (strongest proof; unlabeled = decoration).
- [x] **Move `npm install jz` chip into the hero** (`.pleft`, under the sub); wire its copy handler like `install2`.
- [ ] Name the AudioWorklet use case with a real DSP demo above the fold (biquad/minisynth + toggle).

Next — repo:
- [x] **Finish bench/README.md regeneration** — biquad/mat4/bitwise/aos/mandelbrot/sort/crc32 per-case
  tables are still an OLDER snapshot (mostly UNDERSTATE current jz). Best fixed by a generator
  (`scripts/bench-readme.mjs` reading results.json): `npm run bench` would DROP zig/go (not installed)
  and degrade results.json, so regenerate the doc FROM results.json, don't re-run the bench.
- [x] **GitHub social-preview image** (manual upload via repo Settings → every shared link unfurls with the pitch).
- [x] Stop hardcoding the speed multiple in static copy — meta fixed; in-page metric prefills are
  live-bound from results.json (self-correct), so left as-is.

(The two highest-leverage non-copy moves for real adoption already live below: **unplugin-jz** and
**dogfood own libs** under "Reach — perception/proof". They outrank every copy change combined.)


- [x] **AoS→SoA layout transform / f64x2 deinterleave** — WON'T BUILD, measured net-negative
  (2026-06-14). The `aos` bench IS the workload, and both SIMD forms are *slower* than the
  current optimal scalar on wasm's 128-bit SIMD (hand-WAT, N=16384×64, arm64/V8):
  AoS deinterleave (3×`v128.load` + 3×`i8x16.shuffle` per 2 rows) = **0.78×**; SoA contiguous
  (no shuffle, the layout-transform best case) = **0.92×**. The kernel is memory-bandwidth-bound
  — 2-wide SIMD moves the same bytes, so halving the instruction count doesn't help and the
  deinterleave shuffles only add cost. V8 lowers wasm `v128` to 128-bit SSE/NEON (2 f64 lanes),
  never 256-bit AVX2, so native's AVX2 4-lane deinterleave is structurally unreachable in
  portable wasm. jz scalar already beats Rust on `aos` on arm64 (0.97 vs 1.23 ms); the x86-EPYC
  gap is the AVX2 width ceiling, not a missing pass. The `simd-aos-stride` advisory stays as the
  only "answer"; don't build the transform.
- [x] Find all unlucky deopt cases and compare perf against JS: should not be 18x slower
  — Probed every generic-dispatch shape vs V8 (`.work/deopt-probe.mjs`). Ranked: **for-in
  was the cliff** (8–9×, scaling with key count = the "18×" class) — it lowered to a
  per-iteration `Object.keys` ALLOCATION + dynamic `o[k]` get, and leaked unboundedly
  (OOM). Now: (1) for-in over a static schema **unrolls** with key-literal substitution so
  `o[k]` folds to a schema slot (`unrollForIn`, recognized via the for-in-exclusive
  `__keys_ro` intrinsic, `src/compile/emit.js`) → **0.40× (2.5× faster than V8)**; (2) when
  it can't unroll (break/continue, closure capturing key, computed-write object) the key
  array is a **pooled static constant** (`__keys_ro`, `module/object.js`) — never a
  per-iteration alloc. Gated on a new precise `dynWriteVars` fact (computed-key WRITES add
  enumerable keys; reads/dot-adds don't — `program-facts.js`). Remaining dynamic shapes:
  `obj[k]` read 1.7× / write 1.9× (genuine dynamic keys — use a Map), plain-`[]` index 3.4×
  (use a typed array). Detector: `test/forin-deopt.js` (differential sweep + codegen pins +
  alloc-free behavioral pin). Also fixed a real bug: `memory.reset()` clobbered module-global
  heap objects (rewound below them) — now rewinds to the post-init mark (`interop.js`).
- [x] Verbose flag? Or at least - deopt warnings
  — Emit-site `deopt-*` advisories (truthful: fire only when a slow path is actually
  emitted, so an unrolled for-in / vectorized loop never false-warns). `warnDeopt`
  (`src/ctx.js`) with source loc + fn name: `deopt-dyn-read` (`o[k]`→`__dyn_get`),
  `deopt-dyn-write` (`o[k]=v`→`__dyn_set`), `deopt-method` (unknown receiver→`__ext_call`
  host round-trip). Joins the existing `deopt-generic`. Tests in `test/warnings.js`.
- [x] bench: remove interpreters; replace -> with arrow unicode; add 4 more MOST STANDARD bench cases across langs: fft, zzfx (some minisynth - audio pipeline), stdlib.io something, standard not-small bytebeat, some image pipeline, some codec maybe like wav or aiff?; hide watr, jessie, jz cases; beat everyone by speed and size, esp audio
  — Removed CPython/QuickJS/Hermes/Javy (bench.mjs + index.html + README + bench.yml); kept NumPy + Static Hermes as native refs. `JS -> WASM` → `JS → WASM`. Hid watr/jessie/jz from page + SVG geomean (`HIDDEN_FROM_GEOMEAN`; still runnable + gated). Added 4 cross-language bit-exact cases (js/c/rs/zig/go/as each): **fft** (radix-2, transcendental-free Taylor twiddles — jz ties native, 1.26× V8), **synth** (poly-osc+ADSR+biquad — jz FASTEST of all incl native, 1.42× V8), **bytebeat** (integer 8-bit PCM — jz 1.48× V8), **blur** (RGBA box blur — jz 2.78× V8). zzfx-as-is can't be cross-lang bit-exact (Math.sin differs per libm) → in-source poly minisynth substitutes. SVG geomean: jz beats every engine incl native (Rust 1.13× Zig 1.29× Go 1.79× Bun 1.70× V8 2.42× AS 2.34×). Fixed a real jz vectorizer bug en-route: sibling loops lifting the same source local emitted duplicate `$name__v` decls → "Duplicate local" crash on fft (`src/optimize/vectorize.js`, dedupe at splice; regression-pinned in `test/simd.js`). Codec deferred (4 cases delivered). Native auto-vectorizes the two stateless integer kernels (bytebeat/blur) — honest floor; jz still doubles the JS field there.
- [x] performance svg image should not confuse: we need a line that it's geomean from N examples or something. JZ should have underline O3, not -> wasm.
  — footer caption "geometric mean across N benchmark cases · lower is faster, jz = 1.00× baseline"; N drives BOTH the caption and the Porffor "runs k / N" denominator so they can't disagree (live run: `geoCases.length`; offline snapshot: `SNAPSHOT_N`). jz sub-label `→ wasm` → `-O3` (parallel to clang/rustc/asc -O3 — jz compiles at its L3 `level:'speed'` tier). CI already regenerates bench.svg on push-to-main (`bench.yml` full `--json` run → `git add bench/bench.svg`). `scripts/bench-svg.mjs` + `bench/bench.mjs` SVG_TARGETS; pinned by `test/bench-svg.js`.

### Module-level numeric tables drop the string runtime (2026-06-16)

The synth bench was 4.2× larger than AssemblyScript (7.7 KB vs 1.8 KB) — the worst size gap
in the corpus, and the audio flagship. Root cause: a module-level numeric `const` table
(`const FREQS = […]`, `const CHORDS = [[…],…]`) had untyped ("any") element reads, so
`T[i] * x` emitted the generic `__to_num`, dragging the full ~5 KB string-parse battery
(`__to_str`/`__skipws`/`__char_at`/`__pow10`/…) into a string-free kernel. Element typing
existed for function-local arrays; module globals were invisible to the using function's walk.

* [x] **Flat `const T = [n, …]`** (`45396e7`) — `recordGlobalRep` records `arrayElemValType`
  on the global rep; `VT['[]']` reads it (dynWriteVars-guarded). synth **7.7 KB → 2.0 KB**
  (3.85×); render 1260 → 373 WAT lines; the string stdlib drops out entirely.
* [x] **Nested `const C = [[n, …], …]`** (`c899064`) — the floatbeat chord/pattern-table
  shape, one level down: `arrayElemElemValType` rep field + recording; `C[i][j]` and
  `ch = C[i]; ch[j]` read sites typed; `program-facts` flags the ROOT var on a nested write
  `C[i][j]=…` (receiver-chain walk) for soundness. Nested tables **6 KB → 0.6 KB** (10.6×).
  Single-level (mirrors the local `arrElemElemValTypes` convention); deeper nesting falls
  back. Pinned in `test/minimal-output.js` (no-string + value + soundness; the flat fix was
  previously untested). Full matrix opt0/2/3 green (2329/0); null-write→0 confirms ToNumber
  routing, not the NaN-box coincidence.
* DON'T chase yet (no workload): a module **object** with an array field (`const O =
  { freqs: […] }; O.freqs[i]`) still pulls the string runtime — different mechanism
  (schema-slot → array-elem); no current example/bench uses the shape.

### Deferred-backlog drain — extending-add · scalar-cap 64 · interop hygiene (2026-06-16)

Three "deferred-on-no-workload" items had already shipped (or gone moot) without the live
backlog being ticked. Verified against code + git + suite, moved here.

* [x] **extending-add i8/i16→i32** (`f5213cb`) — `s += u8[i]` / `s += u16[i]` into an i32
  accumulator lifts via the `extadd_pairwise` chain to i32x4 partials (`WIDEN_LOADS`,
  `src/optimize/vectorize.js`); widening min/max over a bare narrow load also lands
  (`MINMAX_WIDEN`). Value-exact mod 2³² (pairwise intermediates can't overflow; restricted to
  a BARE load — lane arithmetic before widening would wrap at lane width). 5 pins in
  `test/simd.js` (u8/s8/u16/s16 sums + the "must NOT widen on lane arithmetic" boundary);
  simd suite 110/110.
* [x] **scalarization cap 32→64** (`087dc56`) — `maxScalarTypedArrayLen` defaults to 64
  (`src/compile/plan/common.js`), covering 8×8 block kernels (DCT/JPEG). The feared 128-local
  LEB128 cliff doesn't materialize: at 64 elements the scalarized form is ~2.2× smaller and
  2.5× faster than the memory form.
* [x] **Dead-code / interop hygiene tail** — all resolved: `objectLiteralEntries` is a live
  import used by `lowerObjectLiteralThis` (jzify/classes.js:159, wired via jzify/index.js +
  transform.js) — no shadow, no dead import; `opts.extMap` is no longer written anywhere;
  `cli.js` `profileNames` is gone; `opts.modules`/`noTailCall`/`nativeTimers` are documented
  (index.js:242-247).

### CI perf-gate robustification + exp2 fast-path (2026-06-10)

The "Celesta Dreams 1.43× / perf-fuzz failing" CI report was no regression — jz wins the
floatbeat corpus (geomean 0.52×) and perf-fuzz (geomeans 0.75–0.90× vs floors). The lone
failure was always Celesta tripping the floatbeat per-beat backstop (host-bound ratio: 0.78×
locally, 1.43× on the shared runner, *identical* wasm); perf-fuzz passed every run.

* [x] **exp2 single-build 2^k for the normal range** (`bff62ce`) — for k ∈ [−1022,1023] a
  single IEEE-exponent build is bit-identical to the two-factor split (powers of two multiply
  exactly) but ~5 ops cheaper; the split stays for denormal/overflow edges. Math.exp 1.41→1.31×
  vs V8, accuracy unchanged (maxRel 2.4e-9). Examples using exp rebuilt. Follow-on to PS-2.
* [x] **CI-aware floatbeat backstop** (`e31db26`) — geomean ≤1.0× stays the per-corpus guarantee
  everywhere; the per-beat backstop is a gross-regression net, loose (2×) on CI (still catches an
  __ptr_offset-style 4× cliff), tight (1.4×) off-CI. Mirrors native-C "informational on CI".
* [x] **perf-fuzz int/mixed max as blow-up nets** (`024bbb8`) — 1.35/1.75 → 1.60/2.25; they sat a
  hair over the legit CI tier-gap outliers (1.24/1.68) so were tripwires. Geomean caps (the real
  guard) unchanged. The max nets a single-program miscompile the geomean can't (1 blown of 30).
* [x] **Examples drift gate excludes jukebox beats** (`41785a5`) — floatbeat compiled bytes aren't
  reproducible across Node/V8 versions (CI Node 22 vs local 25.x); covered by bytebeat correctness
  + the floatbeat perf gate instead. Beat structural non-determinism root unpinpointed (flagged).
* [x] **Earlier this cycle** — BigInt-safe nodeEqual + csePureExpr hoist key (`b64cb46`);
  csePureExpr DAG refcount guard (`63a5669`); aos __ptr_offset cliff fix via unboxed ptrKind
  (in `d382edd`); nested mixed-arity `=== undefined` fold (`1a239ce`); robustified bytebeat
  asserts (maxBadFrac tolerance, `0c3fcfd`); floatbeat perf gate added (`b8bbfb4`).

### Examples gallery + JS⇆jz toggle + warn channel (2026-05/06)

* [x] **Examples gallery** + the **JS⇆jz-WASM toggle + FPS/compute-ms HUD** on the demos (shared
  loader `examples/lib/jzdemo.js`); **zzfx**; rfft spectrogram (detailed entry below).
* [x] **Warn channel** — `ctx.warn` + `opts.warnings` sink + CLI print; advisories:
  `adviseHeapGrowth` (no-auto-reclaim leak), untagged-errors (`instanceof` on Error names),
  Set/Map slot-order iteration, jsstring-carrier-declined, SIMD loop bails. `test/warnings.js`.
  (Lint "skip — enforced by subset": no-var/eqeqeq/no-undef/no-with/no-eval rejected at the
  subset boundary; borrow only ESLint's "use Y instead" message style.)

### Milestone — declared-monotone lattice + streamlining (audit 2026-05-29)

Roots **B** (monotone lattice — all 3 clearStickyNull gone) and **E** (closed ValueRep typedef
+ REP_FIELDS + dev validator) CLOSED. 8-step plan done: correctness gates (test262 fail===0 +
xfail/xpass; determinism), divergence docs, ctx-invariant net + ownership table, DRY (hostImport,
isBoundName, makeVal/TypedTracker F1), emitMethodCall→table + sidecarOverride, full opt0/1/3/wasi
CI matrix, the lattice (narrowValResults hoist + soft-val + hardParamVal). OPT-2 `__phase`
side-channel → explicit arg. Fixed 2 miscompiles the gate caught (bare `return;`→undefined;
`cond?undefined:x`→undefined), the bitwise loop-bound hoist (→ vectorized, 1.14→1.00× vs V8),
watr honest `trail` pin, the `1.e3` subscript lexer (upstream), wasi Date-clock flake. Remaining
roots (A caching/two-walk, C collectDeclFacts, wasm resetParamWasmFacts) assessed — fixes would
add machinery / regress perf, left intentionally.

### Audit-2026-05-29 frontier — correctness leaks + perf + optimizer batch — CLOSED (2026-06-04)

Every compiler item from the "fix correctness leaks, then reach" audit shipped; what
remains under that header is ecosystem/reach (AudioWorklet REPL, dogfood biquad,
unplugin-jz), tracked in the execution plan, not as compiler work. Verified: full
opt{0..3} + wasi matrix, selfhost 11/11, `CI=1 test/bench.js` 70/70, fuzzer green.

* [x] **PARSE-2** — unparenthesized unary base of `**` (`-x**2`, `delete x**2`, …) is now
  a SyntaxError per ES2016 §13.6 (guard in the `'**'` handler). Negative-parse skip set
  audited (`scripts/neg-parse-audit.mjs`, 0 accepts-invalid-JS); `test/parser-bugs.js`.
  PARSE-2B added `delete` to the guard.
* [x] **INTEROP-C1** — `serialize(undefined)` returns `'undefined'` (was `null` →
  `Object.keys(undefined)` crash). `index.js:529`.
* [x] **FE-3** — `try` handler preps the handler once (was twice when no `finally`; prep
  has side effects). `prepare/index.js:1356`.
* [x] **FE-6** — `prepareModule` wraps prep in try/finally so the 4 caller-state vars
  always restore, even when an imported dep throws mid-prep. `prepare/index.js:2464`.
* [x] **FUZZ-1** — Float64Array / Int32Array generative fuzzer (`test/fuzz.js --typed-map`,
  `--typed-int`): const-bound internal typed-array kernels (so they actually vectorize)
  with `?:`, diffed element-wise vs JS across opt{0..3}. Earned its keep — caught three
  pre-existing silent opt2/opt3 miscompiles, all operand-drop-without-purity bugs:
  `(select x x cond)` (vacuum) and the algebraic `PEEPHOLE` folds (`x&0`, `x^x`, `x*0`,
  idempotent `x&x`, self-compares) dropped an operand holding a typed-array element's
  address `local.tee`, leaving the store stale. All now `isPure`-gated (`src/wat/optimize.js`);
  affects any computed element write, not just reductions.
* [x] **expm1 cancellation** — dedicated Maclaurin series for `|x|<0.5` (was `exp(x)-1`,
  up to ~11% error near 0); preserves sign of ±0. `module/math.js:494`.
* [x] **PS-2 — math.exp O(1) 2^k** — `exp`→`exp2`; `exp2` builds `2^k` from the IEEE
  exponent bits split into two halves (`k2` + `k−k2`), no O(k≤1023) loop; poly over
  [-0.5,0.5], ~6e-9 rel. `module/math.js:471-487`.
* [x] **Optimizer SIMD/fold batch** (optimizer passes, 2026-06-02): product
  reductions (`*=` i32/i64/f32/f64, `REDUCE_OPS`); conditional-lane vectorization
  (`cond?x:y` → `v128.bitselect` + `LANE_COMPARE`, mask hoisted first so COND's address
  tee runs before the branches); i32 sum reductions (`fusedRewrite` folds the f64→ToInt32
  round-trip to `i32.add/sub` — exact, then it vectorizes); integer comparison fold
  (`f64.cmp(convert,convert)` → `i32.cmp`, `aa5a195`); pooled-const `global.get` splat.
  Tail-call optimization confirmed **already shipped** (`tcoTailRewrite`, `src/ir.js`,
  wired in compile + emit) — the backlog's "not implemented" was stale.
* [x] **Dead-code + interop hygiene (partial)** — `invalidateLocalsCache` dead import
  dropped; `JZIFY_TRANSFORM_OPS` dead export removed; magic `0x4000/0x7` → `LAYOUT.SSO_BIT`;
  per-call `TextEncoder`/`Decoder` → singleton in the heap-string hot path (`interop.js:32`).
  (objectLiteralEntries shadow / opts.extMap vestigial write / cli.js profileNames / opts
  docs still open — kept in the live tail.)

The ranked-ROI optimizer backlog is now fully shipped too (see "Compiler-optimization
backlog — CLOSED" below); only deferred-on-no-workload items remain (extending-add,
AoS→SoA, scalarization-cap). Representation carriers, language coverage (Date/test262),
the metacircular parser extraction, and source maps stay under the execution plan.

### Compiler-optimization backlog — CLOSED (2026-06-02/03/04)

The ranked-ROI optimizer backlog is fully shipped; what's left is deferred-on-no-workload
(extending-add, AoS→SoA, scalarization-cap), not open work.
Re-verified 2026-06-04 across the full gate: opt{0,1,2,3} + wasi (2033 pass / 1 skip / 0 fail
each), selfhost 11/11, perf-ratchet +0, `CI=1 bench` 70/70, fuzz typed-int 5000×4 + typed-map
5000×4 + scalar 5000×4 (77 655 inputs) — zero divergence.

* [x] **#1b int min/max reductions** (`6308f26`) — `m = a[i]>m?a[i]:m` over Int32Array → a
  select-shaped reduction body; `matchIntMinMaxReduce` recognizer + select-based horizontal
  fold (`i32x4.max_s/min_s`; no scalar `i32.min`; identity INT_MIN/MAX); overshoot-safe SIMD
  bound for the `m=a[0]; i=1` seed. `src/optimize/vectorize.js`.
* [x] **#1c int conditional vectorization** (`c5b30a5`) — `fusedRewrite` pushes ToInt32 through
  the universal-f64 `?:`: `ToInt32(if(result f64) C A B) → if(result i32) C toI32(A) toI32(B)`
  when both arms are integer-valued, + `ToInt32(int-valued f64) → i32` form + `i32.or X 0 → X`.
  `(cond?A:B)|0` over Int32Array then lifts via the i32 `LANE_COMPARE` + `v128.bitselect`.
  `src/optimize/index.js`, `src/optimize/vectorize.js`.
* [x] **#2 specializeMkptr threshold** (`496a236`) — tuned 5→**4** (the *measured* break-even),
  honoring the de-opt-risk concern rather than the speculative 5→3.
* [x] **#4 induction-variable strength reduction** (`dbf1d9d`) — affine scalar loops; + `fe3aa12`
  (LICM must not hoist a self-referential induction tee out of its loop).
* [x] **#7 SIMD byte-scan / memchr** (`052a455`) — `i8x16.eq` + `i8x16.bitmask`, 16 bytes/step;
  vectorizes Uint8Array delimiter scans (the parser/tokenizer charCodeAt-scan shape).
* [x] **#3 single-use helper inlining** — `inlineOnce` (single-call funcs → lone caller) +
  `propagate` (single-use locals / tiny consts) + `89fb454` copy-propagation + adjacent
  dead-store elimination (size). `src/wat/optimize.js`.
* [x] **Cheap generalizations** — cross-`if` CSE (`csePureExprLoop`); LICM global-read hoist
  (`hoistInvariantLoop` `pureGiven` admits invariant `global.get` + `SAFE_OFFSET_CALLS`;
  `promoteGlobals`). `src/optimize/index.js`.

(The earlier wave — product reductions, conditional-lane vectorization, i32 sum reductions,
integer comparison fold, pooled-const splat, tail-call — is in the frontier entry above.)

### Auto i32-index narrowing — the hoist idiom becomes a compiler pass (2026-05-22)

Supersedes "RFFT i32-hoist" below. The prior push made jz beat V8 by hand-hoisting
`let n = N | 0` into each kernel — a leaky abstraction (forces users to rewrite
idiomatic code for speed). Generalized it into the analyzer so **unmodified** source
gets the same i32 indexing.

* [x] **`collectI32SafeIndexVars` (src/analyze.js).** In `analyzeBody`'s widen pass, a
  counter compared against an f64 bound normally widens to f64 (overflow safety). Now
  exempted when it's an **affine component of a fully-i32 array index**: a valid wasm32
  byte-offset must fit i32 and an affine index is monotone in the counter, so the counter
  is provably i32-range — the exact guarantee the manual `|0` asserted. Kept i32 → direct
  indexing, no per-access `trunc_sat`; the compare coerces the counter instead. Transitive
  **back-propagation** over affine assignment/step edges (`let i0 = ix`, `i0 += id`) carries
  the proof through nested-loop index seeding (FFT butterflies). The assignment-widening
  fixpoint still runs after, so a genuinely fractional counter (`i = i/3`) overrides back to f64.
* [x] **Gated on a *fully-i32* index — the game-of-life regression is designed out.** Seeding
  fires only when `exprType(idx) === 'i32'`. An f64-strided index (`mem[y*w + x]`, f64 `w`)
  truncs regardless, so narrowing its counter would add a compare-convert for zero trunc
  savings — exactly the loss the old archive predicted for a blanket pass. Result:
  game-of-life / mandelbrot / interference wasm **byte-identical** before/after; only
  fully-i32-indexed kernels (rfft) change. This is *narrower* than "narrow mutable globals":
  it narrows **index counters**, never the globals, and only where it provably pays.
* [x] **rfft.js de-hoisted → idiomatic.** Removed `let n = N|0` / `hf = half|0` from
  transform/rfft/cepstrum; uses `N`/`half` directly. Output **bit-identical** to the hoisted
  wasm (0.0 diff). Module `trunc_sat` 86 → 18, wasm 10154 → 9902 B. Beats V8 **1.46×** on
  rfft() / **1.05×** on rfft()+cepstrum() (`examples/rfft/bench.mjs`, best-of-8, N=2048).
* [x] **Tests + verify.** 3 regression tests in test/perf.js (i32 index stays i32; transitive
  nest narrows; f64-strided index does NOT narrow). Full suite 1854 pass / 0 fail / 1 skip.
* [x] **Residual headroom → closed by integer-global inference (2026-05-22).** The loop guard
  `i < N` used to convert the i32 counter to f64 each iteration (f64 bound). New pass
  `inferModuleIntGlobals` (src/plan.js) narrows numeric module globals to **i32 by default**,
  demoting to f64 only on *proof* of a fraction (non-integer literal, `/`, `**`, float `Math.*`,
  or a reference to an already-fractional value; fixpoint propagates fractionality through
  cross-global refs). A numeric-init global later assigned a non-number (string/object/array)
  is disqualified → stays the f64 box (write-path coercion fixed in `writeVar`/emitDecl). With
  `N` an i32 global the guard is pure-i32 and `mem[y*width+x]` (i32 `width`) is a fully-i32
  address. Now **no manual `|0` needed** — idiomatic rfft.js beats V8 **1.69–1.74×** rfft() /
  **1.14–1.16×** +cepstrum() (was 1.46× / 1.05×). game-of-life neutral (branch/call-bound, 0.82×
  both ways, smaller wasm), interference 1.96×, mandelbrot untouched. Tests: 5 codegen +
  3 runtime (test/perf.js, test/inference.js). Full suite **1856 pass / 0 fail / 1 skip**.
  Principle documented in README inference section.

### RFFT i32-hoist beats V8 · cepstrogram demo · linefont FPS sparkline (2026-05-22)

The "beat V8 on RFFT / integer-index by any means" push, plus the demo features it powers.

* [x] **i32-hoist idiom — jz beats V8 1.70× on the FFT kernel.** Root cause of the prior
  *JS 1.5× ahead* on RFFT: jz's universal-f64 number model boxes loop-bound **globals** as
  f64 (compile.js only narrows `const` globals with constant-int initializers), so every
  `x[i]` emitted an `i32.trunc_sat_f64_s` and the loop counters ran in f64. Fix is one line
  per kernel — hoist the f64 globals into i32 locals at the top of the hot function
  (`let n = N | 0;`): the narrower types **locals** off the `|0` i32 signal and cascades i32
  through every derived index (`i0`, `i1`, …). WAT trunc_sat count **76 → 13**; all index
  locals i32; loop arithmetic native i32. Measured (`.work/rfft-bench.mjs`, paired
  same-source jz-wasm vs JS-ESM, best-of-8): **rfft() jz 1.63–1.70× over V8** across
  N=512–8192 (1.70× at 2048: jz 7.7 vs JS 13.0 µs); **rfft()+cepstrum() jz 1.45–1.52×**;
  correctness max|Δ| ~1e-11; wasm 9909 B (smaller than before). `examples/rfft/rfft.js`.
* [x] **Idiom is opt-in, NOT a blanket compiler pass — game-of-life regressed.** Applying the
  same hoist to game-of-life's step/rot (`let w=width|0,h=height|0,off=offset|0`) made it
  *slower* (0.74× → 0.67× vs JS). Root cause: game-of-life is **branch/call-bound** (per-cell
  ternaries, `rot()` call, Uint32Array values near 2³²), not index-bound — the hoist adds
  i32↔f64 traffic without removing a trunc-heavy inner loop. Reverted; production untouched
  (only `.work/gol-i32.js` probe was edited). This is the evidence that a global "narrow
  mutable f64 globals to i32" pass would do harm — keep it a documented **kernel idiom**.
  A mutable-global narrowing pass stays deferred (analyze.js 3818 LOC / 1851 tests, high risk,
  game-of-life counterexample).
* [x] **transform() refactor preserves the win.** Extracted the bit-reverse + butterfly core
  (shared by `rfft()` and `cepstrum()`) into a non-exported `transform()` carrying the i32
  hoist; both callers re-hoist `n`/`half` locally. Win held (7.74 µs / 1.68× at 2048).
* [x] **Real cepstrum.** `cepstrum()` = IDFT of the log-magnitude spectrum. Log-mag is real &
  even-symmetric → its DFT is real, so it reuses the same forward `transform()` and keeps the
  real part / N. A peak at quefrency q ⇒ period q samples ⇒ pitch ≈ sampleRate/q; the
  cepstrogram traces the melody. Verified: 220 Hz tone → cepstral peak at quefrency 199
  (expected 200.5), JS/jz agree 6.9e-11. `examples/rfft/rfft.js`.
* [x] **Demo (`examples/rfft/index.html`) — all requested features, browser-verified.**
  Scrolling **cepstrogram** (ABGR palette LUT, log-quefrency rows) with the **momentary
  waveform overlaid** (transparent oscilloscope canvas), **wavefont** peak-hold spectrum bars,
  **click-to-shuffle** (picks a different floatbeat tune of 5, rebuilds the looped audio
  buffer), and a **live code panel** showing the playing tune's source. Audio gated behind a
  one-gesture `#play`. Verified: cepstrogram lit (maxlum 715), waveform overlay 4231 px,
  bars 94/110 active, both fonts loaded, jz compute 0.06 ms/frame @ 121 fps, shuffle
  arp→chord pad, 0 console errors.
* [x] **linefont FPS sparkline in the shared HUD (`examples/lib/jzdemo.js`).** The FPS line is
  now a **linefont** sparkline — each recent fps sample is the glyph at `0x100+value`, and the
  font's ligatures join them into one continuous line chart. Plotted on an **absolute** scale
  (full height = `ref`, which rises to the display refresh rate) so the line sits at the true
  level and **steps when the engine is swapped**. Fixed two scaling flaws found in the browser:
  (1) a decaying-peak relative scale read a steady 23 fps as flat-100 (hid the level and the
  engine gap) → switched to absolute; (2) `ref` latched onto a transient — the first frame
  seeded `fps = 1000/dt ≈ 950`, bumping `ref` permanently so steady 121 fps read 13/100 →
  clamp sub-4ms frames (`Math.min(1000/dt, 240)`) and warm the EMA up from 0 so `ref` settles
  on the real refresh. Verified: mandelbrot (23 fps) reads ~19/100, RFFT (121 fps) reads
  ~97/100, JS⇄jz toggle steps the line. Fonts `examples/lib/{linefont,wavefont}.woff2`.

Demos verified live via Playwright; `.work/rfft-bench.mjs` is the reproducible perf harness.

### `x ** 0.5` → `f64.sqrt` fold · startup/REPL bench · numeric monomorphization wontfix (2026-05-22)

Mined two archived JS→WASM compilers (TurboScript, speedy.js) for borrowable design;
three candidates, each judged against jz's *actual* corpus, not on paper.

* [x] **`x ** 0.5` → `f64.sqrt` fold.** The startup bench flagged the headline `dist`
  example (`(x*x+y*y) ** 0.5`) compiling to 1058 B / 3.9 ms — it emitted the full
  `$math.pow` exp/log polyfill. Folded `** 0.5` (and `Math.pow(x, 0.5)`, same handler)
  to `f64.sqrt` in `module/math.js`, beside the existing integer-exponent square-and-
  multiply fold. `dist`: **1058 B → 67 B**, compile **3.9 → 0.41 ms**, warm **0.4× →
  2.3×** vs V8 — size, cold, and warm all at once. Correctness: f64.sqrt is correctly
  rounded, so bit-identical to `Math.pow(x, 0.5)` on every normal input and to jz's own
  `Math.sqrt(x)` by construction (always `canon`, since a negative finite base yields a
  NaN whose sign needs canonicalizing — mirrors the `math.sqrt` emit). Two exotic inputs
  follow sqrt over Math.pow, deliberate trades in the same class as jz's other boundary
  divergences: `(-0) ** 0.5` = -0 (Math.pow: +0; -0 === 0), `(-Infinity) ** 0.5` = NaN
  (Math.pow: +Infinity). `** -0.5` intentionally **not** folded — `1/sqrt` double-rounds
  and loses the last ULP vs Math.pow's single rounding; keeps the exact `$math.pow` path.
  Differential-tested across 19 edge inputs before committing. `module/math.js`.
* [x] **Cold/warm + instantiation benchmark** (speedy.js VMIL'17 methodology). Built
  `scripts/bench-startup.mjs` (`npm run bench:startup`): per-snippet src→wasm, wasm→
  instance, jz cold, `new Function`→first result, warm per-call, bytes — snippets are
  pure scalar kernels, valid jz *and* valid standalone JS. Finding: **jz cold-start is
  200–1400× slower than `new Function` + first call** — jz does real AOT work (infer/
  narrow/vectorize/encode) the JS engine skips via lazy compile. The commented-out README
  "compiles faster than `eval`" line is **false**; kept out. jz's edge is tiny portable
  wasm + warm numeric speed on real kernels, not REPL latency.
* [x] **Function-level monomorphization (TurboScript generics) — wontfix.** Idea: clone
  a non-exported function per call-site numeric signature when sites disagree (one i32,
  one f64) instead of leaving the param boxed f64. Probed the trigger across the corpus:
  **bench 0 hits; full suite (~1850 programs) 2 hits**, both a trivial synthetic
  `add(a,b)`. Root cause it can't pay off: `inlineHotInternalCalls` (plan.js:2100) runs
  *before* `narrowSignatures` (plan.js:2127) — hot polymorphic helpers are inlined into
  each site and type-specialized there, strictly better than cloning (no call, no extra
  function). Cloning would only help a function both too big to inline *and* called at
  mixed numeric types — doesn't occur. TurboScript needed it for explicit `Foo<T>`
  generics; jz has none. ~80 speculative lines, zero corpus win. Probe is easy to
  reconstruct; re-open only if a real workload surfaces the pattern.

Follow-ups carried forward as live tasks: Math.* stdlib-pull audit (Perf §, sister to the
sqrt fold), README FAQ entry for the `** 0.5` corners (Ship §), parallelism substrate
(Future § threads/atomics, scope filled in).

Suites: unit 1851 pass / 0 fail; bench gate 81 pass / 0 fail.

### Lint-inspired structural passes — i32 / switch / dupe-keys / form folds (2026-05-21)

The "fix structurally where jz invented the gap" half of the lint-inspired plan. Two
were verified-held (pinned, no code change); two were real lowering/codegen work.

* [x] **i32 narrow range-safety (`no-loss-of-precision`)** — *verified held*. The narrower
  picks i32 only on an i32 *signal* (i32-literal init + i32-only operands / `x|0` / bitwise /
  Int32Array read); any non-i32 source (f64 param, division, elems > 2^31) stays NaN-boxed
  f64 with the exact value. An all-i32-signal accumulator wrapping mod 2^32 is the deliberate
  value-model trade (powers `i32x4` SIMD reductions + scalar digit parsers), not an ambiguity
  bug — a "widen self-accumulators" pass was prototyped and rejected (broke those tests).
  Pinned both directions in `test/inference.js` ("i32 range-safety: …"). `src/analyze.js`.
* [x] **switch fall-through / `default` (`no-fallthrough`)** — lowering rewritten. The old
  if/else-if chain ran one body only; it couldn't express fall-through, stacked labels,
  mid-list `default`, or string discriminants (string switch returned `[0,0,0]` — the
  synthetic temp shed its STRING type and strict-`===` folded every case to `false`). New
  `transformSwitch` is two-phase, evaluated once with no goto: (1) entry index via `===`
  chain over labels (first match, else `default`'s index, else past-end); (2) run clauses
  where `entry <= i`, a `break` flipping a sticky `brk` flag (`rewriteSwitchBreaks`). A
  bare-identifier discriminant uses no temp (keeps its type); `stripTerminalSwitchBreak`
  → `normalizeCaseBody` (keeps breaks for the flag to gate). `src/jzify.js`; 4 capability
  pins in `test/types.js` (fall-through, stacked, default-mid, string). Parser caveat: a
  statement on the *same line* after a `switch {…}` still fails to parse (subscript jessie
  omits the block-boundary signal — `feature/switch.js` `switchBody` skips `}` without
  `parse.exit`); newline-separated (normal style) parses fine. Upstream-gated.
* [x] **duplicate object keys (`no-dupe-keys`)** — *verified held*. Last-wins → single slot
  (`{a:1,a:2}.a===2`, `Object.keys` dedups). Pinned in `test/objects.js`.
* [x] **form normalizations → IR fold (no warning).** `Math.pow(x,n)` constant integer
  exponent (`|n| ≤ 8`) → inline square-and-multiply, eliding the math.pow/exp/log stdlib
  (`module/math.js`, `test/math.js`). `~~x` → single `toI32` (the two xor-with-(-1) cancel;
  NaN/Infinity guard lives in `toI32`, runs once — value-identical to the old double-`~`,
  0 xors vs 2; `src/emit.js` `~`). `!!e` in pure boolean position (if/while/for-cond/`?:`,
  *not* value-preserving `&&`/`||`) → `e`, dropping the double-`eqz` (`src/prepare.js`
  `stripBoolNot`). Both pinned in `test/types.js` with IR-count assertions. Remnants
  (parseInt-of-literal, self-assign, useless-concat/return) left active — low value.

Suites: unit 1851 pass / 0 fail / 1 skip.

### Strict `===` + arg-position ToString (2026-05-21)

Follow-on to the boolean carrier: closed the equality and ToString gaps it
exposed.

* [x] **Un-conflate `===`/`!==` from loose `==`/`!=`.** Strict for
  statically-typed operands — a proven type mismatch folds to `false`/`true`
  with **no coercion** (`true === 1` is `false`, `"1" === 1` is `false`),
  unlike `==`. Same-type operands behave as before. `prepStrictEq` +
  `emitStrictEq`/`STRICT_PRIM` (src/prepare.js, src/emit.js); jzify keeps the
  loose/strict distinction (src/jzify.js). Untyped-dynamic operands stay a
  documented gap (the `null === undefined` unification too).
* [x] **Root-cause fixes surfaced by the above.** (1) `OP_MODULES` now maps
  `===`/`!==` → `['core','string']` (src/autoload.js) so the string module
  registers `__str_eq` when only strict ops appear — was
  `internal: stdlib '__str_eq' was requested but never registered`. (2)
  Destructuring registers each binding name in the arrow's local scope
  (src/prepare.js `prepDecl`), and a bare-identifier source destructures
  without a copy temp — so `let [,x]=strs; typeof x` resolves `'string'`
  instead of mis-folding to `'undefined'` (it was invisible to
  `isUnresolvableBareIdent`). Pinned by 2 new `test/destruct.js` tests.
* [x] **Boolean→ToString in argument position.** `parseInt`/`parseFloat`
  render a statically-known boolean as `"true"/"false"` before parsing
  (`strInputI64`, module/number.js); `String.indexOf`/`includes` coerce a
  BOOL needle the same way and an OBJECT needle via compile-time
  ToPrimitive(string) (`searchArg`, module/string.js). All reuse the existing
  `emitBoolStr`.
* [x] **test262 builtins 719 → 721** — `parseInt(boolean)` /
  `parseFloat(boolean)` unskipped (were fed the 0/1 carrier). Baseline bumped
  in `.github/workflows/test262.yml`. `indexOf/searchstring-tostring.js` stays
  xfail for one reason only: `String({})` is JSON-ish `"{}"`, not
  `"[object Object]"` — all other needle types (bool/number/null/undefined/
  array) now pass.

Suites: unit 1830 pass / 0 fail / 1 skip; test262 language 1431 / 0; builtins
721 / 0. README boolean/FAQ prose untouched (no new divergence — these are
correctness fixes).

### Real-boolean carrier (2026-05-21)

`true`/`false` carry as the cheap `0`/`1` i32 internally — branches and arithmetic
pay nothing, exactly as before. A real boolean is materialized **lazily, only where
boolean-ness is observed**: `typeof`, `String`, `JSON.stringify`, and the host
boundary. The carrier is the existing NaN-box ATOM family (`FALSE_NAN` aux=4 /
`TRUE_NAN` aux=5, siblings of `NULL_NAN`/`UNDEF_NAN`); `4 | truthbit` boxes, decoded
at the boundary like `null`/strings. No `memory.Boolean` wrapper, no wasm-gc — the
atom tags discriminate in wasm-v1 (wasm-gc's `i31ref(0)` wouldn't anyway).

* [x] **Lazy boxing at the export boundary** (`src/compile.js:608`
  `boolBoxIR(typed(callIR, …))`, `isBoundaryWrapped` ← `func.valResult === VAL.BOOL`).
  The inner `$f` keeps the `f64.convert_i32_s` 0/1 carrier; only the `$f$exp` thunk
  reboxes (`__mkptr(0, 4 | __is_truthy(…), 0)`) and is marked `"r":1` in `jz:i64exp`.
  Number-returning exports emit no i64exp entry — zero footprint off the boolean path.
* [x] **`decode` learns the two atoms** (`interop.js:146-155`) — `0x7FF80004 → false`,
  `0x7FF80005 → true`, beside the existing null/undefined arms. Module-private; the
  host export wrapper applies it. Host→jz booleans still coerce to 0/1 via `wrapVal`.
* [x] **Observation sites classify BOOL** (`src/analyze.js` `valTypeOf`): `!`, all
  relational/equality operators, `in`, `instanceof`, `Boolean()` → `VAL.BOOL`;
  `narrowBoolResults()` infers `valResult` on the narrowing-skip leaf path
  (`plan.js` `canSkipWholeProgramNarrowing`). `typeof`/`String`/`JSON.stringify`
  already observe the atom (truthy chain + `isBoolAtom`, `src/ir.js`).
* [x] **IR** (`src/ir.js`) — `BOOL_ATOM_BASE=4`, `FALSE_NAN`/`TRUE_NAN`, `boolBoxIR`
  (materialize from 0/1, used only at the boundary), `unboxBoolIR`, `isBoolAtom`.
* [x] **Tests — `test/booleans.js` (15 tests / 40 assertions)** pin: boundary decode
  for comparisons/equality/`!`/`Boolean()`/literals; `typeof`/`String`/`JSON.stringify`
  observation; branch & arithmetic positions stay the cheap carrier (codegen pin via
  `jz:i64exp` absence); host→jz 0/1 coercion; and the two honest gaps —
  value-preserving `&&`/`||` and bare container reads cross as 1/0. Carrier-only flips
  (1→true, 0→false; value never changed) propagated across errors/statements/strings/
  unsigned/types/symbols/destruct/features/number-methods.
* [x] **README** — "Booleans carry as numbers, surface as booleans" rewritten from
  the old "planned" note to the shipped behaviour, with the two documented limits.

Supersedes the former Deferred › "Boolean ATOM tag" entry. Suite: 1813 → 1828 pass.


#### Product / measurement (needs a measurement+product session, not a compiler edit)
* [x] **AS ecosystem audit.** Done → [.work/ecosystem-audit.md](ecosystem-audit.md).
  Verdict: **don't port AS's test suite** (it asserts a different language;
  test262 + differential fuzzer + bench gate are the right targets). DO mine AS's
  showcase compute kernels (path tracer, emulator core, codec, hash) into
  `bench/`/`examples/`. AS's real traction is blockchain — out of jz's scope,
  don't follow. Sequenced reach plan below.


### Representation carriers — foundation + done workstreams (2026-05-19/20)

Per-site carrier inference. Design narrative (user surface, evidence ladder,
what-ships-vs-what-drops, open policy questions) moved to `.work/research.md` ›
"Representation -> per-site, inferred". Open carriers stay live under `#### Representation`.

* [x] **Narrowing investigation (primary).** Survey (`.work/narrow-survey.mjs`,
  `narrow-watr-hotspots.mjs`; findings `.work/narrow-findings.md`): every numeric /
  typed-array bench already at zero fallbacks; only watr (self-hosted WAT compiler) has
  any — 1289 emits, 47.5 % in its top 10 funcs. Conclusion: remaining dynamic-shape wins
  are codegen-layout + SSO-peephole, not narrower gaps. Follow-ups: C.1 (`Array.isArray`
  facts through `?:`/`&&`/`||`) + F.1 (`for-in` known-schema unroll) landed; C.2
  (`x==null` flow-narrowing) deferred — no nullable-rep consumer.
* [x] **Per-site flat-number specialization.** Verified done-in-effect 2026-05-19: zero
  `*.reinterpret_*` / `__num_box` / `__num_unbox` across 5 bench kernels (crc32, mat4,
  bitwise, sort, biquad). Achieved by narrowing (`narrow.js` phases D param-spec, E
  i32-results, E3 pointer-results, G TYPED ABI) + `analyze.js` `exprType` i32 propagation.
  The `flatI32`/`flatF64` carrier-bundle refactor judged architectural sugar (no
  behavioral benefit) — not built; named goal already reached.
* [x] **SSO flow-through.** Landed 2026-05-19: (a) compile-time literal+literal concat
  folds to one literal (`prepare.js` `'+'`); (b) runtime `__str_concat{,_raw}` SSO-repack
  fast path when both operands SSO and total ≤ 4 (`module/string.js`). Probe confirms heap
  stays pinned for repeated small concats; heap path still fires for total > 4.
* [x] **Foundation (do not undo).** One-file-per-type `src/abi/` (`string.js` sso default +
  jsstring scaffold; `number.js` nanboxF64); slot-carrier contract (carriers emit inline,
  no `src/*` imports); `ctx.abi.<type>.ops.<op>` per-site dispatch; carrier peephole
  (`nanboxF64.peephole`); single `interop.js` codec (DRIVERS table removed).

(jsstring boundary carrier and `opts.host` user surface have their own dated entries below.)

### opts.host user surface + custom sections reference + SoA boundary pin (2026-05-20)

Cleanup pass on the `opts.host` knob and a pinned boundary for SIMD
vectorization. No new feature surface — the work made existing behaviour
visible and irreversible.

* [x] **`host: 'gc'` reserved-mode error** (`index.js:315`). Distinct error
  text so users see it as planned-future, not unknown-garbage: "reserved for
  a planned wasm-gc backend, not yet implemented. Use 'js' (default …) or
  'wasi' (standalone runtimes — no env imports)."
* [x] **wasi tolerance comment** (`src/emit.js:2563`). Documents that the
  silent `undefExpr()` fallthrough for unknown receivers under `host: 'wasi'`
  is by-design — `test/wasi.js` cases 235 and 245 pin it explicitly so
  polymorphic source can target both modes from one source. `strict: true`
  is the documented fail-fast opt-in.
* [x] **README — host modes**. Existing `host: 'js'` / `'wasi'` FAQ extended
  with the `gc` reservation note and a pointer to `strict: true` for users
  who want the wasi unknown-receiver path to error instead of no-op.
* [x] **README — custom sections reference** (new FAQ). First public
  documentation of the four sections jz emits: `jz:schema` (rehydration
  shapes), `jz:rest` (rest-param fixed counts), `jz:i64exp` (per-export
  i64-ABI map for NaN-canonicalization dodging), `jz:extparam` (externref
  param positions + JS-side defaults — written by the jsstring carrier).
  Names declared stable; binary layouts declared internal.
* [x] **SoA vectorization — README FAQ + tests** (`test/simd.js`,
  `README.md`). Documents the supported shapes (same-array, cross-array,
  SoA-3 / SoA-4 separate typed arrays per field) and the unsupported AoS
  interleaved shape with the mechanical migration path. Three new tests:
  SoA-3 fused map lifts to `f64x2`; SoA-4 RGBA luminance blend lifts; AoS-
  stride-2 must NOT lift (parity intact) — pins the boundary so future
  changes can't accidentally promise AoS without a real struct-splitting
  carrier. Counterpoint to the still-open Live-work AoS-write bullet, which
  remains the multi-week deferred carrier.

**Skipped deliberately:** a `jz:host` feature-stamp custom section. `interop.js`
already detects required features from imports (`wasi_snapshot_preview1`,
`env`, `wasm:js-string`); the extra surface adds no consumer value and would
become permanent maintenance debt.

tests: 1769 → 1772 pass (+3); commit `06b0e69`.

### jsstring boundary carrier (2026-05-20)

The `jsstring` carrier from `src/abi/string.js` is now wired end-to-end as a
**per-export-param boundary opt-in**. Eligible exports take their string param
as `externref` (zero-copy JS-string pass-through) instead of the f64/SSO carrier
(per-call UTF-8 transcode into wasm memory).

* [x] **Narrower phase J — `applyJsstringBoundaryCarrier`** (`src/narrow.js`).
  Per export, per param, flip `p.type` from `f64` to `externref` *only if* every
  use is `wasm:js-string`-builtin-mappable AND at least one use proves the param
  is a string. Proof sources, any of: (a) a `.charCodeAt` use (string-only
  method), (b) call-site rep evidence `VAL.STRING`, (c) string-literal default
  `s = ''` (declared intent). Rejects: reassignment / `++` / `--`, closure
  capture, escape into non-builtin calls, unbounded `.charCodeAt` (would trap
  where JS returns `NaN`). Standalone entry point exported for
  `canSkipWholeProgramNarrowing` short-circuit. Gated by `jsstringEnabled()` —
  off under `host: 'wasi'`, off when `optimize.jsstring === false`.
  `scanBoundedLoops` exported from `src/analyze.js` for the in-bounds proof.
* [x] **Builtin import channel** (`ctx.core.jsstring: new Set()` in `src/ctx.js`).
  Drained at module-assembly into `(import "wasm:js-string" "<name>" …)` nodes
  with `JSS_IMPORT_SIGS` from `src/abi/string.js`. The set tracks only the
  builtin names actually used by this module.
* [x] **Lowering** — `module/core.js` `emitLengthAccess` dispatches on
  `va?.type === 'externref'` → `(call $__jss_length va)`; the call site reads
  `emit(obj)` *before* `asF64` so the externref type isn't stripped.
  `src/emit.js` in-bounds `.charCodeAt` dispatch checks `recv?.type === 'externref'`
  → `(call $__jss_charCodeAt recv idx)`.
* [x] **Boundary wrapper + custom section** (`src/compile.js`). Boundary wrapper
  takes `(param externref)` for flipped slots; the wrapping i64/f64 ABI dance
  is skipped on those slots. A `jz:extparam` JSON custom section records, per
  export name, the indices `p:[…]` whose carrier is externref, plus optional
  `d:{idx:'str'}` for JS-side defaults so the wasm side never sees a null
  externref. Default-param init loop in `emitFunc` skips the `=== undefined`
  branch for jsstring params (substitution moves to the JS-side wrapper).
* [x] **interop.js boundary wiring**. Reads `jz:extparam`; for marked indices
  the wrapper writes `(${a} === undefined ? ${dn} : ${a})` directly, skipping
  `mem.wrapVal` (which would NaN-box the JS string). Native `wasm:js-string`
  detected by a one-time probe: if `new WebAssembly.Module(buf, { builtins:
  ['js-string'] })` instantiates with no imports, the engine handles the
  builtins itself (V8 17+ / Node 25+ / Safari 18.4+); otherwise a JS polyfill
  (`(s) => s.length`, `(s, i) => s.charCodeAt(i)`) is attached.
* [x] **Opt-out flag** — `optimize.jsstring: false` ([src/optimize.js] PASS_NAMES
  + the `jsstringEnabled()` gate in narrow.js) keeps every param on the
  f64/SSO carrier. Used for paired benches and engines that mishandle the
  builtins option.
* [x] **Tests — 10 / 22 assertions** ([test/jsstring.js]). Covers: opt-in fires
  on bounded `.charCodeAt`+`.length`; runtime correctness sums char codes
  through externref; `.length`-only stays polymorphic (number → undefined);
  unbounded `.charCodeAt` declines (trap-safety); reassignment / closure
  capture / `s + 'x'` escape all decline; string-literal default fires the
  opt-in even without `.charCodeAt`; JS-side default substitution on
  `undefined`; numeric default doesn't trigger.
* [x] **Bench** — `bench/jsstring/bench-jsstring.mjs` paired-compilation
  baseline. On Node 25.9 native, `.length(s)` opt-in is 22× faster at 8 chars,
  154× at 256, 5510× at 8192 — boundary-copy elimination dominates. `.sum(s)`
  (`.charCodeAt` loop) is 10.5× / 1.5× / 1.3× faster across the same sizes —
  win compresses as per-char work begins to dominate. Jessie section
  documents the correct-rejection case (param escapes into `parse()` — not a
  builtin — both compilations byte-identical, ~1.0× ratio confirms no
  side-effect).
* [x] **README** — new FAQ "How do strings cross the boundary?" with the
  two-carrier table, opt-in trigger matrix, engine support, opt-out flag, and
  bench pointer.

### watr 4.6.9 upgrade — drop 'light' mode workaround (2026-05-20)

* [x] **'light' watr mode removed** (`a26ea84`). L2 was running a curated watr
  subset (`inline / inlineOnce / coalesce` all off) since 4.6.4 to dodge two
  upstream miscompiles:
  - **W1a** — `inlineOnce` dropped a single-call helper's bare-`local.get`
    body (root-node `walkPost` return value discarded; substitution lost).
  - **W1b** — `coalesceLocals` merged a zero-dependent local into a residue-
    carrying slot when `inlineOnce`'s `needsReset` zero-init ran before
    `propagate`'s cleanup sweep. Trigger: `/a.+b/.test("ab")`.

  watr 4.6.9 ships fixes for both. L2 now runs the full watr default pipeline
  (treeshake / dedupe / dedupTypes / coalesce / propagate / packData / fold /
  peephole / vacuum / mergeBlocks / brif / loopify / inlineOnce / …). `inline`
  stays off per watr's own default — opt-in only; can duplicate bodies. L3 no
  longer needs an "inlining bonus" — its preset reads truthfully as L2 + larger
  array/hash initial caps + `hoistConstantPool` off.

* [x] **jz csePureExpr snapId — high-water mark, not first gap** (`fed07f8`).
  watr's full `coalesceLocals` removes redundant locals, so the surviving
  `$__pe<N>` set is non-contiguous; the old first-gap allocator picked an
  already-live id and triggered "Duplicate local $__pe20" on mat4. Fixed by
  scanning all surviving cse-pure-expr locals for a high-water mark.

* [x] **17 codegen-shape tests rewired to `optimize: { watr: false }`**.
  Tests in `test/{types,closures,features,feature-gating,optimizer,inference}.js`
  verify jz's compile-time decisions (slot-type dispatch, narrowed return
  types, closure-unbox declarations, escape-analysis allocations, LICM snap
  locals, sourceInline skip-into-export, charCodeAt i32 propagation, …) — not
  watr's downstream cleanup. With full watr running at L2, `inlineOnce` would
  fold non-exported helpers into their lone caller and `treeshake` would erase
  them, so a `(func $mk …)` regex no longer matched. Probe call sites now opt
  out of watr explicitly, making the intent visible at each call.

* [x] **Subscript / watr dead-code workarounds dropped** (`8ef4b46`, `4f9e64a`):
  trailing-null pop in `'()'` emit (closed by subscript 10.4.13's S12 fix) and
  the W5 unsigned-hex `i64.const` dance (closed by watr 4.6.8 handling signed
  hex strings directly). Workaround tag in `prepare.js` 1768–1777 (S2 `new`
  precedence) and the IIFE/labeled-stmt patches in `jzify.js` remain — gated
  on the next subscript release.

bumps: `subscript 10.4.12 → 10.4.13`, `watr 4.6.8 → 4.6.9`.
tests: 1759/1759 unit; 81/81 bench-shape; bench parity holds.

### test262 language tail + native-gap audit (2026-05-19)

* [x] **5 language fails → 0** (language suite 1423→1429, baseline bumped).
  Three codegen defects + one harness boundary fix — `fix:` commit `117fbd0`:
  - comma Expression in a for-in/of head (`for (x in A, B)`) — `jzify.js`
    `normalizeForDeclHead` generalized + new `normalizeForCommaHead` fold the
    trailing operands back into the iterated source; internal crash eliminated.
  - `[,]` / `[1,,]` array elisions — `prepare.js` `'[]'` over-trimmed a trailing
    `null`; jessie already consumes the trailing comma, so every residual `null`
    is a genuine hole. Trim removed.
  - `dedupeRedecls` read only the first name of a multi-name bare `let`, leaking
    a redeclaration when a hoisted function `const` shared the name. Now walks
    every declarator.
  - `test262.js` ASSERT_HARNESS terminated with `;` — works around a subscript
    ASI bug (no semicolon after an arrow block body before `(`). Upstream
    subscript bug — repro belongs in plan Part 1.
* [x] **crc32 vs native** — wasm-v1 floor. jz 11.95 ms = 1.12× clang -O3, beats
  V8 (13.34 ms). Native's edge is the SSE4.2 `crc32` hardware instruction; SIMD
  folding needs carryless multiply (`clmul`, a separate wasm proposal). The CRC
  accumulator is strictly loop-carried — `vectorizeLaneLocal` correctly declines.
  No jz codegen change available; scalar table-driven is optimal.
* [x] **mandelbrot vs AS** — wasm-v1 algorithmic floor (no scalar `fma`),
  proposal-blocked. (`interference` / `game-of-life` are not in the bench suite.)
* [x] **f64 cross-array-map vectorization** — `optimize:` commit `b3bd828`.
  `vectorizeLaneLocal` now sees through the CSE'd offset-tee a map `b[i]=f(a[i])`
  over two base pointers produces (`(local.tee $T (i32.shl i K))` then
  `(local.get $T)`). New `matchLaneOffset` + `_offsetLocalStride` soundness gate
  in `src/vectorize.js`, wired into `tryVectorize` + `tryReduceVectorize`. f64
  cross-array map loops now emit `f64x2`; tests in `test/simd.js`. AoS-write and
  i32 mixed-width remain — see Live work › "native-gap audit".

### Generality track — Step 3 (2026-05-19)

* [x] **Slice views.** `__str_slice_view` / `SLICE_BIT` returns a no-copy view
  into the parent buffer when escape analysis proves the slice never outlives
  it; falls back to copy for SSO parents or oversized lengths.
* [x] **Literal interning.** `dataDedup` / `strPoolDedup` pool string-literal
  data segments — equal literals share one offset, compare by pointer.
* [x] **`s[i] === 'X'` no-alloc charcode compare** (`emitSingleCharIndexCmp`).
* [x] **`<str>.{substr,substring,slice}(…) === <other>` no-alloc** (`8b74dce`).
  `emitSubstringEqCmp` peepholes the call-↔-value pair to `__str_{substring,
  slice}_eq`, which clamp the range exactly like the method then byte-compare
  it against `other` in place. `__str_range_eq` type-checks only `other` (a
  substring method's receiver is always a string), mirroring `__eq`'s
  STRING-vs-? arm. `substr`/`substring` name string-only methods so unknown
  receivers are safe; `slice` requires a statically-known STRING receiver
  (else dispatches to array slice).
* [x] **Runtime scanned-identifier intern table — declined as speculative.**
  Audited real workload (`subscript/parse.js:73,98,150`,
  `subscript/feature/comment.js:16,19`, `bench/jessie`): every
  `substr`/`substring`/`slice` is inline with `===`/`!==` already, which the
  substring-eq peephole above covers no-alloc. No `let id = src.substr(...);
  if (id === "x") else if (id === "y")` pattern in any current corpus. Re-open
  only if a real bench surfaces the bound-then-multi-compare shape as a hot path.

### i32 map-loop audit (2026-05-19)

* [x] **Idiomatic i32 map-loops already vectorize.** Probed `((a[i]|0) * 2 + 1)
  | 0` and `Math.imul(a[i], 2) + 1` over `Int32Array`: the full path composes —
  typed-array carrier inference (`src/analyze.js` `typedElem`, `module/typedarray.js`
  `.typed:[]` / `.typed:[]=`) lowers `state[i]` to direct `i32.load`/`i32.store`,
  watr inlines the kernel into the caller's carrier scope, and the existing i32
  lane vectorizer (`src/vectorize.js`) lifts the body to `i32x4.*`.
* [x] **Plain `a[i] * 2 + 1` (no `|0`) stays scalar — by spec.** JS forces f64
  math and ECMAScript ToInt32 (modular wrap) at the store. Wasm-v1 SIMD ships
  only `i32x4.trunc_sat_f64x2_*_zero` (saturate); relaxed-SIMD is also saturate
  (implementation-defined for out-of-range). A wrap-trunc lane requires a
  manual modular sequence that erases the speedup. Pragmatic answer: use `|0`.
  Not a residual jz codegen gap.

### Generality track — Steps 1, 2, 4 (2026-05-19)

* [x] **Step 1 — use-summary substrate** (`a11578f`..`88bdb52`). The original
  "four escape analyses, fragments of one analysis" framing was partly
  illusory: `scanFlatObjects`/`scanSliceViews`/`unboxablePtrs` *were* three
  redundant standalone body re-walks, but `analyzeBody.escapes` is context-
  sensitive taint woven into the typing walk (separating it would *add* a
  traversal) and `analyzeStructInline` is whole-program post-representation.
  Honest unification: `scanBindingUses` (`analyze.js`) — one traversal
  classifies every binding mention into a closed `USE.*` taxonomy; the three
  real consumers became *policies* (subset predicates). ~6 body traversals → 1.
  `escapes` / `analyzeStructInline` stay separate (boundary in the doc comment).
* [x] **Step 2 — function-namespace SROA** (`9b538d7`). `analyzeFuncNamespaces`
  + `flattenFuncNamespaces` dissolve `parse.space = …` property tables on a
  non-escaping function value into f64 module globals; reads → `global.get`.
  Escaping / computed-indexed namespaces keep the dynamic path. ns-repro
  105 KB → 45 KB WAT, all `__dyn_*` gone.
* [x] **Step 2 — object/dict SROA extended.** `scanFlatObjects` Pass 1.5 admits
  monotonic literal-key field extensions (`o.newProp = …` on a non-escaping
  object literal → extra flat field, `undefined`-init at decl). Field universe
  stays statically closed (computed-key / off-schema / `delete` disqualify).
* [x] **Step 2 — devirtualization** (`31253b6`). Audited the `call_indirect`
  surface: every *non-escaping* function binding was already devirtualized —
  local `const`/`let` lambdas (inlined when small, else direct-call dispatch,
  emit.js A3) and top-level function-namespace slots (`flattenFuncNamespaces`
  SROA → `devirtGlobalCalls`). One real gap: a *forwarder* `(g,x) => g(x)` —
  inlining it substitutes the param with the call-site argument, collapsing an
  indirect call to a direct `call` — was blocked from exported callers by a
  tier-up heuristic that only ever concerned loop kernels. `inlineHotInternalCalls`
  now marks forwarders and lets them cross into exports; `HOF param call` /
  `fn passed as arg` emit zero `call_indirect`. What stays indirect is genuine
  escape (function returned / array-stored / conditionally reassigned to >1
  target) — removable only by watr inlining (Part 3, upstream-gated) or
  interprocedural escape analysis, neither a body-local proof jz can make. The
  dominance / last-write proof the original framing imagined has no measured
  workload demanding it (the namespace SROA already covers top-level init
  writes) — not built, not minimal.
* [x] **Step 4 — memory scalar-replacement** (`3055e4c`). Carr & Kennedy
  register promotion behind `cseSafeLoadBases` (`analyze.js`), an emit-side
  non-aliasing whitelist (unboxed pointer, bound once, read-receiver-only,
  alloc kind disjoint from every store target). `aos`: 6 field reads → 3
  `f64.load`; `jz → V8 wasm` 0.99 ms / 0.82× — faster than native C (1.21 ms)
  and hand-WAT (1.07 ms). Standalone gate, not the Step-1 substrate.

### Execution plan — Phase 0 + Steps 1–6 (resolved 2026-05-17)

* [x] Phase 0 (declarative reorg, C1–C3) — emitter-table spine; redirected once
  the builtins audit showed an empty in-scope tail, kept as a structural refactor.
* [x] Steps 1–6 — Step 1c leaf builtins (one table row each), Step 2a
  correctness commit, Step 3 narrowing-evidence survey (`.work/narrow-findings.md`:
  numeric/typed-array benches at zero fallbacks, only watr has any). Step 4
  (number carrier dispatch) redirected — the i32|f64 choice is a working 1-bit
  decision on `node.type`; a carrier table would re-encode it with one consumer.
  Step 5 object carrier landed (see "Object layout carrier" below). Step 6 descoped.
* [x] `src/abi/array.js` — landed: `taggedLinear` default + `structInline` SRoA
  carrier (see "structInline SRoA carrier" below).
* [x] `ctx.features` cleanup (39beeb2) — `hash`/`regex`/`json` dead flags deleted.
* [x] Infer rungs 6 & 8 — rung 6 (`x === null` flow-narrowing) out of scope (no
  nullable-rep consumer); rung 8 (name heuristic) declined (silent-miscompile risk).
* [x] test262 in-scope-correctness audit (ea1ce43) — all 96 builtins "fails" are
  out-of-scope-by-design; runner buckets 34 skip + 62 xfail + 0 fail, CI gates
  `fail > 0`. Hygiene items folded in.

### structInline SRoA carrier + collection-method dispatch fix (2026-05-17)

* [x] `structInline(K)` carrier (`src/abi/array.js`) — an `Array<{uniform K-field
  schema}>` whose element pointers never escape inlines K f64 schema fields into
  the array data region (stride K), no per-row heap object. Whole-program
  default-disqualify analysis `analyzeStructInline` → `ctx.schema.inlineArray`.
  Header `len`/`cap` count physical f64 cells, so the stride-8 stdlib helpers are
  reused untouched. Closes the `aos` native gap (1.13 → 0.94 ms, checksum
  unchanged). Commits `2be7974` (carrier), `c455ffc` (analysis), `438eeb6` (codegen).
* [x] Collection-method dispatch fix (`d70ec66`) — a zero-arg call of a
  collection-named method (`get`/`set`/`has`/`add`/`delete`) on a
  not-proven-collection receiver (`new C().get()`) no longer falls to the Map/Set
  emitter (which `emit()`-ed a missing key arg and crashed codegen); a
  `COLLECTION_METHODS` set + `collectionMisfit` gate in `emit.js` routes it to
  closure/dynamic dispatch. Test pin in `test/classes.js`.

### Object layout carrier — src/abi/object.js

* [x] 5a. `tagged` carrier (today's layout: `__alloc_hdr` + N×8-byte f64 slots).
  Every object-field site across module/{object,core,array,json}.js +
  src/{emit,ir}.js routed through `ctx.abi.object.ops` (`allocSlots` / `load` /
  `loadBits` / `store`) — two duplicate address helpers (`slotAddr`,
  `emitSchemaSlotRead`) collapsed into one owner. Byte-identical: 19-snippet
  binary-diff proof (identical sha256 wasm). Two over-fitted WAT-text tests
  (inference.js, perf.js) adjusted to read non-zero schema slots.
* [x] 5b-flat. `flat`/SRoA carrier — a non-escaping `let/const o =
  {staticLiteral}` binding is dissolved into plain WASM locals (`o#0`, `o#1`,
  …): no `__alloc_hdr`, no heap, no field load/store; `o.prop` → `local.get`.
  `scanFlatObjects` (analyze.js) conservative eligibility scan — eligible iff
  `o` appears only as a literal-key in-schema `.`/`[]` read or write LHS; any
  escape (bare ref, dynamic key, off-schema prop, `?.`, reassign, compound,
  `++`/`--`, delete, closure capture, self-ref, dup keys, re-decl)
  disqualifies. Dead `o` local dropped so a stray `local.get $o` is a loud
  wasm error. 5 codegen hooks (emitDecl + `.`/`[]` read & write). `let
  o={a:1,b:2,c:3}; o.a+o.b+o.c` folds to one `i32.const`.
* [~] 5b-packed. i32-narrowed 4-byte field cells — DESCOPED 2026-05-17:
  uniform 8-byte f64 shapes are fine, memory compression is not a goal. Would
  need a stricter `slotI32Certain` (i32-range, not integer-shaped) analysis +
  layout-aware rewrites of every uniform-slot walk. Revisit only if a bench
  demands it.

### Jessie compilation blockers (see [.work/jessie-wasm.md](jessie-wasm.md))

* [x] #1 spread in `?.()` — `fn?.(...args)`
* [x] #2 Error subclasses (`SyntaxError`/`TypeError`/`RangeError`/`ReferenceError`/`URIError`/`EvalError`)
* [x] #5 CLI bare side-effect imports `import './x.js'`
* [x] #6 `new RegExp("lit")` literal pattern + clean error for dynamic
* [x] #7 `Object.create` stdlib include — `array` module wasn't pulled in for `__arr_from`
* [~] ~~#3 `Object.defineProperty(obj, k, {get, set})` — needs accessor-property design~~
* [x] ~~#4 `delete obj[k]` on dynamic-keyed objects — touches static-shape model (eval-only; parse-only jessie no longer needs it)~~
* [x] #8 computed object property keys `{[k]: v}` — lowered in prepare to `((t) => (t[k1]=v1, …, t))({static_only})`, side-effects preserved; numeric→string key coercion still gappy on read (separate follow-up)

### Product / Validation

* [x] Options breakdown in readme
* [x] Implement `Date.UTC` as first deterministic slice
* [x] Add minimal Date time-value object (`new Date(ms)`, `.getTime()`, `.valueOf()`, `.setTime(ms)`)
* [x] Add UTC getters: `getUTCFullYear`, `getUTCMonth`, `getUTCDate`, `getUTCDay`, `getUTCHours`, `getUTCMinutes`, `getUTCSeconds`, `getUTCMilliseconds`
* [x] Add UTC setters: `setUTCFullYear`, `setUTCMonth`, `setUTCDate`, `setUTCHours`, `setUTCMinutes`, `setUTCSeconds`, `setUTCMilliseconds`
* [x] Add deterministic UTC stringification: `toISOString`, `toUTCString`

### Validation & quality

* [x] JS-equivalence audit for dynamic property writes
* [x] Excellent WASM output
* [x] wasm2c / w2c2 integration test

### Escape analysis for short-lived literals

* [x] Pattern peephole: `[a,b]=[b,a]` → scalar array-literal destruct lowering in prepare; 0.7ms → ~0.2ms
* [x] Mark each allocation site `escapes: bool` during prepare/analyze
* [x] Non-escaping objects: scalar replacement for short local object literals
* [x] Non-escaping arrays: scalar replacement for short local array literals; spread concat 0.9ms → <0.1ms
* [x] Non-escaping that can't be scalar-replaced: arena rewind with module-level transitive safety analysis
* [x] Test pin: `destruct swap` perf ~0.2ms, codegen asserts no array allocation

### Per-function arena rewind

* [x] Static analysis: `arenaRewindModule` computes safe callee set
* [x] Codegen: emits heap save/restore for safe subset
* [x] Safe subset rejects pointer returns and non-number f64 returns
* [x] Test pin: watr benchmark at 0.99ms vs V8 1.01ms
* [x] Earlier global `_clear()` attempt broke watr; per-call scoped version is safe

### Inline cache for polymorphic shape sites

* [x] Rejected: per-call-site cache `lastSchemaId | slot0 | slot1` — slower than base
* [x] Rejected: fast path schema match → direct slot load — not worth keeping
* [x] Rejected: slow path hash lookup + cache update — overhead outweighed savings
* [x] Rejected: focused bimorphic object-shape perf pin — no win over OBJECT-typed dispatch fix

### Stack-allocated rest-param arrays for fixed-arity sites

* [x] Specialize fixed-arity internal calls so rest reads scalarize to params
* [x] Rewrite call sites to `fn$restN(arg0..argN)` clones
* [x] Test pin: `rest sum` perf 2.7ms → ~0.6ms (4.5×)

### SIMD auto-vectorization for typed-array reductions

* [x] Pattern-detect simple typed-array reductions with no loop-carried scalar deps
* [x] Emit `f64x2` / `f32x4` / `i32x4` ops via default optimizer (level 2)
* [x] Skip when feedback dep present (e.g. biquad cascade)
* [x] Test pin: `typed sum` perf 4.2ms → ~2.2ms (1.9×)

### Smaller wins

* [x] Tail-call optimization — `return_call` through `tcoTailRewrite`; `sum(100000)` no longer overflows
* [x] Loop unrolling for small constant trip counts (≤8)
* [x] Constant-fold across closure boundaries
* [x] Peephole: i32↔f64 boundary minimization

### Performance — closing the native-language gap

* [x] wasm SIMD-128 emission — generalized lane-local vectorizer
* [x] Monomorphic-call specialization (poly)
* [x] mat4 exact-kernel specialization removed
* [x] Remove exact benchmark specialization + harden benchmark (mat4)
* [x] Cross-function scalar replacement (caller→callee), with tier-up guard
* [x] SIMD vectorization for fixed-size f64 matrix multiply
* [x] Hoist loop-invariant scalar conversions for vectorized dot pairs
* [x] Fixed-size typed-array scalar replacement extended past Float64Array — Int32/Int16/Uint16/Int8/Uint8 views now scalar-replace to wasm locals with correct store-coercion (`|0`, `<<16>>16`, `&0xFFFF`, `<<24>>24`, `&0xFF`); coerced types stay local-only — any escape keeps the heap alloc (mirror/fence can't track alias writes). `4918e02`
* [x] `optimize: 'size' | 'speed' | 'balanced'` string aliases over the size↔speed unroll/scalar knobs `8ca6f18`
* [x] Closed as low-value: Float32Array / Uint8ClampedArray / Uint32Array scalar replacement (Float32 needs `Math.fround` ⇒ `math` module pulled at plan time; Uint8Clamped is round-half-even; Uint32 range >2^31 collides with jz's i32 narrowing of `x>>>0`) — edge semantics, no measured win
* [x] Closed as low-value: partial unroll + f64x2 vector body for mat4 — inner loops are constant-trip 4×4×4; full unroll + f64x2 dot-pairing already runs mat4 at 0.78× native C
* [x] Closed as low-value: json arena/raw-u8 fast path — bench already ≈1.0× native C; the residual micro-gap (transient `kbuf` in `__jp_obj` never rewound, per-node `__alloc`) needs a parser value-shape redesign for marginal gain
* [x] Closed as low-value: source/runtime array-view optimization for `normalize()`-style local queue arrays — needs a source refactor or escape-analysis extension (also noted in "Size — closing the AS gap" archive)

### Competitive size/speed gate

* [x] **sort (heapsort) ~8.6× → V8 parity** — `narrow.js` soft-fixpoint over `runArrElemFixpoint` + `refreshCallerLocals` seeding pointer-narrowed param val-kinds; typed-array param propagation now reaches 3-deep call chains.
* [x] **`Math.round` JS-parity** — ties-toward-+∞ (was ties-to-even via `f64.nearest`).
* [x] **`Math.imul`/`Math.clz32` operand coercion** — ECMAScript ToInt32 (wrapping) instead of saturating.
* [x] **All `bench/bench.mjs` at `optimize: { level: 'speed' }`** — fixed two upstream watr optimizer bugs: `inlineOnce` zero-init leak (substitution into already-used target local) and `propagate.substGets` sibling-eval leak (pre-tee constants leaking across siblings). Mandelbrot stays at wasm-v1 algorithmic floor (no scalar `fma`); revisit if `fma` proposal lands.

### i64-tagged carrier switch — investigated, closed wontfix

* [x] Spike + codegen survey (`.work/i64-spike/`). No measurable perf or size win: NaN-box encoding mandatory for raw-f64-bit numbers (no payload headroom); jz already uses unboxed i32 pointer locals (cheaper than i64); reinterpret count is fixed runtime plumbing not per-hot-op; i64-local microbench 1.49× slower; JSON WALK 1.01×, PARSE 0.76×. Boundary simplification not worth the carrier refactor.
* [x] i64 host import sigs landed and kept: `setTimeout` cbPtr, `__ext_prop`/`__ext_has`/`__ext_set`/`__ext_call`, `globalTypes` for i64 host globals, user `opts.imports` sigs.

### JZ-side prep

* [x] Host-import mode — `compile({ host: 'js' | 'wasi' })`
* [x] `setTimeout` / `setInterval` host-driven
* [x] `import.meta`: static `import.meta.url`, `import.meta.resolve("...")`
* [x] Aggressive monomorphic single-caller inlining for hot internal functions
* [x] Couple constant-argument propagation with inlining/unrolling
* [x] Audit typed-array address/base fusion on EdgeJS benchmark
* [x] Bounds-check elision hints for monotone typed-array loops — closed as research-only
* [x] i32 narrowing for integer-heavy kernels — reverted; V8 inliner regression

### Concrete size cuts

* [x] Drop unconditional `inc('__sso_char', '__str_char', '__char_at', '__str_byteLen')`
* [x] Break `MOD_DEPS` cycle `number ↔ string` at `prepare.js:1054`
* [x] Strip data segment for non-emitted strings
* [x] Replace `wasi.fd_write`/`clock_time_get` with `env.printLine` / `env.now`

### Concrete optimizations

* [x] Scalar-replacement of repeated typed-array reads
* [x] Aggressive inlining for monomorphic single-caller hot funcs
* [x] i32 narrowing for module-const integer args (revisit nStages) — reverted
* [x] Loop-invariant hoist of `arr.length` — verified already hoisted
* [x] Bounds-check elision for monotone counters — closed as research-only
* [x] Symmetric widen-pass for length comparisons — closed

### Benchmarks

* [x] Polymorphic reduce benchmark
* [x] fib / ackermann — TCO now implemented

### EdgeJS integration

* [x] Keep safe-mode out of PR claim
* [x] Pick one undeniable use case and optimize around it
* [x] Add benchmark coverage beyond internal examples
* [x] Add wasm2c/w2c2 integration tests
* [x] Rework/close PR #2
* [x] Harden `jz/wasi` default output routing
* [x] Add tests for stdout/stderr fallback
* [x] Do not publish `instantiateAsync`
* [x] Document host contract in README
* [x] Add EdgeJS-compatible smoke fixture
* [x] Build/install EdgeJS locally and verify basic JZ usage
* [x] Verify EdgeJS safe mode behavior
* [x] Verify JZ modules with no WASI imports run in EdgeJS without polyfill
* [x] Verify explicit console host imports under EdgeJS
* [x] Check WASM exception support in EdgeJS — blocked, documented
* [x] Open PR to `wasmerio/edgejs` as example/benchmark
* [x] Add `examples/jz-kernel`
* [x] Include README note: JZ is useful for hot numeric, DSP, parser, typed-array kernels
* [x] Include before/after numbers from reproducible commands
* [x] Fix draft benchmark shape: compile once, call one export, keep hot loop inside WASM
* [x] Replace toy scalar benchmark with stronger kernel from existing suite
* [x] Move `/tmp/jz-edgejs.../examples/jz-kernel` into clean EdgeJS branch
* [x] Reinstall example dependency from clean checkout and rerun
* [x] Decide CI shape: documented example only
* [x] Draft PR description around narrow contract
* [x] `npm test` passes after host/WASI changes
* [x] `npm run test262:builtins` still passes
* [x] EdgeJS local smoke run passes in native mode
* [x] EdgeJS safe-mode result known and written down
* [x] Final integration story: "Use JZ inside EdgeJS to compile hot JS-subset kernels to WASM; EdgeJS remains the JS runtime."

### test262 coverage expansion

* [x] Report overall test262 percentage against all `test262/test/**/*.js` files
* [x] Fix object destructuring assignment regressions
* [x] Add/enable `rest-parameters` tests
* [x] Add/enable `computed-property-names` object tests
* [x] Add/enable `arguments-object` tests where jzify supports them
* [x] Add lexical/grammar coverage: `asi`, `comments`, `white-space`, `line-terminators`, `punctuators`, `directive-prologue`
* [x] Lower braced `do-while` through jzify without body duplication
* [x] Keep `delete` prohibited for jz fixed-shape objects
* [x] Treat `debugger` as parse/no-op
* [x] Broaden local test262 harness (`assert.*`, `Test262Error`, `compareArray`)
* [x] Add/enable ordinary `template-literal` coverage
* [x] Fix optional catch binding parser support (`catch { ... }`)
* [x] Add/enable simple `for-in` coverage
* [x] Revisit broader `arguments-object` coverage — closed
* [x] Keep broad unsupported buckets out of scope (`async`, generators, iterators, `with`, `super`, dynamic import)
* [x] `class` lowering via jzify (constructor + instance fields + methods + `new` + `this`, no `extends`/`super`/`static`/accessors/computed names — rejected with clear errors). Instance = plain object, methods = per-instance arrows capturing it, `this` renamed to that object, `new C(a)` → `C(a)`. `test/classes.js` + `language/{expressions,statements}/class/` wired into the test262 runner with a feature-skip pass (`isClassTest`/`CLASS_EXCLUDED_PATTERNS`): +125 passing class tests, 0 failing.
  * [x] Fixed (`d70ec66`): `new C().get()` chained directly on a `new`/call
    expression no longer crashes when the method name is a collection method
    (`get`/`set`/`has`/`add`/`delete`). `emit.js` gates the generic collection
    emitter behind `collectionMisfit` — a zero-arg collection-named call on a
    not-proven-collection receiver falls through to closure/dynamic dispatch
    instead of `emit()`-ing a missing key arg. Test pin in `test/classes.js`.
* [x] Triage remaining test262 language failures → 0 failing (827 passing). Added path-based skip rules in `test/test262.js` for out-of-scope buckets: property-descriptor semantics (compound-assignment `11.13.2-23..44-s`, logical-assignment `*-non-writeable*`/`*-no-set*`, `types/reference/8.7.2-{3,4,6,7}-s`, `for-in/order-after-define-property`, `spread-obj-skip-non-enumerable`), strict-mode undeclared-ref + RHS-eval order (`compound-assignment/S11.13.2_A7.*_T{1,2,3}`), huge-Unicode-identifier parser-stack overflow (`identifiers/start-unicode-{5.2.0,8,9,10,13,15,16,17}.0.0`), block-scope let-shadows-parameter (`block-scope/leave/*-block-let-declaration-only-shadows-outer-parameter-value-{1,2}`), `for-in/head-var-expr`, computed-member assign to null/undefined (`assignment/target-member-computed-reference*`), `coalesce/abrupt-is-a-short-circuit`, `typeof/string` (Date), `try/completion-values-fn-finally-normal`, `{expressions,statements}/function/arguments-with-arguments-lex` (param default referencing `arguments` while body lexically shadows it).
  * [x] **Fixed in jzify** (not skipped): redundant re-declarations within a scope (`function f(){} var f;`, `var f; function f(){}`, `var x = 3; var x;`) — `dedupeRedecls` in `transformScope`'s `;` handler keeps the first binding, turns a later `let name = init` into a plain assignment. Was a typed-slot clash in codegen.
  * [x] **Fixed in jzify** (not skipped): `var arguments;` / `let arguments` — a body that declares its own `arguments` local is an ordinary variable, not the implicit object: `bindsArguments` makes `lowerArguments` rename it out of jz's reserved set with no rest param synthesized (was "Duplicate local"). Regression tests in `test/test262-regressions.js`.

### Core infrastructure

* [x] Add compile-time benchmark (parse / prepare / plan / emit / watr)
* [x] Benchmark cold vs repeated template compilation
* [x] Fast-path tiny scalar programs: skip expensive whole-program narrowing when no callsites/closures/dynamic keys/schemas/first-class functions
* [x] Skip schema slot observation passes when no static object-literal schemas collected
* [x] Keep function-name membership current during prepare
* [x] Replace repeated `analyzeBody` invalidation/re-walks in `narrow` with versioned fact slices
* [x] Collapse duplicated callsite fixpoint passes into one lattice runner
* [x] Reuse caller fact maps across narrowing phases
* [x] Delay expensive typed-array bimorphic clone analysis unless param is proven `VAL.TYPED` with conflicting ctor observations
* [x] Avoid remaining module init body scans after autoload when loaded modules don't introduce facts
* [x] Fail with error on unsupported syntaxes (class, caller, arguments etc)
* [x] Remove `compile.js` as re-export hub
* [x] Split pre-emit planning into `plan.js`, signature specialization into `narrow.js`, autoload policy into `autoload.js`, static key folding into `key.js`
* [x] Keep `plan.js` separate from `analyze.js`
* [x] Make `narrow.js` read as named phases inside one file
* [x] Move per-function pre-analysis out of `emitFunc`
* [x] Replace hidden global cache invalidation with explicit phase inputs/outputs
* [x] Audit `prepare.js` for hardcoded runtime-module policy
* [x] Do not recreate convenience facade in `compile.js`
* [x] Static string literals → data segment (own memory); heap-allocate for shared memory
* [x] Metacircularity prep: Object.create isolated to `derive()` in ctx.js
* [x] Metacircularity: watr compilation — 8/8 WAT, 7/8 WASM binary, 1/8 valid
* [x] Metacircularity: watr WASM validation — all 5 watr modules validate
* [x] Metacircularity: watr WASM execution — jz-compiled watr.wasm compiles all 21 examples
* [x] console.log/warn/error
* [x] Date.now, performance.now
* [x] Import model — 3-tier: built-in, source bundling, host imports
* [x] CLI import resolution — package.json "imports" + relative path auto-resolve
* [x] Template tag — interpolation of numbers, functions, strings, arrays, objects
* [x] Custom imports — host functions via `{ imports: { mod: { fn } } }`
* [x] Shared memory — `{ memory }` option, cross-module pointer sharing
* [x] Memory: configurable pages via `{ memory: N }`, auto-grow in __alloc, trap on grow failure
* [x] Benchmarks: jz vs JS eval, assemblyscript, bun, porffor, quickjs
* [x] Benchmarks: key use cases (DSP kernel, array processing, math-heavy loop, string ops)

### Size — closing the AS gap

* [x] Identify watr-specific perf blockers with benchmark evidence
* [x] Tried inlining known-ARRAY `.shift()` forwarding logic — rejected (grew code, no win)
* [x] Landed safe monomorphic piece: known-ARRAY `.at(i)` reads header length directly
* [x] Checked extra-head-offset array representation — not worth default header cost
* [x] Implemented safe receiver-fact pieces: known-ARRAY `.map`/`.filter`, numeric indexing, spread
* [x] Landed watr token-test fast path: `x[0] === '$'` compares bytes directly
* [x] Rejected two adjacent follow-ups after benchmarking (non-string fallback, string-literal equality helper)
* [x] Rechecked local queue-view/source-transform proposal for `normalize()` — needs source refactor or escape analysis

### Completed perf / cleanup wins

* [x] Induction-variable strength reduction — investigated, REJECTED
  (2026-05-18). A `strengthReduceIV` WAT pass passed all tests but A/B-benched
  perf-NEUTRAL: V8 TurboFan already strength-reduces, and `aos` is memory-bound
  so address arithmetic is free. The real `aos` residual is 6-vs-3 redundant
  `f64.load`s — memory scalar-replacement (Generality Step 4), not IVSR. Reverted.
* [x] F.1 — `for-in` over known-schema unrolling — unroll now carries a loop
  frame (`b716b22`).
* [x] Trampoline arity bug — uniform closure-table width (`ctx.closure.width`) was sized by max call-site/arrow-def arity, but boundary trampolines for first-class function *values* forward `$__a0..$__a{arity-1}` (lifted func defs slip past the arity scan, which walks bodies not param lists). An arity-3 function used only via a 1-arg indirect call emitted `(local.get $__a2)` against a 2-param trampoline → `Unknown local $__a2` at assemble time. Fix in `resolveClosureWidth`: also `max` over `programFacts.valueUsed` funcs' `sig.params.length`. + test pin in `test/closures.js`.
* [x] Lazy `__length` dispatch
* [x] Specialize `console.log(template literal)` — flatten concat chain to per-part writes
* [x] Re-observe schema slots after E2 valResult
* [x] Plain array growth does not move dynamic prop side-tables
* [x] Suppress runtime allocator exports for host-run standalone benches
* [x] Do not unroll outer nested constant loops
* [x] Owned typed-array `.byteOffset` constant-folds to zero
* [x] Skip `__ftoa` for integer-valued `console.log` args
* [x] Host-import return metadata for `jz-host`
* [x] Sort benchmark samples in place
* [x] Known-string concat skips generic `ToString`
* [x] TCO via `return_call` for expression-bodied arrows
* [x] i32 chain narrowing through user-function returns — callback 0.060ms → 0.015ms (4×)
* [x] Boundary boxing — narrow internal sigs, rebox at JS↔WASM edge
* [x] Watr inliner soundness fix (upstream)
* [x] AST helper consolidation
* [x] Fixpoint runner consolidation
* [x] `.charCodeAt(i)` returns i32 directly — tokenizer 0.14 → 0.07ms (2×)
* [x] Inline `arr[i]` fast path with known elem schema — aos 3.94 → 3.48ms
* [x] LICM soundness — bail on calls + skip shared subtrees
* [x] `arrayElemValType` propagation through `.map` — callback 5.09 → 3.46ms
* [x] Math.imul / Math.clz32 return i32 directly — bitwise 30.96 → 6.09ms (5×)
* [x] Cross-function arrayElemSchema propagation (aos) — 9.79 → 4.02ms (2.4×)
* [x] Per-iter base CSE — hoistAddrBase pass
* [x] Skip `__is_str_key` on VAL.ARRAY when key is known-NUMBER
* [x] Bimorphic typed-array param VAL.TYPED propagation (poly) — 6.65 → 5.52ms
* [x] arrayElemValType propagation through .map → callback param (callback)
* [x] LICM pass for boxed-cell loads — sound version
* [x] Bimorphic typed-array param specialization — function cloning (poly) — 5.06 → 1.13ms (4.4×), ties AS
* [x] Post-link DCE / dead-import & dead-function pruning in assemble
* [x] Callback/combinator 6-way fusion in optimizer
* [x] watr regression — `v128.const i64x2` lowering fix (`6186dcd`)

### Dynamic-property machinery in jz-compiled watr

* [x] `__set_len` calls inlined to direct header `i32.store`
* [x] `__typed_idx` ARRAY fast path (skip type re-dispatch on known-ARRAY receivers)
* [x] Generic hash-probe loop tightening — additive slot walk, drop per-iter `i32.mul` (`c1ce0a0`)
* [x] Additive probe walk in `__dyn_get_t_h` props loop (`a8b7976`, +12 B)
* [x] Prehash constant `.prop` / `?.prop` keys — `__dyn_get_t` is a thin wrapper over `__dyn_get_t_h(obj,key,type,h)`; new `__dyn_get_expr_t_h`; sites pass compile-time `strHashLiteral(prop)` → no `__str_hash` per access (`1790cb7`, +0.27% wasm, checksum stable). Also fixed latent `needsSchemaTbl` gap (now keys on `__dyn_get_t_h` / `__dyn_get_expr_t_h`).
* [x] Rejected: N-way global dyn-get cache — 1-way already hits the dominant "same object, many keys" pattern (`INSTR[op]`); 4-way = ~9 globals + ~250 B for unmeasurable gain
* [x] Rejected: static-segment off-16 props slot for object/array literals — watr's hot dyn-prop receivers (`ctx`, AST nodes) are heap arrays that already use off-16 header slots; relaxing the `off >= __heap_start` guard is high-risk for no return

### JSON optimizations

* [x] VAL.HASH valType + JSON.parse annotation
* [x] Nested HASH/array shape propagation
* [x] Static `JSON.parse(stringConst)` lowering
* [x] Constant-fold `__str_hash` for SSO literals
* [x] Hoist type-tag check across same-receiver prop reads
* [x] Specialize constant-key Map lookups (`__map_get_h`)
* [x] JSON benchmark made honest (no exact-shape specialization)
* [x] `\uXXXX` escape decoding in `__jp` string scanner

### Type system / codegen architecture

* [x] Unified Type record (`ValueRep`) — collapsed ptrKind/ptrAux/globals/val/schemaId into `repByLocal`/`repByGlobal`
* [x] `intCertain` forward-prop lattice + codegen rules (`toNumF64` skip, `Math.floor/ceil/trunc/round` elide)
* [x] Per-emitter short-circuit migration for `__to_num`, unary `+`, `isNaN`/`isFinite`, `Number()`, `Math.*`
* [x] Parallel-map dedup, dead helpers removed (-697 lines compile.js, +568 analyze.js)
* [x] Unboxed-by-default ABI inversion — closed as architecture backlog
* [x] Per-stage base hoisting + `offset=` fusion
* [x] General `offset=` immediate fusion
* [x] Constant-arg propagation (without unroll)
* [x] Rejected: intConst-driven i32 loop narrowing for biquad — V8 inliner regression
* [x] Small-trip-count loop unroll on top of intConst
* [x] Tail call optimization
