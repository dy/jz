# Memory model

Two storage domains, chosen by kind, never by a global switch.

## Dynamic tier: wasm GC

Objects, dictionaries, strings, arrays, closures, Map, Set, and boxed values are wasm GC structs and arrays. The engine collects them. There is no manual reset, no arena, and no pointer invalidation for these kinds. Strings are GC `i16` arrays and cross to the host through the js-string builtins the compiler already imports.

This is what a long-lived program needs: an audio graph keeps its nodes alive for a session, a parser keeps its tables. Bump allocation with a global reset was correct for a kernel and wrong for these programs; it is retired.

## Typed tier: linear memory for typed storage

Typed arrays live in linear memory: one region per buffer, fixed while a view exists, bounds-checked at access. This keeps SIMD loads, host views over exported memory, and zero-copy sharing between tiers. Structs in the typed tier are GC structs with unboxed fields on the `gc` target and linear-memory records with an arena on the `nogc` target.

## Targets

- `gc` (browsers, Node, wasmtime): the full product, both tiers.
- `nogc` (minimal WASI embedders): the typed tier only. Allocation is an arena scoped to each exported call; a typed function that would return a heap handle to the host is rejected with the site named. Programs that need the dynamic tier are rejected on this target with the first dynamic function named in the report.

## Rules

- No compile-time memory layout is observable from source: no `memory.reset`, no address arithmetic, no handle that outlives its scope on `nogc`.
- Host-visible buffers are typed arrays over exported linear memory; growth of linear memory preserves existing views by the wasm memory contract.
- The runtime (`spec/subset.md`, written in jz) allocates only through these two domains; a runtime function that needs a third mechanism is a design error, not a special case.

## What this retires

`memory.reset()`, the realloc forwarding chains, the interned-data reclamation passes, the checkpoint and rehydration machinery, and every workaround whose reason was the 4 GiB self-compile ceiling.
