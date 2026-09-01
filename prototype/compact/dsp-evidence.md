# Float64Array DSP evidence

The typed slice accepts fixed module-level `Float64Array` owners and full aliases. ProgramIndex assigns byte bases, owner IDs, alias groups, element widths, relocation states, direct read and write summaries, and transitive purity. Optional storage families remain null for programs without typed storage.

Function scratch proves canonical loop ranges and creates raw i32 pointer induction. Scalar loops hoist owner bases and advance pointers by eight bytes. SIMD loops advance them by sixteen bytes, hoist dynamic scalar splats, process two f64 lanes at a time, and emit one scalar cleanup element for odd lengths.

## Correctness

`node test/compact-prototype.js` covers:

- construction, zero initialization, `.length`, load, store, and full aliases
- fixed layout and unique owner groups
- transitive purity and direct storage read or write summaries
- rejection of unproved, out-of-range, dead-branch, and induction-variable-mutated accesses
- byte-identical scalar and SIMD memory for finite values, signed zero, NaN, and infinity
- odd-length scalar cleanup before and after watr optimization
- distinct-array shifted loads as a SIMD-positive alias case
- alias, relocation, range, local-effect, and transitive global-write vetoes
- typed A to A to B reuse in plain and optimized modes

The SIMD-positive map emits `v128.load`, `v128.store`, `f64x2.mul`, `f64x2.sub`, `f64x2.neg`, `f64x2.div`, and `f64x2.add`. Every veto case emits scalar WAT with no `v128` instruction.

## Runtime direction

Command:

```sh
node prototype/compact/dsp-bench.mjs
```

Latest loaded-machine result:

- source SHA-256: `a8f86ac86deb25b6fd9f654e6ea66658409aa72c3fcd8adcefd5939e35fef9fd`
- length: 4,097 elements
- scalar module: 302 bytes
- SIMD module: 320 bytes
- scalar map: 0.0041 ms
- SIMD map: 0.0009 ms
- SIMD speedup: 4.69x
- result and 65,552 memory bytes: identical

The machine had about 11.6 GiB of allocated swap. Runtime timing is directional and does not certify release performance. Structural SIMD presence and byte equality remain hard evidence.

## Compile and artifact direction

The self-hosted compact benchmark includes a 64-element typed SIMD row:

- compact compiler: 2,256,528 bytes
- current full compiler: 14,519,509 bytes
- compiler artifact ratio: 6.43x smaller
- typed row compile speedup: 14.13x
- typed row output: 287 bytes versus production's 568 bytes
- overall compile-speed geomean: 38.49x
- minimum compile speedup: 4.43x

The exact integer row remains 212 bytes versus production's 120 bytes. That loss still blocks production promotion and is not offset by the typed row's win.
