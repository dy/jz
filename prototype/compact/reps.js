// Scalar representation IDs shared by ProgramIndex summaries and disposable
// function lowering. Signed and unsigned i32 use the same Wasm storage type;
// their distinct IDs determine how values cross an f64 boundary.

export const REP_UNKNOWN = 0
export const REP_F64 = 1
export const REP_I32 = 2
export const REP_U32 = 3

export const isI32Rep = (rep) => rep === REP_I32 || rep === REP_U32
export const physicalRep = (rep) => isI32Rep(rep) ? REP_I32 : REP_F64
export const wasmType = (rep) => isI32Rep(rep) ? 'i32' : 'f64'
