/** Global compilation context, reset per jz() call. */
export const ctx = {
  emit: {},
  stdlib: {},
  includes: new Set(),
  imports: [],
  scope: {},
  memory: false,
  modules: {},
  vars: {},
  exports: {},
  funcs: [],
  globals: [],
}
