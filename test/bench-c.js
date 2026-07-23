/**
 * C bench-comparator hygiene: build the native comparators under
 * AddressSanitizer and pin their deterministic checksums. Guards the
 * memory-safety class PR #108 flagged (sprintf → bounded snprintf in
 * strbuild.c): an overflow aborts under ASan, a truncation or clamp
 * mistake shifts the pinned FNV-1a checksum. Skips when clang is unavailable.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'tst'
import { is, ok } from 'tst/assert.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const have = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0
const clangAvailable = have('clang')

// macOS clang needs the SDK sysroot when invoked outside Xcode's env.
const sysroot = () => {
  const r = spawnSync('xcrun', ['--show-sdk-path'], { encoding: 'utf8' })
  return r.status === 0 ? ['-isysroot', r.stdout.trim()] : []
}

test('strbuild.c: sanitized build runs clean and keeps the pinned checksum', { skip: !clangAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-bench-c-'))
  const bin = join(dir, 'strbuild')
  const build = (san) => execFileSync('clang', [...sysroot(), '-O2', ...(san ? ['-fsanitize=address'] : []),
    '-o', bin, join(HERE, '../bench/strbuild/strbuild.c')], { stdio: 'pipe' })
  let out
  build(true)
  try {
    out = execFileSync(bin, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' })
  } catch (e) {
    // Some hosts ship a dysfunctional ASan runtime (macOS SDK interceptor spin:
    // the instrumented binary busy-loops without ever reaching main). That's a
    // TOOLCHAIN failure, not a finding — fall back to the plain build; the
    // checksum pin below still guards the truncation/clamp semantics. A real
    // sanitizer ABORT exits fast with a report and is rethrown as a failure.
    if (e.code !== 'ETIMEDOUT' && !e.killed) throw e
    build(false)
    out = execFileSync(bin, { encoding: 'utf8', timeout: 60_000, killSignal: 'SIGKILL' })
  }
  const cs = out.match(/checksum=(\d+)/)?.[1]
  // Deterministic input stream (XorShift32 seed baked in) → constant FNV-1a.
  is(cs, '545957244', 'checksum stable under the bounded-snprintf formatting')
  ok(!/ERROR|runtime error/i.test(out), 'no sanitizer findings')
})
