# Memory model

One storage domain, linear memory, managed by regions. There is no garbage collector: no engine-scheduled pause, no nondeterministic release. Every function pays its own memory tax at its own exit, so a render callback that allocates nothing that escapes runs with zero release cost, and one that does releases exactly what it made.

## Regions

- Every function call owns a region: allocations that do not escape the call are released when it returns, in one operation.
- A value escapes when it is returned, stored into a value of a longer-lived region, captured by a closure that escapes, or handed to the host. Escape is decided by analysis per function, on the IR, with the same fail-closed rule as types: a value whose lifetime cannot be bounded is an error at the site, with the region that would bound it named.
- An escaping value is allocated directly in the region it escapes to; nothing is copied at return.
- The module owns a session region: values that must live for the program (an audio graph, a parser's tables) allocate there. The session region is released only by the host through the module's `release()` export, which invalidates every session handle at once, deterministically, at a moment the host chooses.
- A named region is a value: `region()` creates one, `r.alloc`-scoped allocation happens by passing it as the target scope, and `r.release()` frees everything in it. This is the tool for lifetimes that are neither a call nor the session (a voice, a request, an animation frame).

## Containers that shrink

A dictionary, array, or string that grows and shrinks inside one region reuses its own freed cells through a per-container free list, so a long-lived container does not leak inside the session region. Releasing the container's region releases the free list with it.

## Typed storage

Typed arrays are contiguous regions of their own: fixed while a view exists, bounds-checked, shared with the host as views over exported memory, and the target of SIMD loads. A typed array's lifetime follows the region rule like any other value.

## Targets

One target: wasm with linear memory. Browsers, Node, wasmtime, and WASI embedders all run the same module; nothing depends on the GC proposal. Threads and shared memory are an option on top, not a separate target.

## Rules

- No compile-time layout is observable from source: no address arithmetic, no manual free of an individual value, no handle that outlives its region.
- The runtime (written in jz) allocates only through regions; a runtime function that needs another mechanism is a design error.
- The release tax is visible: the tier report lists, per function, what it allocates and which region it escapes to.

## What this retires

`memory.reset()` as a global reset, the realloc forwarding chains, the interned-data reclamation passes, the checkpoint and rehydration machinery, and every workaround whose reason was the 4 GiB self-compile ceiling.
