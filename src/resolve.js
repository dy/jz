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
 */

import { readFileSync, existsSync } from 'fs'
import { dirname, resolve, join } from 'path'
import { execFileSync } from 'child_process'

// Matches real module imports/exports at statement position — and ONLY those:
//   import 'x'                         (bare side-effect import)
//   import … from 'x'                  (default/named/namespace)
//   export … from 'x' / export * from  (re-export)
// The specifier MUST follow `from` (or be a bare `import`'s string). The old
// `(?:import|export)\s+[^'"]*?['"]…` matched any post-keyword string because
// `[^'"]` spans newlines, so `export const X = [⏎ 'lit'` was read as `export …
// 'lit'` — bundling then rewrote the bare string literal `'lit'` to a module path.
// (Self-compile fallout: `PASS_NAMES = ['watr', …]` had `'watr'` rewritten to
// `…/node_modules/watr/watr.js`, corrupting every `'watr'` constant — and so the
// kernel's whole optimize config, since `cfg.watr` then read that path.)
const importRe = /^\s*(?:import\b[^'"]*?\bfrom\s*|import\s+|export\b[^'"]*?\bfrom\s*)['"]([^'"]+)['"]/gm
// `await import('x')` with a literal specifier at module level is a static
// import in all but syntax (jzify hoists it); bundle its target the same way.
const dynImportRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * @param {string} entryFile - absolute or cwd-relative path to the entry module.
 * @param {object} [opts]
 * @param {boolean} [opts.resolveNode] - resolve bare specifiers via Node resolution.
 * @param {string[]} [opts.external] - bare specifiers (a package name matches
 *   itself and its subpaths) left unbundled: the compile binds them as host
 *   imports (`imports: { '<specifier>': {…} }`) – the codec, device and
 *   filesystem edges of a library that are host services by nature.
 * @returns {{ code: string, modules: Record<string,string>, externals: Record<string,string[]> }}
 *   `code` is the entry rewritten to canonical keys; `modules` maps every
 *   reachable absolute path to its (also-rewritten) source; `externals` lists
 *   the names imported from each external specifier.
 */
export function resolveModuleGraph(entryFile, { resolveNode = false, external = [] } = {}) {
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

  const resolveBareModule = (specifier, fromDir) => execFileSync(
    process.execPath,
    ['--input-type=module', '-e', 'process.stdout.write(import.meta.resolve(process.argv[1]))', specifier],
    { cwd: fromDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim()
  const resolveAbsPath = (specifier, fromDir) => {
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
  const rewriteOne = (match, spec, fromDir) => {
    const rel = spec.startsWith('./') || spec.startsWith('../')
    if (isExternal(spec) || (rel && isExternal(spec, resolve(fromDir, spec)) || (rel && isExternal(spec, resolve(fromDir, spec) + '.js')))) {
      const names = externals[spec] ??= new Set()
      const m = /^import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\})?/.exec(match)
      if (m?.[1]) names.add('default')
      for (const part of (m?.[2] ?? '').split(',')) { const nm = part.trim().split(/\s+as\s+/)[0]; if (nm) names.add(nm) }
      return match
    }
    const abs = resolveAbsPath(spec, fromDir)
    if (!abs) return match
    const at = match.lastIndexOf(spec), q = match[at - 1]
    return match.slice(0, at - 1) + q + abs + q + match.slice(at + spec.length + 1)
  }
  const rewriteImports = (src, fromDir) => src
    .replace(importRe, (match, spec) => rewriteOne(match, spec, fromDir))
    .replace(dynImportRe, (match, spec) => rewriteOne(match, spec, fromDir))
  const specifiersIn = (src) => {
    const out = []
    for (const re of [importRe, dynImportRe]) { let m; re.lastIndex = 0; while ((m = re.exec(src)) !== null) out.push(m[1]) }
    return out
  }
  const resolveModule = (specifier, fromDir) => {
    const abs = resolveAbsPath(specifier, fromDir)
    if (!abs || seenPaths.has(abs)) return
    seenPaths.add(abs)
    let src; try { src = readFileSync(abs, 'utf8') } catch { return }
    modules[abs] = rewriteImports(src, dirname(abs))
    for (const spec of specifiersIn(src)) resolveModule(spec, dirname(abs))
  }
  for (const spec of specifiersIn(code)) resolveModule(spec, dir)

  return { code: rewriteImports(code, dir), modules, externals: Object.fromEntries(Object.entries(externals).map(([k, v]) => [k, [...v]])) }
}
