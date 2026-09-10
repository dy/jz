// The deployed gallery must survive disabled JavaScript and catalog changes.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = (...args) => spawnSync(process.execPath, [join(root, 'scripts/build-site.mjs'), ...args], { encoding: 'utf8' })

test('site: primary menus keep the same destinations and the self-compile badge names a real workflow', () => {
  for (const file of ['index.html', 'get-started/index.html', 'examples/index.html', 'bench/index.html', 'floatbeat/index.html', 'examples/lib/jzdemo.js']) {
    const html = readFileSync(join(root, file), 'utf8')
    const nav = html.match(/<nav class="[^"]*site-nav"[^>]*>([\s\S]*?)<\/nav>/)[1]
    const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    is(links.map(([, href, label]) => [href.replace(/^(\.\.\/)+/, ''), label]),
      [['get-started/', 'guide'], ['examples/', 'examples'], ['bench/', 'bench'], ['repl/', 'repl']], file)
  }
  const home = readFileSync(join(root, 'index.html'), 'utf8')
  ok(!home.includes('selfhost.yml'), 'no stale self-host workflow URL')
  ok(home.includes('workflows/self-compile.yml/badge.svg'), 'badge uses self-compile workflow')
  ok(readFileSync(join(root, '.github/workflows/self-compile.yml'), 'utf8').includes('name: self-compile'), 'linked workflow exists')
})

test('site: gallery stays current and renders into the deployment directory', () => {
  const checked = build('--check')
  is(checked.status, 0, checked.stderr)
  const html = readFileSync(join(root, 'examples/index.html'), 'utf8')
  const dir = mkdtempSync(join(tmpdir(), 'jz-gallery-'))
  try {
    mkdirSync(join(dir, 'examples'))
    const file = join(dir, 'examples/index.html')
    const stale = html.replace(/<!-- gallery:start -->[\s\S]*?<!-- gallery:end -->/, '<!-- gallery:start --><!-- gallery:end -->')
    writeFileSync(file, stale)
    is(build(dir, '--check').status, 1, 'stale deployment is detected')
    is(readFileSync(file, 'utf8'), stale, 'check mode does not write')
    is(build(dir).status, 0, 'deployment generation succeeds')
    is(readFileSync(file, 'utf8'), html, 'deployment includes the complete static gallery')
    is(build(dir, '--check').status, 0, 'generation is idempotent')

    const start = '<!-- gallery:start -->', end = '<!-- gallery:end -->'
    for (const invalid of ['', start, end, end + start, start + start + end, start + end + end, start + end + start + end]) {
      writeFileSync(file, invalid)
      const result = build(dir)
      is(result.status, 1, 'reject malformed markers: ' + JSON.stringify(invalid))
      ok(result.stderr.includes('Expected one gallery block'), 'actionable marker error')
      is(readFileSync(file, 'utf8'), invalid, 'malformed template is never overwritten')
    }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('site: catalog empty → A → A → B escapes text and replaces only the gallery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-gallery-'))
  try {
    mkdirSync(join(dir, 'scripts'))
    mkdirSync(join(dir, 'examples'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    copyFileSync(join(root, 'scripts/build-site.mjs'), join(dir, 'scripts/build-site.mjs'))
    const file = join(dir, 'examples/index.html')
    const catalog = rows => writeFileSync(join(dir, 'examples/examples.js'), `export const examples = ${JSON.stringify(rows)}`)
    const run = () => spawnSync(process.execPath, [join(dir, 'scripts/build-site.mjs')], { encoding: 'utf8' })
    const read = () => readFileSync(file, 'utf8')
    writeFileSync(file, '<header>keep</header><!-- gallery:start -->stale<!-- gallery:end --><footer>keep</footer>')
    catalog([])
    is(run().status, 0, 'empty catalog builds')
    is(read(), '<header>keep</header><!-- gallery:start -->\n\n<!-- gallery:end --><footer>keep</footer>', 'zero cards; surrounding markup preserved')

    catalog([{ name: 'a', title: 'A "quoted" & <tag>', blurb: "it's <safe> & costs $&" }])
    is(run().status, 0, 'single-entry catalog builds')
    const a = read()
    ok(a.includes('alt="A &quot;quoted&quot; &amp; &lt;tag&gt;"'), 'attribute text escaped')
    ok(a.includes('it&#39;s &lt;safe&gt; &amp; costs $&amp;'), 'body text escaped; replacement metacharacters literal')
    is(run().status, 0, 'same catalog builds again')
    is(read(), a, 'A → A is byte-identical')

    catalog([{ name: 'b', title: 'B', blurb: 'new caption' }])
    is(run().status, 0, 'changed catalog builds')
    const b = read()
    is((b.match(/class="cell"/g) || []).length, 1, 'A → B replaces, rather than appends')
    ok(b.includes('href="./b/"') && b.includes('new caption') && !b.includes('href="./a/"'), 'only the new entry remains')
    ok(b.startsWith('<header>keep</header>') && b.endsWith('<footer>keep</footer>'), 'A → B preserves surrounding markup')

    catalog([null])
    is(run().status, 1, 'invalid entry fails the build')
    is(read(), b, 'invalid catalog leaves the last valid page untouched')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
