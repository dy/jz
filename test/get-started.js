// Execute the code readers copy, against the browser bundle built by web-smoke.
import test from 'tst'
import { is } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const html = readFileSync(new URL('../get-started/index.html', import.meta.url), 'utf8')
const code = id => html.match(new RegExp(`<code id="${id}"[^>]*>([\\s\\S]*?)</code>`))[1].replaceAll('&gt;', '>')
const bundle = new URL('../dist/jz.js', import.meta.url).href

test('get started: tagged function, array batches and the same-source JS fallback compute correctly', () => {
  const plain = code('tag-run').match(/jz`([\s\S]*?)`/)[1]
  for (const [name, source, expected] of [
    ['tagged function', code('tag-run'), '5'],
    ['array A → reset → empty → reset → A', code('array-run') + `
      console.log(exports.sum(new Float64Array()))
      memory.reset()
      console.log(exports.sum(values))
      memory.reset()
    `, '6\n0\n6'],
    ['same source as JavaScript', `const { dist } = await import(${JSON.stringify('data:text/javascript,' + encodeURIComponent(plain))}); console.log(dist(3, 4))`, '5'],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module'], {
      input: source.replace("from 'jz'", `from '${bundle}'`), encoding: 'utf8', timeout: 30_000,
    })
    is(result.status, 0, `${name}: ${result.stderr}`)
    is(result.stdout.trim(), expected, name)
  }
})
