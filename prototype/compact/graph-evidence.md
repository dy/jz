# Direct-call graph evidence

Measured on the staged prototype before adding the shared scalar corpus. The script runs each backend and graph size in a fresh Node process with exposed GC. The parser needs an 8 MiB native stack for the synthetic source containing 2,048 declarations.

Command:

```sh
node prototype/compact/graph-bench.mjs
```

Environment:

- Node 25.9.0
- macOS
- about 13.0 GiB of allocated swap
- optimize off

The load makes timings directional. Source hashes, output hashes, semantic results, post-GC heap, and structural counts remain useful attribution evidence.

## Identity

| Item | SHA-256 |
| --- | --- |
| staged compiler graph | `8564403b09810173d9f1cf7f91b414e28dcc0ef46d7b77090b93362ebec58c3a` |
| direct compiler graph | `2f19177162dc7f3e0708ee7f79c46d8a5353e7ab66ddf7627b98246159bba5bb` |

| Functions | Source SHA-256 | Output SHA-256 |
| ---: | --- | --- |
| 128 | `5340359f58b714ae5506d66d2b8fda80a0ca8f0887bbdcaa1a6a39768942ef6c` | `4af4f50fe890db299d4bb25f67957ad22456431d8e457870a7ea320b38d7e22e` |
| 512 | `c464d67d70c0c462b456556fea8229ce774e270765cedae3d2d26b00148cf0f4` | `930222b8b50a21a74372fbf706e73a3de6a41375debd6cdb3943c02d89eeb400` |
| 2,048 | `b642f624941dcc7aa39e0de51a566ab1a7a40a47b94862304b07bf64145a8aeb` | `f053eaf24665e0c6fe8d18bc6ac3663a6ed51995a7dbaa4f282484087cd15060` |

Staged watr output and frozen direct-control output are byte-identical at every size. Every function is reachable, each module has one exported root, and the results are 130, 514, and 2,050.

## Phases

Post-GC heap values are deltas from a baseline taken after loading the compiler and generated source.

| Functions | Backend | Parse ms | Prepare ms | Index ms | Lower or direct ms | watr ms | Total ms | Peak heap | Retained WAT delta | Output |
| ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 128 | staged | 5.00 | 0.57 | 0.54 | 0.46 | 2.19 | 8.76 | 1,118,040 | 136,872 | 2,333 |
| 128 | direct | 4.95 | 0 | 0 | 1.14 | 0 | 6.09 | 678,592 | 0 | 2,333 |
| 512 | staged | 15.43 | 1.37 | 1.18 | 1.01 | 4.41 | 23.40 | 2,022,952 | 403,568 | 9,629 |
| 512 | direct | 15.31 | 0 | 0 | 2.78 | 0 | 18.09 | 1,072,096 | 0 | 9,629 |
| 2,048 | staged | 102.12 | 10.12 | 5.72 | 5.42 | 10.17 | 133.55 | 4,732,264 | 1,446,048 | 38,814 |
| 2,048 | direct | 100.87 | 0 | 0 | 23.93 | 0 | 124.80 | 2,121,624 | 0 | 38,814 |

Linear-regression slopes from the three points:

- staged post-GC peak: about 1.8 KiB per function
- direct post-GC peak: about 731 bytes per function
- encoded output: about 19 bytes per function for both backends

Function scratch stays at one slot. Maximum loop-label demand is zero and maximum finalized function WAT stays at 13 nodes for every graph size.

## Decision

The experiment does not justify a numeric instruction tape for call lookup. At 2,048 functions, indexing plus lowering takes 11.14 ms while the frozen direct control takes 23.93 ms to validate and encode. A persistent tape would add another retained body representation without addressing the largest owner.

Finalized WAT is the largest staged-only linear owner. Its measured delta reaches 1.45 MiB at 2,048 functions, and generic watr compilation adds about 0.37 MiB after lowering. This crosses the backend-attribution trigger, but the prototype remains far below the production compiler and the machine is not suitable for certification. Keep watr unchanged through the scalar and typed-memory proofs. Repeat this experiment on an exclusive machine before proposing an ownership API. Any such API must remove the retained WAT owner and preserve the byte-identical outputs above.
