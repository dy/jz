# Contributing to JZ

## Quick start

```sh
git clone https://github.com/dy/jz.git && cd jz
npm install
npm test              # core suite
node bench/bench.mjs  # run benchmarks
```

### Shared watr optimizer

`package.json` depends on the published subscript 10.8.0 (the surrogate-pair
escape decoding and the async-member parse fixes) and watr revision `5ed6b5d`
(on 5.11.3). This pin includes the scheduler fix that keeps result-producing
calls at the end of folded blocks; effect purity alone does not prove a
statement has no result. The WAT printer joins fragments once per node so wide
functions do not repeatedly copy their growing text. Both kernel output formats
share compilation, optimization and heap checkpoints before encoding or printing. Return to a published version once it carries the fix.
The dependency also
carries the two optimizer rules jz's speed rows rely on: the mixed-sign
truncation-of-convert fold under a non-negative operand (base64's decode
loop) and `ifset` leaving a branchy condition alone (heapsort's child pick).
It also lifts a first operand's block prefix without crossing an earlier
evaluation, closing the watr size backstop. A clean install includes these rules.

Generic local propagation and merging run in watr after linking, including
the fast tier. The same local-slot allocator runs in the lightweight tail,
including level 1: disjoint temporaries share storage instead of inflating
recursive stack frames. Its lifetime proof preserves implicit zero values,
conditional writes, nested branch exits and loop-carried values. A branch that
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
Source inlining gives mutated parameters private local storage and captures
their arguments in call order; substitution must never write a caller's binding.
Small loop helpers enter exported loops only after their callees have expanded,
so the size budget includes the work being moved out of a tierable function.
Typed-width loop versions accept stable local receivers as well as parameters.
They validate the complete Float32/Float64 carrier, snapshot fixed storage and
retain bounds checks, f32 rounding and the original assignment value. Numeric
store proofs permit direct writes; coercing values and other element types keep
their existing helpers. A second stable numeric read receiver can cache its
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
Known-local arithmetic folds in the same propagation pass; JZ only selects
this policy with its existing `hoistConstantPool` option.
Exact cast identities have one owner in watr: JZ calls `simplifyCast` during
early SIMD preparation, and watr uses it in its final identity sweep. Narrow
stores discard irrelevant casts and masks. Integer constant pooling uses
canonical bits rather than source spellings and skips literals too cheap to pool.
The downstream watr workflow builds and tests with the same current JZ package.
See [PLAN.md](PLAN.md) for remaining gates and DSP evidence.

Load reuse visits reads and writes in evaluation order. A shared load executes
at its first occurrence, never before preceding operands; identity-observing
uses retain undefined, while numeric-only uses normalize it. Index definitions
come from the binding census and positive bounds apply only inside their strict
loop guard. Every counter proof rejects additional writes in the loop step.
Mutable loop bounds stay in the loop until IR memory-effect analysis proves
invariance. Prepare does not infer method purity from a name. Immutable string
and typed-array lengths may move when the binding is stable; the shared
reassignment census includes writes by closures and the loop step.
Address CSE ends regions at branch targets and exception boundaries, and keeps
dependency invalidation valid when restoring a sibling arm's incoming regions.
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

Runtime helper templates may emit string literals. Shared string-pool setup
runs after their realization, before reachability; otherwise the pool's copy
length can omit constants that the linked helpers read.

Nonempty array literals reserve their stated length. Empty builders retain the
speed tier's growth reserve, and proven builder bounds still preallocate enough
capacity. `arrayLiteralMinCap` remains an explicit override for kernel builds;
smaller initial storage uses the existing alias and named-property forwarding.
Named-property sidecars start with two slots at every tier and grow on demand;
the speed tier's array reserve does not apply to those sparse property tables.
Collection growth uses `collectionStride` for the entry and optional hash lane;
a boolean selecting the lane is not its byte width. Dictionary slot updates
receive keys already normalized to strings. The host decoder follows forwarding
for arrays and collections and reads collection entries in their stored insertion
order, excluding tombstones.
Derived closure-class members reserve a hidden enumeration rank in the existing
hash entry. Growth preserves it; an ordinary assignment gives the entry a new
own rank and invalidates enumeration caches. No collection entry grows.
Function arity is source arity (before a default or rest parameter), indexed by
closure table slot independently of body deduplication. Its byte table is linked
only when a length reader is reachable.


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
ToPrimitive/string/BigInt helper, with plain numbers kept inline. Present typed
BigInt reads retain their raw-payload fact, while checked reads box only the
successful branch. Atomic value operations share the existing operation catalogue
with the summary: their result is an element or an exception, never undefined.

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
assignment-bound literal and a bracket-string store too. A call through
a binding the fixpoint knows only as nullish so far, and a spread of a nullish
value, contribute nothing rather than escaping their operands: both throw at
run time, and an escape is permanent. A loop's test guards its body the way an
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
miscompiled).
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
The interval interpreter spans the full signed word; overflowing transfers
become unknown. Integer payloads alone never prove bounded accumulation.
Counted reductions combine element bounds with the trip count, including every
intermediate step. Counter proofs reject additional writes in the loop header.
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
Local and result storage also reuse those presence proofs. A missing integer
element keeps its undefined value through copies and returns; using it as an
index must not read element zero. Canonical loop proofs refer to exact access
nodes, so an access outside the loop cannot borrow their bounds. Uint32 locals
whose every write is proven unsigned retain their magnitude via the existing
unsigned carrier flag. Primitive parameters consumed only by word operators may
convert once at the call boundary, as established by the binding-use census.
Comparison emission and folding share one signedness proof: equal word bits
do not imply equal numbers across signed and unsigned domains.
Checked reads share one lowering for integer conversion and comparison:
conversion maps absence to zero; comparison keeps the answer for undefined.
Dependent index reads use branches to avoid address clamps on serial load chains.
They also share exact integer expression narrowing, including conditionals;
early conversion folding cannot hide those integer branches from SIMD lifting.
Saturating integer conversions opt into the shared floating range query's
NaN-aware mode. It bounds numeric outcomes while admitting NaN, which converts
to zero, so checked integer reads need no arbitrary-number conversion helper.
The ordinary range query still proves finiteness; infinity remains unknown.
Ranges obtained from a local's definition include its implicit zero value:
the write may be conditional, and arithmetic can make that skipped-write path
differ from the definition's value before integer conversion.
Counted floating recurrences reuse that range query and the local write census.
Every loop entry needs a proven initializer; unknown entries, numeric aliases,
extra backedges and additional writes prevent the proof. Integer enclosures
bound rounding at every addition without reassociating the arithmetic. These
bounds remove only the ToInt32 infinity guard, retaining the f64 accumulator
and its captured value. The peephole and wide-accumulator pass share the exact
conversion recognizer; arbitrary selects and property-key guards remain distinct.
Local typing and emission share the interval-product proof, including the
negative-zero check; a product fitting i32's magnitude alone is insufficient.

Typed constructor provenance describes storage, not presence. A field or index
result needs a separate non-nullish proof before pointer unboxing: the
summary's, or for `arr[i]` over a hole-free array, the loop's in-bounds proof
(`inBoundsArrIdx`), so a record visitor's element pointer stays raw. A static
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
reads capture the receiver before evaluating the key. Speculative loop extents
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
the key may name a property, which stores the value unchanged.
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

Named functions stored in internal objects or bindings retain their identities
in the summary's existing closure sets. Calls through those values bind the same
parameters and result facts as direct calls. Unknown uses and host exposure still
open the facts; taking a function's address retains the boxed callable-value ABI.

LICM extraction is shared through watr's `hoistInvariants`: traversal, private-local
checks, structural deduplication and temporary typing have one owner. JZ supplies
per-loop invariance and speculation-safety proofs for its helper calls and memory
representations, plus profitability policy. Watr's standalone proof remains
conservative about memory and calls. Proofs are invocation-local callbacks over
Wasm instructions, never properties attached to instruction arrays. JZ still calls
the shared engine before and after address rewriting; watr calls it after inlining.
Those distinct maturity points remain necessary for current lowering patterns.
The shared engine counts local references once per function and updates that
census when deduplication removes copies or introduces a temporary. Each loop
checks private writes against it without rescanning the whole function.
JZ uses watr's instruction-effect classifier for every memory-write family;
unknown write targets block alias-dependent motion. Buffer origins follow
single-definition locals and closed scalar recurrences; other origins remain
unknown. Allocating
helpers cannot be speculated before zero-trip loops or crossed by allocator-global
reads.

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
layout is bound for the per-name slot paths, which keeps a flattened object
property out of the function namespace box. Definite means the store runs
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
`flattenFuncNamespaces` witnesses it by a top-level property store on a
function), so the pass sees the flattened global as a literal-bound name. A conditional store keeps
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
round; one the kinds decide walks only its live arm. A rest parameter is a
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
Lookup dependencies name hashing/equality directly, not mutation helpers.

Source inlining builds the exported expression subset once per pass. A
local arrow bound by `let` and only ever called inlines like a `const` one
(the mention check rejects any write to the name, so a surviving `let` is a
const); `optimize: { sourceInline: false }` keeps every closure form. A
declaration splices each of its declarators (`const r = f(a), g = f(b), b =
f(c)`, each its own statement in order); more than one declarator splices only
in an innermost loop, where the call it removes is what kept the lane
vectorizer out. Nested-call
hoisting uses its body map for membership too, and reuses that map through the
current function's rounds, before the function record's body is replaced.
An eligible callee's single early return folds into a guard. When it returns a
value, both paths assign one fresh result binding before the trailing return;
only the chosen path runs. Eligibility is checked before normalization so an
outlined function does not acquire unnecessary control flow or locals.
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
Compile-time bitwise and integer-store folds share exact ToInt32 conversion;
large constants reduce modulo 2^32 before the compiler's runtime i64 boundary.
Runtime typed stores, DataView, Atomics values and UTF-16 unit construction
share exact ToInt32 lowering. Proven ranges keep direct conversions; unknown
values recover their low word from the IEEE significand beyond the i64 range.
Intrinsic and user calls share excess-argument sequencing. Collection probes
retain precomputed literal hashes while using the same boxed-value conversion.
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
undone. A typed read emitted as proven marks its IR `presentNumRead`, so the
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
guards; negative offsets participate in the lower bound. A nested level lifts
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

`analyzeBody` caches observations, not an immutable semantic snapshot. Its
signature fingerprint covers only the current function signature. Every other
dependency has an explicit invalidation owner:

| Dependency changed | Invalidation before the next dependent read | Owner |
|---|---|---|
| Function body or specialization AST | `setFuncBody` / `reanalyzeBody` | Source rewrite and specialization passes |
| Current parameter/result signature | Live fingerprint; explicit seams during solving | `body-facts.js`, `narrow/results.js`, `narrow/param-abi.js` |
| Function value/type/length overlays and caller facts | `reanalyzeBody`; `invalidateBodies` for affected callers | `narrow/caller-ctx.js`, `narrow/results.js`, `narrow/param-abi.js` |
| Summary, global types/lengths, schema integer census | `invalidateAllBodyFacts` at publication/phase boundaries | `plan/index.js`, `compile/index.js` |
| Compile session | New fact store / `resetBodyFactsCache` | `session.js` |

Global invalidation clears the complete cache, including anonymous roots.
Every rewriting seam, and every plan sweep that reports a change, also advances
one program revision. The summary is keyed by it and by the contents of the
registries beside the program (schemas, functions, globals, binding schemas),
and is rebuilt only when the key moved (`summarizeProgram`,
`src/compile/index.js`). `JZ_DEBUG_INVARIANTS=1` checks each reuse against the
summary's full inputs, so a rewrite that bypasses the seams fails there.
Signature checking does not authorize stale overlay reads. New passes use these
existing seams; they must not add another cache or rely on ambient facts staying
unchanged accidentally.

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
src/
  prepare/      validate, normalize, extract exports/imports (index.js)
  compile/      analyze → infer → plan → narrow → emit; ProgramIndex; program facts; driver (index.js)
                analyze/frame-effects.js: per-function and per-loop escape census (what outlives a frame or an iteration)
                plan/lanes.js: record parameters as scalar lanes (a parameter read only field by field, at literal or known-shape sites)
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

**Stdlib registration — two dialects, by design:** raw `ctx.core.stdlib[name] = body` / `ctx.core.emit[name] = fn` (or the `bind(name, fn)` sugar) is the DEFAULT for dep-free, arity-irrelevant handlers — the overwhelming majority of the stdlib (~580 sites vs ~35 `reg()` calls; this is real, not legacy-to-migrate). Call `inc('__dep', …)` inline in the handler body for any stdlib kernel it needs. `reg(name, deps, fn)` (→ `emitter()`, `src/ctx.js`) — or `wat(name, body)` for the WAT-kernel half, co-located via `reg(name, { deps, wat, emit })` — is REQUIRED whenever either mechanical property matters:
  - **deps must be auto-included, not hand-called.** `emitter()`'s wrapper runs `inc(...deps)` before every invocation of `fn`; anything that wraps/aliases the handler (`dual`, `.deps` propagation, a second name bound to the same function) inherits the guarantee for free. A raw handler's `inc()` call lives only in its own body — copy or wrap it and the dep silently drops.
  - **logical arity diverges from `fn.length`.** `emitter()`/`call()`/`method()` set `.argc` explicitly, which `emitArity()`'s fallback (`h?.argc ?? h?.length`) needs whenever a handler is built through a rest-param wrapper or otherwise doesn't report its true arity via `Function.length`. Plain raw handlers work fine on the `.length` fallback *only when the two agree* — that's the common case, hence still the default.

  The one hard, mechanical rule for either dialect: **never introduce a second write for a FLAT name already registered** — it used to silently overwrite the earlier handler (dropping `emitter()`'s auto-inc/argc guarantee when the earlier write was a `reg()`) with no error. It no longer can: `reg()`/`wat()`/`registerGetter()`/`bind()` (`src/ctx.js` `registerName`) refuse to register a FLAT name (no `:`) that's already occupied — by an earlier raw/`bind()` write *or* an earlier `reg()`/`wat()`/`registerGetter()` call, in either order, through either dialect — and throw immediately, naming both the module registering now and the module that got there first. A guarded `ctx.core.emit` handler clobbered by a *later, genuinely raw* (non-`bind()`) assignment — undetectable at the moment of that write, no Proxy in the self-compilable subset — is caught right after the clobbering module's `init()` returns (`verifyEmitIntegrity`, wired from `src/autoload.js` `includeModule`), by comparing the live table entry against the exact value reference `registerName` stored at registration time. **Type-qualified keys** (`.date:valueOf`, `.string:padStart`, …) are the one exemption: namespaced by design, one physical owner (the type's own module) per key, so `bind()` leaves them on the old unguarded raw write — cross-module collision there was never the hazard. What used to read as a legitimate "generic default, specific override" chain on FLAT names (e.g. `date.js`'s raw `.valueOf` over `string.js`'s `bind('.valueOf', …)`) was never actually that: it was this exact silent-collision class, and it corrupted `.valueOf()` on every unresolved-type receiver for as long as it shipped (`.work/archive/printer-trio.md`). All throw paths are exercised by `test/passes.js`'s stdlib duplicate-registration tests.

**kind vs type:** `kind.js` = value family (STRING, ARRAY, …). `type.js` = WASM numeric type (i32/f64), typed-array ctor detection, integer proofs, loop-unroll helpers (the pure PTR.TYPED aux codec lives in `layout.js`). **AST walks:** use `refsName`/`refsAny`/`some` from `ast.js` — don't hand-roll name scanners.

**ProgramIndex:** `src/compile/program-index.js` owns four disjoint numeric spaces: `sourceId` for prepared/imported functions, `variantId` for specializations, internal `graphId` for callables present when SCC reachability freezes, and `concreteId` for the final Wasm emission order, assigned once after variant identity closes (`finalizeConcreteFunctionIds` freezes `ctx.funcs.list`, so the registry carries existence, never order). At that close, `publishParameterAbi` transfers the settled parameter rows to concrete-ID slots and `programFacts.paramReps` is deleted; emission reads `parameterAbiOf`, never a name-keyed lattice. Analysis and emission follow `reachableForLowering`: a named function the frozen graph does not reach publishes no FunctionPlan and emits nothing, while prepare still rejects unsupported syntax in every body. `npm run test:reach` is the completeness gate for any change to the call-site census, roots, or edges. Use only the matching accessors (`sourceIdOf`/`sourceFunctionById`, `variantIdOf`/`variantFunctionById`, `graphFunctionIdOfName`/`graphFunctionById`, or `concreteIdOf`/`concreteFunctionById`/`concreteFunctionOrder`). Generic `functionById` and `functionIdOfName` do not exist. Every variant records one source ID; variants of variants normalize to that source. `materializeVariant` is the sole registration writer, and `finalizeVariantIdentities` closes the space after union-cursor specialization while asserting that signatures, parameter facts, and FunctionPlans are derived rather than shared. ProgramIndex also owns same-module member targets, address-taken bits, direct edges, roots (host-callable functions through the canonical `isExported`, which resolves aliases and bundle re-exports; the raw `func.exported` flag means only "declared with `export` in its own module" and is read solely by the inline-export-attribute sites in `emit-func.js` and `boundary-wrap.js`), SCC spans, reachability, and BigInt parameter/result boundaries for every callable: named sources and variants in the frozen ID arrays, anonymous closure/start identities in the append-only anonymous space (they materialize during emission, after variant identity closes). The boundary arrays carry the C1-C5b and Shape 6-9 conditions listed in `program-index.js`; RepresentationPlan owns body-local actions only. ProgramFacts carries a mutable `addressTakenNames` census only through index enrichment; ProgramIndex converts it to numeric bits and deletes the source-name key before narrowing. Every later reader uses `ProgramIndex.addressTaken`. Do not restore another function registry, member-target table, address-taken compatibility view, name-keyed target cache, or call-graph writer.

## Architecture

Current pipeline: `source → parse (subscript/jessie) → jzify (always on; the test-only `strict` option skips it) → prepare → compile → optimize → link → watr (WAT→binary)`

**One shared optimizer, owned by watr (`~/projects/watr`).** Generic optimizer changes belong there, with tests in both projects. JZ supplies language-specific analysis, representation contracts, and lowering. The existing generic passes in `src/optimize/` are migration work: consolidate them into watr and delete JZ copies, rather than building a competing optimizer. Never patch only `node_modules`.

The tape (`src/ir/tape.js`) transports WAT through link. Settled program summaries own semantic facts; watr owns generic optimization. [PLAN.md](PLAN.md) prioritizes reliable builds and stateful audio DSP. Further IR or state refactors need a demonstrated defect, bottleneck, or deletion. Each migration slice deletes the authority it replaces.

Float32Array storage does not lower JavaScript arithmetic precision. Maps and
stencils choose their computation lanes together: f32 loads promote to f64x2,
arithmetic stays f64, and stores round to f32. Copies and sign operations can
retain f32x4 lanes. Narrow integer stores preserve the scalar conversion.

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
Record scalar replacement uses one validator for field access, nonescape and
whole-record replacement. Replacement values evaluate before any field changes;
aliases, captures, differing field sets and observed record values keep storage.

Strings store UTF-16LE code units; lengths and positions count units, while
allocation sizes and addresses count bytes. Short ASCII strings retain the
six-unit SSO representation. UTF-8 encoding belongs to byte APIs and Wasm text
metadata; host string marshalling preserves lone surrogates. Schema property
names use JSON escaping inside UTF-8 metadata to preserve every code unit.
Heap-string equality compares four code units per load with a code-unit tail;
substring views never require loads beyond their logical length.

Static data uses owned `Uint8Array` chunks (`src/static-data.js`). Producers write
bytes directly; relocation adjusts those bytes, and only WAT escaping converts
them to text. Never use `String.fromCharCode` as a binary serialization layer.
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
through record fields would leave stale links after a reset.

An async body suspends only at statements (`jzify/generators.js`: a yield as a
statement, or the right side of `let x = yield E` / `x = yield E` /
`x.f = yield E`), so `jzify/async.js` hoists every other `await` first: the
awaited value lands in a temp declared before the statement; what the
statement evaluates before that await lands in temps ahead of it, a callee and
an assignment target staying in place; a short-circuit or conditional whose
later arm awaits becomes an if statement assigning a temp; a loop whose test
awaits tests at the top of `while (true)`. Class lowering (`jzify/classes.js`)
takes `static async` methods on both of its paths and a bare `super()`, and the
member census counts an optional method call (`o.m?.()`) as a read, since the
call binds the method as a value first (`src/compile/emit/class-dispatch.js`).
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
the closures the shapes hold under the name; `includes`, `indexOf` and
`lastIndexOf` keep nothing of their argument, `slice` yields a copy with a
cell of its own whose elements are the row's positions from a literal start,
and any other name on an array is a property beside the elements; shape sets
of up to 64 layouts. A class
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
layouts without a guard. An accessor is a function of its class (a derived
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
the dynamic path. A slot the layout
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
else v = 1`, `let x = c && 1`) and whose reads observe its identity (a
return, a `typeof`, a strict compare, a store: the summary's numeric demand
pass denied it a number) is a tagged carrier (`boolTaggedBinding`,
`src/compile/emit/dispatch.js`): every Boolean store lands as its atom, a
merge keeps its Boolean arm boxed (`emitIdentitySafe`), its storage is the
tagged f64 (`analyze/body-facts.js` Pass E, over a known union only, never
the unknown kind), and no flow fact of one store's kind is recorded for it.
A binding read only for truthiness or arithmetic keeps the raw carrier. The
compile-time rejection remains for the one case a plan typed such a binding
as one concrete non-Boolean kind.

Every array position argument (fill, copyWithin, slice, splice, with, the
search methods' fromIndex) is captured and coerced through `positionArgs`
(`src/bridge.js`): ToIntegerOrInfinity converts a string, reads a Boolean as
0/1, takes the default for undefined, saturates ±Infinity and throws a
TypeError for a BigInt, after the receiver and earlier arguments are
evaluated. `splice(...args)` reads start, count and inserts from the argument
array at run time. A typed array constructor's argument is ToIndex for a
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
undefined. The receiver is captured before arguments, and generator/async
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
its parameter list. A default runs only where its argument is missing, so the
summary treats its writes as conditional. A store into a fresh local aggregate, a binding
declared in the body whose every write is a literal or a `new`, is a store into
fresh memory. A nested function's writes count wherever it is made, a
declaration's initializer included. A callback a builtin runs (an array
method's, `Array.from`'s map function) is walked as part of the frame; a
callback name resolves to its arrow only while no nested function rebinds it. In a program that defines
`toString` or `valueOf`, converting a value the summary cannot prove primitive (an operator's
operand, a property key, a builtin's argument, a typed element store) is a call to the
ToPrimitive function it lowers to (`runsConversion`). The arena rewind (`src/optimize/arena-rewind.js`) restores the
heap pointer at return for any function with a scalar non-pointer result whose
frame is not `arenaUnsafe`, parameters included; the link pass adds what the
source cannot show: a `global.set` of anything but the heap pointers, the error
transport and the insertion stamp; a `call_indirect`/`call_ref`; a host import
that takes arguments (the interop `$__ext_*` imports copy what they receive); a
runtime kernel that stores through an address a mutable global reaches (a
durable log, a property cache); a tail call, except one into a safe kernel,
which becomes a plain call under the restore. Vetoes propagate to callers, so a
cycle of clean kernels stays safe; allocation counts through callees. The
durable-heap logs are census-guarded: they record only outer-container
mutations, which no rewind candidate performs. `whyNotRewind` names the reason
for every declined candidate. Load CSE (`src/compile/cse-load.js`) keeps a
cached typed-array load across a call whose callee does not `writesOuter`; any other
call or user conversion invalidates after its operands, which run first. A store keeps
a cached load only when it cannot reach the element: storage that never holds typed
elements, or the same element grid (the same binding, or two non-view typed arrays of
one constructor) at a provably different index. A view or another element type over the
same buffer shifts or splits the grid, so an index inequality proves nothing there.
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
leaves valid are no veto: the inline caches key on the schema id in a
pointer's high word, and the dynamic-get cache is kept coherent by every
writer of the table it mirrors, which no rewound frame reaches; the for-in
key cache holds an array a rewind may free and stays vetoed. Truly shared memory (`sharedMemory`) rewinds
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
pin the source's own functions).

Generic reads in the self-compiled kernel cost helper entries, and the warm
self-compile gate is paid in them. Five rules keep the common shapes inline:
a typed array that may be unset indexes through its payload kind after the
nullish check, and a key the summary cannot type still indexes directly once
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
typed read it specializes. The summary keeps typed-array named properties
per element type (`typedPropsByAux`): a property stored on a `Uint8Array`
never reaches a read of an `Int32Array`, and an escape opens no cell, since
a typed array's properties come from stores the walk sees or from a builtin
that writes its argument (`escapeObject`); the host holds a view of the
elements alone.

The export boundary is numeric for a parameter used only as a typed-array
index or stored into a typed array (README, "Host boundary"): the usage scan
(`src/compile/param-numeric.js`) counts those uses as numeric, reading the
receiver's typed kind from the summary as well as its declaration. A program
that wants the host's property keys takes them as strings (`key = '' + key`,
JS's own ToPropertyKey); inside the program the summary knows a string key and
the typed-array property semantics hold.

`charCodeAt` on a concatenation dissolved into raw (buf, len) locals reads
16-bit units at `i << 1`; the byte-indexed read it had after the UTF-16 move
was the strbuild checksum regression.

ToInt32 of a value whose range is proven finite and below 2^63 (`f64Range`:
literals, counters, `Math.floor` of a bounded product, a checked byte read) is
`i32.wrap_i64(i64.trunc_sat_f64_s)` with no ±∞ guard, and the i64 form is
kept on purpose: V8's arm64 lowering of `i32.trunc_sat_f64_s` adds a float
round-trip and range checks (bytebeat 1521 → 1370 µs; a 5e7-iteration micro
294 ns against 446). An unproven value keeps the guarded select. The
`__to_int32` helper stays a call where its argument is a checked read's
Number|undefined: folding it to the inline truncation measured 17% slower on
glyfparse (the representation of ToInt32-blind reads is the open lever there).
Load CSE (`cse-load.js`) keeps a condition's typed loads available past an
`if (C) break|continue|return|throw` with no else, since the statements after
it run only when C ran and fell through, and one load serves an
identity-observing use and a numeric one (the numeric use normalizes the
temp): heapsort's sift compares and then swaps without reloading. A
small-constant loop unrolls only within 1000 body nodes in total (trips ×
body): noise's four octaves of an inlined perlin ran 3.6% faster rolled.
watr's `ifset` (one-armed `if` → `select`, the speed profile) leaves a
condition that branches itself alone: heapsort's child pick `if (child + 1 <
n && a[child] < a[child + 1]) child++` as a select over the lowered `&&` ran
35% slower than the branch.

`x ** c` with a constant non-integer exponent is the `$math.pow` kernel, one
implementation for constant and runtime exponents within an ulp of the host:
Arm's optimized-routines pow, a double-double log from a 128-entry table
(`scripts/pow-log-table.mjs` derives and checks it) and the shared exp
table, 10 ns a call against V8's 6; the ladder in front of it takes the
common case (a positive finite base, a non-integer exponent) straight to
the kernel and walks the edge cases only for the rest. The constant fold
in `src/prepare/math-kernel.js` is the kernel's twin, bit for bit.
The k/5 fifthroot fold runs four Newton steps (the last a correction) and
measures a worst case of ~40 ulp across its exponents against the exact
rational power, which `test/pow.js` pins under a 96 ulp ceiling. The lane vectorizer lifts a constant-exponent pow per lane through the
same kernel, bit-exact with the scalar loop. A second algorithm (exp∘log, or
the three-step fifthroot) is never the default: a meaningful result keeps its
f64 accuracy. `Math.exp` and `2 ** x` are one table kernel (`math/trig-tables.js`
EXP2_TAB: 2^(j/64) as the nearest double and the tail its rounding dropped;
`scripts/exp-table.mjs`): reduce to |f| ≤ 1/128 (exp on its own ln2/64 split,
head and tail), T + T·(q + tail) with q the exact-coefficient remainder
series, one exponent build; 0.52 ulp against a 200-bit reference for both,
scalar, 2-wide and the constant folder bit-identical (`test/math.js`).

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

## Principles

- **Don't contort compiler source for microbenchmarks.** Readability wins in `src/`; optimize compiler time and retained memory only from measured, general evidence. Output speed and size remain the primary product budgets.
- **JZ source is JavaScript source.** Supported programs must parse and run as standard JavaScript. Parser acceptance of an ECMAScript early-error-invalid program is a bug/temporary hole, never a language extension or compatibility promise.
- **A finite speed dialect, not an open-ended escape hatch.** Compiled output follows the machine semantics explicitly listed under [“What differs from JS?”](README.md#what-differs-from-js): i32/i64 wrapping and the other enumerated cases. Outside that list, preserve JavaScript answers, exceptions, evaluation order, and effects or reject. “A native compiler could do it” is not sufficient authority for a new divergence: update the public contract and add cross-tier exact tests before landing one. Never trade away a meaningful result's f64 accuracy (no mantissa trimming or arbitrary precision loss).
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

Tests use [tst](https://github.com/dy/tst). Each file in `test/` is self-contained. Run all:

```sh
npm test
```

Run one file:

```sh
node test/strings.js
```

The suite runs once per compiler configuration (`npm run test:matrix`: default,
opt0, opt3, wasi; CI runs the four legs in parallel). A test that must hold at
several optimize levels writes `for (const optimize of levels(false, 2, 3))`
(`test/_matrix.js`): each leg runs its own level and the plain default leg also
runs O1, which no leg carries, so the matrix supplies the sweep instead of every
test compiling at every level on every leg. `JZ_TEST_SWEEP=1` runs the whole
list in one process. Files that build the kernel, spawn tooling, or pass every
option themselves are listed in `LEG_INVARIANT` / `OPT_INVARIANT` in
`test/index.js` and run on the default leg only; naming a file on the command
line runs it on any leg.

Shared helpers live in `test/util.js`: `run` (exports), `wat` (text),
`oracle(src)` (the same program evaluated by Node), `agree` (jz equals Node for
one call), `funcWat` (one function's WAT), and `cases(rows)`, which compiles a
table of `[label, arrowSource, want, ...args]` rows as one module. A compile is
almost all of a test's cost, so a family of one-assertion programs belongs in one
`cases` table, not one compile per assertion.

Release semantics also run `npm run test:262` and
`npm run test:262:builtins`. Negative-parse acceptance is an exact path set,
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
`instantiate` and `memory`; the eleven compile options in `index.d.ts`; and the
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
Allocations round upward to eight-byte alignment without signed address
truncation. Allocation may grow memory and invalidate views: retain handles and
reacquire views through `memory.read()`.

Array/object writes stage replacement values before committing contents and
length. If staging throws, the destination is unchanged; allocations remain
until reset and user getter effects are not rolled back. `memory.reset()`
invalidates handles allocated after the reset base; module-initialized state
remains live. Direct writes and forged pointers bypass these checks.

### Experimental ABI

Prebuilt Wasm must use matching compiler and interop revisions. The raw ABI has
no independent version marker and is not frozen: NaN-box layouts, `_alloc`/`_clear`,
the closure table, `jz:hostabi`, `jz:i64exp`, `jz:schema`, `jz:fields`,
`jz:errcls`, `jz:brand`, schema IDs,
`memory.fieldContracts` and the `_`-prefixed exports are all current-toolchain
policy, regression-tested in `test/abi.js` but not cross-release-stable. Use
`jz/interop`'s `instantiate()` or pin the exact compiler version when
implementing a raw host. BigInt arguments require compiler-emitted slot
evidence; unsupported slots throw `TypeError`. Kernel byte identity is not
promised across releases. The low-level interop helpers (`wrap`, `coerce`, bit
conversions, pointer/tag accessors, NaN constants, `toModule`, `wrapVal`,
`alloc`, `allocTyped`) exist at runtime but are not declared in the public types.

### Known limitations

- DataView indexed own properties are unsupported; indexed writes reject.
  Unextended views have no `.length` or indexed elements.
- Ambiguous Boolean/Number locals whose stored identity escapes reject;
  truthiness-only uses compile.
- Rest-parameter BigInt elements lack boundary evidence and reject.
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

Levels 2 and above carry integer accumulators in guarded i64 loops, whether or
not a ToInt32 read is present: the carried update alone shortens the chain. It restores f64 on exit or before leaving the exact-integer
range. Exception handlers, negative-zero constants, numeric local aliases and
live guard temporaries decline the transformation. The default and size tiers
retain one loop; their structural size/work budgets are unchanged.
