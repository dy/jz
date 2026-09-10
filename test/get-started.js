// Execute the code readers copy, against the browser bundle built by web-smoke.
import test from 'tst'
import { is } from 'tst/assert.js'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

test('get started: copied examples compute the documented results and retain the JS fallback', () => {
  const html = readFileSync(new URL('../get-started/index.html', import.meta.url), 'utf8')
  const code = id => html.match(new RegExp(`<code id="${id}">([\\s\\S]*?)</code>`))[1].replaceAll('&gt;', '>')
  const bundle = new URL('../dist/jz.js', import.meta.url).href
  const dir = mkdtempSync(join(tmpdir(), 'jz-guide-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    writeFileSync(join(dir, 'distance.js'), code('distance-source'))
    for (const [name, source, expected] of [
      ['WASM distance', code('distance-run'), '5'],
      ['wrapped array and reset', code('array-run'), '6'],
      ['original JS fallback', "import { dist } from './distance.js'; console.log(dist(3, 4))", '5'],
    ]) {
      writeFileSync(join(dir, 'run.mjs'), source.replace("from 'jz'", `from '${bundle}'`))
      const result = spawnSync(process.execPath, ['run.mjs'], { cwd: dir, encoding: 'utf8', timeout: 30_000 })
      is(result.status, 0, `${name}: ${result.stderr}`)
      is(result.stdout.trim(), expected, name)
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
