/**
 * Module-graph resolver — flattens a file's relative-import graph into the
 * { code, modules } pair that `compile()` expects.
 *
 * Every specifier is canonicalized to an absolute path so the same physical
 * file always produces one module instance. Two relative specifiers from
 * different importers (e.g. `'../../parse.js'` from a feature module and
 * `'./parse.js'` from the entry) would otherwise hit prepare.js as separate
 * modules with separate exports / mangling prefixes — and any module-level
 * state (like a shared `lookup` registry) would split in two.
 * The file is the physical one, as Node's own module identity is: a directory
 * reached through a symbolic link (macOS's temporary directory, a linked
 * package or directory) names its files by two absolute paths, and a file
 * imported by both is the one module, under the path it was first met by.
 */

import { readFileSync, existsSync, realpathSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { execFileSync } from 'child_process'
import { parse } from './parse.js'
import { lineEnd, isSpace } from './unicode.js'

/**
 * A module's import sites as the compiler's parser reads them: `import … from 'x'`,
 * `import 'x'`, `export … from 'x'` and a literal `import('x')` (jzify bundles it too),
 * each its specifier, the literal's [at, end) in the source with its quotes and the
 * names an `import` binds (`default` for a default). A pattern over the text cannot
 * tell code from a string, a comment or a regex holding the word, and one anchored at
 * a line's start missed the second statement of a line (`;import x from"y"`, a
 * minified bundle's). The parser places a `from` at its keyword, a bare `import 'x'`
 * at `import` and `import('x')` at its parenthesis (`['()', 'import', s]` inside an
 * expression, `['import', ['()', s]]` where the call starts one): the literal is the
 * next token. A source the parser refuses has no sites: the compile reports it.
 */
export function importSites(source) {
  let ast
  try { ast = parse(source, 'jz', 0, false) } catch (e) { if (e instanceof SyntaxError) return []; throw e }
  const sites = []
  const lit = (n) => Array.isArray(n) && n[0] == null && n.length === 2 && typeof n[1] === 'string'
  const clauseNames = (c, out) => {
    if (typeof c === 'string') out.push('default')
    else if (Array.isArray(c) && c[0] === '{}')
      for (const it of Array.isArray(c[1]) && c[1][0] === ',' ? c[1].slice(1) : c[1] == null ? [] : [c[1]])
        out.push(Array.isArray(it) && it[0] === 'as' ? (lit(it[1]) ? it[1][1] : it[1]) : it)
    return out
  }
  // the literal after the token of `width` at `loc` (past spaces and comments)
  const add = (loc, width, spec, names) => {
    if (typeof loc !== 'number') return
    let i = loc + width
    for (;;) {
      if (source.startsWith('/*', i)) { const e = source.indexOf('*/', i + 2); if (e < 0) return; i = e + 2 }
      else if (source.startsWith('//', i)) while (i < source.length && !lineEnd(source.charCodeAt(i))) i++
      else if (isSpace(source.charCodeAt(i))) i++
      else break
    }
    const q = source[i]
    if (q !== '"' && q !== "'") return
    let j = i + 1
    while (j < source.length && source[j] !== q) j += source[j] === '\\' ? 2 : 1
    // (a literal of escapes or of joined pieces stays as written, as the compile reads it)
    if (source.slice(i + 1, j) === spec) sites.push({ spec, at: i, end: j + 1, names })
  }
  const walk = (n, names) => {
    if (!Array.isArray(n)) return
    const op = n[0]
    if (op === 'from' && lit(n[2])) return add(n.loc, 4, n[2][1], names ? clauseNames(n[1], names) : [])
    if (op === 'import' && lit(n[1])) return add(n.loc, 6, n[1][1], [])
    if (op === '()' && n[1] === 'import' && lit(n[2])) return add(n.loc, 1, n[2][1], [])
    if (op === 'import' && Array.isArray(n[1]) && n[1][0] === '()' && n[1].length === 2 && lit(n[1][1])) return add(n[1].loc, 1, n[1][1][1], [])
    // (`import D, { a } from 'x'` parses as `[',', ['import', 'D'], ['from', …]]`)
    if (op === ',' && n.length === 3 && Array.isArray(n[1]) && n[1][0] === 'import' && typeof n[1][1] === 'string' && Array.isArray(n[2]) && n[2][0] === 'from')
      return walk(n[2], ['default'])
    for (let i = 1; i < n.length; i++) walk(n[i], op === 'import' ? [] : null)
  }
  walk(ast, null)
  return sites.sort((a, b) => a.at - b.at)
}

/** The source with each import site's literal as `rewrite(literal, spec, names)` returns
 *  it: graph resolution and build provenance recognize the same sites. */
export const rewriteModuleImports = (source, rewrite, sites = importSites(source)) => {
  let out = '', at = 0
  for (const s of sites) { out += source.slice(at, s.at) + rewrite(source.slice(s.at, s.end), s.spec, s.names); at = s.end }
  return out + source.slice(at)
}

/**
 * @param {string} entryFile - absolute or cwd-relative path to the entry module.
 * @param {object} [opts]
 * @param {boolean} [opts.resolveNode] - resolve bare specifiers via Node resolution.
 * @param {Record<string,string>} [opts.sources] - module sources by path suffix, standing in
 *   for the files they match (a host-only module replaced by a stub, say).
 * @param {string[]} [opts.external] - bare specifiers (a package name matches
 *   itself and its subpaths) left unbundled: the compile binds them as host
 *   imports (`imports: { '<specifier>': {…} }`) – the codec, device and
 *   filesystem edges of a library that are host services by nature.
 * @returns {{ code: string, modules: Record<string,string>, externals: Record<string,string[]> }}
 *   `code` is the entry rewritten to canonical keys; `modules` maps every
 *   reachable absolute path to its (also-rewritten) source; `externals` lists
 *   the names imported from each external specifier.
 */
export function resolveModuleGraph(entryFile, { resolveNode = false, external = [], sources = {} } = {}) {
  // a source override stands in for the file whose resolved path ends with its key
  const sourceOf = (abs) => { for (const k of Object.keys(sources)) if (abs.endsWith(k)) return sources[k]; return null }
  // a package name matches itself and its subpaths; an entry with a path
  // (`src/AudioWorklet.js`) matches the resolved file by suffix
  const isExternal = (spec, abs) => external.some(e => e.includes('/') && !e.startsWith('@')
    ? (abs != null && abs.endsWith(e))
    : (spec === e || spec.startsWith(e + '/')))
  const externals = {}            // external specifier → imported names seen (default as 'default')
  const dir = dirname(resolve(entryFile))
  const code = readFileSync(resolve(entryFile), 'utf8')
  const modules = {}              // keyed by canonical absolute path
  const seenPaths = new Set()
  const pkgImports = {}           // pkg.imports spec → absolute path

  const pkgFile = join(dir, 'package.json')
  if (existsSync(pkgFile)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgFile, 'utf8'))
      if (pkg.imports) for (const [spec, path] of Object.entries(pkg.imports))
        pkgImports[spec] = resolve(dir, path)
    } catch {}
  }

  // (a process per specifier and directory: the modules of one directory ask it once)
  const bareResolved = new Map()
  const resolveBareModule = (specifier, fromDir) => {
    const key = fromDir + '\0' + specifier
    let resolved = bareResolved.get(key)
    if (resolved === undefined) {
      try {
        resolved = execFileSync(
          process.execPath,
          ['--input-type=module', '-e', 'process.stdout.write(import.meta.resolve(process.argv[1]))', specifier],
          { cwd: fromDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim()
      } catch (e) { resolved = e }
      bareResolved.set(key, resolved)
    }
    if (resolved instanceof Error) throw resolved
    return resolved
  }
  // (one module a physical file: a file met again under another spelling takes the one it was first met by)
  const spelled = new Map()       // real path → the absolute path the file was first resolved to
  const resolveAbsPath = (specifier, fromDir) => {
    const abs = locate(specifier, fromDir)
    if (abs == null || !existsSync(abs)) return abs
    const real = realpathSync(abs), first = spelled.get(real)
    if (first === undefined) spelled.set(real, abs)
    return first ?? abs
  }
  const locate = (specifier, fromDir) => {
    if (isExternal(specifier)) return null
    if (pkgImports[specifier]) return pkgImports[specifier]
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const full = resolve(fromDir, specifier)
      const abs = existsSync(full) ? full : existsSync(full + '.js') ? full + '.js' : null
      return abs != null && isExternal(specifier, abs) ? null : abs
    }
    if (resolveNode) {
      try {
        const resolved = resolveBareModule(specifier, fromDir)
        if (resolved.startsWith('file:')) return preferEsmEntry(new URL(resolved).pathname)
      } catch {}
    }
    return null
  }
  // Node resolves a package without an `exports` map to its `main` (often a
  // CommonJS build); a bundler takes the `module` entry, the ESM build jz can
  // compile. When `main` was picked and `module` exists beside it, take that.
  const preferEsmEntry = (abs) => {
    for (let d = dirname(abs); d !== dirname(d); d = dirname(d)) {
      const pj = join(d, 'package.json')
      if (!existsSync(pj)) continue
      try {
        const pkg = JSON.parse(readFileSync(pj, 'utf8'))
        if (pkg.exports || !pkg.module || !pkg.main) return abs
        const mod = resolve(d, pkg.module)
        return resolve(d, pkg.main) === abs && existsSync(mod) ? mod : abs
      } catch { return abs }
    }
    return abs
  }
  // A specifier's literal: an external's as written (its names recorded), another's
  // as the canonical path, in its own quotes.
  const rewriteOne = (literal, spec, names, fromDir) => {
    const rel = spec.startsWith('./') || spec.startsWith('../')
    if (isExternal(spec) || (rel && isExternal(spec, resolve(fromDir, spec)) || (rel && isExternal(spec, resolve(fromDir, spec) + '.js')))) {
      const seen = externals[spec] ??= new Set()
      for (const nm of names) seen.add(nm)
      return literal
    }
    const abs = resolveAbsPath(spec, fromDir)
    return abs ? literal[0] + abs + literal[0] : literal
  }
  const rewriteImports = (src, sites, fromDir) => rewriteModuleImports(src, (literal, spec, names) => rewriteOne(literal, spec, names, fromDir), sites)
  const resolveModule = (specifier, fromDir) => {
    const abs = resolveAbsPath(specifier, fromDir)
    if (!abs || seenPaths.has(abs)) return
    seenPaths.add(abs)
    let src = sourceOf(abs); if (src == null) try { src = readFileSync(abs, 'utf8') } catch { return }
    const sites = importSites(src)
    modules[abs] = rewriteImports(src, sites, dirname(abs))
    for (const s of sites) resolveModule(s.spec, dirname(abs))
  }
  const sites = importSites(code)
  for (const s of sites) resolveModule(s.spec, dir)

  return { code: rewriteImports(code, sites, dir), modules, externals: Object.fromEntries(Object.entries(externals).map(([k, v]) => [k, [...v]])) }
}
