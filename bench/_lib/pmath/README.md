# pmndrs/math, vendored

The modules the `polytri`, `worley`, `fabrik` and `quatmul` cases import, copied
unmodified from [pmndrs/math](https://github.com/pmndrs/math) (`main`, 2026-09-27,
MIT, see [LICENSE](LICENSE)): `core/` whole (the IK solver imports its barrel),
`shapes/polygon2.js`, the two `geometry/polygon2-*.js`, `noise/permutation.js` with
the two Worley samplers, `ik/fabrik3.js`, `random/mulberry32.js`.

These are fixed specimens: a case gets faster by a compiler change, never by an
edit here.

`npm run test:math` compiles all four workloads and pins their checksums against
Node, including repeated calls to the stateful IK solver. It also runs in the
default core suite. The compiler gains have machine-independent pins in
`test/array-load-cse.js`, `test/param-range.js`, `test/present-init.js`,
`test/slp.js` and `test/forward-store.js`.

`JZ_MATH_PIN=1 npm run test:math` requires every case to beat V8. Run it on a
quiet machine before release; the normal run prints diagnostic ratios, and the
committed-evidence claims remain pending until reproducible wins are recorded.
