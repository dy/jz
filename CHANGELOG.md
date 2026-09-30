# Changelog

## Unreleased — v1 preparation

- Add `jz/strict`, with a separate browser bundle and TypeScript definitions.
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
- Keep nullable-string conversion compact and retain static strings after helper inlining.
- Preserve unsigned clamping, object coercion and assignment values in typed-array stores.
- Recognize held builtin functions consistently while respecting local constructor names.
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

Release validation is still in progress. This is not a released v1, and the
standing performance claims still require fresh reference measurements.
