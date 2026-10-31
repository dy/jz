// The test matrix's legs (scripts/test-tasks.mjs, .github/workflows/test.yml):
// JZ_TEST_OPTIMIZE, JZ_TEST_HOST and JZ_TEST_STRICT are defaults for every compile
// of the process, an option a call passes winning (src/compiler.js
// setCompileDefaults). The runner and test/util.js import this, so a process a
// test starts through test/util.js compiles under the same leg.
import { setCompileDefaults } from '../src/compiler.js'

const env = process.env, defaults = {}
if (env.JZ_TEST_OPTIMIZE != null) {
  const v = env.JZ_TEST_OPTIMIZE
  defaults.optimize = /^-?\d+$/.test(v) ? Number(v) : v === 'false' ? false : v
}
if (env.JZ_TEST_HOST) defaults.host = env.JZ_TEST_HOST
if (env.JZ_TEST_STRICT) defaults.strict = env.JZ_TEST_STRICT === '1'
setCompileDefaults(defaults)
