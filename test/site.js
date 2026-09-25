// The deployed gallery must survive disabled JavaScript and catalog changes.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'

const root = fileURLToPath(new URL('../', import.meta.url))
const build = (...args) => spawnSync(process.execPath, [join(root, 'scripts/build-site.mjs'), ...args], { encoding: 'utf8' })

test('site: guide is canonical and the sitemap uses its current URL', () => {
  const guide = readFileSync(join(root, 'guide/index.html'), 'utf8')
  ok(guide.includes('<title>Guide | JZ</title>'), 'short page title')
  ok(guide.includes('rel="canonical" href="https://jz.js.org/guide/"'), 'canonical URL')
  const sitemap = spawnSync(process.execPath, [join(root, 'scripts/sitemap.mjs'), root], { encoding: 'utf8' })
  is(sitemap.status, 0, sitemap.stderr)
  ok(sitemap.stdout.includes('<loc>https://jz.js.org/guide/</loc>'), 'guide indexed')
  ok(!sitemap.stdout.includes('/get-started/'), 'old route excluded')
})

test('site: primary menus keep the same destinations and the self-compile badge names a real workflow', () => {
  for (const file of ['index.html', 'guide/index.html', 'examples/index.html', 'bench/index.html', 'floatbeat/index.html', 'examples/lib/jzdemo.js']) {
    const html = readFileSync(join(root, file), 'utf8')
    const nav = html.match(/<nav class="[^"]*site-nav"[^>]*>([\s\S]*?)<\/nav>/)[1]
    const links = [...nav.matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
    is(links.map(([, href, label]) => [href.replace(/^(\.\.\/)+/, ''), label]),
      [['guide/', 'guide'], ['examples/', 'examples'], ['bench/', 'bench'], ['repl/', 'repl']], file)
  }
  const home = readFileSync(join(root, 'index.html'), 'utf8')
  ok(!home.includes('selfhost.yml'), 'no stale self-host workflow URL')
  ok(home.includes('workflows/self-compile.yml/badge.svg'), 'badge uses self-compile workflow')
  ok(readFileSync(join(root, '.github/workflows/self-compile.yml'), 'utf8').includes('name: self-compile'), 'linked workflow exists')
})

test('site: Pages redeploys only successful main-push benchmark snapshots', () => {
  const pages = readFileSync(join(root, '.github/workflows/pages.yml'), 'utf8')
  const trigger = pages.match(/  workflow_run:\n([\s\S]*?)(?=\n\S)/)[1]
  ok(trigger.includes('workflows: [bench]') && trigger.includes('types: [completed]'), 'benchmark completion triggers deployment')
  ok(trigger.includes('branches: [main]'), 'completion trigger is restricted to main')
  const condition = pages.match(/    if: >-\n([\s\S]*?)\n    runs-on:/)[1].trim()
  const run = { conclusion: 'success', event: 'push', head_repository: { full_name: 'dy/jz' } }
  const allowed = (event_name, workflow_run) => runInNewContext(condition, {
    github: { event_name, repository: 'dy/jz', event: { workflow_run } },
  })
  is(allowed('push'), true, 'ordinary site pushes still deploy')
  is(allowed('workflow_dispatch'), true, 'manual site deployment still works')
  is(allowed('workflow_run', run), true, 'successful main push deploys')
  for (const conclusion of ['failure', 'cancelled', 'skipped'])
    is(allowed('workflow_run', { ...run, conclusion }), false, conclusion + ' cannot deploy')
  is(allowed('workflow_run', { ...run, event: 'pull_request' }), false, 'PR completion cannot deploy')
  is(allowed('workflow_run', { ...run, head_repository: { full_name: 'fork/jz' } }), false, 'fork completion cannot deploy')
  ok(pages.includes("ref: ${{ github.event_name == 'workflow_run' && 'main' || github.sha }}"), 'checkout includes the later snapshot commit')
  ok(pages.includes('node test/headline.js'), 'deployment gates dataset loading and Perry rendering')
})

test('site: benchmark publication requires Perry evidence and a successful push', () => {
  const workflow = readFileSync(join(root, '.github/workflows/bench.yml'), 'utf8')
  const step = workflow.slice(workflow.indexOf('      - name: publish bench snapshot'))
  const script = step.split('        run: |\n')[1].replace(/^          /gm, '')
  ok(script.includes(',perry,'), 'published run includes Perry')
  ok(script.includes('--json=bench/results-ci.json'), 'runner writes directly to its own dataset')
  ok(script.includes('cp bench/results.json bench/results-ci.json'), 'refresh uses current reference checksums')
  const dir = mkdtempSync(join(tmpdir(), 'jz-bench-publish-'))
  try {
    mkdirSync(join(dir, 'bin')); mkdirSync(join(dir, 'bench')); mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}')
    writeFileSync(join(dir, 'bench/results.json'), '{"reference":"unchanged"}')
    copyFileSync(join(root, 'assets/headline.js'), join(dir, 'assets/headline.js'))
    writeFileSync(join(dir, 'bench/bench.mjs'), `import { writeFileSync } from 'node:fs'
writeFileSync('bench/results-ci.json', process.env.SNAPSHOT)
`)
    // Execute the real publication shell with a local git fixture, never a remote.
    writeFileSync(join(dir, 'bin/git'), `#!/bin/sh
echo "$*" >> "$GIT_LOG"
case "$1" in
  log) echo "$SOURCE_SHA source" ;;
  push) test "$PUSH_OK" = 1 ;;
  diff) exit 1 ;;
esac
`, { mode: 0o755 })
    const good = { cases: { alpha: { targets: { perry: { medianUs: 1, parity: 'ok' } } } } }
    const run = (snapshot = good, extra = {}) => {
      const log = join(dir, 'git.log')
      writeFileSync(log, '')
      const result = spawnSync('bash', ['-e', '-c', script], { cwd: dir, encoding: 'utf8',
        env: { ...process.env, PATH: join(dir, 'bin') + ':' + process.env.PATH,
          GIT_LOG: log, GITHUB_SHA: 'source', SOURCE_SHA: 'source', PUSH_OK: '1', SNAPSHOT: JSON.stringify(snapshot), ...extra },
      })
      return { ...result, calls: readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) }
    }
    const success = run()
    is(success.status, 0, success.stderr)
    is(success.calls.filter(c => c === 'push').length, 1, 'one successful push finishes publication')
    is(success.calls.filter(c => c.startsWith('add ')), ['add bench/results-ci.json'], 'only CI evidence is staged')
    is(readFileSync(join(dir, 'bench/results.json'), 'utf8'), '{"reference":"unchanged"}', 'reference evidence is preserved')
    for (const perry of [undefined, { status: 'fail' }, { medianUs: 1, parity: 'DIFF' }, { medianUs: 0, parity: 'ok' }]) {
      const rejected = run({ cases: { alpha: { targets: { perry } } } })
      is(rejected.status, 1, 'missing, failed, wrong, or zero-time Perry evidence blocks publication')
      is(rejected.calls, [], 'invalid snapshot never reaches git')
    }
    const exhausted = run(good, { PUSH_OK: '0' })
    is(exhausted.status, 1, 'exhausted retries fail CI')
    is(exhausted.calls.filter(c => c === 'push').length, 3, 'three publication attempts')
    const stale = run(good, { SOURCE_SHA: 'newer' })
    is(stale.status, 0, 'a superseded benchmark yields to the newer run')
    is(stale.calls.includes('push'), false, 'stale evidence is never pushed')
  } finally { rmSync(dir, { recursive: true, force: true }) }
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
