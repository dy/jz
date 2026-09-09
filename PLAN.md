# JZ plan

## Purpose

Compile JavaScript audio DSP efficiently for audiojs.dev: JS → Wasm → VST.
JZ is a compiler option; Porffor may replace it. The plugin host must depend on
an explicit DSP interface, not JZ's internal object layout or compiler IR.

The useful result is a plugin that sounds correct, meets its audio deadline,
and installs reliably. Compiler architecture serves that result.

## Next work

1. **Close the v1 release gates.** UTF-16 migration is implemented and functionally
   verified below. Fix the remaining enumerability/reflection failures, then
   measure and recover speed/size on a machine within the evidence limits.
   Keep downstream compiler and interop revisions matched when rebuilding.
2. **Prove stateful DSP lifetime.** The gain fixture in `@audio/compile` now
   passes 132 checks per compiler (JZ and Porffor), including parameter queues,
   overlapping instances and 12,000 blocks without observed heap growth.
   Gain is stateless: next use a filter or the existing compressor to exercise
   exact frame counts, variable blocks, persistent state and instance teardown.
   Keep the same source and JS oracle for both compiler chains.
3. **Make ownership explicit where it fails.** Keep compiler-specific memory
   layouts behind the existing DSP adapter. Establish setup/process/disposal
   ownership and bounded callback allocation before generalizing compile-vst.
   For JZ itself, measure warm compiler allocation and reset behavior before
   removing ambient state; fix the responsible lifetime, not every ctx reader.

Gain timing on M4 Max (48 kHz stereo, scalar builds) measured median block
costs of 0.625 µs for JZ and 1.166 µs for Porffor at 128 frames, including the
native host, shell and copies. Three alternating trials establish feasibility
for this fixture, not a compiler-wide ranking or real-time guarantee. The
Porffor adapter retains its shared arena until the final instance closes;
concurrent audio threads and within-block automation are unvalidated.

The offline Web Audio fixture now matches Node's 16-bit PCM checksum after
repeated one-second, 44.1 kHz stereo renders. The discrepancy came from shared
trig approximation precision; the fixture source is unchanged.

Compiler selection belongs to `@audio/compile-vst`'s build options, not atom
metadata or the host. The implemented fixture accepts `--compiler=jz|porffor`;
the general package is still planned. Both chains must pass the same contract.

## UTF-16 migration (implemented)

One string contract: JavaScript UTF-16 code units, including lone surrogates.
Heap strings store little-endian 16-bit units. Lengths, positions and slice
lengths count units; allocation sizes, capacities and addresses count bytes.
Keep the existing six-ASCII-character SSO representation and its canonical
identity invariant. Do not add an encoding mode or a second heap representation.
UTF-8 remains the external encoding for TextEncoder/TextDecoder, URI operations,
UTF-8 file I/O, and WebAssembly names/custom-section text. Binary data stays bytes.

The coordinated migration covers these surfaces; do not publish a mixed string ABI:

1. **Representation and identity.** Define unit/byte conversion once; migrate
   literal/shared pools, host ingress/egress, string headers, slice offsets,
   static/runtime hashes, intern probes, equality and lexical ordering together.
   Preserve lone surrogates at the JS boundary; do not use TextDecoder for
   internal UTF-16 reconstruction because it repairs them.
2. **Runtime and lowering.** Change indexing and decomposed charCodeAt loads to
   16-bit units; migrate concat/append, copy, slice, search/SIMD, replace, split,
   pad/repeat, case/trim, joins, constructors and codePointAt. String iteration
   advances by code point; indexing and split('') remain code-unit operations.
   Delete the UTF-8 constructor pairing/replacement machinery it supersedes.
3. **Every producer and consumer.** Migrate number/BigInt/date formatting, JSON
   parse/stringify (including escaped lone surrogates), regex source/captures/
   lastIndex and Unicode advancement, property keys, collections, error strings,
   schema names, URI/base64/hex adapters and URLSearchParams. Keep btoa/atob's
   byte-valued code-unit contract distinct from UTF-8 text encoding.
4. **Explicit boundaries and lifetime.** Implement real UTF-16↔UTF-8 conversion
   for TextEncoder/Decoder and encodeInto, malformed input, BOM handling and
   supported options; preserve URI error behavior. Audit WASI/files, heap
   relocation/promotion, checkpoint serialization, shared memory, compiler
   snapshots and interop. Rebuild all artifacts against the changed string ABI.
5. **Bootstrap and public contract.** Audit Subscript, source printing, WAT byte
   escaping, source-map/diagnostic positions and constant folding. Remove the
   README's UTF-8/byte-position divergence once migrated; retain accurate limits
   on unsupported Unicode features. Update architecture/layout comments and
   remove UTF-8-specific expected failures as their replacement tests pass.
6. **Release evidence.** Differential tests against Node: packed floatbeat tables,
   ASCII/BMP/astral/lone-surrogate strings, all SSO/heap/slice combinations, keys,
   JSON/regex, encoder boundaries and host round-trips. Run core/O0/O3/WASI,
   conformance, fresh self-compile, full hosted suite, recursive self-compile,
   downstream watr, examples and type checks. Measure size/memory and stable
   performance with unchanged sources and gates; report residual failures.

The immediate regression pin is `"\u0100\u0200".charCodeAt(t & 1)`:
JavaScript yields 256/512; the old byte-string ABI yields 196/128.

## Compiler pipeline

Normalize and expand → settle program facts → lower → link → optimize and
encode in watr. Recompute the summary after program rewrites; emission reads
its settled binding, slot, parameter, result, container and presence facts.
Range proofs and physical storage choices remain separate responsibilities.

The slot-kind census, local value trackers, Map/dictionary alias traces and
repeated parameter-kind joins are removed. Literal tuple positions and
container constructor contents live in summary cells, with mutation and
escape invalidation. Generic local propagation and merging now run in watr
after linking. Guarded scalar updates become selects there too, using Wasm
local types, without synthesizing conditional ASTs after representation planning.
The duplicate local passes, update matcher and cleanup sweep are removed.
Condition chaining and boolean simplification likewise belong to watr; their
tape implementations and linker sweeps are removed.
Snapshot initialization reuses the probe's encoded function bodies when removing
the start preserves indices; changed layouts use the ordinary encoder. Compiler
artifacts explicitly target the JS host, independently of the test matrix.
Fixed scalar builtin callbacks normalize to ordinary functions during prepare,
using signatures that both compiler hosts can read. Their separate WAT closure
emitter is removed. Compile-time math folding and scalar/SIMD emission share
the trig/exp2 coefficient table; reduced-interval trig precision is regression-gated.
Constant folding covers imported module initializers as well as entry statements
and function bodies, so analysis receives normalized constants throughout the graph.
JZ retains lowering-specific optimization and representation proofs.
Static data and shared string pools now stay in Uint8Array chunks from their
producers through relocation and WAT escaping. Binary serialization no longer
depends on JavaScript string character semantics.
Compiler-state inspection explicitly uses the in-process entry; execution tests
keep their selected compiler. Session reset no longer owns that test configuration.
The Wasm adapter forwards allocator export options through the shared session setup.
Local schema facts stay in each function's representation plan. Specialized
variants retain source binding names, so publishing their layouts in the global
schema map was unsound. Analysis visits every dynamic literal initializer and
keeps boolean/pointer logical joins distinct. Prepared null and undefined are
ordinary literal values, so the summary sees their presence without private
symbol sentinels. Strict undefined checks retain the possibility of null;
destructuring assignment expressions preserve their RHS identity and effects.
Generator and async exception paths share one finalizer state; normal completion,
rejection and catch exceptions converge there, and finalizer return/throw overrides
the pending exception.
Parameter initialization now shares one lowering across ordinary functions and
generator factories. In iterator-producing programs, array parameters pull lazily,
interleave defaults and close on early completion. Uncaught generator exceptions
close the machine, including machines without source-level try/catch.
DataView has a distinct runtime discriminator while reusing the existing view
descriptor. Host marshaling preserves its view extent and identity. Typed-array
constructor summaries retain descriptor storage through calls and closures;
array parameter iteration rejects DataView without rejecting typed-array views.
Subscript 10.7.3 restores ASI state when speculative method parsing backtracks.
The pinned public revision `0f65c86` includes the escaped-surrogate parser fix.
The UTF-16 migration preserves JavaScript code units across literals, constructors,
heap strings and host marshalling. UTF-8 conversion is confined to byte codecs,
URI/form encoding, file I/O and Wasm metadata. Schema names use JSON escaping
inside that UTF-8 metadata to preserve lone surrogates. The six-ASCII-unit SSO
layout stays.
Final full native/WASI suites pass 4,463/4,460 tests (one skip each).
Full O0/O3 suites passed 4,463 each before the last literal-hash cleanup; the
final affected string/key suites pass 245 each. The full hosted suite passed
3,566 with one skip; final affected string/key/interop tests pass 273 through
the rebuilt kernel. Fresh self-compilation passed 32 functional tests (292
assertions); recursive compilation is green (14,922,766-byte child). Watr passes
352 core and 268 specification tests; examples, distributions and types build.
Static literal hashing now shares the UTF-16 hash with the intern pool; its
obsolete byte hash and ASCII-only folding guard are removed.
Language/builtin conformance retains one/four baseline failures. The latest
timing run failed warm parity (1.313/1.349/1.345×, cap 1.03×) and fresh parity
(1.079×, cap 0.99×), before the final literal-hash cleanup. Machine load was above
the evidence limit; these measurements do not certify performance or isolate
the migration cost. V1 performance and conformance gates remain open.

## Release gates

- Run the core, matrix, conformance and self-hosting gates on the packaged
  revision. Record baseline failures separately from regressions.
- Rebuild downstream Wasm with matching compiler and interop revisions: the
  string ABI changed. Binary serialization remains independent of string storage.
- Conformance still exposes property enumerability and function reflection.
  Iterator parameter acquisition/step errors are corrected; declaration and
  assignment patterns still use indexed lowering. DataView identity and iterator
  classification are fixed; `.length` and numeric property reads still incorrectly
  use typed-array fallbacks (`4`/`0` on a four-byte view instead of undefined). Preserve semantics or clearly reject unsupported operations; do not add failure-ledger entries to hide them.
- The warm Map/property failure came from counting duplicate and cancelled
  durable-slot log entries toward a fixed limit. The log now reuses them;
  retain the repeated-compile and reset tests as lifecycle gates.
- Speed and size promises require measured evidence, including the DSP fixture.
  Architecture changes alone do not establish real-time suitability. Refresh
  benchmark and memory evidence after compiler changes, with complete rival
  coverage and a machine inside the existing load/swap validity limits. The
  committed evidence is currently stale and does not meet those requirements.
  The UTF-16 migration leaves 52 of 60 measured binary sizes unchanged from
  `dbba8566`. Wordcount shrinks 3,971→3,804 bytes; tokenizer grows 1,456→1,581,
  JSON 7,734→9,824 and watr 308,946→330,237 (300,000-byte cap). The structural loop-count ratchet is remeasured for UTF-16 addressing and
  string helpers; pure numeric categories are unchanged (see its source note).
  The compiler artifact grows 13,966,665→15,423,764 bytes. Recover costs with general
  optimizations; retain Unicode behavior and the fixed benchmark sources.
- Replace the pinned watr source archive with an npm release when it contains
  the required fixes.

Semantic IR, more generic-pass migration, JS runtime replacements and removing
ambient ctx are optional follow-ups. Take one only for a reproduced defect,
a measured DSP bottleneck, or a deletion that preserves behavior. Historical
plans remain recoverable through [.work/README.md](.work/README.md).
