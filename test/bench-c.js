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
import { mkdtempSync, writeFileSync } from 'node:fs'
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

// The C ports that manage memory by hand (hash tables, JSON writers and parsers,
// growable buffers and tagged-union arrays, cached plans), each at its case's reference checksum
// (REFERENCE_CHECKSUMS in bench/bench.mjs; fftplan and provenance: results.json's
// ref). Built with ASan and UBSan where the ASan runtime starts, else UBSan alone:
// a probe of a trivial program decides once, so a host whose ASan hangs before
// main (the macOS runtime) pays one short timeout, not one per port.
const HAND_MEMORY = { mapstr: 1026625040, mapint: 3954235254, setops: 1463522228, mapobj: 854729057,
  stringify: 1432176915, jsontransform: 3050146119, polytri: 84696351, fabrik: 2711562489,
  fftplan: 2894300847, provenance: 842980037,
  jsonroundtrip: 513158889, arraynumeric: 2668943355, arraydowngrade: 4159919390 }

test('C ports with hand-managed memory: sanitized builds run clean at their reference checksums', { skip: !clangAvailable }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'jz-bench-c-'))
  // -ffp-contract=off as the lanes build: a fused multiply-add moves stringify's float sums
  const cc = (flags, src, bin) => execFileSync('clang', [...sysroot(), '-O1', '-g', '-ffp-contract=off', ...flags, '-o', bin, src, '-lm'], { stdio: 'pipe' })
  const probe = join(dir, 'probe.c'), probeBin = join(dir, 'probe')
  writeFileSync(probe, 'int main(void) { return 0; }\n')
  let asan = true
  try {
    cc(['-fsanitize=address'], probe, probeBin)
    execFileSync(probeBin, { timeout: 10_000, killSignal: 'SIGKILL' })
  } catch { asan = false }
  const flags = [`-fsanitize=${asan ? 'address,' : ''}undefined`, '-fno-sanitize-recover=undefined']
  for (const [id, ref] of Object.entries(HAND_MEMORY)) {
    const bin = join(dir, id)
    cc(flags, join(HERE, `../bench/${id}/${id}.c`), bin)
    const r = spawnSync(bin, { encoding: 'utf8', timeout: 120_000, killSignal: 'SIGKILL' })
    is(r.status, 0, `${id}: exits cleanly${asan ? ' under ASan + UBSan' : ' under UBSan'}${r.stderr ? `: ${r.stderr.split('\n')[0]}` : ''}`)
    is(r.stdout.match(/checksum=(\d+)/)?.[1], String(ref), `${id}: reference checksum`)
  }
})
