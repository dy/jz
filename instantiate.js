/** jz/interop: run prebuilt jz wasm without the compiler. interop.js is the runtime
 * behind it; its other exports serve the compiler and the tests. */
export { instantiate } from './interop.js'
