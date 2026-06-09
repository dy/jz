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
// (Self-host fallout: `PASS_NAMES = ['watr', …]` had `'watr'` rewritten to
// `…/node_modules/watr/watr.js`, corrupting every `'watr'` constant — and so the
// kernel's whole optimize config, since `cfg.watr` then read that path.)
const importRe = /^\s*(?:import\b[^'"]*?\bfrom\s*|import\s+|export\b[^'"]*?\bfrom\s*)['"]([^'"]+)['"]/gm

/**
 * @param {string} entryFile - absolute or cwd-relative path to the entry module.
 * @param {object} [opts]
 * @param {boolean} [opts.resolveNode] - resolve bare specifiers via Node resolution.
 * @returns {{ code: string, modules: Record<string,string> }}
 *   `code` is the entry rewritten to canonical keys; `modules` maps every
 *   reachable absolute path to its (also-rewritten) source.
 */
export function resolveModuleGraph(entryFile, { resolveNode = false } = {}) {
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
    if (pkgImports[specifier]) return pkgImports[specifier]
    if (specifier.startsWith('./') || specifier.startsWith('../')) {
      const full = resolve(fromDir, specifier)
      if (existsSync(full)) return full
      if (existsSync(full + '.js')) return full + '.js'
      return null
    }
    if (resolveNode) {
      try {
        const resolved = resolveBareModule(specifier, fromDir)
        if (resolved.startsWith('file:')) return new URL(resolved).pathname
      } catch {}
    }
    return null
  }
  const rewriteImports = (src, fromDir) => src.replace(importRe, (match, spec) => {
    const abs = resolveAbsPath(spec, fromDir)
    if (!abs) return match
    const q = match[match.lastIndexOf(spec) - 1]
    return match.slice(0, match.lastIndexOf(spec) - 1) + q + abs + q
  })
  const resolveModule = (specifier, fromDir) => {
    const abs = resolveAbsPath(specifier, fromDir)
    if (!abs || seenPaths.has(abs)) return
    seenPaths.add(abs)
    let src; try { src = readFileSync(abs, 'utf8') } catch { return }
    modules[abs] = rewriteImports(src, dirname(abs))
    let m; importRe.lastIndex = 0
    while ((m = importRe.exec(src)) !== null) resolveModule(m[1], dirname(abs))
  }
  let m; importRe.lastIndex = 0
  while ((m = importRe.exec(code)) !== null) resolveModule(m[1], dir)

  return { code: rewriteImports(code, dir), modules }
}
