import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const POST = join(ROOT, 'scripts/native/postprocess-watr.awk')
const fixture = `#define FORCE_READ_INT(var) __asm__("" ::"r"(var));
#define FORCE_READ_FLOAT(var) __asm__("" ::"f"(var));
#define DEFINE_STORE(name, t1, t2)
DEFINE_STORE(i64_store32, u32, u64)
#define SIMD_FORCE_READ(var) __asm__("" ::"w"(var));
// clang-format on
static void init_globals(w2c_kernel* instance) {
}
static struct wasm_multi_0x2 w2c_kernel_f0(w2c_kernel * instance, u32 x) {
}
u32 w2c_kernel_main(w2c_kernel* instance) {
}
f64 w2c_kernel_wide(w2c_kernel* instance, f64 a, f64 b, f64 c,
    f64 d, f64 e) {
}
void wasm2c_kernel_instantiate(w2c_kernel* instance, void* imports) {
}
`

test('native wasm2c postprocess is module-generic and fail-closed', () => {
  const out = execFileSync('awk', ['-f', POST], { input: fixture, encoding: 'utf8' })
  is((out.match(/_md = instance->w2c_memory\.data/g) || []).length, 3,
    'injects generated scalar, struct-return, and wrapped-signature functions only')
  ok(!/__asm__/.test(out), 'removes WABT FORCE_READ barriers')
  ok(/#define i32_load\(mem, addr\)/.test(out), 'shadows scalar memory helpers')
  ok(/#define v128_load\(mem, addr\).*_md/.test(out), 'shadows SIMD memory helpers')
  ok(!/init_globals[^}]*_md/s.test(out), 'does not read memory before initialization')
  ok(!/wasm2c_kernel_instantiate[^}]*_md/s.test(out), 'does not touch lifecycle functions')

  const bad = spawnSync('awk', ['-f', POST], { input: 'void f(void) {}\n', encoding: 'utf8' })
  ok(bad.status !== 0, 'generator-format drift fails instead of silently losing tuning')
})
