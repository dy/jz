# Scout 7: value passes of src/optimize, mapped for phase 7

Tree: `git archive main` of 3420027ce (export at `scout-7/tree`, with two instrumentations in
`src/optimize/pass-table.js` only: `on()` honours `globalThis.__SKIP` (a set of step ids), and
`fired()` records which steps changed their input; neither touches pass logic).
Legend: READ = established by reading source; RAN = established by running.

## 1. Inventory

All line counts from `wc -l`. "Stage" and flags are the pass-table entries (src/optimize/pass-table.js).
`+x` flag = on only when the config says true (L3/speed preset has it true; level 2 and size do not unless noted).
Shared helpers the group all use: `src/ir/mem-alias.js` (68 lines: `mayAlias` over the emitter's `node.mem` marks),
`src/optimize/vectorize/access.js` (the address model: `accessOf`, `resolveAddr`, `inertFor`, `windowDefs`), `copyRoots` in forward-store.js.

### 1a. Store-to-load forwarding and store motion

| pass (file, lines) | stage / flag / after / takes-makes | shape matched | rewrites to |
|---|---|---|---|
| forwardStores (forward-store.js 255) | func, `forwardStores`; after hoistAddrBase, hoistPtrOffset; reads `mem`, drops irange presentNumRead mem, lost mem | in one statement list: `f64.store` to slot `base+off`, later `f64.load` of the same slot (also `x = a[0]` read twice, and an `if` whose two arms store a slot: a diamond) | the load becomes the stored value's local or constant (a fresh `$__fjN` set in both diamond arms); a store overwritten before any read is dropped (operand tees kept as drops) |
| sinkStores (sink-stores.js 236) | func, `+sinkStores`; after forwardStores; reads `mem`, lost mem | `(block $B (loop $L (br_if $B …) … f64.store S … (br $L)))`: a slot stored every round, read nowhere in the loop | the store becomes `local.set $sk`; one `f64.store` after the loop under an `$ran` flag (and before each throw guard); a value only that store reads moves past the loop too |
| earlyStores (early-stores.js 264) | func, `+earlyStores`; after forwardStores; reads `fn.distinctParams` | a store (address and value ready) behind statements holding ≥8 cycles of work | raised above them (also sinks a load read once to its reader); scheduling, no value rewrite |
| carryStores (carry-stores.js 192) | tail, `+carryStores`; no `after` (comment: "while each loop has one latch") | loop whose last statement-level store to A is read first by the next round (`load A … store A V`) | `$cs = load A` before the loop under the tests around the load; the load reads `$cs`; the store becomes `local.tee $cs V` (a loop-carried value) |
| forwardChecked (forward-checked.js 325) | tail, `forwardChecked`; after watOptimize | after watr: `(if C (then (i32.store A w)))` then `(if (result f64) C (then (f64.convert_i32_s (i32.load A))) (else nan))` (grid[nb] += 1; if (grid[nb] >= 4)) | the later checked load reads the word a store/load under the same guard left (fresh `$__fwN` teed); `f64 compare of a checked i32 element with an integral constant` becomes an i32 compare in an if |
| forwardHops (forward-hops.js 475) | module, `hoistForwardHops`; after loopCompacts; takes imports reachableWrites globalTypes | element read of an array that may have grown: `(if (result i32) (i32.eq (i32.load (ptr-4)) -1) (then (call $__ptr_offset_fwd RAW)) (else RAW))` (the hop) | one hop local per loop (set before it, set again after each call that may move a block), and a teed local between calls elsewhere |

### 1b. Load and expression reuse

| pass | stage / flag / after | shape | rewrites to |
|---|---|---|---|
| reuseLoads (reuse-loads.js 196) | func, `+reuseLoads`; after forwardStores, cseScalarLoad, specializeLoops; reads/lost mem; drops unsigned presentNumRead wrapSafe mem cellI32 | `(OPLOAD offset=k (local.get $p))` seen again, same op/offset/local, no kill between | first load wrapped `local.tee $rl`, later ones `local.get $rl` (`$__rlN`) |
| narrowByteLoads (same file, step of its own, same flag) | func, `+reuseLoads`; after reuseLoads | `(i32.and (i32.load A) 255)` / `(x >>> 8) & 255` / `x >>> 24`; a local holding a word whose every read takes one byte | `i32.load8_u offset=…`/`load16_u`; the local holds the byte (a peephole that wants reuseLoads' temps) |
| cseScalarLoad (licm.js 1163-1309, in a 1309-line file) | func, `cseScalarLoad`; drops mem | `(f64.load offset=K (local.get $X))`, X in `fn.cseLoadBases` (emit-proven whitelist: bound-once unboxed pointers used only as member-read receivers, kind disjoint from every store of the function) | `$__csN` tee at the first, get at the rest |
| hoistPtrType, hoistPtrOffset, hoistAddrBase (cse-address.js 355, one `regionTrackCSE` skeleton, three entries) | func; flags `hoistPtrType`, `hoistInvariantPtrOffset` (gates both its LICM step and hoistPtrOffset), `hoistAddrBase`; hoistPtrOffset after hoistInvariantPtrOffset; hoistAddrBase drops irange | `(call $__ptr_type (local.get X))`, `(call $__ptr_offset X)`, `(i32.add (local.get A) (i32.shl IDX K))` repeated in a region with the same locals | first site `local.tee $__pt/__po/__ab N`, later `local.get`; ≥2 sites per region |
| shareQuotients (share-quotients.js 141) | tail, `shareQuotients`; after selectArms | `v128.bitselect`/`select` of two quotients with one shared divisor (or dividend) | one division of a bitselect of the other operands, tees hoisted to statements first |
| selectArms (select-arms.js 185; not on the brief's list, same family as shareQuotients: factors a shared tree out of two arms) | tail, `selectArms`; after truncChoice | `c ? T(x,k1) : T(x,k2)` arms differing in ≤2 leaves | one `T` over a select of the leaves; reads `int-range.js intRanges` |
| stillLoads (still-loads.js 189) | tail, `+stillLoads`; before watOptimize | loop that writes no memory, calls nothing, sets no global: invariant loads/work over loads before its first branch | `$__stillN` set before the loop |
| leadChains (lead-chains.js 244) | tail, `+leadChains`; after watOptimize | loop body of ≥12 arithmetic statements, a chain of ≥8 links with ≥6 cycles of work hanging off it | statements reordered (scheduling: chain a few links ahead, hanging work after link k+3; fresh names for rewritten locals); no value rewrite |
| issueOrder (issue-order.js 240; scheduling, listed because it shares leadChains' slot) | tail, `+issueOrder`; after leadChains | straight-line f64 body | reordered by a machine model |
| leadGathers (lead-gathers.js 289) | tail, `+leadGathers`; after watOptimize | loop over items whose round opens with a gather (read at an address read from memory) then searches; loop stores/calls nothing | next round's gather read a round ahead into `$r'`, with a `select` of the next item's address or this one's |
| constBases (const-bases.js 101) | tail, `constBases`; after inlineTiny, unsignedDivision | `(i32.load (i32.add (local.get $a) E))` where `$a` holds one address N here (`word-ranges.js wordRanges`: lo==hi) and E ≥ 0 | `(i32.load offset=N E)`; the local's literal writes dropped when no read is left |

### 1c. Constants and settled values

| pass | stage / flag / after | shape | rewrites to |
|---|---|---|---|
| fold (fold.js 123) | bodies (link, on the tape), `fusedRewrite`; first of the bodies steps | f64 compare of constants / of an infinity or NaN against a finite value (`f64.convert_i32`, finite constant, local all of whose defs are finite), `i32.and/or` with a deciding constant, `i32.eqz` const, `select` on constant | the value, or the surviving arm (when the dropped operand `inert`) |
| settledTests (settled-tests.js 141) | func, `settledTests`; after combineGuards, specializeLoops | `(if T (then … leaves))` then a later `(if T' …)` with T' = T by value (pure i32/f64 compares of locals and constants, through copies) and no write of T's locals between | the later `if` becomes a block with only its tees |
| testedChoices (tested-choices.js 101) | tail, `+testedChoices` | `f64.<cmp> (select LIT LIT c) LIT` | `i32.eqz c`/`i32.ne c 0`/constant (dead tees stripped via liveness.js) |
| foldStaticArrReads (devirt.js 442ff, within a 779-line file) | func, first; takes staticArrs arrResized nameEscapes | read of a never-resized static constant array at a constant index | the literal (reads marks saArr saBits) |
| nanCanon (nan-canon.js 417) | func, `nanCanon` | the emitter's canonical-NaN select around a value only arithmetic/compares/drops consume | the value (def-use walk through locals and arms: a backward demand analysis) |
| poolFloats (pool-floats.js 73) | tail, `+poolFloats`; last of the value group | nonzero f64 literal | read of an immutable global |
| watr's side (for part 4): `valueNumber`, `cse`, `propagate`, `fold`, `deadset`, `lazySelect`, `schedule`, `offset`, `globals`, `licm`, `lsr`: see section 4 |

### 1d. Hoists that are redundancy elimination across the back edge (not on the brief's list; they ask the same kill questions)

| pass | note |
|---|---|
| hoistInvariantLoop x3 (licm.js `computeLoopInvariance`, the unified LICM; three instances in the func stage) | its own memory model: loop writes (`hasUnsafeCall`, `hasUnknownStore`, `hasHeaderStore`, `storedBases`, `storedCells`), `distinctParams`/fresh typed globals, `CELL_PREFIX` cells, stable-header pointers, `HEADER_STORE_FREE` |
| promoteGlobals (globals.js 898-980; 1017-line file) | `global.get` read ≥3 times, never set in the function, no callee that writes it (`collectReachableGlobalWrites`) -> entry local |
| hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset (globals.js, globalPtr stage), postGlobalPtr (tail) | typed-array global's `__ptr_offset` resolved once per function/loop; sound while the global is not written (same write closure) |
| hoistStableGlobalConstLoads / guardMaskedVectorSuffix (globals.js, globalLoads stage) | typed-global length/element loads constant while no store of a clashing global; uses `collectReachableMemoryWrites` |
| promoteCells (cells.js 76) | closure cell no closure took -> local |

## What each rebuilds for itself (READ; counted by grep over the files)

Every one of the tabled passes in 1a-1c walks its function again from the top. None takes a def-use, a parent map, a dominator or a loop forest from outside.

| analysis | where it is rebuilt (this scan) |
|---|---|
| body start (`findBodyStart`) | forward-store, forward-hops, early-stores, carry-stores, sink-stores, reuse-loads (x3), cse-address (x3), share-quotients; the rest scan the header with their own `HEADER` sets (still-loads, tested-choices) |
| read counts (`localGetCounts`, `buildRefcount`, inline `counts`) | forward-store (once per call + once per sinking), early-stores, sink-stores, cse-address (`buildRefcount` for shared-node detection), plus copyRoots' write counts |
| a local's definitions / writes in a region | `windowDefs`/`resolveAddr` (forward-store, sink-stores), `writesOf` (settled-tests, forward-hops `written`, carry-stores `writesAny`), `locals` write set per loop (sink-stores, still-loads, lead-gathers, lead-chains), `copyRoots` (a local set once from another: forward-store and sink-stores) |
| loop/block label targets | reuse-loads `targets`, settled-tests `branchesTo`, forward-checked `targets`, forward-hops `followable`, carry-stores back-edge count, sink-stores `inner` labels, cse-address `branches`/`never` |
| node sharing (a node held in two places) | reuse-loads `census`/`shared`, cse-address `refs` |
| fresh local names | `$__fjN`, `$__skN`, `$__rl` (nextLocalId), `$__pt/po/ab` (nextLocalId), `$__cs` (nextLocalId: cseScalarLoad AND carryStores both use prefix 'cs', run in different stages), `$__qt`, `$__still`, `$__fw`, `$__fh`, `$__sk`: nine schemes among these files |
| value ranges | const-bases (`wordRanges`), select-arms (`intRanges`) |
| liveness | tested-choices (`liveSeq`) |
| the callee effect closure | globals.js `collectReachableGlobalWrites` and `collectReachableMemoryWrites`, forward-hops `collectStillFuncs`, forward-checked `writers`, licm.js `collectHeaderSafeFuncs`, watr's `computeCallEffects`: five (six with watr's) different fixpoints over one call graph, each answering "which functions write what" for its own purpose |

## 2. The same question asked N ways

All cells READ from source unless marked RAN. "kills all" = forgets every cached value of the pass.

### 2a. Kill rules side by side

| pass | call | store | global.set | back edge / loop | join, branch | import call (host can re-enter) | call_indirect |
|---|---|---|---|---|---|---|---|
| forwardStores | any call except `INERT_CALLS` (`$__durable_arr_snap`, `$__ptr_offset_fwd`, `$__ptr_offset`, `$__len`), `$__throw_*`, `pureKernel` (`$math.*` but `$math.random*`): kills all | only `f64.store` is tracked: kills entries of other bases that `mayAlias` (marks; unmarked = alias), same base other offset left alone; any other store/atomic/memory op: kills all | kills all (inertFor) | no loops inside a statement list: a statement with `loop`/`block`/`br` kills all (`BRANCH_OPS`); an `if` that is no diamond may stay | diamond: meet of both arms | kills all (a call) | kills all |
| sinkStores | none allowed in the loop but `$__throw_*`, `pureKernel`, `$__ptr_offset_fwd/$__ptr_offset/$__len` (`HEADERS`): else the loop is not touched | slot must be stored every round and touched by no other access that `overlaps` (same base: ≥8 bytes apart; other base: `mayAlias` marks) | in `EXIT`: loop not touched | the loop must have exactly the head `br_if` and tail `br`, no inner loop, no other exit | n/a | not allowed | not allowed (`EXIT`) |
| carryStores | any call between load and latch, or after the store: no carry | any store after the carried store must be at A's own address (nodeEqual via tee/alias) with disjoint bytes, else no carry; stores before it are overwritten | not examined (not a memory op) | exactly one way back (count of `br`/`br_if`/`br_table` to the label) | branch before the load stops the scan | call: no carry | call*: no carry |
| leadGathers | none in the loop | none in the loop (`isStore`: store, atomic, memory., table.) | not examined | loop must reach its test; only the loop's own test leaves | declines branches by depth | none allowed | none allowed |
| stillLoads | none in the loop (`OPAQUE`) | none in the loop (watr `isMemWrite`) | none in the loop | the loop IS the region | moves only up to the first statement that may branch | none allowed | none allowed |
| reuseLoads | any call or `return_call*` kills all (even `$math.*`) | full-width marked `f/i 32/64 store`: kills loads that `mayAlias`; every other store, atomic, memory.copy/fill/init/grow: kills all | not a kill (loads read memory only) | `loop`: state restarts empty; state after the loop is the state at the end of the body | `if`: meet of arms; a block a branch leaves: empty; try/catch: empty | kills all | kills all |
| cseScalarLoad | any call but `SAFE_OFFSET_CALLS` (7 names: `$__ptr_offset`, `$__ptr_offset_fwd`, `$__ptr_type`, `$__ptr_aux`, `$__len`, `$__jss_length`, `$__jss_charCodeAt`) kills all | NO store kills, except one whose address tree reads the base local (emit proved the base's kind disjoint from every store of the function); `v128.store`, `memory.copy/fill` not examined | not examined | `loop`, `if`: clear before and after; `br*` clear | each `then`/`else` its own table | kills all | kills all |
| hoistPtrType | not a kill (tag bits of the box never change) | not a kill | not a kill | `loop`/`try`/catch: clear before and after | `if`: meet by region identity; block with an exit clears | not a kill | not a kill |
| hoistPtrOffset | `barrier`: any call except `KEEPS_STORAGE` (`$__ptr_type`, `$__ptr_offset`, `$__ptr_aux`, `$__mkptr`; NOT `$__ptr_offset_fwd`, NOT `$__len`) closes every region | any `[if](32\|64).store*`/atomic, v128.store, memory.grow/copy/fill/init closes every region | not a kill | as hoistPtrType | as hoistPtrType | kills (a call) | kills (`call_indirect`, `call_ref`, `return_call*`) |
| hoistAddrBase | not a kill (pure i32 arithmetic over locals) | not a kill | not a kill | as above | as above | not a kill | not a kill |
| forwardChecked | `callsOut`: a call bumps the epoch only if the callee `may` write (function writes memory/global/calls indirectly, or calls one, or is not in the module, or is an import): fixpoint `writers`; `$__throw_*` ends nothing | any store/atomic/memory./table. bumps the epoch (all numbered loads and `global.get`s renumbered); a bounds-checked i32 store leaves its own array's header number (`kept`) | bumps the epoch | `loop`: forget what it writes, bump epoch, before and after | arms start from the saved state; a load an arm ran at its top under the guard survives (`ran`); a block a branch leaves: what it wrote forgotten | `may` (import in the set) | bumps epoch |
| forwardHops | `moves(callee)` = not (`$__alloc*`, `$__throw_*`, `LOWERINGS`, or in `collectStillFuncs`): a moving call empties the asked set and re-resolves the loop's hops; a global receiver `@g` also dies when `reachableWrites.has(callee, g)` | not a kill (a block moves only inside a call) | kills `@g` | per loop: hop local set before, `stillAsked` for what survives the loop | arms from copies; `killAll(written)` after | `moves` = yes (an import is no `still` function) | clears |
| earlyStores | any call: `fixed` (a stop for crossing) | statements swap only if accesses `misses`: roots at two distinct `distinctParams`, or one address expression nodeEqual with disjoint byte ranges (`bytes` by width) | stop | blocks, loops, ifs, selects are stops | stop | stop | stop |
| leadChains / issueOrder | any call: run left as written | loads keep order with the run's stores (no alias reasoning: total order of memory ops) | global.set: run left as written | loop/if/block/br: run left as written | same | same | same |
| hoistInvariantLoop (LICM) | `hasUnsafeCall` = any call but `SAFE_OFFSET_CALLS`, `READONLY_MEM_CALLS`, `NON_MUTATING_CALLS`, pure (`isPureFnCall`: `$math.*` and 6 string helpers), `headerSafe` user funcs (`collectHeaderSafeFuncs`, which excludes any function that calls an import: the import is neither known nor safe) | `hasUnknownStore` (store whose base is no distinct param/cell), `hasHeaderStore` (any store but `HEADER_STORE_FREE`: f64/f32/i64/v128), `storedBases`, `storedCells`; typed-param loads are hoisted across stores only if the base is in `distinctParams` and `storedBases` | `global.get` invariant only if the loop does not set it and has no unsafe call | the loop is the region | n/a | unsafe call (not hoisted) | unsafe call |
| promoteGlobals | callee row `reachableWrites.has(callee, g)`; indirect call anywhere in the function: no promotion | not a kill | the function must not set it | n/a (function-wide) | n/a | NOT a kill: `collectReachableGlobalWrites` returns false for a callee absent from the module; its header says "wasm imports cannot touch module globals" (RAN: wrong, below) | all globals any function writes |
| hoistGlobalPtrOffset | same closure | typed pointees never forward: not a kill | not set in the function | whole-function / `hoistLoopGlobalPtrOffset` per loop (rows of the loop only) | n/a | NOT a kill (same closure; RAN: wrong) | whole-function: all globals; loop: no `call_indirect`/`call_ref` anywhere in the loop |
| hoistStableGlobalConstLoads | `collectReachableMemoryWrites`: a callee absent from the module writes `*` ("a host import can observe an exported memory through its JS closure and mutate arbitrary bytes: fail closed") | store through a clashing typed global (`apart`: both own buffers) | uses `reachableGlobalWrites` too | n/a | n/a | writes `*`: kills (right) | `*` |
| watr valueNumber (for comparison) | clock++ unless the callee is `pure` (jz vouches `$math.*`, `callKinds`) or `read` (the call keyed with the clock) | `isMemWrite` bumps the one clock (all loads renumbered; no alias distinction); loads keyed `@clock` | clock++ (`global.get` is never numbered) | `loop`: kill locals assigned, clock++ before and after | `if` arms from saved locals; assigned locals killed after | unknown call: clock++ | clock++ |
| settledTests, fold, testedChoices, shareQuotients, selectArms, constBases | no memory: only local writes kill (`killName` / `writesOf` / ranges), loops kill their writes | no memory | no memory | settledTests: names written in the loop killed at entry | meet at joins | settledTests: not examined (pure tests of locals) | n/a |

### 2b. Alias assumptions (how regions are told apart)

| region | forwardStores | sinkStores | reuseLoads | cseScalarLoad | earlyStores | LICM | forwardChecked | hoistPtrOffset | globals.js |
|---|---|---|---|---|---|---|---|---|---|
| array elements | `mem` mark `e<cell>`: different cell never overlaps (summary's allocation cell) | same, via `overlaps` | same, full-width stores only | emit whitelist by VAL kind, no marks | none (`distinctParams`) | none | none (epoch) | n/a | n/a |
| object fields | `mem` `f<slot>:<sids>` (same slot and a shared layout overlap) | same | same | whitelist by kind | none | none | none | n/a | n/a |
| typed array buffers | none: unmarked; identity = `resolveAddr` base expression through `windowDefs` + `copyRoots` (copies of one local); two different bases always may alias | same (`keyOf` requires locals the loop never writes) | none; identity = the address local's NAME (`$a2 = $a` is another key) | n/a | `distinctParams` (plan: every call passes distinct fresh arrays) or one address expression with disjoint bytes | `distinctParams` + fresh typed globals; bases through `baseParamOf` | n/a | n/a | `freshTypedGlobals`, `globalTypedLen/Elem` |
| headers (length at -8, forward word at -4) | not modelled (`$__len`, `$__ptr_offset_fwd` inert) | allowed as `HEADERS` | any call/store kills | `SAFE_OFFSET_CALLS` | stop | `HEADER_STORE_FREE` (f64/f32/i64/v128 stores cannot write a header) + `stableHeaderNames` | `kept` header of a bounds-checked i32 store | any store kills | typed pointees never forward |
| module globals | `global.set` kills; `global.get` ops are in addresses via `resolveAddr` (stable if the window never sets it) | no `global.set`; address globals unwritten | n/a | n/a | stop | per loop `globals` set + `hasUnsafeCall` | `global.get` numbered by epoch | n/a | by name, transitive call-graph rows |
| the heap pointer / allocator | n/a | not examined | any call kills | n/a | n/a | `allocGlobal` (`$__`-prefixed) + `hasAllocatingCall` | n/a | n/a | `stillByName` in forwardHops (`$__alloc*`) |
| static data / immutable | n/a | n/a | n/a | n/a | n/a | n/a | n/a | n/a | foldStaticArrReads (devirt.js): by `staticArrs`/`arrResized`/`nameEscapes` |

### 2c. Differences, each classed

| # | the same question | answers | my read |
|---|---|---|---|
| D1 | can a call to an import write a module global? | `collectReachableGlobalWrites`: no (promoteGlobals, hoistGlobalPtrOffset, hoistLoopGlobalPtrOffset; its header: "wasm imports cannot touch module globals"). `collectReachableMemoryWrites` (same file, 20 lines of comments away): yes, `*`, "fail closed". forwardHops `moves`, forwardChecked `writers`, `collectHeaderSafeFuncs`, watr callKinds: yes | WRONG ANSWER, reproduced (section 2d): a host import that calls back an export which sets the global. Not a missed optimization: three passes share the one false premise |
| D2 | does a pure `$math.*` call kill a cached load? | forwardStores/sinkStores: no (`pureKernel`). reuseLoads, cseScalarLoad, carryStores, earlyStores, hoistPtrOffset: yes. LICM: hoistable op | missed optimization (conservative) |
| D3 | which header-reading calls leave a cache alone? | four different lists: `INERT_CALLS` (4), `SAFE_OFFSET_CALLS` (7), `KEEPS_STORAGE` (4, disagreeing: contains `$__mkptr` and `$__ptr_aux`, lacks `$__len` and `$__ptr_offset_fwd`), sink-stores `HEADERS` (3) | missed optimization; one source of truth is a design item |
| D4 | which stores can change a header / move a block? | hoistPtrOffset: any store; LICM: any store but the 4 `HEADER_STORE_FREE`; forwardHops: none (only calls); forwardChecked: any (epoch), except its `kept` case | missed optimization if each is conservative; D4 is WRONG only if some `i64.store`/`f64.store`/`v128.store` can write a header word (the premise of `HEADER_STORE_FREE`: "jz writes every array or typed header word with `i32.store`"): not run, source reading only |
| D5 | when is a typed array "the same buffer"? | forwardStores/sinkStores: same resolved base expression (copies through `copyRoots`); reuseLoads: same local name only; earlyStores/LICM: `distinctParams` proofs from call sites; cseScalarLoad: emit kind | missed optimization (reuseLoads cannot see `$a2 = $a`); all conservative |
| D6 | same-base slots at other offsets: disjoint? | forwardStores: assumed disjoint whatever the offsets (`overwrite` skips `key + '|'` entries); sinkStores/earlyStores/carryStores: byte ranges compared | only an issue for accesses not 8 apart on one base; see 2d for a probe (DataView) |
| D7 | does `global.set` end a cached memory value? | forwardStores, forwardChecked, earlyStores: yes; reuseLoads: no | missed optimization in the first three |
| D8 | what does a store do to a cached element: kill by width? | forwardStores: only f64 slots tracked; reuseLoads: marked full-width stores by `mayAlias`, all else kill; carryStores/sinkStores/earlyStores: byte ranges | consistent enough; missed optimization |
| D9 | call effects | six fixpoints (see section 1): `collectReachableGlobalWrites` (globals, imports no), `collectReachableMemoryWrites` (memory, imports yes), `collectStillFuncs` (block moves), `writers` (memory or global), `collectHeaderSafeFuncs` (headers/globals), watr `computeCallEffects` | the cause of D1: five closures, written at five times, disagree on imports |
| D10 | the marks (`mem`) the passes read are dropped before they are read | fusedRewrite 648/17,797, forwardStores 531, foldLoadCasts 950 (architecture.md "5a landed"); forwardStores and reuseLoads are marked `lost: mem` | missed optimization, by the doc's account (inferred) |

| D11 | does a `$__throw_*` call end a pending store? | forwardStores (`inertFor`, non-strict): no barrier ("ends the activation, whose locals then no one reads"), so `S1; guard; S2` to one slot drops S1 as dead. sinkStores: handles it (flushes the sunk stores before each guard). LICM: `noReturnCall` is "no barrier to motion" | NOT reproduced. Memory stored before a throw outlives the activation, so a caught throw would show S1 missing. Three programs tried (explicit `throw`, a nullish receiver, a callee that throws): all correct, because the user-visible throws lower to the wasm `throw` op (a BRANCH_OP, clears) and the `$__throw_*` calls sit in cold helpers. Hazard by reading only |

### 2d. Wrong answers reproduced (RAN, tree = 3420027ce export; node 25.9.0 is the oracle)

**W1. A host import that calls back an export leaves a promoted global stale (three passes, one shared premise).**
Program (`scout-7/repro/reentry2.mjs`):

```js
import { cb } from 'host'
let g = 0
export let bump = () => { g = g + 1 }
export let f = (k) => {
  const a = g * k + g
  cb()
  const b = g * k + g
  return a * 1000 + b
}
```
host: `imports: { host: { cb: () => ex.bump() } }`, then `ex.f(7)`.

| optimize | f(7) |
|---|---|
| node | 8 |
| 0 | 8 |
| 'size' | 8 |
| 2 (default) | **0** |
| 'speed' | **0** |
| 3 | **0** |
| 2 or speed with `promoteGlobals: false` | 8 |

(`a` = 0, `cb()` makes g 1, `b` = 8: `a*1000 + b` = 8. jz at level 2 and over reads g into an entry local once, `b` reads the stale 0.)

Second program, same cause, in the typed-array pointer hoists (`scout-7/repro/reentry3.mjs`, `repro/m-reentry3.mjs`):

```js
import { cb } from 'host'
let x = new Float64Array(4)
export let reset = () => { x = new Float64Array(4); x[0] = 100 }
export let f = () => { let s = 0; for (let i = 0; i < 3; i++) { s += x[0] + x[1]; cb() } return s }
```
host: `cb: () => ex.reset()`; `ex.f()`: node **200**, optimize 0 **200**, optimize 2 / 'size' / 'speed' / 3 **0**. Bisect (`repro/bisect-on.mjs`): from level 0 turning on any ONE of `hoistGlobalPtrOffset`, `hoistLoopGlobalPtrOffset`, `promoteGlobals` gives 0; turning any single one off at level 2 or speed does not fix it (the other two still do it), which is why a flag bisect shows nothing.

Cause (READ): `collectReachableGlobalWrites` (src/optimize/globals.js:30-143) builds a row for every function of the module and answers `has(name, global)` false for a name with no row; a call to an import has no row. Its header comment: "Unknown callees (imports — absent from the module's func list) write nothing: wasm imports cannot touch module globals." True of the wasm instruction set, false once the host is a JS function that calls an export, which README.md:220 documents ("a function the module returns … reaches the host as a function that calls back into it"; imports are host functions). `collectReachableMemoryWrites` in the same file (line 423-455) handles the same case the other way: "A missing target is a host import. It can observe an exported memory through its JS closure and mutate arbitrary bytes: fail closed." `forwardHops` (`moves`), `forwardChecked` (`writers`), `collectHeaderSafeFuncs` (LICM) and watr's call effects also treat an import as an effect.

Why it matters for phase 7: this is the call-effect question asked in six closures (D9); one effect table for the design removes the disagreement. A sound rule that keeps the optimization: an import writes every global some EXPORT (or anything reachable from one, including closures the host holds) can write; the existing rows give that set directly (`has(import, g)` = some exported function's row has g).

Not wrong, tried (RAN, all agree with node at 0/2/size/speed/3): two call sites sharing a parameter with `g(A, A)` against `g(A, B)` for arrays, object fields and mixed (`repro/cells.mjs`: the mem marks hold where the summary merges cells); the same array passed as both typed-array parameters of an exported function by the host (`repro/distinct.mjs`: `distinctParams` is not fooled); user module named `math` with impure functions (names are `$math$x`, not `$math.x`, so `pureKernel` is not fooled; `repro/mathmod2.mjs`); DataView stores at offsets 4 apart (`repro/dv.mjs`: the f64-offset D6 case does not arise through DataView); an exported `let` the host cannot set (getter only, no variant of W1); 230 random programs (`repro/memfuzz.mjs`: typed arrays overlapping through `subarray`, arrays, objects, out-parameter helpers, loops, ifs; speed and 2): 0 mismatches.
### 2e. Address models (how each pass reads `base ⊕ offset`; READ)

| model | where | what it resolves |
|---|---|---|
| `accessOf` + `resolveAddr` + `windowDefs` (vectorize/access.js) | forwardStores, sinkStores, the SLP packer | base through tees and window definitions, constants folded into `off` (`constOf` folds add/sub/mul/shl) |
| a second `accessOf` + `rootOf` + `misses` | early-stores.js (own copy: only `i32.add` of a constant peeled; roots through the nearest unconditional write; `distinctParams`) | |
| a third `access`/`addrOf`/`pure` | carry-stores.js (address of locals and literals; a tee names the address; `nodeEqual`) | |
| `keyOf` = op + offset + local NAME | reuse-loads.js | only `(local.get|tee $x)` bases |
| `linearIndex` (affine in the counter: constant + integer multiples of opaque terms) | vectorize/alias.js, legality.js (phase 6a's one legality) | same-array dependence distance in lanes |
| `boxRoot`/`offsetRoot`/`wordRoot` (copy chains through the NaN-box layers) | forward-hops.js | which receiver a hop resolves |
| `baseParamOf` / `distinctBases` / `CELL_PREFIX` | licm.js | the parameter a base derives from |
| `memAddress` / `globalBaseAliases` / `memGlobal` | globals.js | which typed global an address derives from |
| shape key `base|idx|K` | cse-address.js hoistAddrBase | the expression, not its value |
| `wordRanges` | const-bases.js | a local's interval at a read |

Nine address models, three of them copies of `accessOf`. A single numbering would replace them with one canonical form for `base + index*scale + const`, and the memory model with one `(region, base value number, byte range)`.

## 3. What each pass is worth (RAN: bytes and counts only, no timing)

Method. Units = bench cases `bench/<id>/<id>.js` but jz, watr, jessie plus `examples/<name>/<name>.js`; 167 units measured; `examples/threejs-math` does not compile standalone ("Unknown module './three/src/math/Vector3.js'") and 6 units were not measured (listed below). Level `speed` (`compileJzAt` for bench, `test/util.js compile` for examples). For each unit: a baseline compile with `globalThis.__FIRED` recording which pass-table steps changed their input (digest before/after, instrumentation in the exported tree only), then one recompile per step with that step turned off (`globalThis.__SKIP = {id}` honoured by `on()`: this turns off every instance of one table entry whatever flags it shares, so `hoistPtrOffset` is separable from `hoistInvariantPtrOffset`, `narrowByteLoads` from `reuseLoads`, `fold` from `fusedRewrite`), plus flag-level configs for `hoistInvariantLoop` (three instances), `valueNumber`, `scheduleStatements` and watr options (`watr: { cse|propagate|offset|fold|... : false }`). A step that did not change its input in the baseline cannot change the bytes when removed, so it is not recompiled (counted as 0): this is exact for steps recorded by digest; `fold` (link tape) is always recompiled. A baseline recompiled at the end of each unit equals the first in every unit ("leak" check: none).
Units whose baseline compile took over 3 s on this loaded machine (load average 7 to 20) were skipped in the main run; a second run covers those under 20 s with the same method minus the watr options (so the watr rows count 129 of 167 units, the `cse` and `valueNumber` rows 167).
"hash differs" counts a unit whose wasm bytes differ at all (same length, other order included: scheduling passes move no length); "byte count differs" counts a different length; the last column is the sum over units of (bytes with the step off) minus (bytes with it on): positive = the step shrinks the module, negative = the step grows it.
`forwardStores` and some others change their input in every unit because they normalize (`normalizeTransparentBlocks`) even when nothing forwards, so "changed its input" overstates their work; the byte columns are the evidence.

```
units complete 167 leak(base!=base2) none 
skipped(heavy) e:wireworld(32599ms) b:stdlib-dists(35318ms) b:decode-wav(27673ms) b:stdlib-special(66502ms) e:schrodinger(4652ms) b:webaudio(76823ms) 
incomplete 
```

#### store forwarding & motion

| step (skip) | units where it changed its input in the baseline | recompiled with it off | units whose bytes' hash differs | units whose byte count differs | count grows / shrinks with it off | total bytes, off minus on |
|---|---|---|---|---|---|---|
| forwardStores | 166 | 166 | 60 | 58 | 54/4 | +5670 |
| sinkStores | 1 | 1 | 1 | 1 | 0/1 | -251 |
| earlyStores | 23 | 23 | 4 | 2 | 2/0 | +21 |
| carryStores | 1 | 1 | 1 | 1 | 0/1 | -16 |
| forwardChecked | 7 | 7 | 7 | 7 | 7/0 | +487 |
| forwardHops | 54 | 54 | 25 | 23 | 15/8 | +1382 |

#### load / expression reuse

| step (skip) | units where it changed its input in the baseline | recompiled with it off | units whose bytes' hash differs | units whose byte count differs | count grows / shrinks with it off | total bytes, off minus on |
|---|---|---|---|---|---|---|
| reuseLoads | 157 | 157 | 97 | 81 | 55/26 | -174 |
| narrowByteLoads | 7 | 7 | 7 | 7 | 7/0 | +85 |
| cseScalarLoad | 0 | 0 | 0 | 0 | 0/0 | 0 |
| hoistPtrType | 12 | 12 | 11 | 11 | 9/2 | +771 |
| hoistInvariantPtrOffset | 0 | 0 | 0 | 0 | 0/0 | 0 |
| hoistPtrOffset | 0 | 0 | 0 | 0 | 0/0 | 0 |
| hoistAddrBase | 139 | 139 | 137 | 136 | 39/97 | +393 |
| shareQuotients | 2 | 2 | 2 | 2 | 0/2 | -92 |
| selectArms | 13 | 13 | 13 | 13 | 12/1 | +362 |
| truncChoice | 0 | 0 | 0 | 0 | 0/0 | 0 |
| stillLoads | 5 | 5 | 5 | 3 | 1/2 | -222 |
| leadChains | 0 | 0 | 0 | 0 | 0/0 | 0 |
| issueOrder | 1 | 1 | 1 | 1 | 0/1 | -122 |
| leadGathers | 2 | 2 | 2 | 2 | 0/2 | -75 |
| constBases | 74 | 74 | 74 | 74 | 74/0 | +807 |

#### constants / settled

| step (skip) | units where it changed its input in the baseline | recompiled with it off | units whose bytes' hash differs | units whose byte count differs | count grows / shrinks with it off | total bytes, off minus on |
|---|---|---|---|---|---|---|
| fold | 0 | 167 | 26 | 21 | 7/14 | -195 |
| settledTests | 49 | 49 | 49 | 49 | 49/0 | +27154 |
| testedChoices | 1 | 1 | 1 | 1 | 1/0 | +70 |
| foldStaticArrReads | 0 | 0 | 0 | 0 | 0/0 | 0 |
| nanCanon | 97 | 97 | 89 | 88 | 78/10 | +8784 |
| poolFloats | 166 | 166 | 166 | 166 | 129/37 | +309069 |
| foldLoadCasts | 107 | 107 | 54 | 49 | 39/10 | +289 |
| foldV128Memargs | 7 | 7 | 7 | 7 | 7/0 | +167 |
| refoldMemargs | 23 | 23 | 18 | 18 | 15/3 | +214 |
| holdWordNumbers | 4 | 4 | 4 | 4 | 3/1 | -43 |
| foldWrappedWords | 4 | 4 | 3 | 2 | 2/0 | +8 |
| foldWrappedWords.late | 12 | 12 | 12 | 12 | 7/5 | -19 |
| maskOperands | 1 | 1 | 1 | 0 | 0/0 | +0 |

#### globals / cells / hoists

| step (skip) | units where it changed its input in the baseline | recompiled with it off | units whose bytes' hash differs | units whose byte count differs | count grows / shrinks with it off | total bytes, off minus on |
|---|---|---|---|---|---|---|
| promoteGlobals | 155 | 155 | 155 | 155 | 44/111 | -1014 |
| hoistGlobalPtrOffset | 69 | 69 | 69 | 67 | 54/13 | +2622 |
| hoistLoopGlobalPtrOffset | 67 | 67 | 67 | 67 | 40/27 | -9042 |
| postGlobalPtr | 0 | 0 | 0 | 0 | 0/0 | 0 |
| hoistGlobalConstLoads | 2 | 2 | 2 | 2 | 0/2 | -35 |
| hoistStableGlobalConstLoads | 2 | 2 | 2 | 2 | 0/2 | -35 |
| promoteCells | 0 | 0 | 0 | 0 | 0/0 | 0 |

#### other representation (listed for completeness)

| step (skip) | units where it changed its input in the baseline | recompiled with it off | units whose bytes' hash differs | units whose byte count differs | count grows / shrinks with it off | total bytes, off minus on |
|---|---|---|---|---|---|---|
| narrowBoxedLocals | 104 | 104 | 102 | 99 | 59/40 | +116 |
| narrowFlagLocals | 7 | 7 | 7 | 7 | 7/0 | +311 |
| shareSplitSlots | 29 | 29 | 23 | 12 | 1/11 | -150 |
| guardToInt32 | 166 | 166 | 166 | 166 | 3/163 | -149251 |

#### by flag (not by step)

| flag off | units run | hash differs | byte count differs | grows/shrinks | total delta |
|---|---|---|---|---|---|
| flag:hoistInvariantLoop | 142 | 141 | 140 | 51/89 | -54760 |
| flag:valueNumber | 167 | 129 | 128 | 111/17 | +63967 |
| watr:cse | 167 | 166 | 166 | 164/2 | +38619 |
| watr:propagate | 129 | 129 | 129 | 126/3 | +106069 |
| watr:offset | 129 | 0 | 0 | 0/0 | +0 |
| watr:fold | 129 | 129 | 129 | 126/3 | +31660 |
| flag:scheduleStatements | 17 | 4 | 4 | 1/3 | +127 |
| watr:identity | 16 | 16 | 16 | 12/4 | -1391 |
| watr:globals | 17 | 15 | 15 | 15/0 | +1466 |
| watr:peephole | 17 | 15 | 15 | 15/0 | +217 |
| watr:licm | 16 | 11 | 11 | 3/8 | -744 |
| watr:lsr | 16 | 16 | 16 | 1/15 | -419 |
| watr:deadset | 17 | 1 | 1 | 1/0 | +33 |
| watr:guardRefine | 16 | 0 | 0 | 0/0 | +0 |
| watr:narrow | 16 | 2 | 2 | 2/0 | +15 |

#### Zero list: steps whose removal changed no byte anywhere in the 167 measured units (speed tier)

| step | note |
|---|---|
| cseScalarLoad | never changed its input in any unit (0 of 167). Its whitelist `fn.cseLoadBases` may be empty everywhere, or `reuseLoads`/`hoistInvariantLoop` take its loads first: not diagnosed |
| hoistInvariantPtrOffset, hoistPtrOffset | 0 of 167 |
| truncChoice, leadChains, foldStaticArrReads, postGlobalPtr, promoteCells | 0 of 167. leadChains is a speed-tier scheduler built for sosfilter/biquad-shaped cascades; neither case changes under it here (RAN: `b:sosfilter`, `b:biquad` complete, leadChains not fired). Their tests pass on hand-written IR |
| watr `offset`, `guardRefine` | 0 changed bytes in 129 and 16 units |

Near zero (1 to 5 units): sinkStores 1 (b:quatmul, -251: with it ON the module is 251 bytes larger), carryStores 1 (b:sdf, -16), issueOrder 1 (b:lorenz, -122), testedChoices 1 (+70 with it on), leadGathers 2 (b:dict, b:hashjoin, -75 total), shareQuotients 2 (b:hsl, b:hwb, -92), maskOperands 1 (hash only), stillLoads 5 (3 differ in bytes, -222), watr `deadset` 1. These are speed-for-bytes passes aimed at one bench case each; bytes are the wrong currency for them, so "dead weight" cannot be read off this table: leadChains, issueOrder, earlyStores, leadGathers, carryStores, sinkStores, stillLoads, shareQuotients, testedChoices need their timing evidence (not measured: the machine was running a battery).

Biggest movers (bytes off minus on, positive = the step shrinks the module): poolFloats +309,069 (it replaces inline literals by global reads; in 37 units it grows them), settledTests +27,154 in every one of the 49 units it changes (no unit grows), nanCanon +8,784 (88 units), forwardStores +5,670 (58 units), hoistGlobalPtrOffset +2,622, hoistLoopGlobalPtrOffset -9,042 (grows 40 units, shrinks 27), forwardHops +1,382, constBases +807 (74 of 74 units shrink), hoistAddrBase +393 (grows 97 units, shrinks 39: a speed pass that costs bytes), promoteGlobals -1,014 (111 units grow with it on), hoistInvariantLoop -54,760 (89 units larger with it on).

Not measured: units whose baseline compile exceeded the 20 s ceiling: examples/wireworld, bench/stdlib-dists, bench/decode-wav, bench/stdlib-special, bench/webaudio, examples/schrodinger (baseline only: 4.6 s, its per-pass run never ran, cause not looked into); examples/threejs-math does not compile alone. 167 units were measured. Levels `size` and 2 were not measured (several of these passes are off there by preset).

## 4. Overlap with watr (node_modules/watr/src/optimize.js, 11,096 lines; READ, read-only)

What watr has that is in the same family (option names are watr's; jz sets `valueNumber`, `scheduleStatements`, `chainConditions`, `propagateLocals`, `coalesceLocals`, `hoistConstantPool`, `watrLicm`, `watrLsr` through `watr-tail.js resolveWatrOpts`):

| watr pass (default / jz speed) | what it does | memory model |
|---|---|---|
| `valueNumber` (default off in watr; jz turns it on unless `cfg.valueNumber === false`; once, before the rounds, ~line 3474) | numbers pure ops, loads and calls over straight-line regions and across loops/ifs; a value held in a local is reused (`$__vnN` minted); calls: `pure` (jz vouches for `$math.*` through `opts.pure`) or `read` (user functions found read-only, keyed with the clock) or unknown (clock++) | ONE write clock: any store, memory.*, `global.set` or unknown call bumps it and renumbers every load; `global.get` is never numbered; no alias distinction, no forwarding of a store to a load |
| `cse` (on; once after the rounds, byte-profit gated) | repeated pure subtrees in a straight-line scope, calls whose callee effects (`CALLFX`: `wMem`, `wGlob`, `unknown`) are clean; reads fenced by clocks | coarse: memory writes and call-outs end groups |
| `propagate` (on) | forward-propagate single-use locals and tiny constants, copies | locals only |
| `fold`, `identity`, `peephole`, `strength`, `branch`, `bool`, `zeroinit`, `deadset` (on) | constant folding, identities, constant branches, dead local sets | locals and values only; no memory |
| `globals` (on) | propagate immutable global constants | immutable only |
| `offset` (on) | `add + const` into the memarg, only when an unsigned bound proves no wrap (`upper()`: constants, `and`, `shr_u`) | none |
| `guardRefine` (jz turns it on) | folds NaN-box tag reads under dominating tag guards | tag bits |
| `licm` (off; jz speed turns it on: `watrLicm`) | hoists loop-invariant PURE arithmetic; loads not hoisted | none |
| `lsr` (off; jz speed: `watrLsr`) | loop strength reduction of affine addresses | none |
| `schedule`, `lazySelect` (off; jz: `scheduleStatements` true, `lazySelect` when `watrGuard === false`) | order straight-line statements by dependent work; defer costly pure initializers | statements swap only without conflicts |
| absent from watr | memory store-to-load forwarding, dead MEMORY store elimination (`deadset` is locals only), load reuse across a store that provably misses, loop-carried passes, anything about array headers, forwarding words, allocation cells, object layouts, "this callee never writes a global" beyond its own effect table |

### Per jz pass: watr analog, what jz knows that watr cannot

| jz pass | watr pass of the same intent | what jz's does that watr's cannot (the fact it holds) |
|---|---|---|
| forwardStores | none | forwards stores through memory at all; reads `mem` marks, resolves addresses through LICM-snapped copies (`copyRoots`), knows `$__len`/`$__ptr_offset_fwd` are header reads and `$__throw_*`/`$math.*` are no memory effect |
| sinkStores, carryStores, leadGathers | none | loop facts (every-round store, one latch, induction steps) |
| earlyStores, leadChains, issueOrder | `schedule` (same intent: expose independent long work) | these are machine-model reorderings (latency tables, `distinctParams`); jz runs leadChains after watr by design because "its own passes would merge the split values back" (pass-table `why`) |
| forwardChecked | none (`guardRefine` is the only guard-dominance pass and it knows tags only) | the checked-element if-form, bound-check keys, header number kept across a bounds-checked store |
| forwardHops | none | what a forwarding word is, which calls move a block |
| reuseLoads, cseScalarLoad | `valueNumber` (loads keyed `@clock`), `cse` | alias marks (cell/layout) that let a store of another cell leave a load alone, emit-proven base whitelist; watr: any address expression, any region of straight-line code, the call effect table. watr's single clock loses every load at every store |
| hoistPtrType, hoistPtrOffset, hoistAddrBase | `cse`, `valueNumber` over `$__ptr_type`/`$__ptr_offset` calls and the add/shl address (a call with a clean effect table is a CSE candidate) | they run before LICM and the fused rewrite read the tees; ≥2-site rule is jz's, not watr's byte-profit gate |
| shareQuotients, selectArms, truncChoice | none | choices over lanes/arms, IEEE-exact factoring |
| stillLoads | `licm` (pure arithmetic only; loads excluded) | "this loop writes no memory, calls nothing": load invariance |
| constBases | `offset` (bound proofs by `and`/`shr_u`/constants only) | `word-ranges` intervals (a local that holds one address here; index non-negative from the loop's test) |
| fold (tape) | `fold`, `identity`, `peephole` | finiteness of an f64 local from its definitions, so `f64.ne x inf` is decided |
| settledTests | `branch` (constant conditions), `guardRefine` (tag guards) | dominating test by value through copies (`holds`), `leaves` |
| testedChoices | `peephole`/`bool` unknown (not read) | compare of a literal select |
| foldStaticArrReads | none | static constant arrays never resized (`staticArrs`, `arrResized`, `nameEscapes`) |
| nanCanon | none | the emitter's canonical-NaN select and who reads it |
| promoteGlobals | `globals` (immutable only), `cse` (global reads fenced by call clocks) | module-wide transitive write closure (`reachableWrites`) so a global written only by init stays promotable where the call graph never reaches it |
| hoistGlobalPtrOffset (and loop) | none | typed pointees never forward; total entry resolve |
| poolFloats | `poolConstants` (jz turns it OFF at speed: `hoistConstantPool: false`) | the opposite policy: one immutable global per float literal, "V8 rematerializes a float constant through an integer register at each use" |
| hoistInvariantLoop | `licm` (pure only) | the memory model of section 2 |

Evidence that two passes do the same thing in practice is in the overlap table below (section 4b). A jz pass whose flag off moves no byte anywhere is in section 3's zero list.

### 4b. Measured overlap (RAN; 55 light units, speed): jz pass group A off, watr option B off, both off

Bytes relative to the baseline, summed over the 55 units. `overlap = dA + dB - dAB`: positive means both passes remove the same thing (turning both off costs less than the sum), about zero means independent, negative means together they do more than the sum.

| group | A (jz steps off) | B (watr off) | units A moves / B moves / both move | dA | dB | dAB | overlap |
|---|---|---|---|---|---|---|---|
| load reuse | reuseLoads + cseScalarLoad + narrowByteLoads | `valueNumber` | 20 / 32 / 35 | +87 | +6,872 | +7,022 | -63 |
| load reuse | same | `valueNumber` and watr `cse` | 20 / 55 / 55 | +87 | +17,351 | +17,967 | -529 |
| address CSE | hoistPtrType + hoistPtrOffset + hoistAddrBase | watr `cse` | 45 / 55 / 55 | -1,805 | +5,975 | +4,590 | -420 |
| address CSE | same | `valueNumber` | 45 / 32 / 55 | -1,805 | +6,872 | +4,965 | +102 |
| globals | promoteGlobals | watr `cse` | 47 / 55 / 55 | -4,410 | +5,975 | +2,512 | -947 |
| constants into memargs | constBases | watr `offset` | 33 / 0 / 33 | +401 | 0 | +401 | 0 |
| dominating tests | settledTests | watr `guardRefine` | 10 / 0 / 10 | +1,938 | 0 | +1,938 | 0 |

Reading: jz's load passes and watr's valueNumber/cse remove different things (overlap -63 and -529: no redundancy; the loads jz forwards or reuses are not the ones watr's single clock keeps). jz's address CSE and valueNumber overlap by 102 bytes of 6,872: small. watr's `offset` and `guardRefine` move no byte in the corpus, so jz's constBases and settledTests carry all of their work (constBases: a known address held in a local, which watr's bound-only `offset` cannot see; settledTests: a repeated test by value, which `guardRefine`'s tag guards do not cover). hoistAddrBase, hoistPtrType, promoteGlobals each GROW the module when on (dA, dAB negative): they are speed passes. The one overlap table is a start: pairs not measured (forwardStores has no watr analog; scheduling vs `schedule`).

## 5. What a single design must cover (list, not design). READ-derived; nothing here was run except where marked

### 5a. Facts per value: what makes two expressions "the same value"

1. Operation, type, immediates: opcode; memarg `offset` (the passes split every address into `base + off` with `accessOf`, folding `i32.const`/`shl` constants in the address: `constOf`); sign/width of the access; lane index; constants by bits (f64 literals by bits, but `fold` and forwardChecked treat every NaN payload as one NaN for comparisons).
2. Operand value numbers, with the address shape canonicalized: `(i32.add A (i32.shl I K))` is one value however the add is ordered (hoistAddrBase matches both orders and relies on fusedRewrite having normalized it: a numbering must do that itself or run after it).
3. Local identity: a version per definition (forward-store's `name@at`), the copy relation (`copyRoots`: a local set once from a local set once, dominated; hoistPtrOffset's `alias` map), a tee as the value it carries, a local written in a loop as a phi (every pass kills its writes at the loop head).
4. For a memory read: (region, generation). The regions are in 5b; a generation moves on a kill in that region (5c).
5. Representation: bytes read vs bytes written at an address (an f64 store forwards to an f64 load bit-exactly, NaN payload included; an i32 element forwarding to `f64.convert_i32_s` in forwardChecked; a byte read of a word in narrowByteLoads), the NaN-box layers (`i64.reinterpret_f64`, `i32.wrap_i64`, `& OFFSET_MASK`, `-4`/`-8` header offsets: forward-hops reads through copies of these), canonical-NaN selects (nanCanon).
6. Value facts: constant; range `lo/hi/int/nz/nan` (const-bases: lo==hi and 0 < lo <= 2^31-1 on the base, index lo >= 0; select-arms `intRanges`; fold: "finite" = `f64.convert_i32`, a finite literal, or a local all of whose definitions are finite); a truth value (`TRUTH`: result of a compare); known-unsigned.
7. Effect class of every op: pure; may trap (div/rem, non-saturating trunc, loads); reads region R; writes region R; moves array blocks; allocates; sets/reads a global; throws (the `$__throw_*` helpers never return); calls an import (re-enters the host). Today the classes are five separate call-graph closures (section 2c, D9).
8. Availability: dominance of the first computation (reuse-loads' `seen.depth >= depth` rule: a load in a conditional arm is not reused outside it, "a predictable branch is cheaper than the select"), the guard under which it was computed (forwardChecked's `held`/`gkeys`: "a load of A in the arm a guard opens runs only where the guard holds"), loop depth.
9. Sharing: one IR node reachable from two parents runs at both: reuse-loads `census`/`shared`, cse-address `refs`. A numbering over a tree must see the DAG or the rewrite lands twice.
10. Profit is not equality: ≥2 sites per region (cse-address), `vnWorth` in watr, LATENCY gates, reuseLoads' refusal of loads in deeper arms. The numbering answers "same"; a separate cost step decides to materialize.

### 5b. Memory regions a model must tell apart to keep every rewrite the passes make today

| region | who needs it apart | how told apart today |
|---|---|---|
| elements of an array, by allocation cell | forwardStores, sinkStores, reuseLoads | `mem` mark `e<cell>`, from the emitter (`markElem`; summary `arrayCellOf`) |
| fields of an object, by (slot, layout set) | same | `mem` mark `f<slot>:<sids>`; unmarked for struct-inlined layouts |
| typed-array buffer, by base | forwardStores/sinkStores (resolved base + offset), earlyStores/LICM (`distinctParams`: plan proves every call passes distinct fresh arrays; fresh typed globals), reuseLoads (local name) | no marks: base expression equality, plan-level distinctness |
| byte range inside one base (offset +- width) | sinkStores, carryStores, earlyStores | byte arithmetic on `off` and access width |
| header words (length at -8, forwarding word at -4) of an array | hoistPtrOffset, forwardHops, LICM `HEADER_STORE_FREE`/`stableHeaderNames`, forwardChecked (`kept`), forwardStores/sinkStores (calls to `$__len`, `$__ptr_offset_fwd` inert) | per-pass lists of calls and store ops (section 2c D3, D4) |
| whether a block can move | forwardHops (`collectStillFuncs`), hoistPtrOffset (any store/call) | "a block moves only inside a call" |
| module globals by name | promoteGlobals, global ptr hoists, forwardHops (`@g`), forwardChecked | transitive call-graph rows; indirect call = every global any function writes |
| the allocator's heap globals | LICM (`allocGlobal`), forwardHops (`stillByName`) | the `$__` prefix, `$__alloc*` |
| closure cells | LICM (`CELL_PREFIX`), promoteCells | name prefix |
| static data (never-resized constant arrays) | foldStaticArrReads, `hoistStableGlobalConstLoads` | compile facts `staticArrs`, `globalTypedLen` |
| the host: an import may call any export and read or write exported memory | all of the above (D1) | handled in 4 of the 7 closures; not in `collectReachableGlobalWrites` |

### 5c. Kills a model has to represent (events and what each ends)

store (by region + byte range; full-width vs narrow vs v128 vs atomic); `memory.grow/copy/fill/init` (everything); call by effect class (pure: nothing; reads: nothing but clocks; writes memory R; sets globals G; moves blocks; allocates; throws and never returns; imports and `call_indirect/call_ref`: everything any export does); `global.set`; a local write (kills values keyed on it; a write of a tee inside the expression kills mid-statement); loop back edge (values from before are not available at the head, values the loop writes are phis); join of two arms (meet); a block with a branch targeting it (meet with the branch's state); `try`/catch (everything); a store of an arm that may not run.

### 5d. Cases that do not fit a plain numbering, and the pass that does each

| case | pass | why it does not fit |
|---|---|---|
| a rewrite behind a guard | forwardChecked (value known only under guard C, "kept" header across a bounds-checked store), hoistGlobalPtrOffset (total entry resolve so hoisting past a zero-trip loop is safe), hoistForwardHops (re-resolve after each call that may move a block; the set before the loop tests in line and calls only where the block moved), settledTests (a dominating test of equal value) | needs a guard-key dominance fact and a "safe to speculate" fact (total / cannot trap) |
| a loop-carried value | carryStores (`$cs` passed across the back edge, initialised before the loop under the tests around the load), leadGathers (next round's gather, address stepped by the induction, `select` for the last round), sinkStores (store sunk past the loop with a `$ran` flag, flushed before each throw guard) | a phi across the back edge plus a pre-loop materialization; requires induction facts (phase 6b) |
| a rewrite that changes control flow | sinkStores (adds an `if` after the loop), carryStores (`if P` before the loop), leadGathers, settledTests (deletes an `if`), testedChoices (replaces a compare of a select by the select's condition), forwardStores' diamond (a fresh local set in both arms: an explicit phi), fold's `select` on a constant | the numbering must be able to emit joins and delete branches |
| factoring across arms (not value-equal) | shareQuotients, selectArms, truncChoice (`ceil`/`floor` choice -> `trunc`) | operation-specific algebra, exactness arguments per op (IEEE: `a - k = a + (-k)`) |
| scheduling, not numbering | leadChains, issueOrder, earlyStores, part of sinkStores; watr's `schedule`/`lazySelect` | order of execution; their only shared need is "may these two statements swap" (the kill rules again) |
| backward demand | nanCanon (a canon is dead if every consumer is arithmetic/compare), forwardStores' dead-store drop (`pending`), tested-choices (dead tees via liveness) | forward numbering has no use information |
| representation | narrowByteLoads, foldLoadCasts, constBases (memarg fold, range proof: no wrap), poolFloats | peepholes over values, not equalities |

### 5e. What a design could drop (if one numbering and one memory model exist)

Candidates for deletion as separate files (each would be a use of the numbering): reuseLoads, cseScalarLoad, hoistPtrType, hoistPtrOffset, hoistAddrBase (five regionTrackCSE/walk skeletons), forwardStores' forwarding half, foldStaticArrReads (a read of the static region), settledTests, fold, forwardChecked (its numbering). Not deletable by a numbering alone: sinkStores, carryStores, leadGathers, stillLoads, forwardHops (each needs loop facts), shareQuotients, selectArms, testedChoices, nanCanon, constBases. The scheduling trio (leadChains, issueOrder, earlyStores) belongs to a scheduler phase, not this one. Which flags move no byte anywhere is in section 3.

### 5f. Placement: the value passes straddle watr (pass-table, READ)

| before watr (func stage, one function at a time) | after watr (tail, whole module) |
|---|---|
| foldStaticArrReads (first), promoteCells, nanCanon, hoistPtrType, hoistInvariantPtrOffset, hoistPtrOffset, hoistInvariantLoop x3, hoistAddrBase, cseScalarLoad, forwardStores, sinkStores, earlyStores, promoteGlobals (and hoistGlobalPtr* in the module stage before), foldLoadCasts, reuseLoads, narrowByteLoads, settledTests | stillLoads (before watOptimize), watOptimize, postGlobalPtr, forwardChecked, leadChains, issueOrder, selectArms, shareQuotients, testedChoices, leadGathers, carryStores, constBases (after inlineTiny), poolFloats (last of the group); forwardHops and hoistGlobalConstLoads are module-stage, after the function walk, before watr; `fold` runs at link, on the tape |

The reasons the table gives for the late ones: forwardChecked "the checked reads and stores watr left" (it needs watr's if-form), leadChains "its own passes would merge the split values back", leadGathers "its value numbering would read the gather back", constBases "the inliner's constant arguments", postGlobalPtr "watr's inliner can merge stable-pointee decodes into one caller". The early ones need the emitter's marks (`mem`, `cseLoadBases`, `distinctParams`) that `watOptimize` drops (it replaces every function's array: architecture.md "The index of phase 5b"). So one numbering that must keep every rewrite is run at least twice (once on emitted IR with marks, once after watr's inlining) or watr's valueNumber must learn the marks.

## 6. The gates: tests that pin these passes

Method (RAN, `scout-7/gates.mjs` and `gates2.mjs`; heuristic by regex over `test(` blocks, so counts are "blocks whose text names the pass", not exact): a block is SHAPE if it calls the pass function on hand-written IR or reads WAT text (`wat(`, `funcWat(`, `wat: true`, `count(`, regexes over WAT); RESULT if it compares jz with the host (`agree(`, `oracle(`, `run(`, `levels(`). Both = a block that has both. The files below each have one dedicated test file; extra pins live in `test/optimizer.js` (9,907 lines), `test/wat-invariants.js`, `test/minimal-output.js`, `test/pass-table.js`.

| pass | dedicated test file (blocks) | blocks naming it over all of test/ (shape only / result only / both / neither) | what survives a rewrite, what must be re-pinned |
|---|---|---|---|
| forwardStores | forward-store.js (5), mem-alias.js (9, shared with reuseLoads), array-load-cse.js (4), slp.js | 8 (4 / 0 / 4 / 0) | `store forwarding: a chain through an out parameter reloads nothing…` and the two diamond tests count loads/stores in the IR/WAT: SHAPE, must be re-pinned (or recast as `wat` counts on the new pass). The "linear traversal work" test (forward-store.js:14) pins a cost property of THIS pass's walk. `array-load-cse.js` flips `forwardStores: false` in config: the flag name is a test input, a deleted flag makes `Unknown optimize key` fail those |
| sinkStores | sink-stores.js (3) | 5 (1 / 0 / 2 / 2) | 2 of 3 call `sinkStores(f)` on IR and compare `is(f, fn(...))`: SHAPE. The third ("out-parameter products agree with the host, through a throw, one array as both and no round") is RESULT: survives |
| earlyStores | one block in optimizer.js (6142) | 1 (0 / 0 / 1 / 0) | an IR pin plus the result checks over `['speed', { earlyStores: false }, 2]` and a wat-order check `earlyStores: false keeps it after`: SHAPE + RESULT |
| carryStores | carry-stores.js (3) | 4 (0 / 1 / 2 / 1) | `kernels agree with the host with and without the carry` survives; the two IR tests pin the rewrite's shape (`carryStores(['module', fn(...)])`) |
| reuseLoads / narrowByteLoads | reuse-loads.js (3), mem-alias.js | 5 (3 / 0 / 2 / 0) | all IR/WAT: SHAPE (`reuseLoads(fn)` returns true/false; counts loads) |
| cseScalarLoad / loads CSE | array-load-cse.js (4), field-cse.js (13) | 12 (3 / 2 / 5 / 2) | `agrees(...)` tests in field-cse.js are RESULT (survive); the `wat` count checks (e.g. "the cursor and the buffer are read once an iteration") are SHAPE |
| hoistPtrType / hoistPtrOffset / hoistAddrBase | header-hoist.js (8), a few in optimizer.js, wat-invariants.js | 5 (1 / 0 / 0 / 4) | mostly RESULT with the kernels; the few SHAPE pins are in optimizer.js |
| shareQuotients | share-quotients.js (3) | 3 (1 / 0 / 1 / 1) | 2 IR pins, 1 RESULT (the hue sector against the host lane for lane) |
| selectArms | one block in optimizer.js | 1 | SHAPE |
| stillLoads | still-loads.js (4), exit-tests.js | 5 (2 / 2 / 0 / 1) | 2 IR pins, 2 RESULT (`reads moved ahead of a loop answer what the loop read, with and without the pass`) |
| leadChains | 2 blocks in optimizer.js (6216, 6254) | 2 | IR before/after pin + result over `['speed', { leadChains: false }, 2]` |
| issueOrder | 2 blocks in optimizer.js | 2 | model-order pins (SHAPE) |
| leadGathers | optimizer.js 5729 | 1 | IR pin + host check |
| constBases | optimizer.js 9781 | 1 | IR pin (`constBases(['module', f])[1]`) |
| forwardHops | forward-hops.js (4), array-holes.js, iteration-release.js | 6 (0 / 0 / 4 / 2) | RESULT and WAT counts together |
| forwardChecked | no dedicated file; covered inside field-cse/grid kernels (not found by name) | 0 by name | unpinned by name: its flag `forwardChecked` appears nowhere in test/ (grep) |
| settledTests | one block, minimal-output.js:1246 (`guards = (settledTests) => funcWat(compile(…, { settledTests }))`) | 1 | SHAPE (counts guards in WAT with the flag on and off) |
| testedChoices | pair-tests.js:39 | 2 | IR pin plus RESULT over `{ testedChoices: false }` |
| foldStaticArrReads | closures.js, strings.js, pass-table.js | 3 | RESULT mostly |
| nanCanon | optimizer.js (13 blocks), pass-table.js | 13 (0 / 3 / 3 / 7) | IR pins (`stripDeadCanons` on hand-written WAT) |
| promoteGlobals | optimizer.js, passes.js, perf.js, wat-invariants.js, iteration-release.js | 6 (1 / 2 / 2 / 1) | mixed; `hoist-loop-global.js` (3 RESULT tests) pins the write-closure behaviour on DIRECT and TRANSITIVE reassignment, not on an import |
| hoistGlobalPtrOffset / loop / const loads | hoist-loop-global.js (3), pass-table.js, perf.js, bench.js | 8 (1 / 2 / 2 / 3) | RESULT; no test where an import re-enters (the reproduced D1) |
| poolFloats | optimizer.js, perf.js, value-number.js, … | 12 (2 / 0 / 10 / 0) | mixed |

### Flag names as test inputs
Passing `{ level, <flag>: false }` is how the "with and without" RESULT tests are written. A phase that deletes a flag (the brief: "the forwarding and reuse files are deleted") turns each such test into `Unknown optimize key` (src/optimize/config.js `resolveOptimize` throws on unregistered keys). Lines mentioning each flag across `test/` (grep -c, RAN): forwardStores 14, sinkStores 13, earlyStores 5, carryStores 8, reuseLoads 5, narrowByteLoads 4, cseScalarLoad 4, hoistPtrType 3, hoistInvariantPtrOffset 1, hoistAddrBase 7, shareQuotients 7, stillLoads 6, leadChains 9, leadGathers 5, constBases 3, settledTests 1, testedChoices 2, promoteGlobals 8, hoistGlobalPtrOffset 12, hoistLoopGlobalPtrOffset 6, hoistGlobalConstLoads 2, nanCanon 19, hoistInvariantLoop 48, promoteCells 6, issueOrder 8, poolFloats 16. Those lines also include imports of the pass function and mentions in comments.

### The two aggregate gates
- `test/perf-ratchet.js` + `test/perf-ratchet.json`: loop-body instruction counts (static `loopBodyOps` and `enteredLoopOps`) summed over the seeded corpus (`scripts/perf-corpus.mjs`, 40 seeds), per category (js: int 1349/647, float 1372/608, mixed 2234/1045, cond 1211/581, buf 31533/2830, nest 5545/2034, slice 230812/30656, ring 30720/4720, condref 202101/7587; the file also holds a wasi table). The check is `ok(equal, …)` (line 370): any difference fails, a lower count as well as a higher one, until `node test/perf-ratchet.js --update`. The header names what moves it: disabling hoistInvariantLoop moves `mixed` 870 -> 1054 (old numbers). It is a WAT-shape gate, aggregate, not per pass; a numbering that produces the same or fewer loop ops passes only after `--update`.
- `test/spellings.js` + `test/spellings.json`: 71 cells with `ops` shortfalls per (kernel, spelling, style, level). "A cell fails on any difference from its listing, a smaller gap too" (header of spellings.js): same two-sided rule. Re-pin by `node test/spellings.js --update`.
Neither ran in this scout (the machine runs a battery). Which passes move them was not measured; only hoistInvariantLoop is documented to.

## What was not done, and what is inferred

- Not run: timing of any kind (machine busy); `test/perf-ratchet.js` and `test/spellings.js` (which passes move them is unmeasured); the test suite; levels `size` and 2 for part 3 (speed only); 6 heavy units.
- Inferred from reading, not run: the inventory rows' shape/rewrite/kill text (sources read in full: forward-store, sink-stores, early-stores, carry-stores, reuse-loads, cse-address, share-quotients, still-loads, const-bases, fold, settled-tests, tested-choices, forward-checked; partly: forward-hops (first 475 lines skimmed for the kill rule), lead-chains, lead-gathers, issue-order, select-arms, licm.js `computeLoopInvariance`/`cseScalarLoad`/`collectHeaderSafeFuncs`, globals.js `collectReachable*`/`promoteGlobals`); D2 to D10 and D11 (classes of difference); all of part 4's "what jz knows that watr cannot" column (watr read at valueNumber, cse, offset and the pass list only; propagate/fold/peephole/identity/branch/globals/licm/lsr/schedule not read in full); part 5; part 6's classification of tests is regex-driven.
- Reproduction hygiene: every wrong-answer program above was run on the export tree of 3420027ce; the export differs from `main` only in `src/optimize/pass-table.js` (`on()` honours `__SKIP`; `fired()` digests) and the instrumented call sites in `driver.js`, `watr-tail.js`, `optimize-module.js`; the W1 programs do not depend on those edits (level 0 + one flag on reproduces them with the pass table's own flags).
- Files: `scout-7/repro/*.mjs` (probes), `measure.mjs`/`measure-heavy.mjs`/`overlap.mjs`/`aggregate.mjs`/`tables.mjs` (measurement), `m-*.jsonl`, `h-*.jsonl`, `p1/*.jsonl`, `oo-1.jsonl` (raw rows), `gates.mjs`/`gates2.mjs` (test census).
