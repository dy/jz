# Contributing to JZ

## Quick start

```sh
git clone https://github.com/dy/jz.git && cd jz
npm install
npm test              # core suite
node bench/bench.mjs  # run benchmarks
```

### Shared watr optimizer

For coordinated changes in sibling `jz`, `watr` and `subscript` checkouts,
test their main branches together with
`npm install --no-save --package-lock=false --ignore-scripts ../watr ../subscript`.
This selects the local libraries without changing the published dependency ranges.
The parser allocation regressions require source-span parsing in subscript and
watr's `loc: false` option.
Before release verification, use `npm ci` to replace local links with the locked
registry packages so local tests exercise the same dependencies as CI.

`package.json` depends on the published subscript 10.8.1 (linear-storage literal
decoding, surrogate-pair escapes and async-member parse fixes) and watr 5.11.8, which
carries the two optimizer rules jz's speed rows rely on: the mixed-sign
truncation-of-convert fold under a non-negative operand (base64's decode
loop) and `ifset` leaving a branchy condition alone (heapsort's child pick).
It also lifts a first operand's block prefix without crossing an earlier
evaluation, closing the watr size backstop. A clean install includes these rules.
The 5.11.6 follow-up preserves result-producing calls and memory growth at
sequence boundaries and corrects local-slot lifetimes across nested control flow.

Watr 5.11.5 also defers costly pure local initializers to the
exclusive value arms that consume them. It runs before local reuse, replacing
eager selects with typed branches where some path needs none of the work.
JZ enables this bounded duplication only when its tier waives the size guard;
default and size builds retain their output. Memory reads, calls, trapping
operations and intervening input writes keep their evaluation order.
The shared folded-code guard also detects partially supplied numeric operands,
so these passes preserve values consumed from the Wasm stack.

Failed closed Number guards retain their excluded interval only for unchanged,
uncaptured local bindings. Typed-loop versioning uses its existing byte-length
ceiling and exact affine extent guard to reject a fast copy that would require
that interval. The surviving checked loop keeps its existing no-respecialization
mark; the Number/SIMD fast path stays unchanged. Unknown offsets, non-unit
strides, incomplete predicates and mutable bindings retain both paths.

Generic local propagation and merging run in watr after linking, including
the fast tier. The same local-slot allocator runs in the lightweight tail,
including level 1: disjoint temporaries share storage instead of inflating
recursive stack frames. Its lifetime proof preserves implicit zero values,
conditional writes, nested branch exits and loop-carried values. Checked-load
unclamping also preserves reads before a defining guard: local-slot reuse can
make the guard overwrite its earlier index. Shared read/write interference
checks protect this rewrite and branch-to-select conversion. A branch that
bypasses the first assignment preserves the local's implicit zero; named region
exits are recorded in the allocator's existing traversal. No JZ-specific allocator is needed.
Dominating small constants propagate into control flow using
the existing binding-use census. This pass skips functions mixing numeric
and named local references, which can alias. The duplicate JZ implementations and cleanup sweep are removed.
Global-load optimizations share a lazy call-graph write proof; tiers without a
consumer build neither it nor the subsumed coarse volatility census. Fixed
typed-array global snapshots cache their immutable allocation length with the
base under that same write proof. A zero base produces a harmless zero length
until the original receiver check runs, preserving zero-trip and nullish behavior.
Fixed number-carrier peepholes call the carrier directly, without a session lookup.
Generic numeric NaN checks share one predicate across classification, conversion,
truthiness, equality and typed search. It requires an actual NaN before accepting
a payload outside the complete box prefix or inside reserved ATOM/aux=0 space.
Signaling/negative NaNs stay numeric; infinities and real pointer/atom boxes do not.
Positive quiet payloads that collide with a live box still require a Number-domain
proof at their producer, never a guessed tag at the generic consumer.
Guarded scalar updates are converted to selects in watr using Wasm types,
after JZ lowers the original branches with their settled representation facts.
The statement scheduler orders adjacent integer min/max updates so an input
carried from the prior iteration is consumed last. Only commuting local-only
updates of the same signedness qualify; floating comparisons, mixed extrema
and observable intermediate updates retain their order. This uses the existing
loop statement walk and adds no runtime guard or new representation.
Condition chaining and boolean simplification also run in watr, including the
fast tier; link no longer implements these generic body rewrites on the tape.
Watr pools costly scalar literals after folding and inlining, before outlining
prices repeated expressions.
Its shared cost estimator counts alignment and offset bytes even when WAT omits
them, so load reuse is judged against its encoded cost.
Integer zero tests use Wasm eqz in the shared identity sweep; inequality uses
two unary tests instead of a zero literal and comparison.
Consecutive constant shifts combine only when their separately masked counts
sum to less than the word width. Memory offsets fold only when unsigned value
bounds prove that the original address addition cannot wrap.
Single-use, small-function and wrapper inlining share construction, parameter
setup, local resets, renaming and returns. Read-only local arguments bypass
copied parameter storage when argument evaluation cannot write their source.
Equal-width literal tuples in every arm of a conditional use the existing
multiple-result ABI. Expression and statement returns share element boxing
and finalizer emission. A block must pass the shared return-path proof before
selecting multiple results; a possible fallthrough needs to carry undefined.
Object.assign captures every argument before checking its target or copying
properties. Summary aliases retain closed layouts through this staging; unknown
keys copy through ordinary property storage on the original target. A fresh
literal target keeps its planned layout too: replacing the call with a spread
constructor would interleave source getters with later argument evaluation.
The existing written-key planner can extend an anonymous data-literal target
before re-summary when every source has a closed, non-null, undeletable layout.
No binding or accessor can expose that target before the copy finishes. Bound
targets require the existing proof that nobody observes their key set; prepare
never adds copied keys speculatively. Conditional source keys keep ordinary storage.
Collection constructors and structuredClone stage ignored arguments before
consuming the input. Grouping captures the iterable and callback before checking
callability or starting iteration. Missing required arguments use the ordinary
undefined/error path; they must not reach emission as absent compiler nodes.
Copies snapshot keys before invoking getters, then test each saved key's current
presence and read its current value. Getter deletion/reinsertion and target
setters can change later reads; a cached slot/value is not a presence proof.
Host copies snapshot all own string/Symbol keys, check each current enumerable
descriptor without Get, then preserve the value's identity through the raw host read.
Object spread sources proved to be only null, undefined, Boolean, Number or
BigInt contribute no keys and preserve the result's closed layout. The source
expression still runs once in property order, including its effects and throws.
String, object and unresolved source kinds retain their ordinary copy path.
Accessor value enumeration and clone decoding share that protocol, keeping the
snapshot separate from the output because hash deletion relocates buckets.
The summary reaches copied getters through its ordinary member-call authority;
a deletable source cannot give a spread a fixed, always-present layout. Deep
clones follow those effects through the existing object and cell identities.
Structured cloning snapshots ordinary-object/Array keys and completes each
recursive value read before taking the next current value. Its Array output
starts with the source length and holes; named string keys share the same copy
path. Map/Set instead snapshot their entries before recursion. Native internal
slots clone separately, and Symbol values use the existing unclonable TypeError;
Symbol property keys are excluded. Error clones retain the documented name/message
model and deep-copy overwritten slot values; non-box NaN payloads remain numbers.
`__copy_keys` reuses ordinary enumeration IR
under a complete temporary emission frame before schema assembly, restoring the
caller frame in `finally` and discarding the helper with each compile session.
Property tables share a canonical String-or-Symbol key conversion. String-hint
hooks run once and may return a Symbol; hashing and equality then preserve its
whole identity without interpreting payload bits as string addresses. Public
string enumeration omits Symbols, while object copies and rest retain them in
own-key order. Structured cloning retains only string-keyed properties.
Size-tier probes leave identity comparison to the shared key/Map comparator
instead of duplicating it at each call. The compact string hash classifies
atoms once; its remaining canonical property keys are strings. String/Symbol
hash values and the speed tier's inline shortcuts stay unchanged.
Symbol factories evaluate every argument before converting the description;
conversion getters, fallback methods and errors follow the string hint even
though descriptions are not retained. Ignored arguments keep their effects.
The host adapter maps each instance's Symbol identities in both directions.
Interned names travel in metadata; fresh host inputs advance the same counter
as compiled factories. Arena reset restores source globals but never reissues
an identity. These maps and counters remain local to an instance.
The shared counter is emitted only for a compiled Symbol factory; loading the
module or using interned names alone does not add a public counter export.
Native method wrappers use internal tag predicates and runtime brand errors.
Preparing an unused wrapper therefore does not add source-level BigInt or throw
demand; its error data and exception support follow actual emission. Their
receiver parameter joins the closure ABI only when a reader is reachable;
explicitly held prototype methods retain it. Strict compilation keeps its
ordinary dynamic-read rejection before selecting a native method reader.
Try, catch and finally bodies establish their block declarations before closures
are prepared, including parser bodies represented as bare statement lists. Recursive
and forward-capturing closures therefore share the block's renamed bindings.
Source inlining captures arguments in call order before defaults or the body
run. Parameter writes in defaults and nested closures require private mutable
storage. Unwritten literals substitute directly. A leaf can also substitute a
single first operand, or reread a binding when its whole expression cannot
invoke user code. Caller-local bindings no closure captures also substitute
when neither the remaining arguments nor the callee writes them. Single-use
Number arithmetic over those bindings follows the same proof. Other arguments
retain captures; alias/local passes can remove copies after proving their
sources stay unchanged. Closure splices do not inherit the parent's binding proof.
Expression calls keep captures in a sequence at their evaluation point. Inlining
never moves initializers out of branches or loops; the IR optimizer owns motion.
Numeric demand follows ordinary array cells through binding aliases, indexed
stores and reads, append/prepend stores, `concat` copies, and known `forEach`
callback parameters. It reuses the
summary's settled cell identity and existing demand lattice; unknown readers,
unmodeled copying methods, escaped arrays and callback defaults prevent numeric
seeding. A concat argument that might itself be an array also keeps its identity.
Summary length columns use the same dense cell ids as element kinds;
definition and store-kind columns use binding ids. Sparse stores keep their map.
Name lookup stores a single binding id directly; only names shared by specialized
variants need a list. Scoped readers still select their binding before joining.
Published readers retain their own columns across later summaries. The typeof
predicate cache retains successful matches; other conditions need no record.
Boolean values that may be absent use the tagged carrier, just like nullable
BigInts. A payload kind cannot erase absence when projecting a binding into
local or captured-cell storage; callback writes and their enclosing reads
must agree on that carrier.
Closure bodies contribute demand only in their own frame. An assignment's
original value also flows to its expression reader, independently of the
stored slot; scalarization must preserve that observation.
A fixed typed receiver and an integer range wholly outside it prove a missing
read before an eager load is emitted. Receiver and index evaluation remain in order, and the missing
index bit propagates through nested gathers. Nullable receivers keep checks.
Typed-array scalar replacement keeps observed writes on the memory path and
converts discarded compound writes back to the element type. Conversion hooks
run before bounds checks, including on an observed Float32/Float64 store whose
index misses. Logical stores retain the same exception and mutation effects as
plain stores, so surrounding catches, finally blocks and loop bounds stay live.
Every variable write invalidates its earlier flow kind immediately, including
assignments nested in expressions. The next operand cannot read a stale kind.
Captured mutable cells keep their joined kind because a call can change them
between operands. Grouped sequences preserve their final value's carrier,
including SIMD lanes and the full magnitude of unsigned helper results.
Packed object-array reads share ordinary array bounds proofs. An uncertain
index carries boxed undefined until a field projection checks presence; layout
admission alone never authorizes a raw pointer local. Receiver captures retain
the packed slot layout, including common fields of admitted unions, so bounds
checks cannot redirect packed cells through ordinary object loads. Effectful
keys capture receiver identity first and resolve forwarding after the key.
Dynamic property-key reads retain ordinary boxed arrays because their dispatch
cannot interpret inline record cells.
Plain member writes capture a mutable receiver and key before RHS calls,
getters or conversions can replace them. Typed element and array-length stores
also retain the receiver across value conversion. Uncaptured private bindings
keep their existing index proofs when no operand writes them. Property-key
conversion precedes a strict primitive-write error, after RHS evaluation;
nullish receivers reject before key conversion.
Unknown numeric receivers retain ordinary own-property writes on collections,
buffers and closures through the shared property store. Primitive rejection
checks the complete boxed-value prefix before tag dispatch, so a numeric NaN's
payload cannot masquerade as object storage. Proven array/typed stores keep
their existing element path.
Pure Number arithmetic over unchanged private bindings needs no key snapshot.
When a key must be saved, its numeric carrier, unsigned interpretation and
current range travel with the value. A proven typed access can tighten that
snapshot to the fixed extent even when a postincrement's complete counter hull
includes its terminal value; RHS effects still see the original evaluation
order (`test/member-targets.js`, the AoS and codec cursor regressions).
Saved-key ranges and unsigned carriers live in emission refinements; creating a
temporary never mutates the function's frozen representation plan.
Ordinary-array stores reuse the canonical loop bounds proof at every tier;
skipping interval analysis does not discard a proved element key. Calls and
coercions that can resize an alias invalidate that proof.
Resolved class-method calls use the same transitive `writesOuter` fact as
direct calls. Their receiver and arguments are still scanned for getters,
coercions and nested calls; an own override leaves the target unresolved.
Prepared computed deletes keep receiver and key as separate operands. Binding,
numeric-buffer and frame-effect scans must visit both; key conversion can call
user code, throw, and publish storage. The surrounding handler stays live.
The runtime rejects nullish bases before key conversion, preserves primitive
key identities, and returns Boolean true for both deleted and absent properties.
Array length, string length/indices and in-bounds typed elements reject strict
deletion. Typed index checks compare full unsigned indices and lengths; numeric
receivers never reach pointer-header dispatch. Explicit host handles use the
matching deletion bridge; a nonconfigurable host property raises the same
source-catchable TypeError.
An initializer emitted as a proved pointer establishes presence for its local
binding just as a proved element read does. Captures and later writes reject
this block-scoped fact; a checked cursor keeps its possible undefined value.
IR clones retain schema-liveness tags on every copied producer. Method dispatch
can replace a constructor's original tree with its clone; losing that tag makes
the linker omit live object fields and Error brands from host metadata.
Boxed arrays use the existing private `TOMB_NAN` atom for an absent slot;
explicit `undefined` keeps its own value atom. Construction, skipped stores,
length growth and deletion preserve that distinction. Indexed value reads
normalize absence; reflection and property-callback iteration check occupancy.
Concat captures all arguments before reading source lengths, copies arrays,
and appends other values without conversion. Spreads finish argument evaluation
before the first copy or string conversion; an empty spread still makes a fresh
array. Ordinary array concatenation uses raw cell copies.
Raw copies (slice, concat, reverse and structured cloning) retain holes;
value copies (spread, Array.from and change-by-copy methods) densify them.
The settled element kind's ABSENT bit is the shared density proof: proven
dense reads and iteration keep their direct loads, while sparse reductions
find the first present element before seeding their accumulator.
Numeric coercion preserves the emitter's present-read proof and folds a
checked read's constant miss arm before considering the broader source kind.
A sparse array's hit arm can still be absent and uses one undefined-to-NaN
conversion; only a dense numeric array carries the checked-number shortcut.
Shape-loss advisories describe the settled summary. Numeric entry contracts
restart its kind solve, so discarded unknown-parameter escapes are discarded
with their diagnostics; genuine losses from the final solve still report.
Array element facts apply only to element reads. A dynamic string key can also
name `length`, a method or an own property; solver and read-only queries join
those kinds before projecting a field. Local schema and JSON-shape propagation
must retain that distinction, including when an indexed result is captured.
Only a present Number key restricts write effects to numeric properties;
nullish keys can change named slots. Only integer Number keys in `0..2^32-2`
address elements; other Numbers name properties, so the summary retains a
separate numeric-property domain through array joins, escapes and host exposure.
A fresh result cannot be mutated by the host before it returns: numeric properties
open only when the host can reach a retained alias, including an import argument.
An open indexed-read kind still retains BigInt producer provenance from known
stored elements and own properties; it does not prove the whole read a BigInt.
Array-valued receiver expressions share named arrays' tagged storage readiness.
Reads and writes retain the original key for ToPropertyKey unless an integer
index proof authorizes truncation. Integer endpoints of a parameter hull do not
prove every argument integral. An i32 parameter ABI can supply integrality,
but its incoming magnitude is reused only within signed-word bounds and while
the parameter is never reassigned, including through a nested closure. Wider
source magnitudes cannot describe a word-converted payload.
Packed replacement requires a present cursor or
an unconditional projection before the store; caught and optional projections
cannot justify dropping an append or property write. The ordinary boxed path
keeps those operations and their evaluation order.
Losing an object layout uses the summary's effectful merge, so dynamically read
BigInt fields retain self-describing storage. Read-only property queries reuse
already-interned shape unions instead of discarding them. A BigInt member read,
including a nullable read through an expression receiver, supplies its storage
carrier to join normalization before raw and boxed arms meet. Unary numeric
dispatch also uses an ordinary array slot's tagged carrier when the key may
name a property. Synthetic destructuring arrays use those same tagged writes
and reads; the normal scalarization pass can erase their storage when proved.
Unary operations unbox their input and honor the planned result carrier,
so exact BigInt results stay raw until their consuming storage edge boxes them.
The array callback emitter substitutes expression bodies only when their values
exclude BigInt, or the whole program excludes it. Unknown or BigInt-bearing
bodies retain the normal closure ABI and its nested storage/join plan; rebuilding
their syntax is not a transfer of those proofs. Numeric callback kernels keep
the existing inline path.
Iterable normalization rejects non-iterable primitives, objects, ArrayBuffers
and DataViews before an index loop begins. Known arrays, strings, typed arrays
and collections retain their existing direct paths. Set construction skips only
nullish inputs; typed elements passed into collections or grouping callbacks use
the tagged element reader when BigInts are possible.
Held Map and Set methods use shared prepared closures, with the ordinary call
receiver ABI. Member reads keep their source optional-chain structure; own data
properties and accessors take precedence over the native value. Runtime readers
become boxed dispatch roots only when settled receiver kinds admit collections.
Their capture-free closures keep canonical identity without module initialization.
Intrinsic constructor and tag identities keep shadowed builtins from changing
receiver checks.
Generic derived classes call captured base methods with their instance as the
ordinary receiver; schema methods retain their explicit first receiver argument.
This also admits native Map/Set base methods without rebinding user methods.
Known Map/Set-derived families reuse the receiver-first initializer chain: the
most-derived factory allocates native storage and installs bound methods before
running base population, field initializers and constructor bodies. Native
allocation and super-method identities cannot be captured by shadowed names.
Local family metadata follows lexical declaration scopes; local bound methods
are not module dispatcher targets. Population captures the selected adder before
opening the iterator and closes unfinished iteration after entry/adder errors.
Computed collection method reads use the same own-property, accessor and native
method dispatch as literal reads. Their key is converted once after receiver
capture; prepared readers are rooted only for settled collection-capable sites
whose key may name a method. Numeric-only keys and unrelated receiver kinds
do not retain native wrappers.
Map construction validates each entry object and reads its properties in key,
value order. Entry getters retain ordinary call effects and can change the
source array's live iteration length. Native Map copies keep their table path.
ArrayBuffer methods use the same receiver-family registry as arrays, strings
and typed arrays. An uncertain receiver selects its real family before calling
its builtin; nullish receiver checks still precede argument evaluation.
Array `for…of` loops capture their source once and reread its length each step.
Appends, shrinking and writes through called helpers remain visible, including
new nodes added while the compiler solves representation plans.
Array callback methods keep their initial iteration bound but refresh mutable
storage before each read. Shrunk indices are skipped except by the find family,
which visits them as undefined. Fixed-length proofs retain the direct loop.
Map construction joins completed entry payloads. A callback whose result is
still absent in an early solver round cannot supply a completed entry, so it
keeps the payload at bottom until its tuple becomes known.
`flatMap` appends each callback result immediately, before another callback can
mutate it; a proven pure callback retains exact-sized two-pass allocation.
Pipeline fusion checks defaults, getters, coercions and seed evaluation with
the existing effect queries. Literal typed-array promotion and fusion preserve the
callback's original receiver whenever named or rest parameters can observe it.
Captured-local AST references belong to the base emitter table: array, typed
array and collection lowerings may reuse an evaluated value independently of
which language modules the current compilation loads.
Constructor calls retain the same one-argument boundary as ordinary calls:
a grouped comma evaluates left to right and passes only its final value.
Forwarded unary iterator calls retain that boundary after preparation. Header
allocation also captures an effectful length once before using it as capacity;
the size check and any user coercion never run twice for one allocation.
Array-literal lowering keeps its completed child walk even when no spread needs
rewriting. Falling back after transforming children repeats work at every nested
literal and can repeat stateful lowerings; holes and child locations stay intact.
Decided-arm folding shares its first summary invalidation with the following
namespace and layout rewrites. Those passes retain conservative prior facts;
remaining fold rounds run against fresh summaries before unseen-key declaration.
No analysis result is reused across an untracked semantic mutation.
Summary queries build unseen object-literal shapes in their own helper. Its
captured name list belongs only to that fallback, so scalar expression queries
need no literal-builder environment. Alias and presence refinements remain live.
Solver query views expose only expression kinds, binding keys and call targets.
The full emission interface is created for published views, after solving; its
scope caches, alias refinements and retained-reader behavior stay independent.
Published parameter hulls are settled read-only records. Queries reuse their
vectors without capturing the solver or consulting mutable function signatures;
a later dispatcher change belongs to the next summary.
Typed-read presence also publishes settled binding lengths and scalar constants,
not initializer or return-body traversal callbacks. The solver retains occurrence
proofs for loop reads; fresh index nodes use the shared pure span transfer over
those records. Later AST changes affect only a new summary.
The held-object proof records mentions only for single object-literal definitions
and name aliases. Every use of those candidates still counts; primitive, array
and reassigned bindings cannot enter that proof and need no occurrence lists.
Memory page limits are validated before either compiler host encodes options.
Assembly also rejects static data that would require more than the maximum.
The hosted compiler applies the same fixed-memory scratch and final-code proofs;
their selected export and owner names survive its arena checkpoints as plain data.
Tagged BigInt copies are solved together when bindings refer back to each other.
Every incoming write must preserve or normalize the component's carrier before
its representation becomes a read fact. This includes nested closures' writes
to the owning frame's bindings. Captures carry the owner's settled representation
through each nested environment, including raw payloads that resemble NaN boxes.
A carrier proof alone cannot establish a value's kind: call-site BigInt-only
proofs also require the source expression's semantic kind.
A definite semantic BigInt can fold a
typeof guard even when stored boxed, provided incoming parameter observations
also exclude other kinds. A return exposed by branch folding ends
emission of the enclosing statement list.
Math and SIMD arithmetic leaves, including bounded calls through other leaves,
inline at expression sites. Typed element arguments retain call-order captures
inside the expression's sequence; downstream alias passes remove redundant
copies after proving their lifetimes.
Gather maps can retain scalar address generation and checked reads while lifting
a pure Float64 arithmetic suffix into two lanes. Scalar recurrences execute in
their original order, including each rounded phase addition. This requires
distinct, unwritten owned parameters; aliases, views, observable suffix locals
and unprofitable packing retain scalar code. The original loop handles odd tails.
Unconditional address caches retain that ownership proof until overwritten.
Constant fractional recurrences use outward-rounded binary-grid bounds to prove
their truncated indices. The accumulator keeps every original floating addition;
unknown writes or a missing reset on a nested-loop entry decline the proof.
Independent whole-binding hulls intersect when published, so the integer
interpreter cannot widen a tighter fractional projection back to the full word.
Interval scans reuse only loop declaration syntax within one scan; entries,
cursor budgets and abrupt-edge flow always read the current environment.
Loop-specific captured state belongs to the loop visitor, not every node visit.
Accumulator hulls bound upward and downward motion separately; a skipped
opposing step must never cancel motion across iterations.
Vector maps, gathers, ramps, reductions and stencils share the span-bound
calculation. Empty signed ranges remain empty even beside INT_MIN; widening
loads require their complete read span before subtracting extra lanes.
Small loop helpers enter exported loops only after their callees have expanded,
so the size budget includes the work being moved out of a tierable function.
Word-local initializers reuse the checked-index exact-arithmetic proof when
all source leaves are semantic Numbers; other values use the shared IR conversion.
Every intermediate must remain an exact Number integer before final wrapping,
so a rounded product cannot cancel into a small result and donate word arithmetic.
Pure comparison bounds may use safe integer intermediates beyond one word without
publishing them as word storage. Guarded name±constant bounds use the exact signed
word preimage; a finite float hull still needs its integrality check. Conditional
private indices require an exact proof for both arms.
Integer-store shortcuts prove numeric carriers, not merely an i32 representation:
pointers still need ToNumber. Clamping requires the original signed magnitude;
a Uint32 word with its high bit set cannot use the signed-word clamp. An observed
assignment preserves its original RHS, including object identity and undefined.
Loop division/remainder counters require guarded Number inputs: a positive
signed-word divisor, a nonnegative signed-word entry excluding -0, and a stable
bound that keeps the final increment in range. Fractional, wide or coercing
inputs keep the original loop; generated local names are not codegen evidence.

Stencil edge peeling runs before integral loop copies change canonical tap tests. Its
Number guards prove nonnegative word extents and entries; the single tap seed
must dominate the loop, with its unit update after the adjacent source/clamp.
Each peeled run owns its declarations, while the for initializer keeps its
original lexical scope. Abrupt transfers, captures and unstable bounds retain
the original traversal. Planning invalidates both rewritten body caches and
program facts before later proofs inspect the split.

SIMD conversion peeling and late integer conversion share the same proof of
the guard, both arms and their captured operand. An existing exact conversion
keeps one magnitude guard; lowering it again adds no guards or temporaries.

Typed-width loop versions accept stable local receivers as well as parameters.
They validate the complete Float32/Float64 carrier, snapshot fixed storage and
retain bounds checks, f32 rounding and the original assignment value. Numeric
store proofs permit direct writes; coercing values and other element types keep
their existing helpers. The raw typed readers, writers and data-address
helper decode fixed storage directly; only relocatable collections need the
generic forwarding decoder. A second stable numeric read receiver can cache its
base, length and element width, sharing one load dispatcher per output version.
This covers integer, floating and clamped storage; nullish and BigInt receivers
retain the original single-receiver loop. Float16 reuses the already-demanded
conversion helper. A null-checked numeric read refines a direct
local when computing its key cannot change that local; coercing or effectful
keys retain the original capture and evaluation order. The older polymorphic
parameter version additionally proves the entire IV range fits the receiver;
views resolve their descriptor to the data address only after reading its length.
Unmapped numeric/flat callee locals retain their call frame.
Unwritten parameters with a shared tiny constant substitute directly at every
read, including loop reads, without creating a local or a cleanup sweep.
Public adapters use the ordinary small-function inline budget; larger workers
remain shared. Internal dispatch trampolines retain the speed-tier budget.
Named-function trampolines use direct-call argument coercion, so narrowed pointer
parameters extract their offset instead of numerically converting a NaN box.
Their Boolean results follow the boundary-wrapper rule: i32 carries raw 0/1,
while f64 may already contain an atom and needs `__is_truthy` before boxing.
Comparing a boxed false with numeric zero turns it into true; recursive named
callbacks, including the JSON literal validator, depend on this distinction.
Object enumeration and bulk field copies publish tagged field-storage demand
for the source and destination layouts. This keeps a BigInt's identity when
`Object.values`, `Object.entries`, `Object.assign` or spread removes its
original slot identity, while preserving the objects' static shapes. An
unknown receiver's computed read or enumeration also exposes every reachable
field value, so nested objects cannot keep raw fields after their identities
are lost. The summary batches that unknown-key effect once per kind round,
revisiting newly discovered fields until stable and resetting before numeric
reseeding; repeated reads do not rescan every schema. A definitely numeric key
exposes only canonical Number property names and their getters, including `NaN`
and `Infinity`;
`-0` reads `"0"`. Nullable, mixed and unknown keys retain the full effect.
This keeps unrelated named closures closed when a generic receiver is indexed
by a numeric loop counter. `Object.entries` retains the same joined value kind as
`Object.values`, paired with its string key.
Guarded numeric demand shares the summary's structural mutation list with
loop refinement. Revisited guard arms reuse that list; each new summary builds
its own list, including writes in closures and their defaults.
Array property stores also feed length analysis: a numeric key can extend the
array, `length` can resize it, and an unknown key can do either. The same
transfer serves assignments and bulk property copies such as `Object.assign`.
Known-local arithmetic folds in the same propagation pass; JZ only selects
this policy with its existing `hoistConstantPool` option.
Exact cast identities have one owner in watr: JZ calls `simplifyCast` during
early SIMD preparation, and watr uses it in its final identity sweep. Narrow
stores discard irrelevant casts and masks. Integer constant pooling uses
canonical bits rather than source spellings and skips literals too cheap to pool.
The downstream watr workflow builds and tests with the same current JZ package.
See [PLAN.md](PLAN.md) for remaining gates and DSP evidence.

Native and Wasm-hosted compiler entries share memory-option configuration.
The kernel ABI carries page limits and distinct imported/shared flags; the
host retains the actual Memory object. Every compile resets this policy,
including empty input and calls after invalid limits are rejected.

A declaration supplies a whole-body integer range only when it is the binding's
sole initializer and no code reassigns it. Copied declarations after unrolling
retain their individual values without publishing one copy's range for all.
Integer-storage proofs count a bare declaration's implicit undefined unless the
summary proves assignment before every read. Conditional local and captured
writes cannot erase that initial value. Captured cells also require every write
to fit signed i32 exactly; integer arithmetic alone can overflow or produce -0.
Arithmetic reads preserve the original Number magnitude, including through
assignment and copy chains whose only final use is a word conversion. An
unbounded recurrence can cross 2^53 and round before that conversion; wrapping
its storage early changes the answer. Closed word hulls still keep i32, and
the existing guarded i64 loop copy preserves exact arithmetic until fallback.
Installed typed lengths may narrow an earlier width-based range; the invariant
check rejects widening a range that another pass may already have consumed.

Load reuse visits reads and writes in evaluation order. A shared load executes
at its first occurrence, never before preceding operands; identity-observing
uses retain undefined, while numeric-only uses normalize it. The same cache
serves numbers and nested array pointers read from plain arrays:
disjoint summary cells preserve reads across scratch-array
writes, and bound-once aliases of a shared element retain that pointer's identity.
Conditional arms keep only prior reads that neither arm invalidates. Numeric
Math calls preserve them; deletion, named-property writes and unknown effects
invalidate them. At a numeric use, a settled Number|undefined kind needs only
missing-value normalization; the null-to-zero branch remains when null is possible.
Mutable scalars retain their complete integer hull through scratch storage only when
every writer is bounded. Missing reads, closure writes and unknown updates
decline that proof. Unary numeric conversion preserves a known hull, and
bounded products multiply before converting to floating point. Numeric
conversion still honors a cached local's possible undefined value, even when
its scratch initializer is zero.
Index definitions
come from the binding census and positive bounds apply only inside their strict
loop guard. Every counter proof rejects additional writes in the loop step.
Canonical array-bound scans use the queried function's summary view, including
before emission has installed an active function. Primitive Math arguments
preserve array lengths; getters, object conversion and unknown calls invalidate
them. A nullable primitive still converts without invoking user code.
Bounds queries use existing constant, mask, loop and occurrence proofs before
requesting the whole-body interval interpreter. An occurrence proof never
justifies an unproven twin with the same receiver and index.
Method effects require a proven receiver and no own override, not just a name
matching a built-in. Local shape facts are seeded before representation plans
freeze, including closure bodies.
Mutable loop bounds stay in the loop until IR memory-effect analysis proves
invariance. Prepare does not infer method purity from a name. Immutable string
and typed-array lengths may move when the binding is stable; the shared
reassignment census includes writes by closures and the loop step.
Method effects require a proven receiver and no own override, not just a name
matching a built-in. Runtime method dispatch checks the receiver family too:
boxed primitives never reach array helpers, and an optional missing method
skips its arguments. Kernel host imports carry signatures and numeric constants,
not function implementations. Their JSON transport uses numeric text to preserve
signed zero, NaN and infinities; presence checks accept zero-valued bindings.
Shared callback construction retains its source kind for builtin overloads and
owns separate IR at each branch. A BigInt representation describes the BigInt
member of a value; call-edge boxing still requires the shared semantic proof.
Regex alternatives retry the remaining sequence before committing a branch;
capture boundaries remain inside that continuation.
Terminal character runs omit retries when only capture-end markers and a
non-multiline end anchor follow. Returning characters cannot satisfy that
anchor; other continuations retain backtracking.
Array searches capture the search value before iteration,
even when empty. Shared diagnostic configuration serves both compiler hosts. Local shape facts are seeded before representation plans
freeze, including closure bodies. Body-fact queries for another body use a scratch
representation overlay; they must not write facts into the active frame.

The summary must distinguish a pending factory result from an unknown value.
Object mutation models wait for bottom-valued targets and descriptors rather
than escaping their arguments before the solver has visited the factory.
Joining numeric typed-array constructors retains their Number element domain,
not a guessed storage width. The private proof never crosses the summary query
boundary as a concrete aux; BigInt, DataView and unknown inputs widen normally.
Solver and query views share typed-element and typed-method transfer rules.
An unresolved index can still read an array element or named property. The
solver may defer its transfer while the index has no evidence; a public query
must retain those possible values instead of proving the read absent.
Numeric payload facts alone cannot bypass computed-key coercion: the key must
also be present. Shared reads and writes route boxed keys through ToPropertyKey;
Array and TypedArray writers classify a coerced key before choosing elements or
named properties. A computed store captures its receiver, key and RHS in that
order, then coerces the held key once. Array growth writes back only while the
receiver binding still denotes that captured array.
An accepted in-place element replacement also contributes its field writes to
the existing property-mutation census. Constant object factories of that shape
must allocate per evaluation; sharing their static payload would retain a prior
call's replacements.

Collection enumeration shares the ordered property walk with plain objects.
Array and typed-array indices precede named properties; initialized and runtime
property tables merge without duplicate keys. Typed views and ArrayBuffers have
no sidecar header and use their global property table. Runtime dispatch checks
numeric values before reading pointer tags. Public enumeration rejects nullish
receivers; copies, spread and for-in keep their empty-source semantics.
Copies read indexed values only within the indexed-value buffer, then use named
property lookup. This preserves metadata on compiler IR arrays copied with
`Object.assign([], node)` under both compiler hosts.

Runtime helper templates own their freshly parsed IR. Each demanded helper is
realized once; late helpers are added only when absent, so there is no parsed
template cache or clone pass. Generated helpers use `loc: false` to avoid
named-property sidecars on every WAT node; public parsing retains source offsets,
and syntax errors retain offsets in both modes. WAT tokens retain source spans until committed,
avoiding quadratic copying of names, quoted strings and comments.
Helper-reference scans collect whole names without unused regex capture records.
AST substitution clones retain source locations, including member and literal
nodes. Diagnostics identify the original site across loop copies while separate
sites keep separate advisories; escape-origin and bounds metadata remain selective.
Schema-read dispatch consumes the registration index of fields and slots; it
never rebuilds that index per read. The index is read-only to the optimizer,
and its registration order supplies dispatch labels. Functions with no tagged
reads leave after the existing assignment census. Fixed layout masks are
formatted once and reused as immutable strings; every mutable IR node stays
fresh. Variable i64 literals format each unsigned word as eight hex digits,
with bounded string storage and no general radix-conversion scratch.
Number formatters own one private digit buffer and call no user code while
filling it. On owned heaps that buffer reserves its eventual string header;
finishing rewinds the region before packing SSO or reusing the digit storage.
Only the result survives. Shared heaps keep the copy, since another instance
may allocate concurrently. Formatting must preserve previously returned strings.
Dense schema dispatch shares one arm per field offset. Scoped read memos walk
their region directly and copy only nonempty incoming maps. An empty inline
cache starts with an impossible high-word sentinel: its low bits are nonzero,
whereas every masked receiver has zero low bits. Numeric zero and subnormals
must miss before the first object read as well as after a cache fill.
Runtime helper templates may emit string literals. Shared string-pool setup
runs after their realization, before reachability; otherwise the pool's copy
length can omit constants that the linked helpers read.

Shortest decimal, integer and radix formatting release their private scratch
region for inline short strings, or replace it with the final heap string.
Shared-memory formatters leave cursor ownership with the shared allocator.
Closure deduplication hashes finite number bits and shares declaration ordinals
between hashing and exact comparison, without formatting numbers or copying IR.
The linker orders functions by descending call count, then runtime before user
functions at equal counts. Runtime ties use name order; user ties preserve source
order. Comparing a user function equal to differently ordered runtime functions
breaks transitivity and makes native/kernel bytes depend on the sorting engine.

Address and tag caches require a dominating initializer. A block containing an
abrupt exit cannot export a newly cached value; exception handlers enter with
empty caches. Blocks without exits retain reuse (`test/optimizer.js`).

Compiler checkpoints check each complete write before touching the upper-memory
lane and bound reads by the recorded stream end, retained across the arena reset.
Lengths, intern indexes and integer payloads use unsigned LEB128; string headers
retain their fixed UTF-16 length. Serializer or decoder allocation into unread
data traps. These helpers are reachable only from checkpoint users.

Captured locals receive their cells independently, before a use that dominates
all references. Allocation enters a conditional arm only when every reference
is inside it. Shared cells stay before the branch, and loop capture handling
keeps ownership of per-iteration cells. A skipped closure branch allocates no
storage for its captured locals.
Captured for-head declarations evaluate together in their original lexical
scope before iteration carriers are initialized. Later initializer writes and
closures retain that initial environment. Each iteration creates fresh cells
before its update, condition and body. A continue exits a labelled body region,
runs its finalizers, then copies the values for the next iteration. Labelled
regions retain the original body's lexical block, including recursive and
mutually recursive declarations and bindings shadowing the loop header. Labelled
blocks do not intercept bare loop transfers; stacked labels share their loop
while object-property colons remain in the expression grammar.

Static aggregate probes retain their emitted field/element IR. If any value
fails the static-data check, runtime construction reuses that IR; it never
re-emits nested literals or registers their closures twice.

Nonempty array literals reserve their stated length. Empty builders reserve four
elements even at the speed tier, and proven builder bounds still preallocate enough
capacity. `arrayLiteralMinCap` remains an explicit override for kernel builds;
smaller initial storage uses the existing alias and named-property forwarding.
Named-property sidecars start with two slots at every tier and grow on demand;
the speed tier's array reserve does not apply to those sparse property tables.
Collection growth uses `collectionStride` for the entry and optional hash lane;
a boolean selecting the lane is not its byte width. A shallow Map copy reuses
the probe layout when its capacity fits the rebuild budget, copying entries and
the hash lane into independent storage. Own-property sidecars are excluded;
sparse tables still rebuild. Dictionary slot updates
receive keys already normalized to strings. The host decoder follows forwarding
for arrays and collections and reads collection entries in their stored insertion
order, excluding tombstones.
Seeded Maps and Sets round twice the source length up to a power of two,
then apply the configured minimum as a floor. Copies use the same reserve.
Derived closure-class members reserve a hidden enumeration rank in the existing
hash entry. Growth preserves it; an ordinary assignment gives the entry a new
own rank and invalidates enumeration caches. No collection entry grows.
Function arity is source arity (before a default or rest parameter), indexed by
closure table slot independently of body deduplication. Its byte table is linked
only when a length reader is reachable.
Function-table dispatch can specialize the checked closure arm of an unknown-key
call, retaining host and non-callable fallbacks. Named properties keep their own
result domain. Dispatch metadata belongs to the outer call after callee/argument
evaluation, and staged writes retain their original source occurrence for the
all-writers census while using the captured receiver at runtime.


Typed-array constructor copies capture the source and its fixed length before
copying. Their dynamic element-kind arm uses the existing in-bounds typed reader:
aux/view dispatch remains, while generic receiver and missing-index checks do not.
The copy performs no user calls and never aliases its source (`test/typed-copy.js`).

Array joining captures length before separator conversion and reads elements
through the checked, tagged reader. Each conversion runs once, in order; a
second pass copies those strings into one result. Input strings remain immutable.
On owned heaps without a user ToPrimitive hook, built-in conversions publish no
allocations, so the result can replace the temporary region. Shared heaps and
user conversions retain their allocations. A future built-in that publishes a
heap pointer must preserve this region-lifetime proof.

String operands share interpolation's identity-preserving conversion, and
concat uses its immutable builder. Regex dispatch delegates plain-string cases
to the string handlers. Split captures arguments first, converts its limit with
ToUint32, then converts the separator before testing zero or undefined. A boxed
temporary uses its own carrier facts, not the source expression's raw BigInt plan.
Padding also captures arguments before conversion, skips fill conversion when
no work is needed, and returns the receiver for an empty fill. Its allocation
size is checked before shifting the code-unit count to bytes.

Implicit ToNumber rejects BigInt. Explicit `Number()` accepts its payload and
delegates all other parsing to the same helper. Unary plus and string positions
use ToNumber; an unboxed object pointer is never a numeric proof. Excluding a
BigInt tag does not prove a Number: unresolved addition uses the shared
ToPrimitive/string/BigInt helper, with plain numbers kept inline. A side the
summary holds to a number or a missing value (a field declared undefined and
stored numbers) is no string and no object: with the other side a number the
sum is numeric, the missing value converted behind a self-compare. Present typed
BigInt reads retain their raw-payload fact, while checked reads box only the
successful branch. Atomic value operations share the existing operation catalogue
with the summary: their result is an element or an exception, never undefined.

A kind names what a read finds, and a read that finds nothing answers
undefined: an index past the end of an array, a typed array or a string, an
empty array's `pop`, a `find` that matched nothing, a key a Map does not hold.
The undefined box is a NaN whose payload f64 arithmetic carries to its result,
which then reads as undefined again, so ToNumber (`toNumF64`) converts a value
that may be the box before a number is made of it. Module reads consult the
same presence facts as local reads: numeric demand does not initialize a
binding. Relational comparisons also convert nullable Number payloads, so null
compares as zero and undefined as NaN. A constant miss arm folds
to NaN (`checkedNumRead`); a value whose IR may yield the box (`mayYieldUndef`:
a constant arm, a runtime reader's result, a local the expression set to
either) or whose expression the summary lets be missing takes one compare and
a select (`missToNaN`); a value that is a number by construction (arithmetic, a
conversion, a load made without a bounds test) converts nothing. The kind of
a conditional joins what any arm may be on any path, so a conditional answers
by its arms, each with its own value (`mayMissValue`): a binding by what it
holds (one that normalizes on write, or that a guard or its definition holds
present, is a number), an element by how the emitter loaded it, an operator by
its own result (a sum's helper calls return the sum). `a[i] > m ? a[i] : m`
over an index in range is two numbers and converts nothing, which the lane
lifts read as the select they take. The Number-or-absent shortcut uses this same
arm and binding proof, so it retains normalization only for actual missing values. A
Float32Array store converts its value as a Float64Array's does: the payload
survives the demotion and the promotion of a read. A string's character past
its end is absent in the summary (`orAbsent(STRING)`), so an identity test of
it stays live, and `+` takes a string operand that may be missing for a string
only beside a string that is there; beside anything else the run decides
(`stringMayMiss`). `test/missing-read.js` holds every receiver against every
binding form and use.

Computed typed-element reads delegate their bounds check to the element reader.
Checked integer-read locals stay in word storage when the binding-use census
proves every read is a bitwise operand or a discarded integer-element store.
The bounds check remains; only its missing result becomes zero. A read may
also meet tests undefined and zero answer alike (`x > 0`, `x === 3`, a
truthiness test) and constant steps inside the arm such a test guards
(`while (rep > 0) rep--`): a missing element never reaches the step. Observed
assignment results, captures, other reassignments, named properties, floating
and clamped destinations retain the original value. The census records destination
syntax, while the existing typed-storage and numeric-key facts decide the demand.
Dynamic typed-array stores normalize object keys once before choosing the
element or named-property path; both paths use that same primitive key.
The all-writers element hull survives copying between slots of the same
integer typed array, including through an unmodified local. Missing reads
add zero to that hull; named keys, captures, replacement values and other
arrays cannot borrow it. The binding-use census proves the local's identity.
Interval transfer preserves numeric conversion of a proven integer, including
the unary plus that load-CSE inserts for its Number temporaries.
Cursor loop guards read an existing, uncaptured local at entry. A body-declared
index, header write or externally mutable cursor cannot use a per-body advance
budget. Nested declarations count even when the assignment census excludes them.
Presence queries retain their own check because they do not load an element.
The reader and length helper share the element-count expression over decoded
offset/aux facts. Bounds use the view descriptor before resolving its data base;
DataView has no indexed elements. Subarrays use the canonical aux encoder so
float16, clamped and BigInt flags survive both static and runtime dispatch.
Array/typed-array `at`, typed-array ranges and buffer slicing capture argument
values before coercing positions. Omitted or undefined ends use the captured
length; an object that converts to undefined instead supplies numeric zero.
The range emitters share `__clamp_idx`. Array `at` retains the original relative
length but rechecks storage after a conversion hook can grow or shrink it.
Unsigned word values must saturate as positive positions, never unwrap to a
negative signed word.
Builtin method dispatch also keeps the summary's presence fact: a nullable
receiver is captured and checked before argument evaluation. Staging preserves
typed constructors, view layouts and deferred BigInt result boxing.
The receiver temporary retains its tagged-local fact for BigInt method reads.
Fixed-arity method spreads retain the receiver and argument prefix in locals,
evaluate every argument before the call, and dispatch by the supplied count.
The builtin signature catalogue supplies arity in both hosts; the kernel cannot
depend on `Function.length` reflection. Registration coverage is tested.
Literal array spreads expand directly, retaining numeric proofs; dynamic
spreads are consumed in order, before later arguments can mutate their source.
Variadic push/unshift capture the receiver and all argument values before
mutating it, then grow and copy in bulk. A trailing spread stages its scalar
prefix in locals; prepend shifts the tail once and reads self-aliased values
from that moved range without a temporary allocation. Pointer write-back is
conditional on the source binding still naming the captured receiver.
Earlier spread sections snapshot their elements only before later potentially
effectful expressions; the existing IR purity query supplies that decision.
A slice read only as a spread source keeps its array and a range
(`compile/array-view.js`): `items = c ? b.slice(1) : [b]` holds `b` with a start
and a count, and the spread copies `b[1..]` straight into the list it builds.
The definition checks the receiver at runtime; a string, a typed array or any
other value takes its ordinary slice. Between the definition and each spread
nothing may run code that can mutate an array: no call, store, spread of
another source, or member read an accessor could answer. An array literal or a
push copies the range; any other consumer reads a copy of it.
Typed BigInt elements use the tagged reader and scalar items use stored-value
lowering, as in ordinary array literals.
The summary likewise treats positions after a spread as possible tail values
or missing arguments, including reducer seeds and collection stores.
Iterable normalization may skip nullish checks only for proven-present sources;
Set/Map constructors still accept nullish sources as empty. String slice and
substring use the same position capture/defaulting helper as typed ranges.
Array callback capture owns its closure dependency and callability proof.
Ordinary and typed loops validate callbacks even when no iteration runs;
reducers capture their initial value before validation. Typed find/findLast
share one early-exit emitter and select traversal direction in the loop builder.
Truthiness has one predicate builder for its runtime helper and inline form.
The existing lean-runtime policy retains the shared call in size mode.
String equality resolves representation and equal lengths in its loop-free
entry. Its cold loop receives heap offsets and a checked UTF-16 length; it
neither decodes carriers again nor reads beyond a substring view. The SSO
invariant excludes mixed carriers before that call. Size mode and the
heap-only configuration share the existing code-unit accessor loop.
Integer decimal rendering and concatenation sizing share one unsigned digit
count expression. Rendering writes backward from the known end, eliminating
the reversal pass; widths and cursors count UTF-16 units. Signed minimum values
retain their unsigned magnitude. Other radices share one reversal fragment.
BigInt presence comes from the representation proof, including typed storage
and DataView origins without literal syntax; dynamic reads and updates use
that same proof when selecting tagged value handling.

The summary's declaration tables own numeric binding IDs, local to that summary.
Kind and incoming-argument facts are indexed arrays; solver and read-only queries
reuse the same IDs. Scope resolution still uses names, but reading a resolved
binding needs no compound string key or second hash lookup.
Shape-loss diagnostics reuse the escape function; joins construct their reason
only when an advisory sink needs it. Disabling advisories preserves all facts.
Host-escape walks allocate a visited set only for values with reference edges.
Solver and query views cache immutable singleton identity lists per summary.
Numeric-demand rounds reuse callable target lists after kinds and escapes settle,
and visit parameter defaults and bodies without temporary frame records. Argument
hulls alternate current and previous buffers; published summaries own their buffers.
Immutable point ranges share storage within each summary, preserving both zero signs;
a repeated argument reuses its existing hull when the bounds do not change.
Argument-range settlement keeps one ordered registry of its per-function buffers.
It compares and swaps each buffer in place, without per-round Map entry pairs or
per-function callback environments. Missing calls clear their old hull; numeric
reseeding clears both the lookup and its registry before solving again.
Mixed object joins use numeric pair keys. Shape-union cache hits stay outside the
closure factory that builds a new member list, avoiding discarded environments.
Spread analysis snapshots keys and kinds in flat private lists, preserving the
read-before-merge order without allocating a tuple for each copied field.
The declaration census shares one flat record per write for scope, initializer,
missing-declaration and Boolean-store facts. Its dictionary roots use flat pairs;
no per-write tuple or duplicated scope/name record survives the collection pass.
Held-value and typed-extent queries allocate visited-name sets only when following
a definition or return arms. Exact Math argument callbacks live in their own
helper, so literal and unknown queries create no unused closure environment.
Flow-sensitive assignment and refinement facts use those same IDs in sparse
collections, reset per function; branch rollback stores IDs as well. Dense
arrays for these sparse facts increased allocation without improving throughput.

Object fields follow construction sites, independently of the physical schema.
Aliases share facts; unrelated objects with the same keys do not. Joined objects
retain at most 32 sites. Publication projects those facts to
layout-wide storage once, so every object using a layout agrees on its field
representation, including BigInt boxing. Overflow retains conservative storage.
Conditions and discarded expressions visit effects without merging unused values:
testing a callable cannot by itself introduce an unknown caller.
The summary checks all passive parameters in one body walk, following direct
calls only into proven passive positions. Testing a data field does not retain
its contents; receiver effects and accessors still run. Defaults, reassignment,
spread positions and recursive forwarding retain conservative argument joins.
The registry and summary share one schema key: a serialization of the brand
and canonical property order. Delimiter characters inside valid JS string
keys must never merge unrelated layouts.
When compilation discovers a spread layout, it registers the layout and restarts
the summary after kinds converge, before demand work. Discoveries are batched;
restarting in the middle of convergence can multiply the number of summaries.
Only the registry-owning caller can request this restart; ordinary summary readers
receive complete facts, and later summaries cannot mutate earlier readers.

A closure's own properties are facts of its site (`closureProps`): `fn.ops = ops`
on a dispatcher stores the array's kind under the name for every instance of
that closure, a read on a closure set joins its members, a name never stored
reads undefined, and an escaped member reads as anything and escapes what it
holds. A global the plan declares without a declaration statement (a function
property flattened to a module global, `plan/scope.js`) is a module binding
named by its writes, undefined until the first (`moduleGlobals`) unless a
top-level statement assigns it unconditionally (`initWrites`: initialized like
a declaration, as `parse.comment ??= {…}` is), and `a ??= b` leaves the binding
holding `core(a) ∪ b`. Definite initialization (a literal's `undefined` field
that the following statements store before any other use) covers an
assignment-bound literal and a bracket-string store too. A statement that does
not name the object runs between the stores (what a constructor computes
before it assigns) unless it may return, a stored null or undefined counts
like any other value, and the proof ends for a caller where a callee's
statement ended it: a method the constructor calls reads the fields assigned
after the call as undefined, its own class's and a derived class's. A call through
a binding the fixpoint knows only as nullish so far contributes nothing rather
than escaping its operands: the call throws at run time, and an escape is
permanent. A nullish object spread copies no keys. A loop's test guards its body the way an
`if` guards its branch, and an assignment as a condition (`(d = ops[i++])`)
proves the assigned name truthy: the emitter carries that as a `notNullish`
refinement (`flow-types.js`), the query layer marks the name `present` for the
body's emission so every consumer reads the kind without its nullish part, and
`dotRead` gives a present name the summary names as one shape the receiver
layout the guarded read retains, so its members read as direct slots. A slot's
raw i32 load still needs the summary's field kind to be a number: the per-schema
census marks certainty from the sites it registers, and a literal it did not
register (one assigned to a parameter inside a closure) can store a string under
the same schema.

A condition is a boolean question, not a value: `toBool` asks each operand of
`&&`, `||` and `!` in place, from `if`, loop tests and `!` alike (the value form
boxed the operand the `&&` yields and tested the box through the generic
chain, in every program). The right operand is asked under what the left
proved, as the value form did, so a guard's `x < W && a[x]` indexes in bounds;
a loop test's facts merge into the counter's own hull rather than replacing it
(a second refinement map for the same name dropped its lower bound and with it
the single-digit rendering of `'x' + i`). A value the summary knows as a Boolean or as a
pointer kind tests as a Boolean carrier or as presence (`kindTruthyIR`). A
Boolean rides either carrier, the raw 0/1 or the atom box: a test of a
BOOL-typed f64 is the number test then the atom compare, never the atom's aux
bit alone (the kernel found the first form: the compiler's own `bool && expr`
miscompiled), and a relational compare of one takes its number (`cmpOp`).
Unknown-receiver stores propagate only when their pending effect grows. A
newly exposed construction replays both indexed and arbitrary-key effects;
numeric reseeding clears these pending facts before solving again. Cache-hit
paths do not create callback capture cells just to return an existing slot list.

Numeric output-buffer contracts reuse the summary's stored-value kinds. Every
element store must be numeric; one numeric initializer cannot prove a later
unknown write. Input normalization can establish those output values, so the
planner closes newly proven boundary contracts before signature narrowing.
Established contracts are skipped, and each additional summary round proves at
least one new parameter.
The scalar range query also reuses typed arrays' stored-value bounds when the
index hull fits the known length. This carries bounds through ordinary locals
and load-reuse temporaries without a new pass. A possible missing read supplies
no integer range; stored width and signedness still constrain the payload.
Immutable literal tables share the existing no-write/no-escape proof with
scalar argument and store analysis. Deletion and return/throw/yield aliases
invalidate that proof, including forwarded helper parameters. Length, capacity
and element bounds travel together as settled per-binding representation facts.
Call-site narrowing indexes each function's parameter names once and reads the
mutable parameter lattice directly. It does not copy every caller fact into a
Map for every call site. Recursive and later caller updates are visible on the
next read. Result analyses keep their existing per-function named maps.
Static lengths, stored-element hulls and scalar argument hulls refine one another
across direct calls. Each refinement uses every incoming site and every writer;
an unresolved path remains unknown. A constructor passed directly to a helper
includes that helper's writes and defaults, not just its initial zeroes. Exposing
the buffer, capturing or storing an array inside another container invalidates
its private-storage proof. Rejected length facts propagate through all forwarding
helpers before any length is folded.
Private module typed arrays use the same all-writers census across every function,
its defaults and module initialization. Expression-bodied arrows contribute their
implicit return, including bare names and containers: an exported getter exposes
the same storage as an explicit return. The ordinary-array length census shares
that escape rule. Exported bindings, escaped aliases and
backing buffers have no closed element hull; shadowed locals use their own binding
identity. A static while-loop trip budget can bound signed additive recurrences
by their total absolute movement. Delta operands need whole-loop facts, including
counter landing and ring-reset transients; body initializer syntax alone supplies
no dominance proof. Every intermediate must fit the signed word before these
hulls authorize storage (`test/interval-proof.js`).
Counted-loop recurrences bound positive and negative movement separately across
conditional updates, including ordinary `x = test ? x + d : x - d` assignments.
An immutable copied typed read can supply its occurrence's element hull only when
its initializer dominates the update; skipped or later initializers cannot lend
that bound. Every prefix and the final update remains in the storage proof
(`test/counter-width.js`).

A direct factory can transfer a fresh typed array's element hull to its caller.
The producer must return only unaliased allocations; returned parameters, globals,
closures and exposed buffers do not establish ownership. Each caller closes the
transferred entry hull over its own writes before publishing it. Factory discovery
uses settled callable identities and visits each body once; recursive dependencies
remain unknown. Intrinsic typed `fill` contributes its stored integer values to
the same census, including representation wrap/clamp; its returned receiver still
counts as an alias, and own/optional/held methods retain the unknown-write path.
`test/interval-proof.js` pins fresh/retained results, defaults, mutation and reuse.

Runtime-sized index buffers have a separate relational proof
(`narrow/element-bounds.js`). Zero initialization, own-index stores and same-array
copies preserve the invariant that every present element indexes its own buffer.
Only integer storage that preserves or lowers a valid index qualifies. A complete
direct-call alias census rejects other writers and escapes; equal stable allocation
counts across every caller let another typed buffer share that index domain.
The source read still needs its own canonical presence proof. Only the exact
dependent access receives a bounds proof: scalar aliases, returned buffers,
sentinel postconditions and unequal affine lengths are not inferred here.
The interval interpreter spans the full signed word; overflowing transfers
become unknown. Its call hulls may authorize integer parameter storage, so
negative-zero literals and sign-changing transfers that can produce negative
zero also become unknown; a magnitude bound alone cannot preserve that value.
Both `x | 0` and `x >> 0` establish the same signed-word interval after evaluating
their input. A checked runtime loop bound therefore keeps its counter narrow
before SIMD lowering, even when the rounded input has no prior interval.
Control-flow snapshots store only known ranges. A separate binding census keeps
unknown parameters, declarations and writes from revealing cached outer constants;
joins retain only names known on every edge. Body analysis can request complete
scalar binding hulls from
that same walk, before storage widening and vectorization. Only stable loop
passes contribute; every read and write joins, including initializers and final
updates. Missing entries and unknown writes reject a hull, and captured bindings
are excluded. Requests are lazy, share typed-read presence analysis, and skip
unrelated loops. Numeric bounds never override a producer's presence or signed-zero
requirements. Integer payloads alone never prove bounded accumulation.
Private integer loop copies capture word conversions within their type guards,
so the interval interpreter sees the exact assigned words. Non-counted mutable
indices enter that lane nonnegative, with positive loop counts; readonly affine
offsets retain signed entries. The original loop handles other inputs. Every
subsequent cursor write still needs the complete lifetime proof before narrowing.
An outer scan can receive the same bounded counter copy when its work contains
another loop. Inner copies settle first and count against the existing size
budget; state and presence copies remain confined to leaf loops.
Counted reductions combine element bounds with the trip count, including every
intermediate step. Counter proofs reject additional writes in the loop header.
Loop-local secondary counters can borrow that bounded step count before storage
is selected. Their complete hull includes initial and terminal values and bounds
positive and negative motion separately; other header, body or closure writes
reject it. Fractional or overflowing motion keeps Number storage. A constant-bound
while loop can also bound companion cursors when its tested counter advances on
every continuing path. Path minima establish the trip budget; path maxima bound
each companion's full lifetime, including its final increment. Optional operands,
skipped advances, abrupt paths and nested control do not establish progress.
Loop seeds reject module counters and mutable module bounds: a callee, getter or
coercion can write them without a write node in the current body.
Loop facts have one producer: the `for` emitter derives them once per loop it
emits (`loopFacts`, `src/compile/loop-model.js`), under the refinements that loop
is emitted in: the counter's hull and step, each secondary counter's range
(`k += s` beside `j++` holds k₀ + t·s below the trip bound), the guard's bound.
They refine the body, the typed-bounds versioner scans under them, and the
loop's lowering link (`src/ir/control.js`) hands them to the optimizer, where the
fractional-recurrence bound reads the trip count. A pass that keeps a loop's node
keeps its facts; one that changes what an iteration does must drop the link.
Loop proofs iterate the head state: each pass applies the test before the
body, so a test's own reads never borrow its refinement, and the exit state is
the head where the test failed, never the body's end. The body-end exit let
`a[j]` after `while (i < 5 && j < 3)` read an element instead of undefined.
A relational test on a typed read proves its index an element index where the
test held; an arm the state makes impossible is not walked. A cursor that also
falls keeps an upper-only advance budget.
Repeated regions require a fresh initializer; peeled copies
join their hulls and every write must be covered. Escaping arithmetic values
propagate backward through local copies. Explicit word conversions still wrap.
SIMD narrowing preserves the scalar conversion: direct saturating instructions
can lift directly, while modular conversions run per lane before packing.
SIMD `select` preserves Wasm's value/value/condition evaluation order, including
temporary writes in either value. An `if` still evaluates its condition first.
The two-lane `cbrt` follows the scalar kernel's operations and rounding exactly;
zero, subnormal or nonfinite lanes use the scalar fallback.
Local and result storage also reuse those presence proofs. A missing integer
element keeps its undefined value through copies and returns; using it as an
index must not read element zero. A binding read from such an element holds its
Number beside its presence in the flow overlay as in the reps (`valBesidePresence`,
the one projection both share): strict equality against it compares the numbers
and the undefined boxes inline, the runtime helper serving values of no known kind. Canonical loop proofs refer to exact access
nodes, so an access outside the loop cannot borrow their bounds. Uint32 locals
whose every write is proven unsigned retain their magnitude via the existing
unsigned carrier flag. A local every read of which re-applies ToInt32 or
ToUint32 (a bitwise operand, a Math.imul/clz32 argument, the value stored to an
integer element of modular width) holds its word whatever number each write
gives (`narrowWordLocals`, the `wordLocals` pass): the conversions are
idempotent, so a hash seeded past 2^31 and stepped by Math.imul and `^` is an
i32. Word demand follows direct local copies, including cycles and loop
copy-in/write-back assignments. A rejected destination rejects every source
feeding it; each copy must satisfy the same numeric-kind and use proof.
A read that observes the number (a return, a comparison, a truthiness
test, an index, an arithmetic step, a float or clamped store, a capture) keeps
the f64 unless a complete range proves i32 storage. Neither a comparison nor
truthiness proves the counter's width. Unit-step loops with stable numeric
bounds get a guarded copy: a private rounded bound and the final counter step
must fit i32, while the original Number loop handles the remaining inputs.
An outer `while` counter also guards its entry, including negative zero, and
reserves space for every positive step before the next test. Module bounds
can supply snapshots only when the loop cannot write them or invoke user code;
calls, accessors and coercions keep the original repeated reads.
Other written locals of fixed nonnumeric kinds keep their original binding in
both arms; loop versioning must not create aliases of a private string builder.
Explicitly wrapping i32 counters compare against exact invariant i64 thresholds;
NaN selects a threshold below every i32 value. Primitive parameters consumed
only by word operators may convert once at the call boundary, as established
by the binding-use census.
Comparison emission and folding share one signedness proof: equal word bits
do not imply equal numbers across signed and unsigned domains.
An unsigned shift by a known nonzero masked count clears the high bit and
proves signed storage width. Zero, unknown and modulo-32-zero counts retain
the complete unsigned range. The expression result query, declaration typing
and integer lattice use the same masked-count proof, including hosted reduction
of enormous counts. A lossless value query must not discard that signed bound.
Checked reads share one lowering for integer conversion and comparison:
conversion maps absence to zero; comparison keeps the answer for undefined.
Dependent index reads use branches to avoid address clamps on serial load chains.
Index-only locals still preserve their full Number magnitude: an out-of-bounds
access is a valid missing read or ignored store, not proof that its index fits.
Only the existing closed signed-i32 value hull can promote an affine index local;
small downstream results cannot bound their arithmetic feeders. The producer's
presence and zero-sign requirements still govern storage and propagate through
copies. A proved uint32 writer whose complete hull fits signed i32 uses that
signed representation directly, retaining ordinary bounded arithmetic. The shared
counter-width query accepts a positive bounded variable step and includes its
largest final overshoot, while trip-count consumers still require an exact step.
A nonnegative integer entry and a bounded integer square limit expose the
counter's equivalent linear bound; unknown or negative entries and fractional
limits keep the original Number test (`test/counter-width.js`). A countdown's
sole decrement test supplies a complete hull only from a dominating positive
integer initializer (nonnegative for postfix), with no other writes; the final
zero or minus-one update belongs to that hull. Unsigned shifts retain a known
operand interval only within one monotone word segment. Fresh typed-array
method chains that preserve length carry their constructor's exact count.
Captured names
use their cell payload type, independently of the i32 pointer that addresses it.
Actual word consumers retain their separate modulo conversion proof
(`test/index-width.js`).
Index arithmetic can keep its low word when its hull lies in [-2^31, 2^32):
unsigned bounds tests reject both negative words and values past the length.
Typed allocations cap byte counts below 2^31. The shared `intExprRange` query
accepts the emitter's carrier bounds for names, and every intermediate must
stay within exact Number integers; a large rounded product cannot cancel into
a small index and borrow this proof (`test/index-key.js`).
A comparison that turns the branch-free read into a branch drops the clamp:
the load runs under the guard, where the clamp selects the index
(`mapCheckedRead`), and the bound is the constant of a length the binding
fixes, as in the branch form, so the loop keeps no register for it.
They also share exact integer expression narrowing, including conditionals;
early conversion folding cannot hide those integer branches from SIMD lifting.
Saturating integer conversions opt into the shared floating range query's
NaN-aware mode. It bounds numeric outcomes while admitting NaN, which converts
to zero, so checked integer reads need no arbitrary-number conversion helper.
The ordinary range query still proves finiteness; infinity remains unknown.
Integer narrowing clamps a proved finite integer to i32 in integer registers,
evaluating its operand once and testing only the sides its hull can exceed.
This preserves saturation without an i64-to-f64 round trip (`test/int-narrow.js`).
Checked typed-array accesses carry a wide integer key through their bounds test:
compare it unsigned with the zero-extended length and use its low word only for
the guarded address. Capture the key once before a store's RHS, retain a possible
NaN/missing-key bit, and leave rounded arithmetic to the existing integer proof
(`test/typed-wide-index.js`). This avoids signed-i32 clamps without assuming a
signed length ceiling.
An access with both occurrence-specific extent and whole-key proofs already
establishes a present integer in `[0, receiver.length)`, hence below `2^32`
for memory32. Its address takes the low word directly. A whole-key proof alone
never permits that conversion: an unchecked `2^32` must not become element zero.
The source index still evaluates once; only the existing exact-intermediate
integer proof may replace its arithmetic. This removes saturation from guarded
offset windows without narrowing their unproved fallback or changing its checks.
The size tier retains the compact conversion through the existing
`inlineToNum: false` policy for per-site numeric-conversion expansion.
Ranges obtained from a local's definition include its implicit zero value:
the write may be conditional, and arithmetic can make that skipped-write path
differ from the definition's value before integer conversion.
The query answers a value block by its last expression (the emitter's checked
element read: index and bound set, then the element or the undefined box),
facts about locals the block's statements write set aside.
Counted floating recurrences reuse that range query and the local write census.
Every loop entry needs a proven initializer; unknown entries, numeric aliases,
extra backedges and additional writes prevent the proof. A write of another
value bounds the local by that value's own range: a local stepped by checked
element reads (`other = next[other]`) has the hull of its element kind. Integer enclosures
bound rounding at every addition without reassociating the arithmetic. These
bounds remove only the ToInt32 infinity guard, retaining the f64 accumulator
and its captured value. The peephole and wide-accumulator pass share the exact
conversion recognizer; arbitrary selects and property-key guards remain distinct.
Local typing and emission share the interval-product proof, including the
negative-zero check; a product fitting i32's magnitude alone is insufficient.
The emitter's mask and typed-load shortcuts use the same zero-sign proof,
including compound multiplication. Multiplication by zero retains its floating
operation unless both operands are constant: its other operand's sign and any
side effects remain observable through returns, storage and reciprocals.
Unsigned-word facts also survive f64 locals created by source inlining. A
present read with that all-writes proof converts exactly to a uint32 for `%`;
a proven positive divisor then needs only word remainder. Missing reads keep
the generic path, and the unsigned literal proof excludes negative zero.

Typed bounds versioning rejects a numeric hull when no receiver length can
satisfy it: the known length when available, otherwise the unsigned wasm32 byte
header divided by the element stride. Owned arrays and views have the same
ceiling. This leaves the checked accesses in place without hiding an entire
loop nest behind an impossible fast-arm guard; later specialization can still
optimize the loops that execute.

A typed array a guard proves is read as that typed array (`plan/guard-views.js`,
the `guardViews` pass): past `if (!(a instanceof Float32Array)) throw …` the
statements that follow read a view of the proven constructor over the same
storage, `new Float32Array(a.buffer, a.byteOffset, a.length)`, a declaration
every typed analysis already follows, so the export keeps the typing a type
test on its parameter withdrew. The guard runs as written and the view is
another object, so only numeric elements and storage properties use the view.
Calls, methods, named keys and identity uses retain the original value: a callee
or callback can observe which array it receives. Reassigned or undeclared
bindings and guards inside loops keep their original reads. Fixed-memory
modules disable this specialization because its view descriptor allocates;
their checked receiver accesses retain the final no-allocation proof. An `instanceof`
test of a typed constructor is the program's word that a typed array may
arrive, from the host or from a value of unknown kind: it includes the typed
module and demands the element helpers' width dispatch, which `__typed_idx`
without the demand collapses to the array body, eight bytes per element. A
store on a receiver the flow proves typed includes the module for the same
reason before it consults the typed store emitter.

Native kind predicates on unknown carriers use the full positive NaN-box prefix
and pointer tag. Tag extraction alone cannot distinguish a pointer from finite
Numbers or negative NaN payloads. The single masked comparison evaluates its
operand once; typed constructor tests additionally compare the element/view aux.

A typed array's default sort uses direct-width insertion for a known kind up
to 32 elements. Longer arrays share main's stable byte-wise radix kernel;
the generic and size paths use the same radix kernel after their short-array
helper. This keeps long sorts linear while removing per-element dispatch from
short sorts. Both paths preserve NaN payload order and put -0 before +0.
A typed receiver of settled element kind reads
its element count from its header in `.length`, `subarray` and `sort` (a
reassigned binding included, when every constructor agrees); a DataView, of no
element kind, keeps the runtime dispatch.
Cached parameter lengths initialize after that parameter's default and before
later defaults that may read it. Only a frozen nonnullable typed parameter kind
proves the entry read safe; a guard inside the body cannot. Reassignment anywhere
in the parameter defaults or body disables that cache. Computed typed-property
reads share the inherited `buffer` and `BYTES_PER_ELEMENT` accessors; DataView has neither indexed length
nor bytes per element.

Typed constructor provenance describes storage, not presence. A field or index
result needs a separate non-nullish proof before pointer unboxing: the
summary's, or for `arr[i]` over a hole-free array, the loop's in-bounds proof
(`inBoundsArrIdx`), so a record visitor's element pointer stays raw. That proof
requires the complete initializer to preserve the counter, and no length store,
unknown call, accessor or coercion between the bound and the read to shrink an
array through an alias. An independent read after the loop still needs its own
bounds proof. A static
const array's reads fold their base and length to the literal's
(`optimize/devirt.js` `foldStaticConstArrayReads`, which recognizes the speed
tier's inline forwarding hop as well as the `__ptr_offset` call it replaced:
a never-resized static array never forwards), and a constant literal indexed
in place (`[2, 4, 2, 9][t >> 17 & 3]`, hoisted to a synthetic const by
prepare, its length recorded there for the reads emitted before it) needs no
bounds test when the index's integer hull (`intExprRange`) stays under that
length: the read is the load. The size tier keeps an unknown receiver's
element read in its helper (`leanRuntime`); the speed tier reads the array
arm inline. Computed
typed-array reads keep the actual receiver tag unless presence is proven; catch
elimination must also consult presence even when the payload kind is known.
Nullable direct reads guard the receiver while retaining their schema/element
loads. Dot reads preserve plain local identity for dispatch caching; computed
reads capture the receiver before evaluating the key. A named receiver also
needs that capture when the key assigns it, or key evaluation/coercion can call
code that reaches its captured cell or module binding. The existing expression
capture carries the same payload facts and keeps null rejection ahead of key
coercion. Pure numeric keys retain their direct binding identity. Speculative loop extents
treat a missing buffer as empty, so a zero-work call does not inspect its header.
Only an executed access throws. Versioned loops prove receiver presence separately
from index extents; presence alone cannot remove an out-of-range check. Guard
stability includes helper calls, default arguments and writes in loop headers.
Unknown calls invalidate globals and captured cells; ordinary locals remain stable.
Loop pointer hoisting reuses function-entry snapshots when the broader write
proof holds. Both hoists share one module traversal and the existing snapshot map.
Unary negation likewise requires a nonzero interval whose negation fits i32.
Other integer operands widen without a NaN-normalization guard, since their
carriers are finite.

Typed element facts require a numeric key; named properties retain ordinary
boxed values independently of the element width. Presence is part of that
proof: a missing numeric payload addresses the property `"undefined"`.
Numeric demand owns typed-store coercion proofs. Usage-only parameter scans
must not classify a typed receiver's unknown key or stored value as numeric:
the key may name a property, which stores the value unchanged. In the demand
pass a typed array's index is a read that is no evidence (`index()`): a
parameter read only there keeps its key as it is, one also stepped or added is
a number by the boundary contract.
A parameter returned as itself reaches the host with its identity (`fib('1')`
is `'1'`), so its export boxes it. A return, or the assignment an early return
lowers to, under a guard only a number passes (`x !== x`, `x === 0.0`, a
predicate whose body is such a test of its parameter: `isnan( x )`,
`isInfinite( x )`, through `&&`, `||`, `!`) gives back a number: both the
demand pass (`numericProofs`) and the parameter proofs (`numericGuard`,
param-numeric.js) read it as a numeric-compatible use, and libm's
`if ( isnan( x ) ) { return x; }` keeps the f64 export. An equality against
a number reads the parameter as a number would be read; against anything else
it tells the value's own type apart and the parameter stays as it is.
Dispatch reuses the later lossless i32 local-storage proof even when the
summary's earlier kind still admits absence. The same bounds query reuses a
settled i32 index's range when it fits the receiver length.
Checked numeric loads retain Number|undefined in the existing flow overlay;
that permits a single missing-value conversion without an impossible null arm.
When the all-uses proof normalizes a binding on write, its flow kind describes
the stored Number instead of retaining the initializer's possible absence.
Likewise, arithmetic over nullable BigInts keeps the summary's BigInt|Number
result in the flow overlay: an absent operand can produce NaN or an integer
Number. Treating that union as definite BigInt boxes an already tagged result.
Load CSE caches the numeric conversion when its occurrences consume the value
arithmetically; raw identity uses retain a separate cache entry. This uses the
prepared unary `u+` operator, so missing reads become NaN before reuse.
Dynamic dispatch keeps numeric keys numeric, avoiding a formatting/parsing
round trip. Known receivers pass their type to the existing typed dispatcher.
Typed reads parse valid integer indices without a Number/String round trip;
invalid canonical numeric keys cannot have sidecar entries. Writes retain the
full classification because invalid numeric keys still convert their RHS.
Computed length/byte accessors follow own-property lookup, including an own
undefined value, and fall back to the same length/offset helpers as dot reads.
The tagged store converts its RHS before checking the index,
then preserves the original assignment value. Raw internal stores still serve
algorithms whose bounds are already checked. Reference evaluation precedes
both index and RHS effects; source inlining checks dependencies in both
directions before moving a call's prefix across an assignment target.
A global's i32 storage may hold a pointer; it supplies numeric expression
facts only when the global's value kind is Number.

Size mode keeps one shared dynamic property lookup instead of adding schema
dispatch arms whose generic fallback remains necessary. The existing read-reuse
walk still removes repeated lookups; speed modes retain guarded specialization.
In speed modes a receiver whose shape set the summary retains, a name or a
member chain, reads and stores its field through one masked compare per member
shape that names it, with the shared dynamic lookup as the miss. Receivers must
be reads that repeat without effect; a call result keeps the shared lookup.
Where the schema-read devirtualization pass runs (few schemas, the pass on),
it owns that dispatch instead, with its sid cache and duplicate-read reuse.

Expression-property reads share one receiver-dispatch generator, including
prehashed keys and optional host fallback. Each selected path normalizes its
key once: dictionary reads own their hash, external reads reuse the normalized
key for both own-property and host lookup, and other receivers delegate the raw
key so typed numeric indices retain their fast path.
Computed reads request host fallback from receiver facts, like named reads;
prior helper demand is not evidence about the receiver. Numeric element paths
and proven internal receivers do not request that fallback.
Unknown readers select the shared dispatcher before emission finishes; its
factory selects the host arm at link time. The existing ingress query is shared
by computed and chained reads, cached in the session fact store for imports and
public parameters, and observes host globals as their producers are emitted.
Thus a helper emitted before its host-valued caller keeps the needed fallback,
while a closed program's dispatcher collapses to its internal body.
Computed stores likewise request host dispatch from the receiver, even in a
write-only module. After key conversion, the shared property writer sends an
external receiver to its host setter and returns the original RHS. It never
substitutes an internal property table for the host object's storage.

Named functions stored in internal objects or bindings retain their identities
in the summary's existing closure sets. Calls through those values bind the same
parameters and result facts as direct calls. Unknown uses and host exposure still
open the facts; taking a function's address retains the boxed callable-value ABI.

LICM extraction is shared through watr's `hoistInvariants`: traversal, private-local
checks, structural deduplication and temporary typing have one owner. JZ supplies
per-loop invariance and speculation-safety proofs for its helper calls and memory
representations, plus profitability policy. Watr's standalone proof remains
conservative about memory and calls. Watr receives invocation-local proof callbacks
over Wasm instructions. JZ still calls
the shared engine before and after address rewriting; watr calls it after inlining.
Those distinct maturity points remain necessary for current lowering patterns.
The shared engine counts local references once per function and updates that
census when deduplication removes copies or introduces a temporary. Each loop
checks private writes against it without rescanning the whole function.
JZ uses watr's instruction-effect classifier for every memory-write family;
unknown write targets block alias-dependent motion. Buffer origins follow
single-definition locals and closed scalar recurrences. Conversion blocks may
stage an index in local scratch: origin tracing visits every statement and the
result, still rejecting loads, calls and conflicting roots. Other origins remain
unknown. Allocating
helpers cannot be speculated before zero-trip loops or crossed by allocator-global
reads.
Float32 constant-cell reads use the settled byte extent of a present, unchanged
owned parameter as a separate no-trap proof. The entire load must fit, including
its memory offset; distinct-buffer facts separately rule out loop writes and
calls that could change it. Unknown extents, views and rebound pointers retain
their reads. Single-precision arithmetic follows the same nontrapping rules as
double precision. This fixed-extent rule does not infer capacities for rebound
scratch allocations.
A versioned loop's existing extent guard separately allows Float32 scratch reads
to leave a nested loop. Emission marks each raw read with the exact emitted loop
that owns its bounds proof. LICM accepts it only while that owner remains a strict
ancestor of the destination, its address is invariant, and calls/stores cannot
change the cell. The read stops inside the guarded outer iteration, including
when the inner loop runs zero times. Copied loops retain local ownership; missing
metadata fails closed. A function-level demand flag avoids the ancestry walk for
ordinary bodies, but never licenses a load. No runtime guard or late pass is added.

Value numbering and statement scheduling are watr's (`valueNumber`, `schedule`),
run once before its rounds; jz enables them (`valueNumber`, `scheduleStatements`
in its config) and vouches for its math runtime through watr's `pure` option: those
calls read and write nothing and cannot trap (their loads read constant tables,
their truncations are guarded), so they share and move like arithmetic. Read-only
user functions come from watr's own call effects. Value numbering names values,
not locals: a helper inlined twice with one argument (colorpq's `spow(L / 10000,
nv)` in a numerator and its denominator) leaves two chains of locals holding the
same values under different names, which subtree CSE kept apart, and the kernel ran
twice. Scheduling orders each straight-line run by the longest chain of work still
depending on each statement, so independent kernel calls start together and
overlap: colorpq's three inner pows run first, then its three outer ones, 97 to 75
ms. The passes' unit cases live in watr; jz keeps differential cases against the
same program with the pass off in `test/value-number.js` and `test/schedule.js`.
Helper expansion ends the per-function pipeline: `$__ptr_offset` stays a call
through every pass (LICM hoists it, unswitch and devirt recognize it), and its
inline fast path is lowering, the last step.

Argument lowering and result packing are independent: ordinary, rest and spread
calls share multi-value materialization. Tail calls require the complete result
arity to match. Receiver temporaries preserve the source's type, typed-element
and regex-literal facts through the shared receiver-fact copier.

The summary still visits arguments passed to escaped callees. Such a callee
cannot publish a precise result, but callbacks passed to it contribute their
calls and parameter kinds. Equality only demands numeric storage for a definitely
present number; a number-or-undefined operand must retain its identity.

Jzify's lexical census distinguishes parameter, body and named-function scopes.
Immutable self-binding writes are lowered before async/generator bodies are
copied. Non-strict writes preserve evaluation and their expression value; strict
writes throw only when assignment occurs. Parameter initialization errors in an
async function reject its promise. Promise reactions share one FIFO queue for
both pending and already-settled promises.

Internal exceptions carry a private tagged code until a source catch materializes
an ordinary branded Error. User-thrown numbers remain numbers. Property dispatch
has no error-code lookup: caught errors use the same fields and class checks as
constructed errors. Canonical TypeErrors share lazy runtime helpers, so dead
guards can shed both their code and message data. A catch without a binding
consumes the transport directly, without constructing an unobservable Error.
Unused generated error signals disappear at link; explicit source throws retain
the host channel. Generated Wasm and interop must
be rebuilt together when this internal transport changes.

Source handlers also catch synchronous host imports. Modules needing that edge
export an i64 throw entry; interop preserves the bits until Wasm reinterprets them
and raises the existing tag. Host objects remain external handles, including
Errors, so catching one preserves its identity and native Error brand. A bound
catch admits BigInt in the representation census even without a source literal
(488 bytes for the minimal O2 numeric-catch control; bindingless catches are unchanged).
The codec and callback wrappers are installed before deferred module initialization.
Reentrant source throws retain their original bits only during the active host
call, avoiding a second object copy when a host callback rethrows them. Raw
same-instance exceptions retain the existing exported tag. Imported slots are
wrapped once even if multiple import records name them. Host method reads capture
the callable before arguments, then `__ext_invoke` receives that callable and its
receiver; `__ext_call` retains the object/key/arguments ABI of older modules.
Generic host reads use `__ext_get`: functions retain identity and stay unbound
until a member call supplies its receiver, while containers keep their native
marshalling contract. Raw copy and call-reference reads use `__ext_method` to
avoid inspecting the returned value. Both share one property-read routine.
Legacy `__ext_prop` remains supported for previously compiled modules.

Coercion distinguishes absence from an own non-callable value through the
existing property-presence probe. Only absence selects an inherited method. Calls evaluate their receiver, property and
arguments once, in source order, before checking callability. Nullish member reads
throw before arguments run. Dynamic field and element helpers reject nullish
receivers before decoding memory; unresolved property accesses retain source
catch/finally handlers. A computed object key is evaluated once before
checking the receiver and converting the key to a property name.

ToPrimitive has one method-resolution chain, generated for the string and
number hints in `compile/emit/to-primitive.js`. Both statically known objects
(`src/ir/coerce.js`) and runtime coercion kernels call those prepared functions.
Each method lookup preserves absence separately from an own non-callable value;
only absence reaches the class or inherited method. Each callable is read once,
and the second method is looked up after the first call's effects. Exhausting
both methods throws a TypeError. Programs without user methods retain the
constant inherited tag. The two functions are runtime roots
(`ctx.funcs.runtimeRoots`): address-taken, boxed ABI. Implicit coercions retain
surrounding catches, since method calls only become explicit during emission.
Closure classes register their accessor slots in the same census as object
literals. Property lookup retains hidden slots in the own-property view;
enumeration keeps its separate filtered view. Getter and setter calls retain
surrounding catches even when their receiver has a known layout.
Date uses the same own-method lookup before its inherited timestamp or string
method. Numeric conversion and relational operators request the number hint;
addition and loose equality preserve Date's string default. Dictionary-backed
objects use their runtime property owner in that chain. `Number()` accepts a
BigInt primitive returned by a hook; `BigInt()` converts the primitive first,
while typed BigInt stores reject Number primitives even for empty ranges.
`+` with a heap operand of known kind concatenates unless a user conversion
method may run. Loose `==` between a heap kind and a Number, String, Boolean
or BigInt applies that same conversion before comparing primitive values.
String bit/content shortcuts require strict equality or two proven strings;
loose comparisons with an unknown partner use the shared conversion helper.
Dynamic BigInt comparisons inspect the partner's tag, never its raw payload
bits: a subnormal Number can have the same bits as an integer. `Array.from`
uses the tagged element reader when copying typed BigInts into ordinary slots
or passing them to a mapper, including through an unknown source kind.
Generic addition receives operands through `storedValue`, including boxed BigInts.
The shared primitive check classifies those boxes as primitives; addition unboxes
both BigInts or throws on mixed numeric domains. An object's conversion result
has no fixed numeric kind. Number/nullish joins can skip string dispatch while
retaining ToNumber for the missing or null arm.

Relational operators share the boxed coercion/string-comparison slow path.
Both operands evaluate before left-to-right primitive conversion. Proven
numeric and string comparisons stay direct; an i32 pointer is not an integer
value. Unordered comparisons remain false, including `<=` and `>=`.
Date-only generic names alias their typed emitter; inherited generic names
such as `toString` retain their own implementation.

Member updates retain the receiver and converted key through GetValue and
PutValue. A nullish base rejects after evaluating the key expression and before
its conversion hooks. Plain writes defer key conversion until after the RHS.
Typed stores reject nullish receivers before value coercion or header loads,
after capturing the receiver, key and RHS. Direct and runtime stores share this
order. A typed assignment with a dynamic key or unknown constructor returns a
tagged value; only the proven numeric element path has a raw BigInt carrier.
Checked property reads retain the captured receiver's exact schema. Optional
reads box raw BigInt fields inside the successful arm, before joining undefined.
Expression field writes use that same schema storage rule and capture the
receiver before evaluating their RHS.
Dictionary read-modify-write fusion requires a proven HASH receiver. Opaque
element stores exclude objects only with the shared ARRAY-or-TYPED call-site
proof; `notString` alone cannot exclude a dictionary.
Runtime initialization uses declared helper dependencies: a table reached
through a fallback needs initialization even without a direct helper call.
Template realization follows table setup, keeping dead helper constants at
the reclaimable data tail. Table consumers must declare their dependencies.
Source inlining leaves spread argument lists to runtime call marshalling
instead of treating each spread as one positional value.

Property enumeration uses one traversal builder for Object.keys/values/entries,
for-in and JSON. It merges schema, init-sidecar and runtime keys: array indices
sort numerically across all three sources; strings retain insertion order.
Runtime values override init values without moving the key. Schema slots own
field values; deleting and reinserting a field adds an ordering record to the
existing property table. Static enumeration takes the summary's word first: a
name whose objects have one closed layout (no computed-key store, no literal
store outside the layout, no escape: `spreadSidOfExpr`, the proof a spread copy
needs) lists that layout, whatever alias or flattened function property the
writes went through; without the summary, the per-name write census must rule
out additions through aliases and helper parameters, and stands down
whenever the summary knows the layout and does not certify it closed
(`openSidOfExpr`): a store it alone sees. A DEFINITE literal-key write outside
a literal-bound name's layout is no sidecar entry: the plan declares the key
in the literal (`plan/declare-written-keys.js`: `{ a: 1, b: undefined }` for
`o.b = 2` or `o['b'] = 2`), so it is a slot of one closed layout; the name's
layout is bound for the per-name slot paths. Definite means the store runs
before anything can observe the object: a statement of the same list as the
binding, with nothing between them that could run other code or ask about
keys (`in`, a spread, a deletion, a branch, a loop, an unresolved call);
module initializers and the entry module form one such list, in the order
they run, so a bundled `parse.comment['#!'] = …` qualifies. A call between
them is resolved when it is a direct call to a module function whose body,
parameter defaults and direct callees never mention the literal's name and
never run what the pass cannot name (a closure, a computed callee, a
constructor, an accessor read where the program declares accessors, an
await); a builtin method call is harmless when no method of the program
bears its name and no argument can be a function (a closure the callee
defines is not run by being defined). The operator registrations between a
parser's `parse.comment ??= {…}` and a later module's `parse.comment['#!'] =
…` are such calls. Any other mention of the literal's name between the
binding and the store (an alias, an argument, a computed-key store, a value
of another literal) ends its run: an alias reaches code the pass cannot
follow, and a key declared after a computed store would sit ahead of it in
the layout. A namespace of plain values (`parse.comment ??= {…}` with no
arrow property) flattens like one with arrows (`plan/scope.js`
`flattenFuncNamespaces` witnesses it by a store to a function's property
anywhere, or a top-level compound one), so the pass sees the flattened global
as a literal-bound name. A function's properties are never boxed: where the
function escapes they stay in the table its pointer keys, so the function
read as a value is still callable and still a function to `typeof`. A call
through a global bound once to a function (`devirtGlobalCalls`: a flattened
`m.assign = nz` called as `m.assign(…)`, an alias `nrm = m.assign`) rewrites
to the function's own call, so the call census, the inliner and the parameter
proofs read it as one; a global nothing reads once its calls are rewritten, or
an alias of one, drops its init and leaves `ctx.funcs.globalDevirt`, so the
function's address is no longer taken by it. One read as a value, or one the
host holds, keeps both. A conditional store keeps
its key out of the literal and in the sidecar, because a declared slot is an
own property from the literal on and `in`, hasOwnProperty, for-in and
Object.keys would all report it before the store. This is the one place a
bound literal's layout widens; the program-facts merge used to add every
written key. Empty literals (the dictionary idiom), spreads, computed keys,
brands, index keys, `length`, a name with a computed-key write or an
`Object.assign` (a dictionary: its keys and their order are runtime facts),
and names that also take a non-literal value stay as they are. A bracket
string key on a summary-shaped receiver reads as
dot syntax. A for-in over a closed layout unrolls one body copy per key (the
loop variable a string literal, so `o[k]` is a slot read and `k.length` a
constant): an aliased source (`for (s in cm = o)`) assigns once first, a loop
variable declared outside keeps its last key, `break` and `continue` target
the copies' blocks; a body over the size budget (384 nodes in total: the
three-comment loop of subscript is 3 × 101) or one capturing the key in a
closure keeps the pooled static key array. Over an OPEN layout (the summary
names the receiver's one layout, some site still adds keys, and the
receiver is never nullish) the same unroll lists the layout's keys and a
pooled loop over `__keys_dyn` follows inside the copies' break block: the
keys added at run time, sidecar then global table, in insertion order and
none of the layout's. That is JS order unless a key added later is an array
index, which JS lists first; a layout holding such a key keeps the pooled
loop. The keys a `__keys_ro`/`__keys_dyn` site lists are cached per site (an
inline cache: `__enumc_off<id>`/`len`/`ep`/`arr`), keyed by the receiver's
sidecar and its length, or by the receiver's own offset for one without a
sidecar (a static-segment literal, a durable object written only after
init); every cold key-set change (a global dyn-prop insert on an OBJECT
receiver, a delete, a relocation, a heap reset) moves `__enumc_epoch`, and a
hit needs the fill's epoch. Sites in alternation (a parser's comment table
and its number-prefix table) keep their own entries, and an insert on an
ARRAY or CLOSURE receiver (`node.loc = at` on every parsed node) moves
nothing, since their properties never enumerate. The HASH arm's
`__hash_keys_ro` keeps the shared entry, epoch-checked.
`__prop_order` and Map/Set's `__coll_order` specialize one sorting template.
Only property sorting allocates ranks; Map/Set read insertion sequence numbers
from their existing slots, using a 4N-byte offset buffer instead of 12N bytes.
Coercion activation reuses the class-dispatch member census, including definitions
and parameter defaults. Its generated intrinsic probes add no ordinary member
accesses, so synthesis does not invalidate that census.

Prepare uses one shape census for literals, declarations and assignments,
including the keys contributed by known spreads. Unresolved spread sources
defer summary layout selection; they do not escape known sibling values while
the solver is still settling. Default-export expressions declare their binding
so imported objects and callables participate in the same analysis.
Source shapes remain separate from layouts extended by property writes or
`Object.assign`: replacing a record cannot inherit the earlier instance's
extra fields. Replaced bindings reuse the existing allocation-provenance guard
to prevent layout extension; disagreeing shapes use ordinary schema dispatch.
The summary records lost schema identity, so dynamically readable BigInt fields
use the existing tagged storage. Representation planning retains object-field
initializers as it does array elements, including computed BigInt values.
Possibly absent arrays use the existing checked index helper before header reads.

A store of a name outside a shape's slots is tracked beside the shape (its kind
under that name, and under an unknown name), not escaped: a read of the name
on a shape the summary still follows is what was stored there, absent
otherwise. A receiver of unknown shape is an instance of a lost shape or a
foreign object, never of a followed one. A literal with a spread whose sources
the summary knows but whose layouts differ, or a computed key, is a keyed
dictionary: its entries by name, an unknown-name entry for what it cannot
place. A dictionary joined with objects or primitives keeps its cell; the
object shapes ride on the cell and its reads join both. A parameter used only
in tests, identity compares and `typeof` keeps the shapes of a join it
cannot name. A conditional on a parameter no call has bound waits for a later
round; one the kinds decide walks only its live arm (`x == null` of a kind
without the nullish tags; `x === undefined` of a parameter no call passes an
argument for, forwarded as it is or not, `argBound`: three's `Matrix4(n11, …)`
forwards to `set` only when given values; `x.p` of a number, a boolean or a
BigInt outside their few methods, which is undefined). `if (x.p)` proves `x` non-nullish
where true and, where false and every object `x` may hold answers `p` with a
class flag (`static { C.prototype.isC = true }`, a getter of the literal), no
object at all; with the per-kind clones narrow/specialize.js gives a function
whose parameter's callers disagree, `te[12] = x` in the else arm of
`Matrix4.setPosition` stores a number in one clone and nothing in the other.
A rest parameter is a
tuple of its arguments by position, absent past a call's count. Set cells
follow their elements; iterating a Set, Map or string materializes its
members. A read or store through a nullish receiver, a call of a name no
shape holds and a property read on a primitive outside its prototype are
throwing or undefined, not unknown. A declared local takes the summary's
exact shape as a parameter does.
Literal arrays, rest arguments and collection entries keep their positions
without escaping objects merely because another position has a different kind.
Dynamic mixed-element reads, mutation and cell union invalidate that precision
and expose the stored identities. Host escape and retention walk the positions
as well as the aggregate, so mixed tuples cannot hide objects or callables.
Construction and physical-layout IDs index ordinary arrays of field rows;
missing rows read as NONE. Those dense numeric identities need no hash table.

Prepared functions, synthesized dispatchers, imports and variants use the record
constructor in `src/function.js`. Defaults and rest bindings have fixed fields;
variants copy the explicit result facts and can clear the rest binding. No open
spread-copy contract is needed. Variant queues keep named fields, not mixed
tuples. The function registry and active state use the same constructors at
startup and reset; function entry replaces only the active state.
Array-pattern parameters use positional placeholders and ordered initializers,
shared by ordinary functions and generator factories. They do not pack unused
callback arguments into a synthetic rest array. The legacy object-pattern and
actual `arguments` paths retain argument-list packing.
Map/Set lookups share insertion's
capacity/forwarding check, without a separate general pointer decode.
Map/Set key hashing and SameValueZero use the shared numeric-NaN predicate
before tag dispatch. Signaling/negative NaNs and the numeric ATOM/aux-zero
payload domain share NaN's hash and equality; non-NaN values never enter boxed
content comparisons, even on a hash collision. Real Symbol and BigInt keys
retain their identity/value contracts.
Map/Set's ordinary and prehashed lookups share one probe generator with the
prehashed dictionary readers, including missing-value sentinels, forwarding
and external receivers. A prehashed lookup takes its hash
as an argument; the ordinary lookup computes it after checking the receiver.
Proven-present string keys use the existing prehashed probes and string hash;
possibly missing string elements retain generic key hashing. Shared probe
lowering captures the key once and preserves excess argument effects through
the ordinary intrinsic-call staging.
Numeric and pointer hashes mix both words into low table buckets; XOR alone
clusters consecutive integer-valued doubles. Folded numeric-key hashes use the
same mix as the runtime, including the reserved empty/tombstone hash values.
Map hashing classifies numbers and NaN boxes once, before decoding a tag.
Its string and BigInt arms inherit that proof; finite mantissas can contain
every tag pattern and must never be interpreted as payload pointers.
Dictionary and Map read/modify/write slots use the ordinary upsert generator:
only a missing slot receives undefined; hits retain their value for the caller.
Growth preserves header metadata, aliases, insertion order and durable logs.
Every growable collection probes before testing its load threshold: replacing
a Map or dictionary value and adding an existing Set key reuse the current
entry even at 75% load. A missing key alone grows and retries the same probe;
the bounded probe also handles a completely full minimum-capacity table.
Map, Set and dictionary growth share one cold rehash body. It uses the stored
hash word and copies the complete entry, preserving insertion sequence, keys
and values across both entry widths and compact or separate-lane layouts.
Healed tombstones keep old probe chains connected but are excluded from a
rebuilt table, whose length counts only live entries. The existing probe, forwarding and reset-log paths remain at the caller.
One shared lowering recognizes both `d[k] = f(d[k])` and
`m.set(k, f(m.get(k)))`, proving safety and counting reads in one walk.
Map methods must retain their builtin identities; Map keys keep their boxed
identity, while dictionary keys must normalize without user code. Operands
must be primitive and value operations non-throwing: other property reads,
implicit user coercions and BigInt operations can observe early insertion or
invalidate a held slot. Map updates return the receiver; assignments return
the stored value. Nullable number/string coercion evaluates
an expression once before its sentinel checks; a computed read can run key
conversion hooks and is never duplicated just because its stored kind is known.
String conversion applies the same absence check to numeric, string and boolean
elements. A stored element kind cannot erase the undefined of a missing read;
constructors, interpolation and string-method arguments share that conversion.
Lookup dependencies name hashing/equality directly, not mutation helpers.

Source inlining builds the exported expression subset once per pass. A
local arrow bound by `let` and only ever called inlines like a `const` one
(the mention check rejects any write to the name, so a surviving `let` is a
const); `optimize: { sourceInline: false }` keeps every closure form. A
declaration splices each of its declarators (`const r = f(a), g = f(b), b =
f(c)`, each its own statement in order); more than one declarator splices only
in an innermost loop, where the call it removes is what kept the lane
vectorizer out, except a factory's: a body whose value is a fresh literal of
its own (`let self = {…}; …; return self`) splices at every declarator, since
the name then binds the literal and scalarizes where it never escapes
(`const a = new Vector3(), b = new Vector3()` before a loop). A factory's
splice is an allocation site the size of the literal it makes: no site cap
counts it, and the `constructor` binder that takes its address keeps the
body. A default is decided at the site: an argument the call leaves out is
its parameter's default, evaluated in its turn in the parameters' scope, or
undefined; one the call passes runs no default where the caller's summary
proves it not nullish, and a value that may be undefined keeps the call at
that site. A selected default containing a closure also keeps the call: its
captures belong to the callee's parameter scope, which source substitution
does not clone. Nested-call
hoisting uses its body map for membership too, and reuses that map through the
current function's rounds, before the function record's body is replaced; it
lifts a call out of an `if` test to a declaration before the `if` (an `else
if` test into the else arm), and lifts a kernel or a loop-only candidate
inside an innermost loop only. The budget a callee is held to is the
duplication its splice adds: a small body within its cap of sites outside
loops, a larger one at two sites (a leaf's second copy under 200 nodes when
every site is in a loop, 48 otherwise; a sole site copies nothing). A body
past that budget still splices at its sites in innermost loops, where the
call is the per-iteration cost, while its straight-line sites keep the call
and the body (`Vector3.applyMatrix4` from a dozen sites, `intersectsSphere`
with a loop of its own); those copies are bounded together (400 nodes). A
dispatcher's arm and a binder's closure are no sites: they call the member
for a receiver the summary cannot name, and the function stays for them.
Unreachable callers also cost no copies; the summary's reachability proof
keeps unused library methods from consuming a live callee's duplication budget.
An eligible callee's returns lower to one trailing `return r`: `return X`
assigns `r`, inside a loop `done = true; break` follows (and a loop that may
return ends the loop around it the same way); statements after one that may
return go in the else arm when its then arm always returns (down an else-if
ladder whose every arm returns, so the ladder keeps the shape the union
carrier's exclusion stacking reads), under `if (!done)` otherwise. `done` exists only where a guard reads it, and a final
`return <literal>` initializes `r` instead. A `break` or `continue` targets
a loop or switch of the body and splices with it; a return in a switch or
try, and a `throw`, keep the callee outlined. Eligibility is checked before
normalization so an outlined function does not acquire control flow or locals.
The summary's boolean-operator table also serves value typing and integer
certainty; internal eager boolean expressions keep their identity in locals.
Integer certainty does not erase boolean identity: a mixed boolean/number
result keeps tagged f64, and an identity-observed local still needs ToNumber.

Concatenation results carry the lazy hash cell; the Map hash mixes a packed
short string and loads a cached heap hash in place. Speed modes lay out a key
index for every schema of eight or more keys, probed once per slot search, and
a dynamic read site past the schema-dispatch budget keeps an inline cache of
the last static schema it resolved; size mode keeps the scans. The wasm name
section names a closure body after its enclosing function.
Schema indexes write little-endian hash, slot and offset words directly; their
layout does not depend on the compiler's own BigInt-to-string conversion.

A destructuring reads through its source: an object pattern's names take the
source's members, a default merges in where the member may be undefined, an
array pattern reads by position, a rest element copies the remainder into a
fresh array. Prepare folds a computed key that is a static string
(`o[KEY]` after `const KEY = 'k'`) to the literal key, so the read or store
is the slot access `o.k` compiles to. The array-pattern protocol
(src/iterator-pattern.js) over an indexed source is read by position in the
summary: `__it_open` binds a cursor, each step takes the next element; the
protocol's functions still run over the source's kind without its identity.
A pattern over a value the summary proves an array that is never nullish
reads by index instead (the plan sweep `indexArrayPatterns`,
compile/plan/index-array-patterns.js): the cursor becomes the array, a step
its element at the position, a rest the slice from there, a skip nothing,
and the closes nothing, so the pattern costs no record, no calls and no
unwinding, and the frame it is in keeps its allocations its own (the
protocol's record pool is module state). The array iterator is live and
finishes once, so the reads replace the steps only where every pull binds a
name with an expression that runs no code (a default of `a.push(1), 0`
between two steps keeps the protocol). A collection, a string (iterated by
code point) or a value that may be nullish keeps the protocol.

The generated bounded loop over a Map snapshot proves each entry pair
present inside its body, so an array pattern can read that pair by index.
The proof requires the private snapshot to remain unescaped and unwritten,
its bounds unchanged, and the pair binding neither reassigned nor captured.
When every use of a pair reads only its key, value or length, `splitMapPairs`
replaces those private pairs with key/value column snapshots captured before
iteration. Escaped, mutated or dynamically indexed pairs keep their arrays.
An empty Map creates no columns; own key/value methods or size properties
prevent the rewrite. Changed planning passes invalidate identity-keyed binding
and mutation scans before the next pass reads them.

The frame census (compile/analyze/frame-effects.js) reads the summary through
the function's own view (keyed by its signature, as the emitter reads it). It
takes a store into a parameter the export boundary types (`boundaryTyped`,
set after the summary) as a number into fixed storage. A member reaches the
class functions of the receiver's listed layouts (`memberFunctions`): a
method on a receiver that may be nullish or of several classes, an accessor's
getter or setter, each a callee whose own census counts; a property named
like an accessor on a kind that is no object (an array's `length`) is a plain
read, and a layout whose schema declares the accessor slot (an object
literal's getter or setter closure) or may carry a static pair beside its
slots keeps the read unknown. A loop's scope declares nothing of the
function's: its parameters are outer storage there, and a block kept in one
outlives the iteration. A constructor called plainly (`throw TypeError(m)`) is fresh
storage, a conditional of fresh values is fresh, and a loop's callee
allocations count toward its rewind (they belong to the iteration that
called). The per-iteration rewind the census grants is recorded on the frame
by the loop's label (labels count from zero in every function), published
under the function's WAT name once its body is emitted, and inserted after
the peephole walk, which copies the spine of every loop it changes inside
(optimize/loop-rewind.js).

Whether a value a call allocated outlives a frame is a question of age: what
it was written into is older than the frame, or is the frame's own and goes
with it. So an escape is decided as it runs. The escape flag `$__esc` holds
the lowest address an escape wrote into since it was cleared (all ones while
none ran, zero for an escape with no address: a module binding, a host that
may keep what it is handed, a module-wide table). Every escape the census
finds in a function's or a closure's frame is a site (`sites`): a heap value
stored where it is no fresh local of the scope, a captured or module binding
assigned one, a store that may make its receiver grow. The emitter lowers
the flag there (emit/dispatch.js) to what the site's kind says it writes into
(`SITE`: the node's receiver, the cell of the binding it assigns, its first
argument, read off the node as it is emitted), and link restores a frame's
heap at return when the flag stands at or above the frame's own mark: it
saves and clears the flag at entry and leaves the lower of the two at exit
(optimize/arena-rewind.js). A temporary built of closures, cells and objects
within a call goes with the call; a state made on the first call keeps that
call's memory and releases every later one's.

Four refinements keep a site from lowering the flag for nothing. A store of
a value that holds no heap pointer escapes only by making its receiver grow
(a relocation, a property's first storage, a key made a string, a durable
array's log): its site checks after the store whether the heap moved
(`siteGrows`), by the receiver as it stood before the store, which rebinds a
grown receiver to its new storage. The mark it compares with stands past the
store's operands: a value or an argument that may allocate as it is
evaluated (`allocatesNothing` says which cannot) moves the mark to the
heap's top as it ends, unless the heap had moved before it began, so a
temporary the value is computed of keeps no call, and the order the store is
emitted in decides nothing. In a loop that allocates nothing else,
calls nothing and that neither a `return` nor a jump to a label leaves, one
check stands around the outermost such loop the receiver's binding stays the
same through (`siteNames`). An assignment yields what it stored, so its site asks the
value whether a running call made it (`siteAsked`, module/core.js
`__esc_new`): a number, a buffer swapped for another, a string of the
module's own lie below `$__base`, the mark of the outermost frame reading
the flag, and lower nothing. A value read off the receiver it is stored
into (`a[i] = a[j]`, a swap through a local written once) is no escape: the
store that first put it there lowered the flag to the same receiver. A
record replaced by a literal of numbers that the emitter writes into the
cells its element had (emit-assign.js `inPlace`) hands its receiver nothing
and allocates nothing: its site lowers nothing. A
receiver the expression itself makes (`xs.slice().sort()`,
`Float64Array.from(xs)`) is fresh memory.

A call the census cannot name is no escape: it runs code of the module,
whose own sites lower the flag (every closure is censused, its sites its
own; a function literal a builtin calls in place is walked with the scope
around it), or the host's, which link flags where the import is called.
What a builtin of the called name would store into a receiver of unknown
kind (`push`, `set`, `fill`) is a store into it. A call through a binding
the summary resolves to closures (`calleeOf`) joins their facts to the
caller's; link takes the closures they were emitted as, every closure the
summary never saw, and every table entry that is no closure as the targets
of the indirect call.

What is known before the call spares it the protocol. An escape with no
address that no branch, no loop and no earlier return stands before runs on
every call (link takes a branch for one only where its label lies around
the escape too: a loop branching to its own head leaves nothing): the frame
never restores (`arenaUnsafe`), nor does a caller that
calls it on every call; one into storage older than the frame (a
parameter's, a captured binding's) keeps the function's own frame (`keeps`),
a caller's may restore. An assignment decides so only where the call surely
made its value (a literal, a `new`). A frame that suspends never restores. A
loop's per-iteration rewind reads no flag: its census takes every escape and
every call it cannot name for a verdict. Link adds what the source cannot
show, each lowering the flag to zero where it runs: a write of a global that
is no scratch, a call handing a host import a value (jz's interop imports
that read hand it nothing; the runtime's own imports keep nothing but a
callback they schedule, bridge.js hostImport), a `call_ref`, and in a runtime
kernel a store whose base address a global reaches (an index read off a
table addresses the receiver it indexes). A tail call is a call to link:
what its callee lowers or keeps, the frames above it read. A handler takes
for the flag the lowest it stood at since the outermost reading frame was
entered (`$__esc_low`, emit/statements.js `flagCaught`): the frames an
exception left skipped their epilogues and did not hand back the flag they
held, so every frame that clears the flag hands it to the lowest first, and
the outermost clears that as it is entered. What no frame wrote below a
mark stays released, a call in which a catch ran included. The handler puts the
mark of the outermost reading frame back as it stood where its `try` began
(`baseHeld`): a mark left standing past its frame would
make every later frame one inside another. A site the
emitter never flagged and a body the census never walked lower it as the
frame is entered (compile/index.js checks each). The protocol is paid by a
frame with a reason of its own and by every exported frame, the one a host
calls block after block; an inner frame only a kernel's rare path flags keeps
its heap until the frame around it returns. The flag has two readers: a
frame link rewrote to restore by it, and the host, for an export whose calls
it releases (`jz:release`). Lowerings no reader can reach are dropped, with
what their checks kept unless a pass before link made later code read it (a
receiver read twice is read once into the site's local); a module with no
reader carries no flag.

A frame that ran an escape keeps what the escape reaches, not all it
allocated (`arenaReach`, module/core/reach.js; off at the size tier, where a
kept call keeps whole). An escape into storage older than every frame
reading the flag (`$__base`) logs where it wrote: the receiver, the cell of a
captured binding (`__esc_cell`), the value a module binding took
(`__esc_root`, which lowers the flag to one: below every mark, above the
zero of an escape the log does not describe). What a frame made is reached
from outside it only through such storage, by a store that ran while the
frame did, so the log names every way in. As the outermost frame returns
(its saved base all ones; for a call the host releases, the host, which
calls the exported `__survive`), the walk starts from the log and follows
the blocks the frame made as they stand then, so a store of one fresh value
into another needs no barrier, and the heap goes back to the end of the
highest block reached. Nothing moves. The walk reads a block by its
pointer's kind (a header's count, a table's entries, a moved block's stub, a
view's buffer, a closure's environment, which carries its count in a header
where the module has sites) and takes every word that reads as a pointer
into the frame's memory for one: a number that reads so keeps a block more,
never one less. A block made before the frame that grew in place past the
frame's mark counts by its end, and one with no payload, the last the
frame made, starts at the heap's top. The durable log's buffers, which a store
into a receiver made at start writes into the frame's memory, count as
reached; the log of the walk itself is allocated as the module starts, below
every mark, and link takes the allocation back where no frame walks. It is a
table an entry is found in by its address, asked only for a receiver other
than the one logged last, so a loop that stores into one receiver pays a
compare an iteration, and one that stores into many a probe; it is emptied as
the outermost frame is entered, where the frame before wrote into it. Blocks below the highest reached stay, reached or not: a value
stored last keeps what the call made before it. The frame keeps all, as
before, where the flag stands at zero, where more receivers were written
than the log holds (128), or where the walk finds no memory for its stack.
So a function every call of which stores what it made (`keeps`) restores by
the flag all the same where a host calls it; one the module calls keeps
whole, the frame around it deciding for both.

`JZ_DEBUG_POISON=1` makes every restore, a frame's, an iteration's and the
host's, overwrite what it frees: a pointer kept into freed memory reads all
ones instead of what the block held until the next allocation. The suite and
the audiojs atoms run under it as a check of the proof: every test of a
computed value passes; the tests that pin the emitted shape or its size (the
restore of a frame and of a loop, golden sizes, the loop ratchet, the
kernel's byte parity) see the fill and differ. `JZ_DEBUG_ESC=1`
makes every site tell the host which one lowered the flag
(`env.__esc_note(id)`, the ids listed on stderr), to find what keeps a
call's memory.

An exported parameter used as a numeric array (paramNumericArrayLike) is
Float64Array in the export and has kind variants under hidden export names
(narrow/param-abi.js): Float32Array at every typed slot, and Float32Array at
the slots stored into and read back with Float64Array at the others. The host
calls the one the arguments fit exactly (interop.js kindDispatch); a slot read
after it is written takes only its own kind, or a plain Array for Float64Array.
A variant is minted only where its kinds differ (the mixed one where an
in-place slot stands beside another) and takes each slot in the same round as
its origin, so the summary is rebuilt no more often than without it. A variant
calls what its origin calls, from its own body: those calls join the call-site
census, so a callee fed both kinds splits per kind (specializeBimorphicTyped)
instead of going generic.
An accumulator copied into a guarded loop keeps the same numeric-use contract:
a binding's `s += value` is compatible wherever `s = s + value` is. An unknown
accumulator does not itself prove a Number; the array contract still needs an
independent numeric operation or stores proven to supply present Numbers.
Boxed arrays preserve holes across the host boundary: absent cells use the
reserved tombstone, while present `undefined` uses its value atom. Encoding and
staged writes test each index's presence; decoding leaves holes unassigned.
Array copy-back deletes holes and writes present undefined, including nested
arrays and storage reached through forwarding headers after memory growth.
`jz:release` names the exports whose calls keep nothing, `flag` those that keep
nothing when the escape flag stands at or above the host's mark: the host
rewinds the heap to where it stood before it copied the arguments in, and
sets `$__base` to that mark around the call. `host` names those whose frame
releases nothing by itself though it allocates (no rewind at the level).
A call of any other export whose parameters are all numbers on their own lane
(no slot of the i64, externref or host-BigInt lanes, no typed slot, no rest)
leaves the host nothing to marshal and nothing to release: it crosses as it
is (interop.js `crossing`), written out by arity so that it allocates nothing,
with a BigInt argument, a result that is no number, a throw and a call made
while another runs handed to the general path or its decoding. Measured on a
module with heap state, a call costs 6 ns raw, 16 ns so, 150 to 250 ns by
the general path. `ask` names
those that allocate and whose result may be a heap value: their calls take
the general path, which releases once the host holds a copy of the result.

`E[Symbol.iterator]()` is `__it_from(E)` for every receiver (jzify): an
indexed value's own iterator, a collection's snapshot view, a provider's
`@@iterator` result, a machine itself; a jz builtin carries no `@@iterator`
or `next` member of its own. The summary names each mint's record by its
call node, a site of the runtime record's layout (std/iter-helpers
`ITER_RECORD_KEYS`), and keeps the source beside it: `it.next().value` is the
source's element where the record's own slots would join every mint in the
program, and a generator object (`__it_mk` with the machine's closures)
answers `next` with its own closure. `[...E]` (`__it_drain`) and
`Array.from(E)` (`__it_arr`) drain a provider's iterator into a fresh array
of its elements and pass an indexed value through. The helpers' bodies still
run over the arguments' kinds without their identities; their own results
stay out of the result table. The protocol lowerings (a for-of that probes
for a provider, decorated iterators) are gated by the program's iterator
producers: `jzify.witness` reads every bundled module's parsed AST ahead of
any lowering (`programModuleAsts`), so a module iterates what another one
mints, and the compiler's own `jz:` modules keep their member calls.

A Map's keys and a Set's members are handed out only by enumeration: a key
whose identity the join drops is held beside the kind and escapes when the
container enumerates, escapes or reaches the host, never when it is stored.
Two tuple rows of one length unify by position; a row that reaches itself is
unified before its rows merge. A shape joined with primitives keeps its
identity in a cell of its own, read like a dictionary that may hold it.

A wrapper hands back what its closure argument returns: a return that calls a
parameter (or a local returned untouched, or passes the parameter on to
another wrapper) binds nothing into the wrapper's result, and each call site
reads its own argument's result; away from a call site (`resultOf`) a
forwarded result is unknown. A closure set holds up to 1024 members before
its members escape. `Object.assign` onto a shaped target stores each source
slot by name; onto an array or dictionary it stores every shape of a shape-set
source.

Unknown-receiver stores affect schemas whose identity escaped analysis or whose
instances the host can hold. The summary retains their stored values and applies
them when another schema escapes later. Retained object joins use the existing
set-ID space. Emitters see a layout only when every member agrees, so member
BigInt slots use tagged storage for differing layouts while analysis retains their
identities. Escaping an object also escapes its field values; escaping a callable
escapes its result. Each summary owns and resets these facts.
A map's keys are retained beside its values: storing an object as a key does
not lose its shape; enumerating the map (keys, values, entries, forEach,
iteration, a copy) or losing the map does. Lookups, presence tests and
deletions do not escape their arguments. A call of a name outside a known
shape escapes the arguments, not the receiver. Freezing returns its
argument with its shape; other read-only builtins keep their argument shapes.
An object parameter the call lattice already typed still takes the summary's
exact shape, so its slot accesses stay direct.
A boolean arm beside a number arm in `&&`, `||`, `??` or `?:` carries its
numeric image: a raw 0/1 stays, a boxed boolean atom (a field read, a boxed
local, a call result) converts, since the join is value-typed NUMBER.
Number-key stores can reach every canonical number spelling, including negative,
fractional, NaN and infinity keys; digit-only names are not a sufficient proof.
For arrays, canonical index strings share the element cell, and an unknown
string store also reaches that cell. Other named properties stay separate;
the documented i32 numeric-index contract is unchanged.
Boolean arms beside numeric arms use their numeric image when the result's
representation is numeric; observable boolean results retain their tagged value.

Default ABI carriers are immutable and shared between compile sessions.
Only strings select an alternative carrier: the emitter reads the binding's
externref hint directly, without a second registry or a general type dispatcher.
Tagged typed-array reads reuse the ordinary checked numeric reader.
Only the BigInt branch checks bounds separately, and it uses the shared data
pointer decoder so offset views retain their origin.

Schema-read devirtualization runs from level 1. Its budget counts shapes naming
the requested field, rather than every shape in the module. Dense IDs use the
existing branch table; up to four sparse matches use guarded direct loads.
Unknown receivers must match the complete object NaN-box prefix before their
schema ID selects a load. Missing shapes retain the generic lookup, and fields
exceeding the dispatch budget retain that lookup unchanged.

The host boundary carries plain `jz:fields` data alongside schema names. The
summary supplies field families and typed/nested identities; schema analysis
supplies numeric refinements and records only discriminant constants actually
consulted by lowering. Host-exposed schemas use tagged BigInt storage, including
shapes shared by BigInts and numbers; private schemas whose identity stays known
retain their raw lanes.
Returned object literals allocate independently, since host writes can outlive
the call. Interop enforces
that snapshot on structured ingress and writes, and uses it to decode scalar
carriers. Retained arrays exposed to the host have open elements because their
handles carry no element contract. Fresh returned arrays keep their construction
proofs; typed buffers keep their storage policy. See the [host memory contract](README.md#host-memory-contract) for mutation
and allocation failure behavior.

JSON.parse shares decimal accumulation and rounding with Number/parseFloat;
its own scanner checks the stricter JSON grammar. Generic and shape-specialized
parsers share one whitespace loop, with an inline guard for compact input. The
scanner bounds each UTF-16 load and accepts only tab, LF, CR and space.
Known key chunks are emitted directly as hexadecimal bytes, without intermediate
Number or BigInt packing. This keeps native and self-hosted output identical.
Integral significands bypass
the decimal conversion table. Parsed objects overwrite duplicate keys and order
array-index keys before registering a schema. The schema cache hashes decoded
keys, verifies their contents, and grows its backing table while preserving IDs.
Exhausting the pointer's schema-ID field raises a RangeError instead of corrupting
another object. The ordinary module clear resets the table and cache together.
Cache allocation clears its entries explicitly: arena reset reuses memory and
the bump allocator does not promise zero-filled storage.

URLSearchParams uses ordinary class lowering with shared methods and private
key/value arrays. Unused methods disappear through existing reachability analysis.
Its callback iterator rereads the live fields after each callback, including
when appending entries grows their backing arrays.

Dynamic object reads, writes, presence and deletion share one schema-slot search.
The search classifies a short or canonical interned query once, outside the scan;
other keys retain content equality. It uses the existing schema table and adds no
cache or allocation. Size mode retains the single content-comparison loop.

Array read-only/current-pointer policies and multi-site push counts reuse the
binding-use census. It distinguishes property reads from member calls, preserving
indexed access, optional calls, writes, aliases and captures as separate evidence.
On a cache miss, a declaration census first bounds which names need use records;
free names receive records only when the caller explicitly tracks them. Forward
uses, capture records and encounter order stay intact without allocating discarded
tuples for every referenced global or nested closure local.
String self-appends consume that same census: only a local empty-string builder
with no retained aliases may extend its buffer. A self-assignment alone proves
nothing about ownership. Discarded appends and empty resets preserve it; a sole
terminal return can publish the result. Captures, stores, borrowed replacements
and observed assignment results retain fresh-copy concatenation, as does generic
addition after ToPrimitive. Private builders keep linear allocation.
The existing fixed-builder length proof also publishes reserved capacity into local
ValueReps. Allocation converts that logical count using the settled record layout;
push still updates visible length and returns its current value. Fixed builders
omit forwarding/growth, while multi-site record pushes share the existing slot
layout code. Conditional growth, exception handlers, escapes and induction/header
mutations reject the proof.

The source loop transforms share one closure-write census per function. They
preserve writes to existing bindings and introduce only private temporary locals,
so changing loop arithmetic does not require rescanning all nested closures.

The interval interpreter also supplies call-argument and typed-store bounds.
`intervalRanges` enables whole-binding hulls and the complete interprocedural
scalar/element fixpoint at O2/O3/size. O0/O1 omit those optional certificates;
typed-read presence, signed-zero/overflow vetoes and conservative ABI validation
still run. Already proved summary bounds also retain the magnitude of signed-word
parameters; the interval budget controls the separate caller solve, not these
existing ABI facts. An explicit pass override changes this compile-budget choice. No
source-size threshold or special compiler-input policy controls these proofs.
Recursive scalar parameters use the existing call-graph components: private signed-
word hypotheses must contain every external entry and every recursive argument.
An unknown, missing, wide or negative-zero argument removes its hypothesis, and
validation repeats before any range is published. Exported or escaped components,
reassigned/default/rest parameters and components with no external entry decline.
Exhausting the validation budget publishes nothing. This proves parameter width,
not a bound on recursive result accumulation. Return/throw arms contribute no
fall-through state; rounding a proved integer preserves its hull, and a varying
shift count preserves a hull only when every scaled endpoint still fits the word.
A loop-local counter initialized to a nonnegative integer other than `-0`, then
advanced only by a positive integer constant, keeps its sign even with an unknown
upper bound. This lexical fact bounds `counter % K` for positive constant `K`;
it proves no i32 magnitude for the counter itself. Body, condition and captured
writes reject it. `test/interval-proof.js` pins the fact's scope and rejections,
and the remainder and dense-switch tests pin signed-zero behavior and lowering.
Its branches retain completed environments and share one hull join. Range pairs
are immutable, so unchanged bounds survive a join without another allocation.
Compile-time bitwise and integer-store folds share exact ToInt32 conversion;
large constants reduce modulo 2^32 before the compiler's runtime i64 boundary.
DataView calls capture arguments before offset/value conversion. ToIndex uses
semantic Number evidence for its signed-word shortcut, never a pointer's i32
storage; wider offsets retain unsigned wasm32 bits until the bounds check.
Setters apply ToNumber or strict ToBigInt before checking the view's extent,
including OOB writes, and the shared setter family also owns Float16 conversion.
Runtime typed stores, DataView, Atomics values and UTF-16 unit construction
share exact ToInt32 lowering. Proven ranges keep direct conversions; unknown
values recover their low word from the IEEE significand beyond the i64 range.
The unknown tail converts inline below 2^63 (NaN saturates to ToInt32's zero)
and calls the kernel only for the infinities and the values beyond, lowered
after the lane lift, which reads the conversion as the kernel call.
An f64 local with finite constant steps also has a magnitude enclosure when
its trip count is unknown: IEEE rounding eventually absorbs each step. The
all-writes proof checks both rounded endpoints after joining every other
definition; unknown writes and nonfinite or overflowing endpoints reject it.
This can remove a ToInt32 magnitude guard but never authorizes i32 storage.
Intrinsic and user calls share excess-argument sequencing. Collection probes
retain precomputed literal hashes while using the same boxed-value conversion.
Math arguments finish evaluating before any operand converts to Number;
unknown or BigInt operands capture their values first, and ignored arguments
still run. Spreads materialize their argument values before conversion so a
later argument or valueOf cannot change an earlier operand. Integer Math methods
apply Number conversion before word wrapping, including throwing on BigInt.
Captured Math operands retain Number facts already proved by their emitted value.
Typed read/modify/write fusion validates the emitted RHS before committing its
guard-local read: a remaining conversion call restores ordinary checked reads.
Writes to compiler-owned scratch locals are pure when their values are pure.
Schema-tag masks reuse the numeric constant evaluator.
Internal parameter ranges narrow only when every incoming call proves them;
exports, indirect calls, missing arguments and unknown writes retain checks.
The same ValueRep range feeds integer arithmetic and indexing after lowering.
Typed-store summaries account for element wrapping and fresh zeroed storage.
Truncated division preserves its quotient range only when it cannot wrap i32.
Structural index proofs require every occurrence to succeed; an access node
also carries its own occurrence's proof, so an unprovable twin no longer
re-checks a proven read. Sentinel guards (`compile/sentinel-guard.js`) version
what no static proof bounds: a cursor that only a data sentinel stops, like the
lower envelope's pop `while (s <= z[k]) k--` and scan `while (z[k + 1] < q) k++`.
A loop whose test reads at the cursor becomes `while (G && C′) B′; if (!G)
while (C) B`, and a block's rest after the statement that steps the cursor
becomes `if (G) S′ else S`. G tests only the bounds the unproven reads lack.
Renamed locals retain their original summary kinds through an alias, including
nullish possibilities; this also covers temporaries introduced by load-CSE.
Counted loops and computed indexes stay with loop-entry versioning, which
tests once per entry instead of once per pass. Emitted from one AST, the
fast copy and checked twin of a loop-entry version share their locals, so a
checked integer read's `undefined` keeps an accumulator f64 in both. Such a
loop is versioned in the source instead (`compile/twin-locals.js`):
`L → if (G) L else { let x′ = x; L′ }`, with G the extent test in source form.
The fast copy keeps its names and G proves its candidate reads; the twin
declares its own names and a fresh copy of each outer local dead after the
loop, and reads its original's summary kind through a summary alias. The
emitter versions neither copy again, and a split that narrows no local is
undone. Present integer reads alone do not bound an accumulated sum: its
complete trip/step hull or another exact-word proof must justify the carrier.
The positive twin test uses a fixed-trip signed-element reduction; the
variable-trip glyph fixture retains semantic checks, including wide cursors.
Negative source-shape checks run before counted-loop canonicalization, which
can turn a variable-start loop into a qualifying constant-start copy.
Likewise, using a geometric stride as an index does not justify wrapping
`id *= 4`, and a word-sized product's operands do not justify losing Number
rounding above 2^53. The named row-index test pins hoisting outside the hot
element loop; it does not require that hoisted Number product to become i32.
A typed read emitted as proven marks its IR `presentNumRead`, so the
binding it initializes records a present Number rather than the summary's
nullable kind. A pass that rewrites a body in place calls
`invalidateRewrittenBody`: the binding-use census, interval proof and mutation
memo are keyed by node identity. An element a loop stores for its next pass
stays in a local (`compile/carry-elements.js`): the loop reads `A[I]` once
before it starts, and the store `A[I] = E` also sets the local to E's
converted value. The store must be proven in bounds, and nothing between it
and the next pass's read may write I's names, store to A at a maybe-equal
index, store to an array that may share A's buffer, or call. An integer
element always takes its conversion (`E | 0` for Int32Array): a copy of a
loop counter would otherwise rate the local unbounded and widen it to f64.
Loop versioning
groups cursor offsets by their shared extent and omits already-covered nest
guards; negative offsets participate in the lower bound. A cursor read in a
statement before the one that advances it (`out[k] = x; k++`, a compaction)
spans one round fewer than a read at or after the advance: an output sized
for every round takes the fast arm. A nested level lifts
its guard to the nest entry only when every name that guard reads is stable
over the top loop's body, condition and step (`stableLoopNames`: a call may
replace a global, so calls count as writes). The top loop's own counter,
written by its step, is exempt for a slot term of an inner guard when the
header is plain (`iv < B` with `iv++`, `iv >= B` with `iv--`): the lifted
conjunct sits at the nest entry, where the counter holds its entry value —
the maximum of a descending loop and the minimum of an ascending one, the
wrong end for the other bound — so the emitter bounds that term by the
counter's EXTENT, entry on one side and loop bound on the other
(`versionableTypedNest`'s `topExtent`, `control-flow.js`'s `topEndsOf`),
rather than reading it.

Ephemeral dictionaries use the same zeroed header allocator as other collections.
Empty-literal reassignment uses the binding's planned layout, just as declaration
does. Clearing a prior table requires a private local receiver: bare aliases,
closure references and module bindings keep fresh allocation identities.
A count dictionary the census proves i32-lean keeps the raw word in its slots
and reads it with a bare wrap, so every store path encodes the value the same
way (`emit-assign.js` `dynSetValueI64`), the runtime key-kind dispatch's string
arm included: a specialized variant of the kernel stores through it.
Allocation and fixed probes share one capacity calculation; unrepresentable
domain sizes retain the ordinary growing table instead of overflowing a hint.
Hash words reserve unsigned values 0/1 for empty/deleted slots. Runtime,
literal, interning and host-codec producers must agree, including negative i32
bit patterns. Changes to this contract require rebuilding Wasm with matching interop.
Collection entries and allocated headers lower fixed fields directly to memory
offsets. Their layout proves the access; generic WAT address arithmetic retains
its wrapping semantics unless the optimizer independently proves no wrap.
Table reuse invalidates enumeration keys before clearing its contents. Host
`memory.reset()` calls the compiled reset so heap rewind, cache invalidation and
durable-state healing have one owner; JS-only memory retains its fallback.
Owned-memory usage takes its baseline after initialization completes, including
reactors initialized after the host adapter is ready.

The size preset keeps indirect function-table calls instead of adding speculative
direct arms alongside their fallback. It also keeps shared/exported source bodies
outlined and calls the shared dynamic length and numeric-conversion helpers.
Single-use internal bodies can still inline. The speed preset retains those
expansions. Numeric uses alone do not make a coercion pure: an internal
parameter may carry an object whose valueOf runs at every use, or a BigInt
that throws only when the use executes. The old per-parameter coercion hoist
is removed; numeric proofs and the export boundary contract eliminate known
Number conversions before ordinary IR optimization.

### Body-fact freshness

`analyzeValueFacts` requests kinds, shapes and allocation identities without
new scalar storage proofs. `analyzeBody` additionally requests complete local
widths. Both share one cache entry and invalidation authority: a later storage
query upgrades the pending scalar candidates without repeating constructor or
schema discovery. It reuses the original provisional locals and range facts,
then runs the same narrowing/widening rules as a cold full query; earlier returned
maps remain unchanged. Existing typed-read presence walks still collect scalar
hulls alongside their occurrence proofs.

`analyzeBody` caches observations, not an immutable semantic snapshot. Its
signature fingerprint covers only the current function signature. Every other
dependency has an explicit invalidation owner:

| Dependency changed | Invalidation before the next dependent read | Owner |
|---|---|---|
| Function body or specialization AST | `setFuncBody` / `reanalyzeBody` | Source rewrite and specialization passes |
| Current parameter/result signature | Live fingerprint; explicit seams during solving | `body-facts.js`, `narrow/results.js`, `narrow/param-abi.js` |
| Function value/type/length overlays and caller facts | `reanalyzeBody`; `clearBodyFacts` for affected callers | `narrow/caller-ctx.js`, `narrow/results.js`, `narrow/param-abi.js` |
| Summary, global types/lengths, schema integer census | `clearBodyFacts` at publication/phase boundaries | `plan/index.js`, `compile/index.js` |
| Compile session | New fact store | `session.js` |

Global eviction clears the complete body cache, including anonymous roots,
without changing the semantic program revision. Physical carrier changes use
this eviction; summary result contracts read their ABI from live signatures.
Semantic input changes, such as an export's `boundaryTyped` contract, use
`invalidateBodies` to invalidate both the body facts and the summary.
Majority-kind specialization requires a use that can benefit from the pinned
kind. A parameter only forwarded to unchanged user callees does not justify
a clone or another summary solve; the existing binding-use census proves this.
Every rewriting seam, and every plan sweep that reports a change, also advances
one program revision. The summary is keyed by it and by the contents of the
registries beside the program (schemas, functions, globals, binding schemas),
and is rebuilt only when the key moved (`summarizeProgram`,
`src/compile/index.js`). `JZ_DEBUG_INVARIANTS=1` checks each reuse against the
summary's full inputs, so a rewrite that bypasses the seams fails there.
Signature checking does not authorize stale overlay reads. New passes use these
existing seams; they must not add another cache or rely on ambient facts staying
unchanged accidentally.
Literal folding and front-end lowering share `rewriteChildren` in `ast.js`.
It preserves unchanged subtrees and function bodies instead of allocating an
AST copy merely to discover that nothing changed.

Historical `.work/` citations below refer to retired evidence, recoverable using
[.work/README.md](.work/README.md). [PLAN.md](PLAN.md) is the active product plan.

Compiler lifecycle diagnostics live in `src/debug.js`. `JZ_DEBUG_INVARIANTS=1`
enables phase, representation and mutation checks for development. Source builds
use one flag; the browser and self-hosted release builds specialize it before
import analysis, removing the diagnostic code. These checks report compiler bugs,
not source-program warnings. Phase consumers read the owned context fields directly;
wrapping those fields in temporary objects adds no protection.

## Code layout

```
jzify/          pre-compile desugar (index.js orchestrator + phase modules)
  names.js      temp-name factory
  bundler.js    esbuild export/interop folds + object-literal idioms
  classes.js    class + object-method `this` lowering, pseudo-classical/prototype folds, statics
  switch.js     switch fall-through lowering
  generators.js function*/yield state machines + iterator-helper loop fusion
  hoist-vars.js var hoisting; arguments.js — arguments/rest lowering
  settle-vars.js a `var`, or a bare `let`, declared at the assignment that dominates its uses (`const` when written once); a counter declared by its loop
src/
  prepare/      validate, normalize, extract exports/imports (index.js)
  compile/      analyze → infer → plan → narrow → emit; ProgramIndex; program facts; driver (index.js)
                analyze/frame-effects.js: per-function and per-loop escape census (what outlives a frame or an iteration)
                plan/lanes.js: record parameters as scalar lanes (a parameter read only field by field, at literal or known-shape sites)
                plan/counted-loops.js: a counted loop over its trip number (computed start, secondary cursors, unrolled body rolled back, unit stride versioned); guards preserve full cursor entries and updates, including signed zero. Bounds must be stable and free of coercion calls; captures and mutable array lengths retain their original loops.
                plan/unswitch-loops.js: a loop testing a name it never writes (`if (stereo)`), a copy for each answer, its declarations renamed so each copy's values have its arms' kinds
                plan/kind-split.js: a loop reading a name of several kinds, a typed array among them, a copy over that array where `instanceof` says the name holds it (the constructor from the name's values and its callers' arguments)
                plan/integral-loops.js: a loop moving a cursor of unknown integrality, a copy over its int32s where a test says it is one
                plan/loop-fields.js: a field or a Float64Array element a loop reads and writes through one receiver, in a local for the loop, stored back after it
                plan/chosen-calls.js: a local holding one of several named functions and only called, the choice of direct calls
                plan/called-args.js: a function whose parameter is only called or tested against strings, a copy for each named function or string literal a call passes there
                plan/object-reads.js: a key a loop reads of an object the function made and only reads, read once where the object is made
  optimize/     WAT-array passes + vectorize.js + loop-rewind.js (per-iteration heap restore, after the vectorizer);
                arena-rewind, sort-locals, low-word-mask are tape passes run by link
  link/         whole-module passes on the tape: treeshake, custom sections, throw-runtime prune, function order, local names (index.js)
  summary/      the program summary: one kind per binding, slot and result, a whole-program fixpoint refreshed after source rewrites
  ir/           tape.js, the IR tape (parallel typed arrays); the WAT-array helpers until emit builds the tape
  wat/          assemble.js, optimize.js
  abi/          NaN-box ABI helpers (string, array, object, number)
  op-policy.js  shared jzify/prepare reject + class-error messages
  # shared leaves — cycle-free, imported across stages:
  ast.js static.js kind.js type.js param-reps.js
  ctx.js bridge.js reps.js ir.js autoload.js resolve.js
  layout-kinds.js  region-arena relocation arms per heap kind (executable registry; prose twin layout-kinds-doc.js)
module/         stdlib
layout.js       NaN-box bit layout + PTR.TYPED elem-aux codec (compiler-free, shared with module/)
interop.js      host↔wasm value marshalling: NaN-box decode/encode at the JS boundary (exports, imports, memory views)
err-codes.js    compile/runtime error-code registry (host decode of trapped error classes)
wasi.js         WASI shim; linked by interop.js, no public subpath
cli.js          command-line driver (`jz` binary): flags → compile opts, file IO, --why
```

**Folder policy:** one folder per pipeline *stage*, not per arbitrary concern. `jzify/` lives at repo root (pre-compiler transform, like `layout.js` / `cli.js`). Shared cycle-free leaves stay at `src/` root so `module/` imports stay short.

**Stdlib registration — two dialects, by design:** raw `ctx.core.stdlib[name] = body` / `ctx.core.emit[name] = fn` (or the `bind(name, fn)` sugar) is the DEFAULT for dep-free, arity-irrelevant handlers — the overwhelming majority of the stdlib (~580 sites vs ~35 `reg()` calls; this is real, not legacy-to-migrate). Call `inc('__dep', …)` inline in the handler body for any stdlib kernel it needs. `reg(name, deps, fn)` (→ `emitter()`, `src/ctx.js`), paired with `wat(name, body)` for any WAT-kernel half, is REQUIRED whenever either mechanical property matters:
  - **deps must be auto-included, not hand-called.** `emitter()`'s wrapper runs `inc(...deps)` before every invocation of `fn`; anything that wraps/aliases the handler (`dual`, `.deps` propagation, a second name bound to the same function) inherits the guarantee for free. A raw handler's `inc()` call lives only in its own body — copy or wrap it and the dep silently drops.
  - **logical arity diverges from `fn.length`.** `emitter()`/`call()`/`method()` set `.argc` explicitly, which `emitArity()`'s fallback (`h?.argc ?? h?.length`) needs whenever a handler is built through a rest-param wrapper or otherwise doesn't report its true arity via `Function.length`. Plain raw handlers work fine on the `.length` fallback *only when the two agree* — that's the common case, hence still the default.

  The one hard, mechanical rule for either dialect: **never introduce a second write for a FLAT name already registered** — it used to silently overwrite the earlier handler (dropping `emitter()`'s auto-inc/argc guarantee when the earlier write was a `reg()`) with no error. It no longer can: `reg()`/`wat()`/`registerGetter()`/`bind()` (`src/ctx.js` `registerName`) refuse to register a FLAT name (no `:`) that's already occupied — by an earlier raw/`bind()` write *or* an earlier `reg()`/`wat()`/`registerGetter()` call, in either order, through either dialect — and throw immediately, naming both the module registering now and the module that got there first. A guarded `ctx.core.emit` handler clobbered by a *later, genuinely raw* (non-`bind()`) assignment — undetectable at the moment of that write, no Proxy in the self-compilable subset — is caught right after the clobbering module's `init()` returns (`verifyEmitIntegrity`, wired from `src/autoload.js` `includeModule`), by comparing the live table entry against the exact value reference `registerName` stored at registration time. **Type-qualified keys** (`.date:valueOf`, `.string:padStart`, …) are the one exemption: namespaced by design, one physical owner (the type's own module) per key, so `bind()` leaves them on the old unguarded raw write — cross-module collision there was never the hazard. What used to read as a legitimate "generic default, specific override" chain on FLAT names (e.g. `date.js`'s raw `.valueOf` over `string.js`'s `bind('.valueOf', …)`) was never actually that: it was this exact silent-collision class, and it corrupted `.valueOf()` on every unresolved-type receiver for as long as it shipped (`.work/archive/printer-trio.md`). All throw paths are exercised by `test/passes.js`'s stdlib duplicate-registration tests.

**kind vs type:** `kind.js` = value family (STRING, ARRAY, …). `type.js` = WASM numeric type (i32/f64), typed-array ctor detection, integer proofs, loop-unroll helpers (the pure PTR.TYPED aux codec lives in `layout.js`). **AST walks:** use `refsName`/`refsAny`/`some` from `ast.js` — don't hand-roll name scanners.

**ProgramIndex:** `src/compile/program-index.js` owns four disjoint numeric spaces: `sourceId` for prepared/imported functions, `variantId` for specializations, internal `graphId` for callables present when SCC reachability freezes, and `concreteId` for the final Wasm emission order, assigned once after variant identity closes (`finalizeConcreteFunctionIds` freezes `ctx.funcs.list`, so the registry carries existence, never order). At that close, `publishParameterAbi` transfers the settled parameter rows to concrete-ID slots and `programFacts.paramReps` is deleted; emission reads `parameterAbiOf`, never a name-keyed lattice. Analysis and emission follow `reachableForLowering`: a named function the frozen graph does not reach publishes no FunctionPlan and emits nothing, while prepare still rejects unsupported syntax in every body. `npm run test:reach` is the completeness gate for any change to the call-site census, roots, or edges. Use only the matching accessors (`sourceIdOf`/`sourceFunctionById`, `variantIdOf`/`variantFunctionById`, `graphFunctionIdOfName`/`graphFunctionById`, or `concreteIdOf`/`concreteFunctionById`/`concreteFunctionOrder`). Generic `functionById` and `functionIdOfName` do not exist. Every variant records one source ID; variants of variants normalize to that source. `materializeVariant` is the sole registration writer, and `finalizeVariantIdentities` closes the space after union-cursor specialization while asserting that signatures, parameter facts, and FunctionPlans are derived rather than shared. ProgramIndex also owns same-module member targets, address-taken bits, direct edges, roots (host-callable functions through the canonical `isExported`, which resolves aliases and bundle re-exports; the raw `func.exported` flag means only "declared with `export` in its own module" and is read solely by the inline-export-attribute sites in `emit-func.js` and `boundary-wrap.js`), SCC spans, reachability, and BigInt parameter/result boundaries for every callable: named sources and variants in the frozen ID arrays, anonymous closure/start identities in the append-only anonymous space (they materialize during emission, after variant identity closes). The boundary arrays carry the C1-C5b and Shape 6-9 conditions listed in `program-index.js`; RepresentationPlan owns body-local actions only. ProgramFacts carries a mutable `addressTakenNames` census only through index enrichment; ProgramIndex converts it to numeric bits and deletes the source-name key before narrowing. Every later reader uses `ProgramIndex.addressTaken`. Do not restore another function registry, member-target table, address-taken compatibility view, name-keyed target cache, or call-graph writer.

## Architecture

Current pipeline: `source → parse (subscript/jessie) → jzify (always on; the test-only `strict` option skips it) → prepare → compile → optimize → link → watr (WAT→binary)`

The parser entry (`src/parse.js`) orders the operators of every first
character longest first. subscript tries them newest-first and commits to the
first whose text matches, and a one-character operator matches any text it
begins: `>`, registered after `>>`, took the first character of a shift
standing right of a comparison, so `a < b >> c` read `(a < b) >> c`
(subscript 10.8.1; `test/shift-precedence.js`).
It reads a statement list by one call, a statement per pass: subscript's
`feature/asi.js` reads the statements after a boundary by a call inside the
call that read the one before and declines past 2000, where a block no longer
closes (`Unclosed {`), so a library bundled into one file did not parse. Each
statement is read at a precedence of its own (`ONE`, which admits what
subscript's `lvl - .5` admits), and the boundary after it only notes that
another follows. The trees are subscript's, node for node (`test/parse-list.js`).
The change belongs in subscript's `feature/asi.js`; this layer goes when it is there.

It also reads source text the way ECMAScript does where subscript takes a
shortcut. A name is ID_Start then ID_Continue, `$`, `_`, ZWNJ and ZWJ, written
raw, as a surrogate pair or escaped (`src/unicode.js`; the range tables are
generated from Node's Unicode data by `scripts/gen-unicode-id.mjs`, since the
compiled compiler has no `\p{…}`), and every stage after the early errors sees
an escaped name decoded. Between tokens stand the WhiteSpace and
LineTerminator characters and no others; the space layer owns the comments and
ends a line at LF, CR, LS and PS (`test/identifiers.js`). Two statements on one
line need `;` between them unless the first ended in a block of its own, and a
postfix `++`/`--` takes no line break before it: the step layer checks every
place the ASI layer splits a statement off, and every statement body end,
against the gap the space layer saw (`test/parser-bugs.js`). The ASI layer's
flags outlive the tokens that raised them; the step layer keeps an empty
statement's `;` out of the next statement and reads the gap before a template
for its tag, and a label heads any statement, not only a loop.

A parsed node's `loc` indexes the compile's sources laid end to end: the
program's text from 0, then each bundled module's after the one before
(`ctx.js addSource`, `prepare/handlers.js parseModule`). The compiler's own
`jz:` modules and the text it writes carry none. A rewrite gives the node it
builds the position of the node it replaces (`ast.js withLoc`,
`rewriteChildren`, jzify's recursive rewriters, `prep`), and a function record
keeps its body's position when a pass rebuilds the body. The walks that reject
(the early errors, jzify, prepare, emit) hold a located node's position current
while inside it and restore the enclosing one after: a fault at a node the
compiler built reports the nearest written one around it, and outside any walk
the active function's body stands in (`ctx.js here`). `locate` maps a position
to its module, line and column, and a message shows the names the source wrote
(`test/error-location.js`).

**One shared optimizer, owned by watr (`~/projects/watr`).** Generic optimizer changes belong there, with tests in both projects. JZ supplies language-specific analysis, representation contracts, and lowering. The existing generic passes in `src/optimize/` are migration work: consolidate them into watr and delete JZ copies, rather than building a competing optimizer. Never patch only `node_modules`.

The tape (`src/ir/tape.js`) transports WAT through link. Settled program summaries own semantic facts; watr owns generic optimization. [PLAN.md](PLAN.md) prioritizes reliable builds and stateful audio DSP. Further IR or state refactors need a demonstrated defect, bottleneck, or deletion. Each migration slice deletes the authority it replaces.

Float32Array storage does not lower JavaScript arithmetic precision. Maps and
stencils choose their computation lanes together: f32 loads promote to f64x2,
arithmetic stays f64, and stores round to f32. Copies and sign operations can
retain f32x4 lanes. Narrow integer stores preserve the scalar conversion.
Scalar `fround` code computes in f32 where the rounding is the same
(`optimize/float32.js`, the `narrowFloat32` pass, after the lane lift and the
devirtualizations, whose marks its copied nodes keep): f64 carries
53 bits, more than the 2·24 + 2 that make a double rounding of a sum,
difference, product, quotient or square root of f32 values agree with the
single one (Figueroa, "When is double rounding innocuous?", SIGNUM Newsletter
30(3), 1995); negation, magnitude, the roundings to an integer, min, max,
copysign and the comparisons are exact in either width. A local every write of which holds an exact f32 value (a
promoted f32, a constant the format holds, a conditional of such, a narrowed
local) becomes an f32 local whose reads promote; a write of one rounding step
over exact operands (`x *= s`, the store temp of `out[i] = sx * scale`) rounds
early when every read it reaches only rounds the value (a demote, a NaN test
of the value against itself, a copy whose reads do), which one walk of the
function in evaluation order settles (loop bodies twice; a read node an
emitter placed at several points is reached by the writes of every one). A
local no visible write reaches is left alone: code materialized later writes
such temps. Narrowing is worth its promotes: a local narrows when it removes
more conversions than its reads in f64 code add, so a flag or a count written
by constants alone stays f64 (the loop-body ratchet holds it). Then each demote takes
its operand's f32 form: a promote peels, a step of exact operands computes in
f32, a conditional demotes in its arms. A value that may hold the undefined box,
a sum of f64 values, or a local read where the rounding would show stays f64.

An integer a number holds computes in an integer register where its interval
proves the two agree (`optimize/int-narrow.js`, the `intNarrow` pass, over the
intervals of `optimize/int-range.js`). Integers below 2^53 are exact in f64, so
a sum, difference or product that stays within 2^52 is the same number in i64,
its remainder by a constant is `rem_s`, its quotient under a truncation is
`div_s`, and a comparison of two such values compares the integers. The
emitter also uses word remainders for positive runtime divisors with a proven
integer interval. Signed dividends retain their sign when the result is zero;
storage classification preserves that Number result, and a ToInt32 consumer
can discard only the zero-sign correction. Cyclic remainder bounds may prove
a nonnegative interval only when every write, including initialization, keeps
it; fractional increments do not acquire an integer bound.
The interval walk follows the statements in evaluation order and keeps for every
i32, i64 and f64 local `{ lo, hi, int, nz, nan }`: the closed interval, whether
the value is an integer, whether it may be -0, whether it may be NaN; no
interval at all is any value, a box among them. Raw i64 constants and truncations
have bounds only where Number endpoints represent their integers exactly.
The walk seeds i32 parameters with their actual signed-word range. Decided
comparisons retain operand writes, calls and traps in evaluation order. A saved
word's conversion agrees with its readback, and finite values exclude special
floating-point exponents. Division over one-sided denominator intervals respects
negative zero, interior `0 / 0` and negative underflow; a numeric zero endpoint
alone never proves the sign of a reciprocal.
Subtracting selected bits, `x - (x & mask)`, preserves a proved signed word
without borrowing across bits. The interval walk uses that identity to close
bit-removal recurrences, including a mask saved by the immediately preceding
assignment when its producer cannot change `x`. Unknown, wide or negative-zero
inputs and intervening writes keep ordinary Number arithmetic.
Saved scalar predicates retain those refinements only while a dominating
assignment and every read's reaching definition remain unchanged. The lookup is
requested at a guard and cached across interval rounds; conditional writes,
loop-carried definitions and ambiguous shared occurrences decline it. Equal
copies, tee results and a selected arm with an unchanged condition can carry
the bound back to its producer. A faithful signed-word conversion relates the
word's range to its original Number while preserving the Number's possible -0.
This bounds a checked worklist's integer fast copy; truthiness alone never
narrows its fallback. Bounded lookup exhaustion simply stops propagation.
A comparison refines only reads that later guard operands have not overwritten;
this applies through eager compound tests and negation. A short-circuit value
conditional also refines its selected arm when the opposite arm cannot produce
the requested truth: a fixed boolean, or the condition's unchanged saved value.
Specialization assumptions intersect these path bounds instead of replacing
them with a wider integer interval, retaining NaN and negative-zero exclusions.
Nested integer loops can then reuse the entry's Number bounds without testing
them again each outer iteration. Arms hull at their join,
and a loop head is the hull of its entry
and its back edges, widened where a bound still moves after two walks and
narrowed again by the loop's own tests. Only a local on a cycle of writes (a
counter, a running sum, a pair that feed each other) widens: every other
bound is a hull of theirs and settles once they do, so a flag written 0 and 1
stays [0, 1]. A typed array the function makes (`__alloc_hdr_n`, zeroed) and
reads and writes through its locals alone, boxed or unboxed, holds what the
function stores into it, so an integer element read from one is bounded by
those stores (a stack of triangle indices, a hash table of counters); an
array a local of which is read anywhere but an address, a header, a fill, a
copy, a box, an unbox or a compare of its box escapes, and its elements are
any word. The elements are part of the fixpoint, and one whose hull grows
for more than three rounds is any word. A number the intervals know is truthy
where it is not zero, and the test a copy makes of a number it assumes an
integer is decided where the intervals already know it (`int-narrow.js`);
an element read that may miss is truthy where it is a number other than zero,
inline, since a box is a NaN (`emit/dispatch.js` kindTruthyIR). The function is walked whole each
time, each loop from the head it had, so the walks are as many as the heads
take to settle whatever the nesting. An f64 element read is a number only
where its node says so (`presentNumRead`, `numberRead`): a read that may miss
yields the undefined box, and `x == null` of it must not fold. The tests of a
value's kind read the same intervals: a value that equals itself is a number,
one that equals its truncation is an integer the truncation holds
(`readBack`), and the i64 that holds a number's bits (`of`) is no box under
any tag test, no string key, no missing value and no object, so
`__is_str_key` of it answers 0 and `__eq_strict` of two of them is `f64.eq`.
A conditional whose test the intervals decide is the arm it takes, after what
the test does on its way. A local narrows when every write that reaches a
read is such an integer and it removes more conversions than its reads in f64
code add, weighted by loop depth; a value that may be -0 narrows only where
every read is an integer consumer's. A test the intervals decide folds to its
answer, and `i32.and`/`i32.or` fold only over operands that are 0 or 1: the
same operators combine flag words.
An addition whose other operand cannot be -0 may also read a bounded integer
subexpression through i32: that sum erases the subexpression's zero sign.
The existing interval facts supply this proof, and the rewrite must remove
more conversions than it adds. A bare product, an unknown other operand, or
an out-of-i32 product keeps its floating semantics.

A loop is compiled twice where its values decide its types
(`optimize/specialize.js`, the `specializeLoops` pass, off in the `size`
preset): a copy for reads that hit and integers that are integers, and the loop
as written for everything else. A typed read that may miss leaves the copy
where it would miss, for the loop as written, which goes on from the first
statement of the stretch the read is in: a run of statements that writes no
memory and calls nothing, which every way to the read passes. What the round
stored before that statement is stored once. The loop as written takes a way
in at each such statement (a `br_table` at its top, and at the top of each
block on the way; a conditional on the way takes its arm without its test),
the locals the copy keeps in its own give their values back to the ones that
statement finds live (backward liveness, per statement), and a local the
stretch read and then wrote is put back from a copy taken where the stretch
starts. A conditional that tests the kind of a value and calls the runtime in
the arm a number does not take (`__dyn_get`, `__add_slow`, `__to_num`) leaves
the same way in place of that arm. An f64 local the copy reads as an integer
is tested on entry (it equals its own truncation and its magnitude is within
2^51), except one whose low word is taken as an address: that is a box. The
copy's locals are its own (`$name.f<id>`), so the integer pass types them by
the copy's values alone. An outward branch restores every written copy:
fallthrough liveness cannot describe a destination that skips an enclosing
copy's write-back. The copies made where a read leaves run once and
weigh nothing in that choice (`cold`), beyond the sign of a zero they would
show. A copy that narrows nothing is dropped (one that tests no read has to
narrow more to stay), the checked twin of a versioned loop is never copied
(the emitter marks that arm `checkedTwin`, `compile/emit/control-flow.js`: a
copy that holds a versioned loop leaves where its extents fail, and the twin
stays in the loop as written alone; that leave weighs nothing, since the arm
the extents choose runs as fast in the loop as written, so a versioned loop
alone buys no copy), the runtime's own functions are left as
they are written, and a function grows by at most twice its size. Loops
rewind by the label as written, so a copy rewinds with its original
(`optimize/loop-rewind.js`).

The guards of a copy are combined once the integers are in place
(`optimize/guards.js`, the `combineGuards` pass). Each index is read as a sum
`c + a·counter + Σ k·term`, a term being a local or an expression that only
computes, named by the writes its locals hold (the last write that runs
before the read on every way to it); a temp the emitter tees an index into is
the sum it stores, and a test that goes, or is rewritten, keeps the temp's
assignment: the reads after it depend on it. An index the loop leaves alone, and one the loop's counter
makes (one step at the end of every round, one test at the top, or one of
the tests the top leaves by: `flag && j < n` in the short-circuit form the
emitter writes bounds `j` on every round that runs), is tested ahead of the
loop for the first and the last round, in i64,
and the loop as written runs where a test fails. Reads of one array whose
indices differ by constants are tested by the first of them, for the least
and the greatest, where that guard runs whenever the others do and leaves to
the same statement. A test that fails ahead of its read leaves earlier than
the read would; the loop as written decides the read. A read the program
itself keeps within its array stays tested where it stands: one that a
conditional it is an arm of, or a branch it comes after, shields by bounding
a local its index is made of (`i > 0 ? a[i - 1] : 0`, a stencil's border), whose
guard ahead of that test would leave on a round that reads nothing. A test
bounds a local by ordering it, or equating it with a constant (`!x` included);
one that equates two locals, or tests an element it reads, bounds nothing:
what it reads through a select, a block or a conditional is what they compute,
not the tests and the sets on the way to it.

LICM reads a view's descriptor words as it reads a header's: `fn.viewNames`
(stamped in `compile/emit-func.js`, carried to a promoted global's local by
`optimize/globals.js`) names the locals that hold a typed view, whose length
and data words no store in the loop can change. A typed array binding
assigned more than once stays a box; its length is read through the low word
of the box and leaves a loop like a pointer's, where the binding always holds
an array (`fn.presentTyped`: the header of a binding that may hold none is
read where the loop reads it, so a loop that runs no round reads nothing).
The same presence proof admits the canonical mixed owned/view descriptor
selects. Every base and view-bit operand must come from that same unchanged
binding. LICM moves the complete data select: its owned arm eagerly reads
address zero but discards that value, so moving the load by itself would be
unsound. Empty arrays still have valid descriptors; possibly absent receivers,
mixed selectors and bindings changed in the loop retain their loads.
`test/licm-typed-views.js` pins those cases, including mutations through calls,
zero-trip loops and descriptor reads that must still trap when executed.
`a.subarray(lo, hi).sort()` whose result nobody reads sorts the range in place
and allocates no view (`module/typedarray.js`). A call spliced at its site
binds to a temporary only the parameters its body writes and the arguments
that are not simple: a body that rounds `x`, `y` and `z` in place still reads
`target` and `offset` as the names they were passed (`compile/plan/inline.js`),
where no argument of the call and no statement of the body writes them.

Numeric syntax has one evaluator in `static.js`. Module planning, local and
capture facts, integer proofs and template folding share it; callers retain
binding eligibility and storage limits. Module constants settle in `plan/scope.js`
before representation planning, with only unresolved declarations revisited.
The semantic summary is a snapshot stored on `ctx.summary`; it does not own the
mutable emission state beside it. Source rewrites require a fresh summary.

Closure calls capture the callee before argument effects and validate callability
after those effects. Generic, spread and member-slot calls share the same ABI
lowering in `module/function.js`; proven callable values omit the runtime check.

Fixed plain-array lengths flow from the existing builder analysis into local
and parameter ValueReps, then FunctionPlan owns them during emission. Spread,
conflicting growth, resizing, and escaping uses invalidate the proof. Equal
push counts across branches preserve it. Cold argument-free array builders stay callable
through inference; shared Watr inlining can remove their frame after lowering.
Cross-function FunctionPlan queries expose only the scalar facts and schema-ID
arrays their callers need. Scalars pass through; arrays are copied. There is no
recursive projection of arbitrary representation objects.
The summary knows an array's length where it cannot change (`lens`): every
array of a cell is a literal of one count, nothing resizes or deletes from any
of them, no store names an index the count does not hold (a counted loop bounds
its counter, a const its name) and no holder is out of sight. Such a read is
the cell's own load off the raw base, never absent inside the count; a
literal-index store inside it is the cell's own store, behind the reset's
snapshot of a durable array. A module const grown only by counted top-level
pushes through its own name is frozen after init (`frozenLenOf`): its binding
holds the final pointer, so reads through it follow no forward. An element
read whose index the walk finds inside a fixed length is present by node
(`presentReads`), and a never-nullish expression of one layout reads its slot
directly. A bare `let` assigned before every read declares empty, not absent
(`summary/definite.js`). The module's own bare declarations take the same
proof over its statements: a function runs where a statement names it or,
called by the host, after they end, so a name a function reads is assigned on
every path to the end (`var HIGH; if (le) HIGH = 1; else HIGH = 0` holds a
number, and so does the slot `{ HIGH: HIGH }` copies it into). A module
binding a read can find unassigned or nullish, where some read observes that
(a presence test, a copy into another binding), keeps the f64 carrier: the
integer-global inference (`inferModuleIntGlobals`) leaves it, since an i32
reads 0 where the program reads `undefined`. The block emitter holds a name a checked read or
store dereferenced present for the rest of its block. `why` reports the first
cause an array built at a fixed count keeps its checks by (`array-open`).
The summary also keeps the hull of the arguments each parameter receives over
every call the walk binds (`paramRangesOf`: a counter's span, arithmetic on
it, a const's captured initializer interval, a caller's own hull through a
chain of calls). A parameter assigned anywhere, including by a closure, cannot
supply its incoming hull to another call. Every channel that binds a
function's parameters notes its arguments (`bind`): a call through a table or
a function's property joins the hull like a direct call, one that cannot align
them (`.call`, `.apply`, a callback) opens the position, a function the host
or a dispatcher may call has no hull, and a recursion that keeps widening a
position opens it. The emitter starts a parameter's flow interval from it, so
a ToInt32 of `floor(y) + gy` inside a sampler needs no infinity guard. A typed
element read inside the array's count is a number, never undefined
(`typedReadPresent`): the index's span within a count the walk knows (an
allocation of one bounded length, a name of one definition, a helper whose
every return is such an array, a view of the whole buffer of such an array:
`new Uint32Array(f64.buffer)`), a mask, or a counter the loop bounds by the
array's own length (`i < x.length`). An integer a name holds for good is known
from the first round (`ints`): its one definition's value, through the names
it copies and the fields of a literal nothing stores to (`heldLiteral`: every
mention reads a field by name or declares an alias read the same way), since
the functions of a round walk ahead of the module's statements and an absent
joined in the first round is never lost. A callee taking such a read takes a
number, with no per-use conversion, and the emitter takes the verdict as an
index proof of its own (`presentTypedRead`, `typedIdxProven` class 8): the
read loads with no bounds test and no miss arm. Any number a name holds for
good (`held`, the same definitions) is what a module name's reads fold to
(`foldModuleConstants`): `HIGH = idx.HIGH` indexes by a constant. The global
stays with the statement that assigns it, and an exported name keeps its read,
since the host can store to it (`test/held-number.js`). preEval decides a test that
reads a module constant (`const DEBUG = false`, a `var` written once) and
drops the dead arm; only the test reads the constant, a reference in the code
that stays keeps its name. A loop that writes no array header
(element stores only, calls to functions the module-wide census finds header
safe, `collectHeaderSafeFuncs`) reads a present array's forwarding word and
length once before the loop (`presentArrays`, optimize/licm.js); a durable
array such a loop stores into is saved for the reset ahead of it. An element
receiver whose one missing value is absence throws from its own bounds test;
an unbounded index stores in place when inside the length and asks the helper
past it; a strict equality of two numbers-or-missing compares inline; and
`const g = f` of a function the module holds, a name or a member of an
imported namespace, reads as `f` (a call through it is direct, an export of it
re-exports the function).
Record scalar replacement uses one validator for field access, nonescape and
whole-record replacement. Replacement values evaluate before any field changes;
stable local aliases share the same fields only when their source cannot be
rebound. A result copied through locals whose only readers compare with null or
undefined needs presence alone; a scalarized record supplies a non-nullish marker.
Other definitions retain their exact values, so null and undefined stay distinct.
Captures, differing field sets and observed record identities keep storage.

Strings store UTF-16LE code units; lengths and positions count units, while
allocation sizes and addresses count bytes. Short ASCII strings retain the
six-unit SSO representation. UTF-8 encoding belongs to byte APIs and Wasm text
metadata; host string marshalling preserves lone surrogates. Schema property
names use JSON escaping inside UTF-8 metadata to preserve every code unit.
Heap-string equality compares four code units per load with a code-unit tail;
substring views never require loads beyond their logical length.

Static data uses owned `Uint8Array` chunks (`src/static-data.js`). Producers write
bytes directly; relocation adjusts those bytes, and only WAT escaping converts
them to text. Keep `__static_str` outlined until late dead-data removal: the helper
call retains the ownership edge for sentinel strings. Inlining it earlier leaves
raw addresses that the helper-based liveness check cannot recognize. Never use `String.fromCharCode` as a binary serialization layer.
Substring interning shares one UTF-16 address calculation between copied slices
and views. Short ASCII slices return directly as SSO; the remaining copy path
always has a memory-backed source and copies whole code units.

Decimal parsing and shortest float formatting share the power-of-five generator
and its 828-byte seed table. A 245-byte correction stream restores all 651 exact
128-bit powers of ten needed by parsing. The generator returns two i64 lanes;
formatting reuses them directly instead of storing and reloading scratch memory.
No initialization state or second full power table is needed.
The shared unsigned 64×128 product supplies all three rounding limbs. Decimal
inputs whose significand and power of ten are exact f64 operands use one
multiply or divide; the full integer algorithm handles the remaining range.
An integer below 2^53 renders as its digits before the shortest search starts
(`__ftoa_shortest`): a counter, an index or a key made of numbers (stdlib's `memoize`
joins its arguments) formats in a digit loop, the boundary and beyond as before.

Function-local layouts belong in `localReps`, carried by the function plan.
Do not publish inferred local or parameter schemas in `ctx.schema.vars`:
specialized variants reuse source binding names but can require different layouts.

Parameter initialization is owned by `jzify/arguments.js`. Ordinary functions
prepend its initializers to the body; generator factories run the same list
before creating the suspended machine. Iterator array parameters use lazy pulls
and close on early completion. Keep parameter effects outside the state machine.
All binding patterns use the same private iterator records. A close releases
its record once, after any user `return()` call; nested and reentrant patterns
therefore retain independent cursors. Recycled records clear user references.
The pool is lazy because module initializers can use binding helpers before
stdlib initialization. Its array uses ordinary arena snapshot/restore; linking
through record fields would leave stale links after a reset. The records
stay in the pool, each marked while it is open: opening and closing one
stores no pointer, so a call that destructures keeps nothing, and the frame
census counts no store into a record for an escape (`SCRATCH`): the iterator
it holds is lent from its opening to its close.
Map and Set constructors stream custom iterators through these records, closing
after entry errors before another step. Native inputs keep their copy path unless
an own iterator overrides it. Generator records expose their self-returning iterator
method; a plain next-only object is not an iterable. Iterator/result objects may
also be callable, as required by the ordinary object protocol.

An object rest `{a, ...r} = o` is the spread of `o` without the keys the
pattern names (`expandDestruct`, `src/prepare/handlers.js`): the spread item
carries them (`spreadExclusions`, `src/ast.js`), a computed one as the temp
holding its property key, and every reader of a literal's spreads (the
summary, the emitter, the layout census) skips them. A source whose layout
the summary proves copies its slots; any other copies its own keys at run
time. A pattern that begins with a rest, a computed key or nothing tests its
source for null and undefined first; a named key's read throws by itself.

An async body suspends only at statements (`jzify/generators.js`: a yield as a
statement, or the right side of `let x = yield E` / `x = yield E` /
`x.f = yield E`), so `jzify/async.js` hoists every other `await` first: the
awaited value lands in a temp declared before the statement; what the
statement evaluates before that await lands in temps ahead of it, a callee and
an assignment target staying in place; a short-circuit or conditional whose
later arm awaits becomes an if statement assigning a temp; a loop whose test
awaits tests at the top of `while (true)`. An await suspends the machine as a
yield does, and the value it resumes with is `__awaited(a, v)`, `a` holding
the operand: the summary types it as the operand's settled value, the operand
itself when it is no thenable, the value an async call's promise fulfills with
(the promise is named at its `__async_run` call node, as the iterator runtime's
records are, beside what the machine completes with, a promise or thenable it
completes with adopted), anything for a promise made another way. The
machine's locals are declared ahead of the steps that initialize them behind
the TDZ mark (`src/ast.js`), a declaration that defines no value; a bare
`let x` in the body defines its undefined where it stands. An async function
passes its arguments straight to its machine, `(a, b) =>
__async_run(M(a, b))`, all of them packed only when it reads `arguments`. A
closure made inside an async function or a generator reads the kinds the same
closure made inside a plain function does (`test/async-factory.js`).
Class lowering (`jzify/classes.js`) takes `static async` methods on both of
its paths and a bare `super()`, and the
member census counts an optional method call (`o.m?.()`) as a read, since the
call binds the method as a value first (`src/compile/emit/class-dispatch.js`).
A derived constructor's statements before `super(…)` run before the base's
initializer and may compute the call's arguments (`splitCtorSuper`); the
derived class's field initializers follow the call, then the rest of the body.
The schema lowering (a class as a layout with a brand and functions of the
receiver) takes a base class of another module: prepare brings a module's
imports in ahead of its lowering (`prepareImports`, in the order ES evaluates
them), so `class D extends B` resolves `B` through the import map to a class
lowered before. Async and generator methods hoist as functions of their kind;
a class stays closures only inside a function, under a base the module cannot
see (`Error`, an expression) or as an expression with statics, and the
`class-generic` advisory names which. `'m' in o` holds for a member of the
instance's class as it would through a prototype (`classMemberIn`); a static
call `C.s(…)` reaches the lifted function `C$s` in the summary as in the
emitter (`liftedProp`, method-dispatch.js `tryFnPropCall`).
The supported empty class-prototype reflection uses the ordinary getter registry,
with the settled closure kind rather than its storage hint. Accessor probes and
optional reads retain captured receiver facts in a scoped alias, preserving receiver
evaluation. Static string keys retain their identity across a nullish receiver check.

A bundled module's statements run at start-up, before its importers', in the
order ES evaluates them (`ctx.module.moduleInits`). `import('x')` of a
literal hoists a namespace import of `x` (jzify `hoistDynamicImports`):
awaited at module level it is a static import; anywhere else the call is
`Promise.resolve().then(() => ns)` and the import is lazy. Once every module
is prepared (`src/prepare/module-eval.js`), a module no static import
reaches from the entry moves its statements into a loader that runs once,
after the loaders of the lazy modules it imports, and keeps an evaluation
error for every later import; a declaration of one of its globals becomes
the assignment it makes. A namespace read as a value is one object per
module, keys in code-unit order, a getter for a binding a function assigns.
The loader's bindings are spelled without `T`: a `T`-named declaration in a
module initializer is a temp of the start function.

A member is a function of its own: `arguments` in a method, an accessor or
a constructor is the member's (`ownArguments`, lowered as a function's before
the arrow), and a default parameter may read `this` (`rewrite(mparams)` on
the schema path, `bodyDefaults` for an object literal's method, whose
receiver is bound in the body). The factory takes the initializer's defaults
(one reading the receiver stays the initializer's alone), so `new C()` and
`new this.constructor()` pass the default's value for an argument left out,
never an undefined the initializer's default would replace in a kind that
keeps it: a `Vector3` built without arguments holds numbers, a `Box3` holds
its vectors. A store under an accessor's name on a receiver the summary
types as instances of a class without the accessor is the field's slot
store (class-dispatch.js `lacksSlot`). A field stored under a method's name
(`this._onChangeCallback = cb` beside `_onChangeCallback() {}`) is the own
property that shadows the method: the summary marks the name
(`dynamicProps`), and the emitter's dispatch reads the field's slot in place
before calling the member (class-dispatch.js `ownSlot`). A store to
`C.prototype.p` in a static block of `C` or among the statements of the scope
declaring it, and `Object.assign(C.prototype, {…})`, name members of the class
(`foldPrototypeStores`): a function is a method, a literal stored as the
class is defined is a getter's result, any other value lives in a binding
the getter reads; a store the fold cannot take is rejected. In a program that
reads a `constructor` member (`new this.constructor(…)`, `a.constructor === C`)
every class carries one: called, its factory; read, the class itself (a
wrapper of a rest parameter where the factory has more parameters than a
closure carries). A typed-array constructor named as a value
(`{ Float32Array }`, `switch (a.constructor)`) is the function `jz:typed`
makes of it, and `E.constructor` on a value that is not `this` asks its
`__ctor`, which answers a typed array's function or reads the member.

The summary walks what the program reaches: a function or closure is walked
once a call binds its parameters, the host holds it (an export, an escaped
or host-held callable), emitted code calls it (a class dispatcher) or a
module initializer runs it, and the rest keep no kind. An API surface the program never exercises cannot hand what it
computes (a host import's result, say) to the allocations the exercised
surface shares. A rule that reads a member of no kind yet (a round before
its binder ran) contributes nothing rather than taking the absence as a
fact; only the nullish kinds mean absent.

The summary (`src/summary`) models, beyond the forms the tests pin: `fn.call`
and `fn.apply` as calls of the closure (a closure cannot observe `this`); an
optional call `?.()` as undefined on a nullish callee and nothing on one of no
kind yet; a call through a nullish slot as a throw; a top-level arrow binding
as its function until reassigned, and a function named as a property receiver
by its identity; `Object.defineProperty(o, k, d)` as the store `o[k] = d.value`
it lowers to; an inlined array callback's element parameter as the array's
element (`callbackElem`: the parameter is aliased to a read of the array);
a class member on an unknown receiver as called with the family of classes
whose member of that name is that function (`familyOf`), and a member call
on a jz object of lost shape as the join of those members' results and of
the closures the shapes hold under the name; a member call through a shape
beside primitives (`merge`'s mixed cell) or through a value of unknown or
several kinds as a call of the closure the shapes hold under the name, the
unknown one's result unknown (an async factory's object sits in every
promise's value slot beside what the other promises settle with, and its
methods run through that join: left uncalled, their writes to captured and
module bindings went unseen), and a read through such a value hands those
closures where the summary cannot follow them; `includes`, `indexOf` and
`lastIndexOf` keep nothing of their argument, `slice` yields a copy with a
cell of its own whose elements are the row's positions from a literal start,
and any other name on an array is a property beside the elements; shape sets
of up to 64 layouts. A layout with more construction sites folds to its layout
in every union, including unions formed before the fold. New shape unions collect
canonical members in one private array before sorting; folding rebuilds that array
without changing retained member lists or allocating intermediate Sets and maps.
Closure and shape member lists are interned by a numeric hash bucket followed by
exact member comparison, with a dense collision chain. A hash never establishes
identity; named singleton functions retain their string-key lookup. This avoids
serializing each candidate list merely to find its existing identity.
A spread of sources whose layouts the summary knows makes
a layout no literal may name: the summary lists it (`unnamedLayouts`), and
the compile names it and summarizes again until a spread of such a literal
makes none new, before the plan decides anything from the summary, so the
plan and the emitter read the literal's fields in the layout `emitObjectSpread`
builds. A class
initializer (`C⟨init⟩`) called on one layout is walked for that layout under
bindings of its own (initializer contexts): a derived class's `super(…)` no
longer joins its arguments into the base's parameters, so each layout's
slots hold what its own construction stores; the base keys keep the quiet
join for the emitter of the one function, and a closure capturing an
initializer's binding returns that initializer to the join. A lost shape
escapes only the fields a read through an unknown receiver cannot answer
precisely (a foreign object, a class member or a dynamic store bears the
name); the others keep their values, since a store through such a read
reaches the summary. A raise folds in a value the join's own effects moved
(a lost element escaping its array) rather than writing over it. The emitter
calls a member directly when every layout of the receiver resolves it to one
function, and reads a field every member layout holds in one slot as that
slot (`commonSlot`), so a method inherited by a class family runs on prefix
layouts without a guard. A call of a name no slot holds runs the closure the
summary holds beside the fields (`ns.inner.parse = f` on a literal that
declared no `parse`): its body is reached and its parameters bound, as for a
slot. An accessor is a function of its class (a derived
class's too: its instances carry their own schema), a slot of an object
literal's schema, or a static pair on the class value (the
`dynamicAccessorNames`); an unknown receiver dispatches on its schema id and
probes for the slot only where a literal's schema or a static pair may carry
it (`slotAccessorRead`, `accessorStore`), so a dispatcher's fallback reads
plainly in a program without them, and a receiver the summary types skips
the probe unless a side property of that slot may be present
(`accessorHolders`). An object literal's accessor is the one own property it
defines wherever a property is listed, copied or keyed: the layout's
enumeration view (`layoutView`, `src/ast.js`) names it at its first
definition, index keys first, and reads it through its getter (undefined for a
setter alone). The static paths read the view off the layout; at runtime
`__schema_view[sid]` holds the view's keys and a map of each key's slot, kind
and setter slot, read by the enumeration walker (`walkObjectProperties`),
JSON's object walker, the computed-key kernels after a miss in the layout's own
slots (`__view_find`, `__view_get`, `__view_set`, `__view_del`) and the data
copy a spread or a clone makes (`__view_data`), which the module exports: the
host decodes such an object through it (`jz:views` lists the layouts). After a
`delete` of an accessor, a read or store of its name through a binding takes
the dynamic path. A property stored outside a layout (through an alias, a
destructuring target, a helper's parameter) lives in the object's
dictionary: its header's, or for a durable or static object the one
`__dyn_props` keys by its offset. The module exports both lookups
(`__obj_props`, beside `__dyn_set`) and the deleted-slot mask
(`__obj_deleted`, beside `__dyn_del`), and the host decodes an object as
enumeration does: the layout's slots less the deleted ones, then the
dictionaries, a later value replacing an earlier one in place. The copy
`__view_data` makes reads the same dictionaries. A slot the layout
marks hidden (`ctx.schema.hidden`: an Error's `message` and `name`, a
closure-lowered class's members, named by the brand on its instance literal)
drops out of the view but keeps its slot, so reads, stores and calls go
straight to it and `in` still finds it (`ownKeys`). The table and every
runtime path that reads it exist only when code the program lowers builds
such a literal (`viewsOn`, settled after the plan); the enumeration walkers,
JSON's walker and the copies also read it for a hidden layout
(`enumViewsOn`), and the accessor kernels do not. A host reference
(`PTR.EXTERNAL`) is listed and serialized by the host (`__ext_enum`,
`__ext_json`), imported only when a host object can reach the module
(`demandHostReceiver`). A getter or setter runs user code at a member read or store, a
computed key, a spread and the builtins that list values: the frame census
counts each as a call, and load CSE keeps a body's loads across one
(`runsAccessor`, `src/compile/analyze/frame-effects.js`). Getters and setters run through one prepared
function (`src/compile/emit/accessor-call.js`), a value's `toJSON` through
another (`src/compile/emit/to-json.js`, only in a program that names JSON), an
own property shadowing its class's method. `why: true` and any
`warnings` sink report `shape-lost` with the first cause a layout was lost by;
the census is the first thing to read when a library compiles dynamic.

A method shorthand parses as a function: `m(p) { body }` is
`[':', 'm', ['function', null, p, body]]`, `*g()` the same with `function*`,
`async` wrapping either, `static get v()` as `['static', ['get', …]]`
(subscript `feature/accessor.js`, `feature/class.js`). The shape is the
semantics: a function body is statement-shaped (`{ m() { f() } }` returns
undefined) and its `this` is the receiver, where an arrow-valued property
`m: () => f()` returns f's value and keeps its lexical `this`. `memberFn` in
`classes.js` is the one recognizer of a member's function value (a
`m: function () {}` property is a method the same way); every lowering path
(class, struct, statics, the object-literal `this` wrapper, the prototype
fold) builds its arrow from it through `methodValue`. Nothing downstream may
read a member's shape from its body: the parser used to spell methods as
arrows, and a one-statement body that was not a `return` or a control
statement was taken for the arrow (`{ m() { this.x = 5 } }` failed, an
`async m() { return 2 }` resolved a NaN-box leak). Strict mode rejects a
method shorthand as it rejects `function` (the arrow property is the
canonical spelling). Parameter defaults are transformed with the function
(`transformParams`): a lowered form in a default value is lowered there too.

Well-known symbol keys use a shared name lookup in the entry walk. Ordinary
computed reads allocate no key list or pairs, and the walk has no captured
per-node callback. Lexical shadows still bypass canonicalization; names absent
from the lookup, including object-prototype names, keep their computed access.

Strict mode's spelling rules (`==`, `!=`, `void` are prohibited) apply to
the program, never to the `jz:` runtime modules the program's lowerings pull
in (`ctx.module.inStd`, `src/prepare/handlers.js`): an array pattern in
strict mode lowers through the iterator modules, whose source spells
`== null`.
A class function returning BOOL yields the raw 0/1 only to a reader whose own
`valTypeOf` proves the call BOOL (a receiver of one named class); a dispatcher
returns into a tagged f64 slot, so it boxes its class arms' BOOL results like
its fallback arm's generic call, and a direct call through a receiver the
readers cannot type (an optional chain's temp) carries the atom too.

A binding that holds a Boolean beside another kind (`let v; if (k) v = true;
else v = 1`, `let x = c && 1`) and some read of which may observe its
identity (a return, a `typeof`, a strict compare, a string, a store: the
summary's numeric demand pass did not prove every read a conversion) is a
tagged carrier (`boolTagged`, `src/kind/val-type-of.js`): every Boolean store
lands as its atom (`boolCarrier`, `src/compile/emit/dispatch.js`: a
declaration, an assignment, a logical assignment, a parameter default), a
merge keeps its Boolean arm boxed (`emitIdentitySafe`, a merge nested in a
merge of open kind included), its storage is the tagged f64
(`analyze/body-facts.js` Pass E), a store that may be a Boolean records no
flow fact (a store of an array or a number still does), and a numeric read
converts the atoms (`toNumF64`, as for a slot or a result of such a kind; a
slot holding a Boolean beside a number is no integer to the slot census).
The summary's kind decides where it names its tags; where it is the unknown
kind, the binding is tagged when a Boolean reaches it (`boolStores`: a
store, a definition or an argument of a kind naming BOOL, or one Boolean by
its syntax), and in a body no walk reached, which keeps no kind, when its
stores are a Boolean and another value by their syntax. A parameter holds
its callers' atoms whatever its reads (`coerceArg` boxes a Boolean for an
untyped parameter), and calls passing a comparison beside an integer leave it
the tagged f64 unless every read converts (`narrow/param-abi.js` narrows no
other one to i32). A binding every read of which converts keeps the raw
carrier and holds numbers: a store of a value that may carry an atom (a
field, an element, a result) lands as its ToNumber. No such binding rejects;
`test/bool-number.js` pins each operation in each place. An integer-certain
binding counts the writes a nested closure makes to it, and a reassigned
parameter its caller's value (`intLevelMap` seeds the analyzed body's own
parameters, the slot census's included). A Boolean answers its own
`toString` ("true", not "1": `.boolean:toString` for a Boolean receiver, an
atom arm in the runtime method dispatch).

A typed array's `fill` captures all arguments, then converts its value once
before its positions, even for an empty range. Numeric arrays use ToNumber;
BigInt arrays use ToBigInt, which rejects Numbers. A proved present BigInt
keeps its raw payload. The first element passes through the element writer;
`memory.copy` doubles the filled run (`__typed_fill`), log2(n) copies for n
elements. `with` converts its index and replacement before checking the index
and copying, preserving mutations made by conversion hooks. Search arguments
also evaluate before conversion, but an empty search never coerces fromIndex.
Captured values cannot use the original local's live numeric shadow: only a
direct read of that local may use its shadow.
Indexed BigInt stores share that ToBigInt conversion for every value not proved
BigInt, including unknown call results. Both known and dynamic receivers convert
before the bounds guard, preserve the original assignment value, and allow source
handlers to catch conversion errors. Only a proved BigInt uses a raw i64 carrier;
the generic writer receives tagged values even when its domain proves BigInt.

Every array position argument (fill, copyWithin, slice, splice, with, the
search methods' fromIndex) is captured and coerced through `positionArgs`
(`src/bridge.js`): ToIntegerOrInfinity converts a string, reads a Boolean as
0/1, takes the default for undefined, saturates ±Infinity and throws a
TypeError for a BigInt, after the receiver and earlier arguments are
evaluated. Typed set offsets share this path. `splice(...args)` reads start,
count and inserts from the argument array at run time. A typed array constructor's argument is ToIndex for a
primitive (the full ToNumber where the program links it, the atoms in place
otherwise, a BigInt a TypeError), a copy or view for an array, typed array
or buffer, an iteration for a Set or Map and `Array.from` for another object
of a known kind; an argument of unknown kind dispatches at run time without
the array-like arm, whose dynamic reads would cost a numeric kernel its size.
The dynamic method dispatch (`src/compile/emit/method-dispatch.js`) gives
`f.call(thisArg, …)` and `f.apply(thisArg, args)` on a closure value a closure
leg. Object methods use an explicit trailing receiver slot in the uniform
closure ABI; programs without receiver reads omit it, while explicit receiver
arguments still evaluate for their effects. Detached calls pass
undefined. Direct-only closure ABI shrinking preserves every supplied argument
slot, including ignored arguments whose evaluation may mutate or throw. It
rewrites each shared call node once, after collecting all incoming arities.
The receiver is captured before arguments, and generator/async
methods capture it before suspension. Iterator records call cached protocol
methods with their original receiver. The summary joins receivers at calls,
including accessors; source inlining must preserve that call frame. Class
lowering retains its existing bound-method contract. Prepared statement lists
share the block emitter's flow refinements and invalidation; a callable proof
survives a throwing guard in either form. An unshadowed `call` on a proven
closure goes through the closure ABI directly. The module resolver
(`src/resolve.js`) takes `sources`, module text
by path suffix standing in for a file: the Web Audio bench replaces the
worklet host, which loads processor code through `new Function`, with a stub
of the same shape (`bench/_lib/graph.js`).

Frame effects (`src/compile/analyze/frame-effects.js`) are two facts per
function, read off the prepared AST and the summary before emission and
transitive over direct calls: `writesOuter` (the body may write storage that
exists before the call) and `arenaUnsafe` (an allocation made during the call
may outlive the frame: a heap-capable value stored into outer storage, a growth
of an outer container, a captured or module binding assigned a heap value, an
unknown or host callee). Parameter defaults run in the frame before the body:
the census, like every scan of what a function reads, writes, reassigns or
captures, walks `frameRoots(fn)` (`src/function.js`: the defaults, then the
body; `frameNode` as one statement list), and an arrow keeps its defaults in
its parameter list. Mutable parameter cells are seeded before any default runs;
a default closure captures that cell and a default assignment updates it, in
parameter order, just as on the indirect closure entry path. A default runs
only where its argument is missing, so the summary treats its writes as conditional.
Integral loop copies use the same complete capture census: a default-created
closure can change the original binding while a copied loop runs.
Canonical array bounds also inspect resolved callees with their own summary
views: writes to unrelated fields or typed elements preserve array extents.
Defaults are included; array-length writes, accessors, conversions, unknown calls,
recursive cycles and changes to the caller's receiver/counter bindings decline.
String bounds share the binding-preservation proof: an immutable string can
still be replaced through a captured variable between its length test and read.
The boundary-carrier prepass supplies each scanned function's own summary view.
Planning and pre-rewrite analysis request function effects without per-loop
rewind proofs. The final census computes those proofs from the rewritten bodies,
after variants exist; no earlier consumer reads them. `test/frame-effects.js`
compares both modes' function effects and retains the final loop proof.
Private census lookup tables lease the AST scratch pools and release them in
`finally`; published effects own their maps and sets. Nested walks, query errors,
and repeated compilations must not alter previously returned facts.
The transitive graph keeps named functions as string keys and closures as their
numeric summary identities. Spell a closure name only for a diagnostic; building
string keys on every fixpoint edge allocates temporary strings in the hosted compiler.
Snapshot its immutable traversal rows once; only the result facts need a keyed
lookup table. Repeated rounds must not rematerialize Map entry pairs.
A store into a fresh local aggregate, a binding
declared in the body whose every write is a literal or a `new`, is a store into
fresh memory. A nested function's writes count wherever it is made, a
declaration's initializer included. A callback a builtin runs (an array
method's, `Array.from`'s map function) is walked as part of the frame; a
callback name resolves to its arrow only while no nested function rebinds it. In a program that defines
`toString` or `valueOf`, converting a value the summary cannot prove primitive (an operator's
operand, a property key, a builtin's argument, a typed element store) is a call to the
ToPrimitive function it lowers to (`runsConversion`). Accessor definitions contribute
their public property names to that census. Conversion tests presence separately
from reading a method, so an own undefined shadows the inherited method and a
getter runs exactly once in hint order. Schema-class getters follow the same
callability rule, which checks the complete boxed function tag.
The arena rewind (`src/optimize/arena-rewind.js`) restores the
heap pointer at return for any function with one result, parameters
included, outright where nothing its frame may reach lowers the escape flag
and by the flag otherwise (above). A result that may be a heap value (a
pointer kind, a tagged value the summary cannot hold to numbers) is asked as
the frame returns (`asked`, module/core.js `__made`; an address as it is): one
that names memory at or above the frame's mark is of the frame's making and
the caller's to keep, so the frame gives back nothing; a number, or a value
older than the call, lets it restore. The host asks the same of what an export
returns as it decodes it (interop.js `mem.read`): it takes a copy of a string,
an array, an object and a collection, and releases the call then; a typed
array's view and a closure's handle above its mark hold the call's memory.
An export whose result is asked is one the host releases (`jz:release`),
whether or not it copies an argument in.
A function with several results (an array literal returned as its elements)
holds each in a local past its restore and asks each.
Asked results need only the rewind (`arenaRewind`), independently of the walk
(`arenaReach`). Their address test also releases pure scratch frames returning
older values, where no escape flag is demanded. When inner rewind is disabled,
the host can still release a mixed numeric result's copied arguments if the
result is an ordinary number; NaNs and boxed values retain those copies.
A tail call leaves the frame
before its epilogue, so one whose callee never runs the function again
becomes a plain call under the restore, at the price of one frame, and one
that may (a recursion written as tail calls) stays, the function keeping its
heap. Allocation counts through callees. The durable-heap logs
record only mutations of containers made before the reset mark, each a store
the census counts: its site lowers the flag to the durable receiver, so no
frame restores over a logging path. An object's tagged field is logged once
per round (`__durable_obj_snap`) when it first receives a value that names
memory of that round (`__is_eph_bits`). Static writes, computed keys and
`Object.assign` use the same field log. Its record shares the array log and
address bitmap; an odd address marks one field's saved value. Recording only
that field leaves neighboring raw BigInt cells uninterpreted, even when their
bits resemble a pointer. A store may stand at no census site (a runtime
kernel or a borrowed iterator record), so allocating the record lowers the
escape flag to the field itself. Reset restores a logged field only if it
still names the round's memory. Numbers and raw BigInts keep their mutations,
and their stores need no undo record. A direct field store into a function
local whose every initializer is an object literal needs no reset save either:
its receiver was made after the reset mark. The frame census supplies that
fact; parameter aliases, nested writes to the binding, calls that return an
object, and paths through its fields retain the runtime check.
`whyNotRewind` names the reason
for every candidate that keeps its heap. Load CSE (`src/compile/cse-load.js`) keeps a
cached typed-array load across a call whose callee does not `writesOuter`; any other
call or user conversion invalidates after its operands, which run first. A store keeps
a cached load only when it cannot reach the element: storage that never holds typed
elements, or the same element grid (the same binding, or two non-view typed arrays of
one constructor) at a provably different index. A view or another element type over the
same buffer shifts or splits the grid, so an index inequality proves nothing there.
A loop's bound is positive inside its body when the counter its test names starts at
zero or above and its step adds one, the one part of a comma step that writes it
included (`j++, k += step` beside `j < half`: the fft butterfly's `re[a]` survives the
store of `re[a + half]`). A short-circuit or a conditional runs its first operand always:
a load read there is available after the expression and in its later operands, a load
first read in a later operand is that operand's own, and what any operand invalidated
is gone after it. A field of an object is cached like an element (`fieldOf`): the
receiver a binding, the field a slot of every layout the summary lists for it, with no
accessor of the name on any of them, and the first read one its statement makes
before it applies any operation (`let y = c.b[c.p]` reads `c.b` and `c.p` first),
so the cache is a `const` declared before that statement, in the order of the reads
(an assignment inside an expression the emitter folds would be lost with it). A store of a field of that name through any
receiver ends it unless the summary proves their construction sites disjoint;
equal layouts alone prove nothing. Host-visible or opaque identities decline the
proof, and folding a layout removes its per-site distinction.
A computed-key store into a receiver that may be an object ends every field it
may reach, and a call that may write outer
storage, a user conversion or a reassignment of the receiver flushes as for elements;
an element store into an array or a typed array leaves fields alone, whatever
expression names the array (`c.b[c.p] = v`). Conditional
arms inherit their test's cached field and plain-array reads; the join retains only reads surviving
both arms, including when source inlining lowered returns to result assignments.
Typed-element loads retain their existing control boundaries so checked-load conversions
do not hide conditional reductions from the vectorizer.
A function whose fresh allocation is stored into module state used to rewind
and hand out a dangling pointer; the census is what makes the rewind sound.
The same census runs per loop with the loop body as its scope: an iteration
that lets no allocation escape and itself builds a value (a literal, a `new`,
a concatenation, a fresh-value method) restores the heap pointer at its start
(`optimize/loop-rewind.js`, placed after the lane vectorizer so loop shapes
stay matchable; the link pass validates the marker locals `$lrw<N>` against
the loop's own tape and callees, not the function's, so a dispatch through a
table before the loop leaves it, and strips the rest, reporting `loop: …`
with the tape's reason through `whyNotRewind`), so a loop building a
temporary per row runs in constant memory. The property caches a rewind
leaves valid lower no flag: the inline caches key on the schema id in a
pointer's high word, and the dynamic-get cache is kept coherent by every
writer of the table it mirrors, whose store keeps every frame; the for-in
key cache holds an array a rewind may free, and its write keeps them too. Truly shared memory (`sharedMemory`) rewinds
nothing: one thread's restore would discard every other thread's allocations.

Record parameters become lanes (`src/compile/plan/lanes.js`, a plan sweep
before the object scalarizer). A same-module function that reads a parameter
only as `p.k` with literal keys, outside nested functions and without writing
a field or using `p` whole, gets a sibling `f$lanes` with one f64 parameter per
key read; every direct call site hands the fields over. A site that spelled
the record as a literal never allocates it: the values go straight into the
lanes, in parameter order, so a literal whose values have effects qualifies
only when it lists the read keys in that order, and an unread key stays only
when its value is effect-free. A site passing a name the summary proves an
object of one shape reads the fields at the call, beside effect-free
arguments, and only when the callee writes no outer storage (the frame census
above), or the copies could go stale while it runs. One opaque site keeps the
record form at every site; with all sites retargeted the original is dead.
`optimize: { laneRecords: false }` keeps every record form (the summary tests
pin the source's own functions), as `optimize: { valKindClones: false }` keeps
a function whose parameter's call sites disagree on its kind one function
(narrow/specialize.js `specializeValKindDichotomy` otherwise clones it per
kind and routes each site to its own).

Generic reads in the self-compiled kernel cost helper entries, and the warm
self-compile gate is paid in them. Five rules keep the common shapes inline:
a typed array that may be unset indexes through its payload kind after the
nullish check (a store through it as well: `plannedTypedPayloadInfo` answers
the payload's constructor, and the store rejects the missing receiver after
its key and value are evaluated; a BigInt element keeps the runtime writer,
which boxes the value the assignment yields), and a key the summary cannot type still indexes directly once
a runtime test proves it an integer the i32 index holds exactly (a typed
array answers a number key from its elements alone; a property name, an
undefined key or a huge integer keeps the dynamic get); an optional chain's
guarded temp carries its head's present kind through the summary view's
`alias`, so `map?.get(k)` probes the Map and `rep?.slot` loads the slot, and
the guarded arm carries a BOOL continuation (`set?.has(k)`) as its atom,
typed while the alias holds, since it joins the undefined arm; a
receiver that may be an array reads its element inline (tag, one forwarding
hop, bounds, load) and calls the helper only for anything else, a number key
on a receiver the summary cannot type included (`node[0]` under a walker); a
known array, Set, Map or dictionary takes its data offset with that one hop
inline (`fwdOffsetIR`), the chase past it outlined; a nullish test of any
expression is two bit compares on one i64 temp; strict equality of two
untyped operands settles inline where bits can (equal bits are equal
values, a NaN's own excepted; two packed strings with different bits are
different strings) and calls the helper for the rest; a boxed boolean is a
`select` of the two atoms, which truthiness and unboxing read back as the
condition; the runtime templates test nullish receivers with two bit
compares, the tagged typed read masks the tag and the BigInt flag off the
box, the Map key hash mixes a number key in place, and the string hash
reads a heap string's length in place. Every lane vectorizer recognizer
(`src/optimize/vectorize`) classifies a written local through one function
(`laneAccess`, `addr-model.js`): a read first is loop-carried, a write first a
lane-local, and a lane-local the continuation reads is live out (`last =
a[i]`, read after the loop: the v128 shadow never lands in the scalar local,
and at a trip count that is a multiple of the lane width no scalar tail runs
to write it either; liveness is the straight-line scan of the continuation, a
write on one path killing nothing past it). Live out declines, except a
constant flag in `tryVectorize` (`if (a[i] !== b[i]) ok = 0`: one constant,
no else): its shadow starts as the scalar's splat and the scalar takes the
constant after the vector loop when any lane's BITS differ from that splat
(`constantFlagStore`, `map.js`; a float compare read a NaN entry as changed).
The typed-param unswitch
(`src/optimize/unswitch.js`) looks through the inline array arm to the
typed read it specializes, including the BigInt-capable tagged helper: its
Float64 gate proves those reads produce Numbers. Other element kinds retain the
original helper. The accesses it leaves to the helpers (a loop of
several output receivers, a body too large to copy, a stored value of open
kind) decode their receiver once before the loop (`src/optimize/typed-decode.js`):
the element count, the data address and the float width in three locals, no
elements for a receiver that is no Float32Array or Float64Array. Each access
tests `i < n`, loads or stores directly inside, and calls the helper outside,
which answers a missing receiver, another kind and an index past the end
(speed tier: the helper call stays beside the direct path). The summary keeps typed-array named properties
per element type (`typedPropsByAux`): a property stored on a `Uint8Array`
never reaches a read of an `Int32Array`, and an escape opens no cell, since
a typed array's properties come from stores the walk sees or from a builtin
that writes its argument (`escapeObject`); the host holds a view of the
elements alone.

A remainder rebuilt from its shifted quotient is a mask
(`src/optimize/shift-remainder.js`): `x - ((x >> k) << k)`, the fraction of a
fixed-point split (`q = (x / 65536) | 0; r = x - q * 65536` once the emitter
holds both in i32), is `x & (2^k - 1)` for either shift. The quotient may sit
in a local: the fact holds from its write until it or `x` is written, ends at
a loop's head and after any construct a branch may leave, and each arm of an
`if` starts from what held after the condition.

The export boundary is numeric for a parameter used only as a typed-array
index or stored into a typed array (README, "Host boundary"): the usage scan
(`src/compile/param-numeric.js`) counts those uses as numeric, reading the
receiver's typed kind from the summary as well as its declaration. A string
operand of `+` or of a relational operator is a literal or any expression the
summary knows as a string (`isStr`: `const m = 'm'; x < m` compares strings,
`s1 + b` after `s1 = '' + a` concatenates), and the parameter beside it keeps
its runtime dispatch. A program
that wants the host's property keys takes them as strings (`key = '' + key`,
JS's own ToPropertyKey); inside the program the summary knows a string key and
the typed-array property semantics hold.

The dynamic property reader checks a primitive STRING receiver and an exact
nonnegative signed-word Number key before ToPropertyKey. Its float/integer
round trip accepts `-0` as index zero, while fractions, saturation and nonnumeric
keys retain ordinary key conversion. The existing checked string reader handles
empty, SSO, heap and sliced strings. This avoids formatting numeric keys on every
generic string read, including allocating long decimal keys for out-of-bounds
reads; it does not infer an index from receiver tag bits alone.
The known-string emitter uses the same boxed-key dispatch as array reads: a
settled receiver kind does not prove that the key is numeric or skips its hooks.

`charCodeAt` on a concatenation dissolved into raw (buf, len) locals reads
16-bit units at `i << 1`; the byte-indexed read it had after the UTF-16 move
was the strbuild checksum regression.

ToInt32 of a value whose range is proven finite and below 2^63 (`f64Range`:
literals, counters, `Math.floor` of a bounded product, a checked byte read) is
`i32.wrap_i64(i64.trunc_sat_f64_s)` with no ±∞ guard, and the i64 form is
kept on purpose: V8's arm64 lowering of `i32.trunc_sat_f64_s` adds a float
round-trip and range checks (bytebeat 1521 → 1370 µs; a 5e7-iteration micro
294 ns against 446). An unproven value keeps the guarded select. The range
is flow-sensitive (`optimize/flow-range.js`): a comparison bounds the local in
the arm it guards, the arms hull at their join, and a loop's written locals
are unknown at its head, so a clamp (`if (v > K) v = K; else if (v < L) v = L`)
proves the `|0` after it; `f64Range` reads the same facts through an
if-expression or select, and only under its NaN-admitting query, since the
failed side of a comparison may hold NaN. Consecutive byte stores of one
word's bytes at consecutive addresses (`o[k] = u & 0xff; o[k + 1] = u >>> 8`,
`writeU32`) are the word's little-endian store16/store32 (`mergeByteStores`);
word scales canonicalize to shifts before this fusion and SIMD recognition.
Pure address sums compare independently of their parenthesization, retaining
operand order and the original store evaluation. Address CSE also recognizes
an unscaled local byte offset after the zero shift disappears, using the same
dependency writes and control-region boundaries as scaled addresses. The blur
channel lift therefore keeps one shared byte-address value.
wav's sample loop stores its truncation directly. The
integer element store (`module/typedarray.js`) stores the word its value narrows to
(`i32Narrowed`, ir/numeric.js, the narrowing toInt32 itself starts with, seen before a
temp hides the value): an i32, an integer element's read with its convert peeled, a
checked read of one as the i32 if-form (the hit arm its raw load, the undefined miss
ToInt32's 0: `px[i] = lut[ink[i]]`, the byte-transform class), an exact-int tree, a
bounded f64. A receiver a module `let` holds keeps that word through the check of the
receiver. A value only the runtime bounds (`ink[p] = v > 255 ? 255 : v`) converts at
the speed tiers behind the kernel's own first test inline, the `__to_int32` call its
cold arm (`inlineToNum`; the peephole and the vectorizer read that form as they read
the call), and -Os keeps the call alone. A `Uint8ClampedArray` store is ToUint8Clamp
inline: `f64.nearest` of the value clamped to [0, 255] under a saturating unsigned
truncation (NaN to 0 as the clamp says), two selects for a word, a folded constant; no
call per pixel of an ImageData (`test/typed-store.js`).
Load CSE (`cse-load.js`) keeps a condition's typed loads available past an
`if (C) break|continue|return|throw` with no else, since the statements after
it run only when C ran and fell through, and one load serves an
identity-observing use and a numeric one (the numeric use normalizes the
temp): heapsort's sift compares and then swaps without reloading. A
small-constant loop unrolls only within 1000 body nodes in total (trips ×
body): noise's four octaves of an inlined perlin ran 3.6% faster rolled.
The plan's unroll for a small typed array (`unrollTypedArrayLoops`,
`compile/plan/literals.js`) copies a loop out only when its counter reaches
an element index of such an array, itself or through a binding made from it
(`indexesByCounter`): the copies are what turns the index into a literal. A
loop whose counter reaches none is the same in every copy (bezfit's six
passes over a 48-element scratch array wrote the whole nest out six times,
16.4 kB for 3.8, and scalarized nothing).
watr's `ifset` (one-armed `if` → `select`, the speed profile) leaves a
condition that branches itself alone: heapsort's child pick `if (child + 1 <
n && a[child] < a[child + 1]) child++` as a select over the lowered `&&` ran
35% slower than the branch.

`x ** c` with a constant non-integer exponent is the `$math.pow` kernel, one
implementation for constant and runtime exponents within an ulp of the host:
Arm's optimized-routines pow, a double-double log from a 128-entry table
(`scripts/pow-log-table.mjs` derives and checks it) and the shared exp
table, inline in `$math.pow` after the ladder, which takes the common case (a
positive finite base, a non-integer exponent) straight to it and walks the
edge cases only for the rest: 8.1 ns a call against V8's 6.9, where it took
10.9 as a second function behind the ladder with its literals built inline. A constant base c > 0 other
than 2 (`Math.pow(10, db / 20)`, `10 ** (db / 20)`) is `$math.pow_b`: the
compiler takes log(c) with the kernel's own operations (`powLog`), and the call
runs the exponential part alone, bit for bit the kernel's answer for a runtime
base equal to c, 3.6 ns against V8's 6.4 (9.9 before); an exponent the kernel
would not take (an integer, 0.5, a tiny or a non-finite one) goes to
`$math.pow` (`test/pow-base.js`). A version that took y·log(x) in one double
where |y·log x| is small (within about 2|y·log x| + 1 ulp) measured 1.45 times the
kernel's speed, short of the 2 that a hundred ulp would have to buy, so the kernel
stays whole. The constant fold in `src/prepare/math-kernel.js` is the kernel's
twin, bit for bit.
The k/5 fifthroot fold (`$math.pow_fifths`) runs four Newton steps (the last a
correction) and measures 3 ulp against the exact rational power x^(k/5), which
`test/pow.js` pins under a 96 ulp ceiling. `x ** 2.2` means the double 2.2,
though, and x^(c − k/5) − 1 ≈ (c − k/5)·ln x grows with |ln x| (513 ulp at
x = 7e-140 for 2.2), and x^r leaves the doubles near 2^±(1022/r): the fold runs
on x itself only on [2^-L, 2^L] (`trig-tables.js` fifthFold, L keeping that
term within 40 ulp, 72 for 2.4), and every other x is written 2^(5j)·x' with
the fold on x', 2^(jk) applied in two factors and the 2^(5j) part of the
exponent's rounding multiplied back in: within 40 ulp of the host everywhere,
with no pow kernel or table pulled in. The lane vectorizer lifts a constant-exponent pow per lane through the
same kernel, bit-exact with the scalar loop. A negative integer exponent
takes the reciprocal of x^|n|, one rounding past the chain and so exact where
the power is (10 ** -2 is 0.01; squaring the reciprocal first gave
0.010000000000000002, and 20 ulp from the host at 16), and the reciprocal's
square-and-multiply only where x^|n| leaves the normal doubles (1/x^n
overflowed to 0 where x^-n was still a double, 5.67e102 ** -3); the kernel's |y| ≥ 2^63 shortcut answers 1 at x = 1,
where the ladder sends x = −1. A second algorithm (exp∘log, or
the three-step fifthroot) is never the default: a meaningful result keeps its
f64 accuracy. `Math.exp` and `2 ** x` are one table kernel (`math/trig-tables.js`
EXP2_TAB: 2^(j/64) as the nearest double and the tail its rounding dropped;
`scripts/exp-table.mjs`): reduce to |f| ≤ 1/128 (exp on its own ln2/64 split,
head and tail), T + T·(q + tail) with q the exact-coefficient remainder
series, one exponent build; 0.52 ulp against a 200-bit reference for both,
scalar, 2-wide and the constant folder bit-identical (`test/math.js`).
The scalar kernels read their f64 literals from memory (`$math.kc`, module/math.js
`kc`), 0, ±Infinity and NaN aside: V8's arm64 code builds a literal from up to
four 16-bit moves and a register transfer at every use, where a load at a
constant offset is one instruction. The table holds the words of the kernels a
program includes (stdlib-pull renumbers them as it injects it), 126 bytes behind
`Math.atan` alone; with a shared or imported memory it is static data the start
copies into allocated space like any other. `exp` and `2 ** x` let every argument in
range past their NaN, overflow and underflow tests with one comparison and take
k = round(64x/ln2) from the low word of x·64/ln2 + 1.5·2^52, with no
float-to-integer conversion (a range check in wasm); `log` and `log10` pass
every normal x > 0 by one comparison and centre m on √2 by a select, where the
branch went as the argument's low bits went. None of it changes a bit
(`test/math-entry.js`); ns a call on arm64 against Node 25.9, loop subtracted,
before and after, V8 last: exp 3.3 and 2.1 (2.4), `2 ** x` 3.1 and 2.0 (4.1),
log 4.1 and 3.0 (3.1), sin 4.2 and 2.4 (6.3), atan 2.9 and 2.2 (2.6).

jz's Math is not V8's bit for bit: it keeps within 50 ulp of it, for 9% more
time on the floatbeat corpus than the fast kernels it replaced, where porting
V8's fdlibm exactly (branch `audiojs-math`) took 75% more. The budget is spent
on the polynomials, never on the argument reduction. `sin`, `cos` and
`tan` reduce x to n·π/2 + r, |r| ≤ π/4, and take sin(r) or cos(r) by n's
parity (a branch; a phase keeps it predicted), negated by n's second bit.
An |x| ≤ π/4 (the double below it; x·2/π rounds to ½ and ties to n = 0) is its
own remainder and skips the reduction, the same bits: an LFO or a pan angle in
[0, 0.7] ran at 0.73 (sin) and 0.57 (cos) of V8's speed and now 1.26 and 1.21,
where an argument across [−30, 44] pays the test (2.2 to 1.9 times V8).
Below 2^24 the reduction is inline Cody–Waite: n from x·2/π rounded by adding
and removing 1.5·2^52 (whose low word is then n), r = x − n·H1 − n·H2 − n·H3 −
n·H4 with π/2 in 29, 29, 29 and 53-bit parts, each truncated so −0 stays −0.
Every n·Hk but the last is exact and every subtraction that cancels is exact,
so r is within an ulp of the true remainder even at the double nearest a
multiple of π/2 (an exhaustive search of k < 2^24 finds the worst at k =
9206271, |r| = 2^-59), where three parts (111 bits) would err by 6e6 ulp.
Past 2^24 `$math.rem_pio2` is Payne–Hanek in integer arithmetic: x's 53-bit
significand times the 192 bits of 2/π its exponent selects (a read-only
table, fdlibm's ipio2 bits in 64-bit words), the product mod 2^192 giving n
mod 4 and a 128-bit fraction, within 1.3 ulp of the true remainder, the
worst double of all (6381956970095103·2^797, |r| = 2^-61) included; no loop
and no scratch memory, where fdlibm's version keeps a working array in
linear memory. The kernels (`trig-tables.js`, fitted by
`scripts/minimax-trig.mjs`'s Remez exchange in 256-bit fixed point) are the
lowest degree the budget allows: sin(r) = r·(1 + t·P(t)) of degree 11 (45 ulp
minimax, 38 as evaluated; degree 9 is 46000) and cos(r) of degree 12 (0.8 and
2.2; degree 10 is 1071). `sin2`/`cos2` do the same two lanes wide, one
kernel when both lanes' parities agree, bit-identical with the scalar; a lane
past 2^24 sends both to it. The constant folder mirrors the kernels below
2^24 and leaves a larger literal argument for run time (the compiler compiled
by itself has 64-bit BigInt, which cannot mirror the 192-bit product).
`atan` reduces |x| by three intervals and at most one division (as is, π/4 +
atan((|x| − 1)/(|x| + 1)), π/2 + atan(−1/|x|)) to |t| ≤ tan(π/8) and a
degree-19 odd polynomial (8.8 ulp minimax); `atan2` divides and calls it, and
`atan2_2` runs the same operations two lanes wide, the interval picked per lane
by bitselect, where both lanes have a finite y and a finite nonzero x (3.3 ns
an element in a lifted loop against 5.9 lane by lane, V8 7.8).
`asin` and `acos` use fdlibm's rational kernels, with split-word correction
near ±1. Runtime evaluation and constant folding share the same constants and
operation order; the domain and edge sweep pins their error against V8 to one ulp. `sinh` and
`cosh` split e^|x| as (½e^(|x|/2))·e^(|x|/2) past 709.78, where the result is
still finite; `asinh`, `acosh` and `atanh` take fdlibm's forms over jz's log
and log1p, each the one that cancels nothing in its range; `log1p` takes the
ratio x/(u − 1) before the product that overflowed past 2.5e305. Measured
against V8 (`node scripts/math-ulp.mjs`: the floatbeat corpus's arguments,
the doubles nearest k·π/2 to k = 1e6 with their ±4-ulp neighbours, 200k
log-uniform arguments a function, the edges): sin 40, cos 39, tan 49,
atan and atan2 10, sinh 5, cosh 3, tanh 5, asinh 4, acosh 5,
atanh 4, exp 1, expm1 3, log 4, log1p 4, log2 4, log10 2, cbrt 0, hypot 2,
pow 11, a k/5 exponent 40; sin(π) is 1.2246467991473532e-16 and the kπ/2
set stays within 2 ulp. `test/math-ulp.js` pins each bound with the lanes and
the folder bit-identical. On arm64 against Node 25.9, ns a call scalar and
two lanes wide on an audio phase: sin 5.0 and 2.7 (the kernels this replaced
4.6 and 2.6, the fdlibm port 6.0 and 5.6, V8 13); atan 3.7 (3.9, 4.4, V8 7.5);
These timings precede the asin/acos consolidation. At that snapshot the
floatbeat corpus ran at 0.49 of V8's time (0.45 before, 0.78 with the full
fdlibm port); fresh merged performance measurements remain separate evidence.

Values use proven raw lanes or tagged carriers; heap values use NaN-boxing (see README). The legacy `ctx` store still carries compilation state. Consult its lifecycle ownership table in [`src/ctx.js`](src/ctx.js) before changing state; new persistent facts belong in ProgramIndex and frozen summaries, not another ambient store.

## Adding a stdlib method

1. Find or create the module file in `module/` (e.g. `module/string.js`)
2. Register the handler — plain `ctx.core.emit['name'] = fn` (`inc()` any deps inline) unless deps must auto-include or arity must be explicit, in which case `reg('name', deps, fn)` / `call` / `method` from `src/bridge.js` (see "Stdlib registration" above). WAT include deps via `deps({ … })`. Emit helpers: `flat`, `body`, `bool`, `idx`, `spread`.
3. If the handler's key is `.name` or `.kind:name` (a `.prop`-dispatched method/property, as opposed to a bare global-call name like `parseInt`), run `node scripts/gen-prop-modules.mjs` and commit the resulting `src/prop-modules.generated.js` diff — it's the derived table `includeForProperty` (`src/autoload.js`) uses to decide which modules a property NAME might auto-load at prepare() time, before value-type inference can say which module it'll actually dispatch to. `test/self-compile-includes.js`'s freshness test fails loudly (naming this command) if you forget.
4. Add tests in `test/`
5. Run `npm test`

## Adding an auto-vectorizer recognizer

Generic recognizer work belongs in watr. The discipline below also applies to the
existing JZ implementation while it migrates.

The lane vectorizer (`vectorizeLaneLocal` in [`src/optimize/vectorize.js`](src/optimize/vectorize.js))
lifts typed-array loops to WASM-SIMD. Recognizers are tried in order in its dispatch; each consumes the
shared `matchBlockLoop` descriptor and returns a wrapper or `null` — a `null` is fail-safe (the loop
stays scalar), so **never emit code you can't prove equivalent to the scalar loop.**

Typed extent guards may give their fast arm fresh signed-word locals for
stable integral entries, private affine index definitions, and secondary
cursors whose final update also fits. The checked arm keeps its original
Number locals. Every arithmetic intermediate must remain a safe integer;
final address bounds cannot justify losing rounded products or negative zero.
Captured bindings and live exits keep their original storage. Entry literals
come from the completed loop initializer, including later declarator writes.
Existing static bound proofs avoid redundant source copies, and guard setup
alone cannot justify another speculative copy of the guarded body. The two
unchanged FFT shape tests and `guarded index` oracles in `test/simd.js` pin this.
A stable Number module binding may supply the same guarded word snapshot; the
module storage remains unchanged, and the temporary local shadow ends with the
fast arm. Numeric Math calls preserve it only when their operands cannot invoke
user conversion. Source loop planning asks effect queries before emission has
settled accessor views or synthesized conversion helpers, so those queries use
source accessor facts and conservatively retain object-conversion effects.
Optional calls are effects even when their AST carries no argument slot.
When an existing entry guard proves a module bound is a Number, the effect
query uses that fact only for the guarded bound; other operands and the
original fallback retain their conversion effects.


Escape-loop vectorization preserves the iterator's scalar Number or word type
through pair execution and scalar tails; f64x2 lane counters do not justify
truncating a Number counter. The iterator needs a per-pixel positive-zero seed,
one terminal unit update, and no use in the orbit recurrence. Logical
negations retain their original comparison and invert its boolean result,
including unordered Number comparisons. Fractional/NaN limits, odd widths,
zero work and counters carried between pixels are pinned in `test/simd.js`.

Discipline (non-negotiable — these run in the default `speed` build that ships to everyone):

- **Bit-exact.** Compile `{optimize:3}` vs `{optimize:3, noSimd:true}`, run N frames, compare output
  buffers byte-for-byte (0 diffs). **Seed RNG** (`randomSeed:K`) for any example using `Math.random` —
  two un-seeded instances diverge and look like a miscompile. Float reductions that reorder across lanes
  are ulp-divergent → gate at `optimize≥2`; per-lane maps/reductions reorder nothing and are exact.
- **Ratchet +0.** `npm run test:ratchet` must stay byte-identical — recognize only the intended shape;
  don't widen the default corpus path.
- **Run `npm run test:self`.** The dev suite runs on V8, but the self-compile build compiles JZ *with JZ*.
  `test:self` is the correctness round-trip; `npm run test:self:perf` is the warm/fresh
  self-compile speed gate (a local release step: it needs a quiet machine, so CI never
  times it). CI has one self-compile workflow (`.github/workflows/self-compile.yml`):
  it builds `dist/jz.wasm`, runs the round-trip, the whole suite through that
  compiler (`npm run test:wasm`) and the recursive jz × jz check. The parser and
  the encoder jz depends on are bench cases (`jessie`, `watr`) with speed pins in
  `test/bench.js`, not workflows of their own.
  A recognizer can be bit-exact on V8 yet make `dist/jz.wasm` fail validation
  (`i64.reinterpret_f64 expected f64, found i32`) — **the V8 suite will not catch this.**
  - *Cause & fix:* a top-level **self-recursive** helper taking the `ctx` object as a param — JZ's
    signature narrowing can't prove the recursive call passes an i32 pointer, so it leaves that one
    function's `ctx` boxed (`f64`) while every other has `ctx:i32`, and callers emit a bad reinterpret.
    Define ctx-using *recursive* lifters as **nested `function` declarations that capture `ctx`** (take
    only `expr`/`stmt` args), like `scanForLoadsStores`. No `ctx` param ⇒ nothing to mis-narrow. Also:
    don't reassign a parameter (use a local).
  - *Debug:* `compile(<self.js source>, {optimize:false, wat:true})`, map the failing `function #N` to a
    name by counting `(func $…` in order, then dump its param types — the odd `ctx:f64` is the smoking gun.

Coverage is not exhausted but is diminishing-returns vs reach work (see `.work/audit.md` §9): i32x4 cellular
automata (game-of-life/ising/rule30) and lyapunov's carried-recurrence outer-strip remain feasible;
data-dependent gathers and scatters (dla/sand/voronoi) are not: WASM-SIMD has neither, so they stay
scalar. A read strided by a secondary counter (`k += step`) gathers lane by lane in the general map
when the cost model finds enough work per element (the radix-2 butterfly's twiddles).

Straight-line code has its own packer, SLP (`src/optimize/vectorize/dot-slp.js`): two element
stores one f64 apart with isomorphic values become one `v128.store` when every leaf pair is
overhead-free: adjacent loads (one `v128.load`), the same pure scalar (a splat), or two locals a
kernel loaded once from consecutive slots (`ax = a[0], ay = a[1]`, the field-first idiom of
vector and matrix libraries) which become one `v128` loaded beside them. The pack reads both
lanes before either store, so the high value may not load the low store's slot through any
name (two parameters can be one array); a store's base resolves through jz's staging temps,
never through a load. `test/slp.js` pins the shapes and the bails. The same address model
drives `src/optimize/forward-store.js`, which runs before the packer: in straight-line code a
load of a slot the list just stored (or loaded into a local) reads that local instead, and a
store the list overwrites unread goes; a store through another name, a call, a branch or a
nested block forgets everything (`test/forward-store.js`).

A static typed array the program only indexes by constants is registers
(`src/optimize/static-scratch.js`, first in the module optimizer). The shape is the scratch a
numeric library reads a float's words through: `F[0] = x; hi = U[1]` over
`U = new Uint32Array(F.buffer)`. A view of a static array's whole buffer has the array's address
(module/typedarray.js), a constant its declaration holds (`hoistConstGlobalInits` follows one
constant binding to the next). When every read of such a binding in the module is the base of
a load or store at a constant offset inside the array, no other access reaches those bytes: a
store through any other pointer lands in another object. A load whose every byte the stores
before it on its path wrote is then those values' bits, shifted and joined, whatever the widths
and types on either side (a word of a float, a float from two words or eight bytes, a signed
piece), and a store no load left in the module reads a byte of goes. A path forgets what it
knows at a loop's entry, at the end of a block a branch leaves, and at a call to a function
that stores to such an array, calls one that does, or is not the module's; the arms of an `if`
keep what both hold. Any other use of a binding (an argument, a return, an export, an element
of another object, an index that is not constant, a view made in a function or of a part)
keeps its array in memory, with every binding that shares the buffer. `test/static-scratch.js`
pins the shapes, the joins and the bails.

An assignment that is a statement of a function's own list declares its value as a binding of
its own (`src/prepare/split-bindings.js`, last in prepare, at every level; `splitBindings: false` opts out): `x -= n; xx =
x * x` reads as `let x1 = x - n; xx = x1 * x1`. The list runs once, top to bottom, so what
precedes the assignment read the old value and what follows reads the new. Each binding then
holds one value and has its kind: an integer assigned after a float is an i32, a parameter of
any kind reassigned from arithmetic is a number from there on, and a parameter only the list
assigned is never written, so its constant argument reads as the constant. A write nested in
the list (an arm, a loop) assigns the binding of its place, and a binding a closure names is
one cell its calls share and stays whole. It is a normal form of the source, not a pass of a
level: what an exported parameter is used as is read off it, and the answer may not differ by
level. A read as a string flows back through what made the value (summary demand, `STR`): a
copy, a call's argument, the operands of a `+`, so `x = s + s; x.slice( 1 )` uses `s` as a
string. A test of the analyzers' rule for a second write puts the write in an arm, or opts out. `test/split-bindings.js` pins the statements it leaves and the
agreement of both forms with the host. A pass that copies a node or puts one in its place
carries what the parser noted on it (its position, `loc`) through `copyNode` and `noted`
(`src/ast.js`), not `slice`: a statement rewritten without them has no source position.
The list keeps its current binding names and applies them once when reaching each
statement; it advances the assigned name after reading the RHS. Rewriting the remaining
suffix after every assignment made both traversal and temporary AST allocation quadratic.
The split-binding tests pin linear visits, unchanged nodes and source positions, and
repeated/changed/error compilation sequences with retained modules.

A split binding of the type of the one it continues takes its slot
(`src/optimize/split-slots.js`, last before the generic optimizer): the one before is dead
once the next is written, so `x = +x` on a parameter that is a number costs no local and the
function is the one the source wrote. It shares when every access of the slot comes before
the binding's first write in evaluation order and no loop holds both an access of the slot
and a write of the binding.

A module array of numbers the program only uses as scratch is locals
(`src/compile/plan/scratch.js`, pass `moduleScratch`, after the inliner): `normalize( frac,
FRAC, 1, 0 ); frac = FRAC[ 0 ]; exp += FRAC[ 1 ]`, a library's way to return two values. The
array is a module constant bound to a literal of numbers, not exported; in every function that
runs each mention is an element at a constant index inside the literal's count, outside any
closure; each read follows a store of that element on every path to it
(`summary/definite.js`); and no call between them reaches another function that names the
array or a callee the program cannot name. Each function then holds the elements in locals of
its own, and the array, its stores and the reset's snapshot of it are gone. A function runs
when the host holds it, a value names it, a statement of the module calls it, or one that runs
calls it (`liveFunctions`); the inliner counts a callee's sites among those only, so a
library's allocating variant nothing calls (`normalize( x )` over `assign( x, [ 0, 0 ], 1, 0
)`) takes nothing from the body's budget. `test/module-scratch.js` pins the shapes, the bails
and that a caller nothing runs changes no byte.

A spliced call leaves names for one value and statements in its caller's lists; the alias
pass reads them away (`src/compile/plan/alias.js`, pass `aliases`, ahead of the splices and
after them). A binding whose every definition is one other binding, itself a parameter nothing
writes or a binding of one definition, is that binding: the result every return assigned the
same array to, the local the caller read it through, a parameter called through a local of its
own. It must be declared with the value or assigned before every read on every path
(`summary/definite.js`), and no closure may mention it. A binding whose every definition is
one truth value or `undefined` is that value. What the names decided is then decided: a member
no function has, read off a lambda the body made and nothing stores a member to or takes as a
value, is undefined; `typeof undefined` against a type, an equality of two truth values, a
`||` or `&&` read as a test, and the `if` or `?:` of a decided test are their answers. A
logical operator read as a value keeps its form: the kinds of what it yields were read off it.
A local nothing reads, declared with a value that runs nothing (a name, a literal, a fresh
object or array of such), is not declared only when this pass can remove every store too.
Closure captures, including write-only captures, and stores outside statement lists retain
their bindings. Prefix flattening likewise keeps a binding captured by its result: a closure
may write it or read it after the initializer's source changes.
After the splices each list inside a body splits
as the body's own list does (`splitReassigned( fn, true )`), over the bindings the list
declares ahead of the assignment and nothing outside the list mentions, and over a binding
declared bare outside the list that the list alone mentions, from an assignment nothing in
the list precedes: the `var opts` of a spliced body whose statements the lowered returns put
in an arm. A body that is one statement (a loop alone) is a list of it.

The inliner (`plan/inline.js`) splices with these in view. A function that reads `arguments`
is one of a fixed count at each site before the splices run, and a test of the count is
decided in the variant (`if ( arguments.length > 1 )`). A body that makes closures splices
with them where its own control is a list with one trailing return: a closure's parameters
and locals are named anew with the body's, and a parameter a closure mentions is bound to a
temp, never read as the caller's name. A closure's writes require mutable parameter storage
even when the call supplies a literal or selects a literal default.
Lifting a call preserves preceding reads and effects, including user code run
implicitly by getters or primitive conversion. The effect scan reads arguments
in the caller's scope and each candidate body in its own scope; a local lambda
keeps its original parameter scope in its synthetic signature. Unknown calls
can write captured bindings even when no assignment appears in the candidate.
A lambda declared in a list of its own splices where it
is called, where nothing outside the list mentions it. A loop that calls its parameter (a
series summed from a generator, a continued fraction from its terms) splices at the speed
tier wherever the argument is a function the caller names or makes, whatever the count of
sites, and lifts out of an expression there; a returned call splices as an assigned one does.
An assignment's target that runs nothing, over names the splice cannot store to (a local no
closure mentions, a constant of the module), commutes with any splice: `OUT[ i ] = f( x )`.
A caller past 3000 nodes takes no more loops at sites outside its own loops, and the loops it
left are pinned for watr's single-caller inliner, which has no bound: a driver of three
hundred kernels was one function that never left the baseline tier. The size tier has no
such bound: a function of its own costs its frame. A site that passes a
BigInt and a Number to one operator of the body keeps the call, which throws when it runs. A
read of a name an object literal does not declare is undefined in the scalarized literal,
unless every object inherits the name or the literal is an instance of a class, whose members
are the class's to answer (`plan/literals.js`). `test/alias.js` pins the kernels, the bails
and the driver.

At the speed tier a loop's time is the loop's and its callees'. The budgets that count a
callee's sites across the program (a small leaf within its cap of sites outside loops, a body
at its sites in loops while sites times size stays under 400) make it depend on how many other
loops call the same function, so past them the speed tier decides by the caller: a tiny leaf
(15 nodes) splices at every site whatever their count, since its body is the size of the call
and the call is what joins the kinds of every site's argument into one parameter (`isnan` at
two hundred sites, tested for `undefined` and `null` at each because one passed a value of no
known kind); a straight-line body of up to 200 nodes splices at a site in a loop of any depth
(`warm`) while the caller is under 3000 nodes; a body takes the calls it keeps along (`lcm`
over `gcd`, whose loops stay a function), outside a cycle of calls, whose copy would hold the
cycle's call again; and a function a value names is still the body of its direct calls
(`modf( x )` beside `modf.assign = assign`). A call in an arm of a conditional runs only
where the arm does, so the conditional itself moves ahead of its statement, as a statement:
`c ? a : f( x )` is `let t; if ( c ) t = a; else t = f( x )` and then `t`, `a && f( x )` is
`let t = a; if ( t ) t = f( x )`, past what it commutes with only, as a lifted call moves. A
parameter the body only reads is what the site passed; one it writes is a binding of the
call's own. `test/splice.js` pins each rule on a kernel that shows it and the agreement with
the host. The cost is bytes: stdlib's special functions as one module (`bench/stdlib-special`)
are 23% larger at the speed tier, and 8% smaller at level 2 and at the size tier.

A binding of a spliced call read where it holds a literal is the literal
(`src/compile/plan/constants.js`, pass `constants`, after the splices). A spliced call binds
each argument its body writes to a name of its own, and the body's tests of that parameter are
tests of the literal the site passed:
`if ( min === 0 ) min = 0`, `max <= min`. The walk carries what each binding holds along the
statements in the order they run. A read of a binding that holds one literal on every path
to it is that literal; an operator over literals is its answer (a comparison, `!`,
arithmetic on numbers, a function of `Math` whose value is exact: `EXACT_MATH`, src/ast.js);
the arm a decided test rules out is no code, so what it would have written is not written.
Paths that meet keep what both hold the same; a loop, a labeled statement and a `try` start
and end without the bindings written anywhere in them; a binding a closure mentions and a
name of the module are not followed. A logical operator is decided where it is read as a test
only. The bindings followed are the ones the splices made (the names that begin with the
compiler's mark): a binding the function's own source declared keeps its name, which the
passes that read a loop by its shape match (a clamp against `w - 1`, a window of `2 * r + 1`:
the blur recognizers stopped firing on a literal), and the emitter folds a constant of the
source where it is read. `test/constants.js` pins the flows and the folds.

A mutable parameter uses an i32 carrier only when the shared integer lattice
proves every write fits signed width and excludes negative zero. Integer-valued
arithmetic alone does not prove that: increments, multiplication, negation and
unsigned shifts can leave the signed range. The mutation census includes nested
closure writes; callers agreeing on i32 entry values cannot bound later updates.
Explicit word operations keep the direct integer ABI (`test/inference.js`).
Call arguments use the same lossless value proof. Recursive arithmetic does
not inherit signed width from an integer entry; each incoming call must fit.
Unsigned locals and results keep their positive magnitude, and absent typed
elements remain undefined unless the callee itself asks for a word conversion.

A parameter every call fixes to one integer reads as that integer in its body
(`substituteIntConstParams`, narrow/param-abi.js, once the signatures settle; validated as
`intConst` is: never written, no default, not the rest): an index, a stride, an offset the
consumers then see as the literal they serve best, a store inside a fixed length or a folded
sum, not as a name whose value a fact carries. The parameter stays in the signature; callers
pass what the body no longer reads. Substitution and inlining share the numeric-domain
check in `compile/numeric-mix.js`: a call that mixes Number and BigInt must still
throw when it runs, so a possibly mixed body retains its parameter references.
Constant replacement keeps union members in that check: a later `typeof` guard
can narrow a Number-or-BigInt parameter to its BigInt arm.
A self-recursive helper writing `out[ offset + stride ]`
(stdlib's `modff`) stores at a literal index instead of guarding a growth at every call
(`test/array-methods.js`).

A literal of no members declares nothing, so it scalarizes to nothing and every read of it
is `undefined` (`opts = {}`, the default of an options parameter), and `||` or `??` over a
literal `undefined` or `null` is its right side (`emit/logical.js`): `opts.tolerance || EPS`
is `EPS` with no value tested for what kind it is.

A binding assigned on every path to each of its reads holds no `undefined` to test for. The
summary proves it (`summary/definite.js`) and declares the binding empty; the emitter reads
the same proof where it declares the local (`emitDecl`), where it used to ask for an
unconditional first write. `let r; if ( c ) r = a; else r = b` is the result of every spliced
body that returns from an arm: a polynomial with a test for zero cost a compare and a select
per evaluation, and a loop over it was no lane loop. A labeled block ends with what held at
each `break` to it, so a binding the block assigns past a `break` is not assigned after it.

Single precision is the `narrowFloat32` pass described with the lane lift above;
`test/float32.js` compares every form with the host to the bit. A module name
defined by an exact function of `Math` over numbers held for good holds its number
(`PI32 = Math.fround( 3.14… )`), published once more after the plan, where a call
through a name that holds a builtin is the builtin's (`holdModuleNumbers`).

The tape's fold (`src/optimize/fold.js`) answers a comparison of two `f64` constants and a
mask by a constant that decides or passes its other operand: what a literal argument leaves
of a test after the generic optimizer has brought the constant to it.

A typed store reads its key before its value, as PutValue does (`module/typedarray.js`): a
key that reads what the value's effects may store to (a global or an element a call changes,
a local the value assigns) is taken into a temp first.

A module name that holds a builtin for good is that builtin where the name is used
(`resolveHeldMethods`, plan/scope.js, at every level): a method of a prototype the target
dispatches by the receiver's kind (`Object`, `String`, `Array`, `Number`, `Boolean`), called
through `call` (`var toStr = Object.prototype.toString; … toStr.call( v )` is
`__object_toString( v )`, `has.call( o, k )` is `o.hasOwnProperty( k )`, `lower.call( s )` is
`s.toLowerCase()`); a function of the target named bare or in a namespace (`Symbol`,
`String.fromCharCode`: `isNamedCallee`, autoload.js), called direct or through `call`; a
namespace held whole (`var proto = Object.prototype; proto.toString.call( v )`), whose members
resolve as if named in place. A member of a held function or namespace the target does not
serve reads as undefined (`Sym.toStringTag`, `proto.__defineGetter__`: no well-known symbols,
no legacy accessors), as prepare reads a member of a namespace it does not serve (`Math.frund`
is undefined, a call of it is still refused): a library's polyfill holds them and never runs.
A library tests a value's class and its environment this way from modules of its own that
another imports (stdlib's `utils/native-class`, `symbol/ctor`, `utils/define-property`), so
the name is resolved where the modules are one program. The name is declared once with the
builtin, or with a name that holds it, and nothing stores to it; its declaration goes with its
last mention. Any other use of it is a value the target has no form of and stops the compile,
as before (`test/held-method.js`). Prepare answers `typeof` of what the program never declares
at compile time (`staticTypeofString`): a function of the target is `'function'` (`typeof
Symbol`, `typeof String.fromCharCode`), the globals every host has (`globalThis`,
`WebAssembly`) are `'object'`, an unresolvable name is `'undefined'`; `window`, `self`,
`global` and `process` are one host's or another's, so the run answers, and a host that lacks
one imports it as undefined (interop). `Ctor.prototype.m.call( recv, … )` named in place on a
primitive's prototype (`Number.prototype.toString.call( n, 16 )`) is the method on the
receiver (`foldPrototypeBorrow`), as the array-like borrow was; `Boolean.prototype` is the
dotted name as `Number.prototype` is, where the bare `Boolean` is the conversion.
A function of the target named bare (`parseInt`, `isNaN`, `Symbol`, `RangeError`) held in a
name the program declares, through any names (`var P = parseInt; var Q = P; Q( s )`), is that
function where the name is called or asked its type (prepare's `namesTargetFn`, the alias
table `scope.chain`): the table seeds each such name with the module that serves it, for the
call's sake, and a read of the name used to resolve to the module. A seeded name is the
target's own (`RangeError` is seeded `Error`, its module's; the call keeps its class). Its
`.length`/`.name` is the reflection `Math.max.length` is refused as (`isTargetFnRecv`), not
the undefined an unserved member of its namespace reads as. The
`Function` constructor lowers to a `TypeError` where it runs (`ERR.DYNAMIC_CODE`): jz compiles
no source at run time, and a library reaches it only behind a feature test that fails.

A module whose initializer reaches into the host (a host global it names, a member read or a
call on a host value) ships its init as the `_initialize` export, as a WASI reactor does
(`legalizeReactorInit`, optimize/watr-tail.js), and the interop calls it once the memory is
readable: nothing can serve `globalThis.document` from inside `new WebAssembly.Instance`. A
pure module keeps its `start` section and instantiates bare.

A module name that holds one regular expression for good is that expression where a method
of it is called (`holdModuleRegexes`, plan/scope.js). jz compiles a regular expression where
its literal is known (module/regex.js); a library hands its patterns on through a function
that returns the literal, a name, and a member of the function (stdlib's
`regexp/function-name`, read by `utils/constructor-name`). The name is written once, at the
module's level, with a literal, a name that holds one, or a call of a function of no
parameters whose body returns one; a pattern with a cursor of its own (`g`, `y`) is followed
through names only, since each call of the function makes another expression with another
cursor. A name stored a second, other literal holds no one expression (`regex.hold`): the
compile says so where a method of it is called, where it used to run the literal registered
last, whatever the name held (`test/held-regex.js`).


The shared matcher is not the RegExp value. Every evaluated literal allocates an ordinary
OBJECT header with a salted `lastIndex` schema, its own cursor and dynamic properties;
a direct literal method call can omit that unobservable instance. The header's length
word remains the OBJECT deleted-slot mask (zero), not its field count. A cursor read
converts after the argument string, through the captured receiver; updating it uses the
ordinary numeric field store. `jz:regexp` records pattern/flags by schema id, preserving
lone surrogates with JSON escaping, so interop returns real RegExp instances and keeps
plain objects with a `lastIndex` field distinct. Runtime branding, getters, conversion,
JSON and deletion share this schema identity. `Object.getOwnPropertyNames` uses the same
property walk as enumeration, with a demand-only accessor view that includes hidden
slots; ordinary enumeration still excludes them (`test/regex.js`).

A module binding nothing that runs reads is not declared, where its value runs nothing
(`dropUnreadGlobals`, plan/scope.js, at every level): a name, a literal, a closure, an
operator that converts nothing (`typeof`, `===`, `&&`), or one that converts numbers, strings
and booleans only, since an object's conversion calls its `valueOf` and a BigInt's can throw.
`var Fcn = Function` behind a code generator nothing calls then compiles to nothing (one the
program calls is a TypeError where the call runs). A read is a
name in a function the call graph reaches or in another statement of the module; a binding
read only by one that goes, goes after it; an exported binding stays (`test/unread-globals.js`).

A function's properties are a record reached through its name (`materializeAutoBoxSchemas`,
plan/scope.js: the `__inner__` box), and the function's value is the callable. A function
taken as a value (an argument, an element, an alias) is read through that value, so its
properties keep the closure-keyed dynamic path, which every alias reaches: `typeof`, a call
and a property read through the value answer what the host answers (stdlib's
`assert/is-object-like` hands `isObjectLike` to `arrayfcn` and then sets
`isObjectLike.isObjectLikeArray`; `test/objects.js`).

## Principles

- **Don't contort compiler source for microbenchmarks.** Readability wins in `src/`; optimize compiler time and retained memory only from measured, general evidence. Output speed and size remain the primary product budgets.
- **JZ source is JavaScript source.** Supported programs must parse and run as standard JavaScript. Parser acceptance of an ECMAScript early-error-invalid program is a bug/temporary hole, never a language extension or compatibility promise.
- **A finite speed dialect, not an open-ended escape hatch.** Compiled output follows the semantics explicitly listed under [“What differs from JS?”](README.md#what-differs-from-js): wide bitwise operands, 64-bit BigInt, constant rounding and the other enumerated cases. Outside that list, preserve JavaScript answers, exceptions, evaluation order, and effects or reject. “A native compiler could do it” is not sufficient authority for a new divergence: update the public contract and add cross-tier exact tests before landing one. Never trade away a meaningful result's f64 accuracy (no mantissa trimming or arbitrary precision loss).
- **Minimal surface.** Every feature must justify its weight. If it can be a library, it should be.
- **No external runtime and no GC.** Needed JZ runtime operations are linked into the module; unused operations are omitted.

## Testing

### Source cleanup

`npm run lint:imports` checks unused imports in the root JavaScript modules,
`src/`, `jzify/`, and `module/`. Run `npm run lint:imports:fix` to remove them.
The ESLint configuration enables only this rule, so it does not reformat code
or remove variables. Keep initialization-only dependencies as bare imports
(`import './register.js'`); the fixer preserves those.

`npm run audit:files` uses Knip to find unreachable source modules. Package
exports and the CLI are discovered from `package.json`; `knip.json` also roots
the standalone scripts, tests, examples, benchmarks, and browser assets that
use compiler internals. Fixtures, generated output, and standalone programs
are outside the source-file deletion scope. When adding a new external loader,
include its entry point before trusting the report.

Review reported files for string-based loading and documented use before
deleting them. After that review, `npm run audit:files -- --fix --fix-type files
--allow-remove-files` removes the reported files. Run the tests below after
cleanup; an unused binding alone does not prove its module has no side effects.

### Test suites

Tests use [tst](https://github.com/dy/tst). Choose the owner of the work you need:

| Command | Work |
| --- | --- |
| `npm test` | Core semantic/structural regressions, one process; **no bootstrap or generated population sweeps** |
| `npm test -- strings dyn-keys` | Named files, regardless of owner; keeps completed-test GC and warm compile-state checks |
| `npm run test:matrix` | Core default/O0/O3/WASI legs |
| `npm run test:integration` | Libraries, tools, examples, site/package smoke for the current leg |
| `npm run test:generated` | Fuzz correctness, WAT populations, deterministic codegen ratchet for the current leg |
| `npm run test:extended` | Integration matrix plus native/WASI generated owners |
| `npm run test:bootstrap` | Fresh self compiler: round-trip, O0/O2/O3 parity/oracles, separate checkpoint overlay |
| `npm run test:bootstrap -- --full` | Above, plus the full hosted suite and recursive compilation |
| `npm run test:battery -- fast` | Core matrix plus the distinct armed O3 invariant leg |
| `npm run test:battery` | Above, extended checks, armed integration/fuzz, fixpoint, then exclusive full bootstrap |
| `npm run test:all` | Core + extended + conformance + benchmark + full bootstrap + self performance |

`node test/index.js --suite=all --list` lists every registered file without compiling.
`--suite=core|integration|generated|bootstrap` selects an owner; `--suite=all`
explicitly requests the old single-process collection (including heavy builds).
`test/_suites.js` gives each file exactly one owner; `test/test-infrastructure.js`
checks that the union is complete. CI runs the core and integration on all four
legs, generated checks on native/WASI, and bootstrap in its own workflow.
No seeds, oracle comparisons, or optimization profiles are removed.

Matrix/extended/battery subprocesses default to **one job**. Set `JZ_TEST_JOBS=2`
(or battery `--jobs=2`) deliberately; do not start several batteries on one
machine. Logs go to printed temporary-directory paths, not parent-process
strings. `JZ_TEST_TIMEOUT` bounds an ordinary task in milliseconds (default one
hour); bootstrap has a four-hour task budget and always runs alone in the battery.
Timeouts terminate the task's process group, including nested builders. GC runs
after completed tests and generated programs, also checking external-memory
and RSS growth; it does not clear compiler state between test files.

A test that must hold at several optimize levels writes
`for (const optimize of levels(false, 2, 3))` (`test/_matrix.js`): each leg runs
its own level; the default leg also owns O1. `JZ_TEST_SWEEP=1` runs the whole
list in one process. For a formerly explicit all-profile loop, `ownedLevels`
also preserves its complete WASI/hosted-compiler cross-product. Do not split a
pass-on/pass-off comparison that needs both results in the same assertion.
`LEG_INVARIANT` / `OPT_INVARIANT` in `test/index.js` skip redundant legs;
explicitly naming a file overrides those skips.

Bootstrap sharing is invocation-local: a private fresh build is SHA256-checked
by each consuming process, never loaded from a stale `dist/` or mtime cache.
The forced-checkpoint build stays independent, and checkpoint instances leave
memory when their process ends. `test:self` still makes a fresh standalone build.
CI installs with `npm ci --ignore-scripts` plus `npm rebuild esbuild`.
`prepare` builds only the site/JavaScript assets (`build:web`), the files the npm
package actually ships; installation no longer bootstraps an unused compiler.
`npm run build` remains the explicit full distribution build including `jz.wasm`.

Shared helpers live in `test/util.js`: `run` (exports), `wat` (text),
`oracle(src)` (the same program evaluated by Node), `agree` (jz equals Node for
one call), `funcWat` (one function's WAT), and `cases(rows)`, which compiles a
table of `[label, arrowSource, want, ...args]` rows as one module. A compile is
almost all of a test's cost, so a family of one-assertion programs belongs in one
`cases` table, not one compile per assertion. Reuse compiled exports **within a
fixture** for its argument table, not through a global compiler cache (which
would hide state leaks). Keep population compilation inside test callbacks so
`TST_GREP` cannot accidentally run an entire corpus during imports.

To count and time real compiles, including duplicates:

```sh
JZ_HASHES=/tmp/strings.json node --import ./test/_hashes.mjs test/index.js strings
```

The recorder's `meta.calls` and per-key `measurements` complement its outcome
hashes; keys include effective host/optimization defaults. This is opt-in
instrumentation, not a production compilation cache.

Release semantics also run `npm run test:262` and
`npm run test:262:builtins`. Workers default to at most two, further bounded by
available memory and CPUs; `--jobs=N` / `JZ_TEST262_JOBS=N` explicitly overrides
that choice. The npm commands expose GC to worker isolates. Negative-parse
acceptance is an exact path set,
not a count ceiling: any change must update and explain
`test/test262-neg-accepts.json`; residual entries are blockers/inventory, not
language extensions.

## Performance & size invariant

JZ makes a load-bearing promise: **on the bench corpus, JZ wasm is at least as
fast and at least as small as the alternatives.** Concretely, enforced by
`test/bench.js` (run by CI on every push/PR — `.github/workflows/bench.yml`):

- **Speed** (`-O` speed-tuned build): JZ median ≤ V8 and AssemblyScript (`asc -O3`)
  on every comparable case, and ≤ them on geomean; ≤ Porffor's native artifact on
  every comparable case and geomean. The `porf-native` lane uses committed
  evidence because the 2026 Porffor rewrite has no wasm target. JZ wasm must
  be no larger than the corresponding Porffor native artifact per case and by
  geomean. *Live timing ratios are asserted off-CI only (local
  `npm run test:bench` on stable hardware); on CI they print informational
  because a shared 2-core runner reads identical builds up to 15× slower.
  Checksums, sizes, compile success, and the committed-evidence Porffor floor
  stay hard-gated on CI.*
- **Native parity** *(asserted only when `clang` is on PATH — i.e. locally; CI
  runners have no clang, so this pin is printed but not gated there)*: JZ wasm runs
  at `clang -O3` speed — geomean jz/C ≈ 0.86–0.98×
  (JZ *beats* native C on `poly`, `mat4`, `aos`, `tokenizer`, `sort`, ties
  `mandelbrot`). Two cases trail native and are pinned `near`, not as a parity
  claim: `biquad` is wasm-v1 ISA-bound (no scalar `fma` — hand-written WAT ties
  it too) and `json` is string-carrier bound. The geomean ceiling is the
  guarantee; the `near` per-case pins are regression backstops.
- **Size** (`optimize: 'size'` build): JZ wasm ≤ AssemblyScript (`asc -Oz --converge`)
  on every comparable case, and ≤ it on geomean. (Porffor left this axis with its
  wasm target; its native binary sizes read on the bench page's native band.)
- **Codegen slack**: `wasm-opt -Oz` should find little to remove in JZ's own
  output — whatever it shrinks is latent size headroom. Gated
  (`WASMOPT_SLACK_MIN=0.90` in `test/bench.js` — geomean ~3% slack on size
  builds, worst case ~9%; see `.work/wasm-opt-slack.md` for the per-class
  attribution); target is 0.95+, ratcheted down as codegen tightens.
- **Correctness floor**: `test/differential.js` fuzzes jz-compiled wasm against
  the same source run as plain JS — "smallest/fastest" never via a wrong answer.
- **Compiler-efficiency floor** *(v1 release blocker)*: full recursive jz×jz must
  produce bytes below wasm32's 4 GiB ceiling, then match or beat the pinned
  Porffor self-host on same-machine wall time and peak memory. A trap is a
  failure. Record Porffor's JS→C time and its full JS→native build time; JZ's
  executable-Wasm output sits between those stages. See `.work/audit.md` §10
  and the Porffor alpha 3 measurements in `.work/evidence.md`.

Run locally (needs `asc` and `wasm-opt` on PATH for the full picture; the
`porf-native` lane picks up a Porffor git checkout via `PORF_BIN`):

```sh
npm run test:bench   # the gate
npm run bench:size       # just the wasm-size table (jz vs AS -Oz, + wasm-opt slack)
npm run bench            # just the speed harness
```

**Ratchet, don't backslide.** `bench.js` carries per-case `win`/`tie`/`near`/`todo`
claims (against each competitor and against native C) and geomean ceilings. When
you make JZ beat a `todo` or close a `near` gap, promote it to `win`/`tie` in the
same PR; when you shrink codegen, tighten the relevant geomean ceiling and the
`wasm-opt` slack budget. A PR may not move any claim backward. If a change trades size for speed (or vice-versa) deliberately — e.g.
the unrolled/vectorized hot kernels — say so in the commit and adjust the
*size* budget, not the speed pin.

### Adding a bench case

1. `mkdir bench/<name>/` and add `bench/<name>/<name>.js` — valid JZ that
   `import`s `{ ... }` from `../_lib/benchlib.js`, exports `main`, and ends with
   `printResult(medianUs(samples), checksum, …)`. Use an existing case as a template.
2. For a fair size/speed comparison, add a self-contained `bench/<name>/<name>.as.ts`
   (AssemblyScript port — env imports `perfNow`/`logLine`, see `bench/bitwise/bitwise.as.ts`).
   Optional: `<name>.c` / `.rs` / `.go` / `.zig` for native baselines, `<name>.wat` for a hand-written reference.
3. Add the case to the `SPEED` and `SIZE` maps in `test/bench.js` (claims
   default to `todo` / `na`), and a `SIZE_BUDGET` backstop.
4. `npm run bench -- --cases=<name>` and `npm run bench:size -- <name>` to see where it lands.

Prefer cases that mirror real JZ target workloads (numeric/DSP/parsing/wasm-utils) —
the corpus *is* the guarantee, so widen it toward the code you actually ship.

## Public contract and ABI

The public surface is deliberately small (README owns it): the root exports
`jz`, `compile`, `instantiate` and `jz.memory`; the `jz/interop` subpath with
`instantiate` and `memory`; the compile options in `index.d.ts`; and the
CLI flags in `jz --help`. Everything else is internal and may change without a
major version, including `jz.pool` (experimental SPMD worker pool, node only).

`normalizeOptions` in index.js folds the public `memory` and `optimize` objects
onto the internal flags. Tests and scripts may pass those flags directly:

| Internal option | Public spelling | Notes |
|---|---|---|
| `maxMemory`, `importMemory`, `sharedMemory` | `memory: { maximum, import, shared }` | a shared `WebAssembly.Memory` object sets `sharedMemory` by itself |
| `noSimd`, `noTailCall` | `optimize: { simd: false, tailCall: false }` | |
| `noEhAbort` | `optimize: { exceptions: false }` | trap on throw in catch-free modules; the w2c bench lane uses it per case |
| `alloc: false` | `optimize: { alloc: false }` | raw standalone ABI: no allocator/reset exports, no decoded-error metadata |
| `whyNotSimd`, `whyNotRewind` | `why: true` | reports go to the `warnings` sink |
| `stencil`, `outerStrip`, `toneMap` | `optimize: { stencil, … }` | pass names, validated by `resolveOptimize` |
| `strict` | none | test-only: skips jzify and rejects the forms it lowers plus dynamic fallbacks |
| `sourceType` | none | parse goal for test262 (`script`/`module`); the default `jz` goal keeps export-as-ABI |
| `nativeTimers` | none | blocking `__timer_loop` in `_start` for the wasmtime CLI; a command-module auto rule is the intended replacement |
| `importMetaUrl` | none | the CLI sets it from the entry file |
| `profile`, `inspect`, `helperCounters`, `_eagerStdlib`, `_interp` | none | instrumentation and self-compile hooks |

Advisories reach any `warnings` sink, one per site (the source offset when the
node kept one, else the message): `heap-return`, `heap-loop`, `deopt-generic`,
`deopt-dyn-read`, `deopt-dyn-write`, `deopt-method`, `deopt-prop-read` (how the
read lowered and the receiver's candidate shapes), `class-generic` (a class
kept as closures and why), `shape-lost` (the first cause the summary lost an
object layout by, with the function and statement), `host-global`,
`jsstring-declined`, `int-global-truncation`; `simd-why-not`
and `rewind-why-not` need `why`. Warnings are delivered after the pipeline
returns, so a warning callback may compile again; a compile attempted while
the pipeline is active is rejected.
`scripts/why-census.mjs <case>` prints a bench case's census: the layouts lost
in order (the first is the root of a cascade), the dynamic reads by function,
the classes kept as closures.

### Semantics contract

Outside the dialect differences the README lists, accepted programs must
preserve JavaScript values, exceptions, operand order and effects at every
optimization level. The list includes the export boundary's numeric
parameters: an exported function's parameter the body never uses as a string
is trusted numeric (`analyze-for-emit.js`, `paramNeverString`), so a string
passed there is converted where JavaScript would concatenate. Unsupported representations must reject. An unlisted silent
wrong value or an accepted invalid-parse case blocks release. Early-error
validation runs before lowering in both the JS and Wasm compiler;
`test/test262-neg-accepts.json` gates the accepted-invalid ledger. Error classes
and codes are stable within a major; message text may improve.

### Host memory contract

Strings use UTF-16 code units; UTF-8 belongs at encoding and I/O boundaries.
`memory.Object()` and `memory.write()` enforce compiled field kinds, typed
storage, nested schemas, integer refinements and discriminants used by lowering.
Incompatible replacements throw `TypeError`. Nullable fields admit their value
family and nullish values. Modules sharing memory must agree on existing schema
contracts and bind their schemas at the same ids: a pointer carries the id its
module compiled with, so a module whose schema would bind at another id in the
memory is rejected before it is instantiated: its tables are read from its
custom sections and merged on copies, committed whole once every id, brand
and field contract agrees, and the module's start function and data never
reach a memory that rejects it (one compilation, or the same module again,
shares; the host references of a memory are one table for every module in
it). A class layout carries its brand
(`jz:brand`, `Name#id`), so two classes with one field list are two schemas,
and a host object matching such a layout by keys alone is ambiguous rather
than silently bound. Booleans preserve their identity; exposed BigInt fields are tagged,
including shapes shared by BigInts and numbers. Returned object literals have
independent storage, so mutating one result cannot change a later result.

Plain arrays retained by the host have open element types. Typed arrays retain
their storage policy; fresh arrays can specialize while being constructed.
An indexed store through a host object's array-valued field commits the copied
container back to its captured owner. Reference staging retains that owner with
the receiver temporary; only the actual store performs the write-back, so a
short-circuited logical assignment or a thrown operand does not invoke a setter.
Native containers already share storage and require no write-back.
Allocations round upward to eight-byte alignment without signed address
truncation. Allocation may grow memory and invalidate views: retain handles and
reacquire views through `memory.read()`.

Array/object writes stage replacement values before committing contents and
length. If staging throws, the destination is unchanged; allocations remain
until reset and user getter effects are not rolled back. `memory.reset()`
invalidates handles allocated after the reset base. Owned memory retains
module-initialized state. Imported/shared memory resets the entire arena and
requires re-instantiation before calling the module again. Direct writes and
forged pointers bypass these checks.

### Experimental ABI

Prebuilt Wasm must use matching compiler and interop revisions. The raw ABI has
no independent version marker and is not frozen: NaN-box layouts, `_alloc`/`_clear`,
the closure table, `jz:hostabi`, `jz:i64exp`, `jz:schema`, `jz:fields`,
`jz:errcls`, `jz:brand`, schema IDs,
`memory.fieldContracts` and the `_`-prefixed exports are all current-toolchain
policy, regression-tested in `test/abi.js` but not cross-release-stable. Use
`jz/interop`'s `instantiate()` or pin the exact compiler version when
implementing a raw host. BigInt arguments require compiler-emitted slot
evidence when the slot is used; unsupported slots throw `TypeError`. The
shared binding-use census marks wholly unused parameters in `jz:hostabi.skip`.
The wrapper supplies neutral carriers without reading or converting those
arguments, preserving undefined for default initializers. It also skips unused
rest packing and arguments beyond a non-rest function's arity. Defaults and
captured reads participate in the census (`test/interop.js`). Kernel byte identity is not
promised across releases. The low-level interop helpers (`wrap`, `coerce`, bit
conversions, pointer/tag accessors, NaN constants, `toModule`, `wrapVal`,
`alloc`, `allocTyped`) exist at runtime but are not declared in the public types.

### Known limitations

- DataView indexed own properties are unsupported; indexed writes reject.
  Unextended views have no `.length` or indexed elements.
- Used rest-parameter BigInt elements lack boundary evidence and reject.
- Array patterns share lazy pulls, undefined-only defaults and IteratorClose on
  early completion or binding errors. Native Map/Set views are snapshots.
  Indexed values cannot override their iterator.
- Resizable `ArrayBuffer` (`maxByteLength`, `resize`, `transfer`) is unsupported.
- Async generator functions work; async generator methods and `await using` reject.

## Commits

Small, focused commits. Describe what and why, not how.

### Runtime inspection

`compile(source, { inspect: true }).inspect.runtime` describes final Wasm exports,
including reachable helpers. `noAllocation`, `noHostCalls` and `boundedWork` are
`true` only when proved; `null` means unknown. `maxInstructions` is a conservative
instruction-count upper bound, not a latency estimate. A `call_indirect` resolves
to the closure table's own entries when that table is closed — declared here,
neither imported nor exported, never written — and stays unknown otherwise. The
`native` host exports no table, so its closure calls resolve; `js` and `wasi`
export `__jz_table` for their embedders and keep them unknown. Recognized constant-bound
integer loops currently use a full i32-domain bound; many SIMD, dynamic-bound and
recursive shapes remain unknown. Shared-memory writes leave allocation unknown.
These facts exclude initialization and host marshalling and do not certify an
audio deadline. Inspection does not alter output bytes.

`memory.fixed` selects exports for a final-code memory proof, sharing that
inspection's call/effect census (`compile/func-inspect.js`). The proof rejects
allocation, host/open-table calls and cycles, and checks every hidden typed
variant. `compile/fixed-memory.js` follows the settled frame census to named
callees and plans non-escaping constant-size typed locals after the function
plan is installed. Placements belong to a function signature and constructor
node, never to the length expression (named sizes can recur). Equal layouts share a static slot only
across disjoint top-level statement spans: an entire loop/branch is one span.
Numeric keys cannot expose `.buffer`; captures, aliases and identity uses
decline placement. Constructors clear the slot at their original site. The
normal static-data writer, rebasing and heap-base calculation own placement.
Before Wasm inlining erases function identities, scratch owners must also prove
non-reentrancy in every call context, including unselected exports. Scratch
slots belong to the instance.
The contract disables `arenaReach` for the whole module; ordinary exports may
still allocate. It does not certify host marshalling or wall-clock latency.

Levels 2 and above carry integer accumulators in guarded i64 loops, whether or
not a ToInt32 read is present: the carried update alone shortens the chain. It restores f64 on exit or before leaving the exact-integer
range. Exception handlers, negative-zero constants, numeric local aliases and
live guard temporaries decline the transformation. The size tier retains one
loop; its structural size/work budgets are unchanged.
An unrelated local read as a float declines only its own integer carrier;
the remaining carriers are rechecked from the original loop. Structural tests
verify each widened loop never reads its original float accumulator, allowing
independent float counters to keep their comparisons and conversions.
Accumulator versioning runs after SIMD lowering and signed-word narrowing: its
bailout scaffold must not hide a Number loop or a stronger checked-access i32
proof. Scalar tails and remaining wide carriers still receive the same guarded
integer optimization.

Returned closures decoded by `interop.mem.read` hold their environment just as
a typed-array view holds its backing storage. Mark the handle before constructing
the host callable, including closures nested in copied arrays, objects and Maps;
a later releasing export must not reuse that environment. `test/call-release.js`
retains factories and mutable counters through repeated factories and scratch calls.
