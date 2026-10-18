// usage: node build-jz.mjs <root> <case-id> <case.js> <level> <out.wasm>
// Builds a bench case with the compiler of the checkout at <root>, through that
// checkout's own bench build, in a process of its own: two compilers in one
// process share their dependencies' module state (the parser's grammar).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [root, id, js, level, out] = process.argv.slice(2)
const { compileJzAt } = await import(pathToFileURL(join(root, 'bench/_lib/compile.js')).href)
writeFileSync(out, compileJzAt({ id, js }, { level }))
