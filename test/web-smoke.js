// Web smoke — the demo/REPL pin. The live site compiles IN THE BROWSER with
// dist/jz.js; a single unguarded Node global (an un-`typeof`-guarded
// `process.env.JZ_DUMP_FOR` in the `for` emitter) once shipped and broke every
// loop compile on every page, silently (jz's own catch wrapped it; the only
// symptom was the REPL error banner + a mis-labeled "WASM unavailable" hero).
// This test runs the EXACT shipped artifact under the EXACT browser condition:
// a child process with `process`/`Buffer` deleted imports dist/jz.js and
// compiles + instantiates + runs the same sources the pages compile —
// the REPL's default sample (parsed out of repl/index.html so it cannot
// drift) and both landing hero grids — at the pages' own optimize levels.
// Wired into the suite → `prepublishOnly` runs it on every publish.
import test from 'tst'
import { ok, is } from 'tst/assert.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

// The REPL's default editor content, straight from the page source.
const replHtml = readFileSync(join(ROOT, 'repl/index.html'), 'utf8')
const introMatch = replHtml.match(/const INTRO_SRC = `([\s\S]*?)`/)

test('web-smoke: dist/jz.js compiles the REPL sample + hero grids with no Node globals', () => {
  ok(introMatch, 'INTRO_SRC found in repl/index.html')
  // Fresh browser bundle — the artifact under test is what ships, not the source tree.
  const built = spawnSync(process.execPath, [join(ROOT, 'scripts/build-dist.mjs'), '--js-only'], { cwd: ROOT, timeout: 120_000 })
  is(built.status, 0, `dist build: ${built.stderr}`)

  const driver = `
    // Browser condition: no Node globals. Delete BEFORE the bundle loads so any
    // unguarded reference throws exactly as it would in a <script type=module>.
    const sources = JSON.parse(${JSON.stringify(JSON.stringify({
      repl: { src: introMatch[1], opt: 3 },                                                 // repl/index.html default (optimize radio: speed)
      gridCurrent: { src: readFileSync(join(ROOT, 'assets/grid-current.js'), 'utf8'), opt: 3 },  // index.html hero, dark theme
      gridLife: { src: readFileSync(join(ROOT, 'assets/grid-life.js'), 'utf8'), opt: 3 },        // index.html hero, light theme
    }))})
    delete globalThis.process
    delete globalThis.Buffer
    const { default: jz, compile } = await import(${JSON.stringify('file://' + join(ROOT, 'dist/jz.js'))})
    for (const [name, { src, opt }] of Object.entries(sources)) {
      const bytes = compile(src, { optimize: opt })                     // must not throw (the REPL path)
      new WebAssembly.Module(bytes)                                     // must validate
      const r = jz(src, { optimize: opt })                              // must instantiate + run top-level
      if (!r || !r.exports) throw new Error(name + ': no exports')
      console.log('ok', name, bytes.byteLength)
    }
    // and the compiled code must actually COMPUTE: the repl sample's orbit()
    const r = jz(sources.repl.src, { optimize: sources.repl.opt })
    const x = Number(r.exports.orbit(1000))
    if (!Number.isFinite(x) || x === 0) throw new Error('orbit(1000) computed ' + x)
    console.log('ok orbit', x)
  `
  const drv = join(tmpdir(), `jz-web-smoke-${process.pid}.mjs`)
  writeFileSync(drv, driver)
  const run = spawnSync(process.execPath, [drv], { cwd: ROOT, timeout: 120_000, encoding: 'utf8' })
  is(run.status, 0, `browser-sim compile failed:\n${run.stderr || run.stdout}`)
  for (const name of ['repl', 'gridCurrent', 'gridLife', 'orbit'])
    ok(run.stdout.includes(`ok ${name}`), `${name} compiled + ran in browser condition`)
})
