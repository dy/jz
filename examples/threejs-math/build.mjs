// Vendors three.js's own math-layer source (node_modules/three/src/math, unmodified — the
// version package.json pins) into ./three/, then compiles threejs-math.js against it exactly as
// test/three.js compiles test/three/kernels.js: resolveModuleGraph + compile(…, { modules }).
// The vendored copy is generated, not hand-maintained (.gitignore'd) — regenerate after bumping
// the three devDependency, or after this demo starts calling a class the seed entries below
// don't already reach transitively.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveModuleGraph } from '../../src/resolve.js'
import { compile } from '../../index.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const THREE_SRC = join(HERE, '../../node_modules/three/src')
const OUT = join(HERE, 'three/src')
// Real files, not a synthetic entry — resolveModuleGraph needs a path that exists. Matrix4.js
// and Frustum.js between them transitively reach every class the kernel below uses (Vector3,
// Sphere, Plane, Quaternion, MathUtils, constants, …) — the same closure test/three.js compiles.
const SEEDS = ['math/Matrix4.js', 'math/Frustum.js']

// resolveModuleGraph's `modules` return holds everything the entry IMPORTS, not the entry
// file itself (that's `code`) — so each seed must also be added to the set by hand.
const modules = {}
for (const seed of SEEDS) {
  const abs = join(THREE_SRC, seed)
  modules[abs] = true
  Object.assign(modules, resolveModuleGraph(abs).modules)
}
let vendored = 0
for (const abs of Object.keys(modules)) {
  if (!abs.startsWith(THREE_SRC)) continue   // this demo's own file, not a three.js source
  const dest = join(OUT, relative(THREE_SRC, abs))
  mkdirSync(dirname(dest), { recursive: true })
  writeFileSync(dest, readFileSync(abs))     // byte-identical — no rewriting, no bundler needed client-side
  vendored++
}
console.log(`Vendored ${vendored} three.js math files`)

const entry = join(HERE, 'threejs-math.js')
const g = resolveModuleGraph(entry)
writeFileSync(join(HERE, 'threejs-math.wasm'), compile(g.code, { modules: g.modules, optimize: 'speed' }))
console.log('Compiled threejs-math')
