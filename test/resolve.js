// The file resolver (src/resolve.js): a module's import sites as the compiler's parser
// reads them, wherever a statement stands on its line, and never a string, a comment or
// a regex that holds the word. Each program runs as files under Node and as one jz
// module through resolveModuleGraph.
import test from 'tst'
import { is } from 'tst/assert.js'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { pathToFileURL } from 'url'
import { importSites, resolveModuleGraph } from '../src/resolve.js'
import { onKernel } from './_matrix.js'
import { jz } from './util.js'

const scratch = mkdtempSync(join(tmpdir(), 'jz-resolve-'))
process.on('exit', () => rmSync(scratch, { recursive: true, force: true }))
let programs = 0
const files = (modules) => {
  const dir = join(scratch, String(programs++))
  mkdirSync(dir)
  for (const [name, src] of Object.entries(modules)) writeFileSync(join(dir, name), src)
  return dir
}

test('resolve: import sites are the parser\'s, not a pattern\'s', () => {
  const sites = (src) => importSites(src).map(s => s.spec).join()
  is(sites(`const k=1;import{a}from"./a.js";import b from"./b.js";export*from"./c.js";export{d}from'./d.js'`), './a.js,./b.js,./c.js,./d.js', 'a minified line')
  is(sites(`import D, { a, b as c } from './a.js'\nimport * as ns from './b.js'\nimport './c.js'`), './a.js,./b.js,./c.js', 'every clause')
  is(sites(`f(import('./a.js')); const p = import(/* lazy */ './b.js')\nimport('./c.js')`), './a.js,./b.js,./c.js', 'import() as an argument, past a comment, starting a statement')
  is(sites(`const s = "import x from './a.js'", t = \`\nimport y from './b.js'\n\`, r = /import\\('\\.\\/c\\.js'\\)/\n/*\nimport z from './d.js'\n*/\n// import('./e.js')\nconst o = { import: 1 }; o.import('./f.js')`), '', 'strings, a template, a regex, comments and a member hold no site')
  is(sites(`import x from './a.js'\nconst = 1`), '', 'a source the parser refuses has none: the compile reports it')
  const [s] = importSites(`import { a } from "./a.js"`)
  is([s.at, s.end, s.names.join()].join(), '18,26,a', 'the literal with its quotes, the names it binds')
})

test('resolve: a module graph of the sites, its sources untouched elsewhere', async () => {
  if (onKernel()) return
  const cases = [
    ['two imports on one line after a statement (a minified bundle)', {
      'a.js': 'export const a = 2', 'b.js': 'export default 5',
      'main.js': `const k=1;import{a}from"./a.js";import b from"./b.js";export const f=()=>a*10+b+k`,
    }, 'a.js,b.js'],
    ['a re-export after a statement', { 'a.js': 'export const a = 3', 'b.js': `const k=1;export{a}from"./a.js";export const g=()=>k`,
      'main.js': `import { a, g } from './b.js'\nexport const f = () => a + g()` }, 'b.js,a.js'],
    ['a template holding an import line', { 'a.js': 'export const a = 4',
      'main.js': `import { a } from './a.js'\nconst s = \`\nimport x from './a.js'\n\`\nexport const f = () => s + a` }, 'a.js'],
    ['a comment holding an import line', { 'a.js': 'export const a = 4', 'b.js': 'throw new Error("b evaluated")',
      'main.js': `import { a } from './a.js'\n/*\nimport x from './b.js'\n*/\nexport const f = () => a` }, 'a.js'],
    ['a string holding import() of a file', { 'a.js': 'export const a = 6',
      'main.js': `import { a } from './a.js'\nconst s = "import('./a.js')"\nexport const f = () => s + a` }, 'a.js'],
    ['a regex holding import() of a file', { 'a.js': 'export const a = 8',
      'main.js': `import { a } from './a.js'\nconst r = /import\\('\\.\\/a\\.js'\\)/\nexport const f = () => r.test("import('./a.js')") + a` }, 'a.js'],
    ['a member named import', { 'a.js': 'export const a = 1',
      'main.js': `import { a } from './a.js'\nconst o = { import: (s) => s.length }\nexport const f = () => o.import('./b.js') + a` }, 'a.js'],
  ]
  for (const [name, modules, bundled] of cases) {
    const dir = files(modules)
    const want = (await import(pathToFileURL(join(dir, 'main.js')).href)).f()
    const { code, modules: graph } = resolveModuleGraph(join(dir, 'main.js'))
    is(Object.keys(graph).map(p => p.slice(dir.length + 1)).join(), bundled, `${name}: the modules bundled`)
    is(jz(code, { modules: graph }).exports.f(), want, `${name}: as Node`)
  }
})

// One module a physical file, as Node keeps one: a directory reached through a symbolic link
// names its files by two absolute paths, and a graph keyed by the path as written held a file
// imported both ways as two modules, each with its own state (a counter bumped once in each
// where Node bumps one twice). Two forms: a linked directory inside the project, and the
// project itself entered through a link while one of its imports comes back by the real name.
test('resolve: a file reached through a symbolic link and by its own path is one module', async () => {
  if (onKernel()) return
  const COUNT = 'let n = 0\nexport const bump = () => ++n'
  const twice = (first, second) => `import { bump } from '${first}'\nimport { bump as again } from '${second}'\nexport const f = () => bump() * 10 + again()`
  // a linked directory inside the project
  const inner = files({ 'main.js': twice('./lib/count.js', './alias/count.js') })
  mkdirSync(join(inner, 'lib'))
  writeFileSync(join(inner, 'lib', 'count.js'), COUNT)
  symlinkSync(join(inner, 'lib'), join(inner, 'alias'))
  // the project through a link, an import back by the real name
  const outer = files({ 'count.js': COUNT })
  const link = join(scratch, `link${programs++}`)
  symlinkSync(outer, link)
  writeFileSync(join(outer, 'main.js'), twice('./count.js', `../${outer.slice(scratch.length + 1)}/count.js`))
  // (each with the one module it holds: the file under the path its first import met it by)
  for (const [name, entry, first] of [['a linked directory', join(inner, 'main.js'), join(inner, 'lib', 'count.js')], ['an entry through a link', join(link, 'main.js'), join(link, 'count.js')]]) {
    const want = (await import(pathToFileURL(entry).href)).f()
    is(want, 12, `${name}: Node keeps one counter`)
    const { code, modules } = resolveModuleGraph(entry)
    is(Object.keys(modules).join(), first, `${name}: one module`)
    is(jz(code, { modules }).exports.f(), want, `${name}: as Node`)
  }
})
