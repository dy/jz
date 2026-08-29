// Shared native/kernel regression for BigInt typed-array element stores.
// The payload deliberately has PTR.BIGINT tag bits and a hostile low-word
// offset: unconditional runtime tag probing would dereference near 4 GiB.
export const BIGINT_TYPED_STORE_PAYLOAD = '0x7ffa8000ffffffffn'

export const BIGINT_TYPED_STORE_SOURCE = `
  export let boxedI64 = present => {
    let value = 0
    if (present) value = 0x7ffa8000ffffffffn
    let out = new BigInt64Array(1)
    out[0] = value
    return out[0] === 0x7ffa8000ffffffffn ? 1 : 0
  }
  export let boxedU64 = present => {
    let value = 0
    if (present) value = 0x7ffa8000ffffffffn
    let out = new BigUint64Array(1)
    out[0] = value
    return out[0] === 0x7ffa8000ffffffffn ? 1 : 0
  }
  export let rawI64 = () => {
    let value = 0x7ffa8000ffffffffn
    let out = new BigInt64Array(1)
    out[0] = value
    return out[0] === 0x7ffa8000ffffffffn ? 1 : 0
  }
  export let rawU64 = () => {
    let value = 0x7ffa8000ffffffffn
    let out = new BigUint64Array(1)
    out[0] = value
    return out[0] === 0x7ffa8000ffffffffn ? 1 : 0
  }
`

export const BIGINT_TYPED_STORE_ERROR_SOURCE = `
  export let mismatchI64 = index => {
    let value = 0
    if (index < 0) value = 7n
    let out = new BigInt64Array(1)
    out[index] = value
    return 1
  }
  export let mismatchU64 = index => {
    let value = 0
    if (index < 0) value = 7n
    let out = new BigUint64Array(1)
    out[index] = value
    return 1
  }
`

export const BIGINT_TYPED_STORE_CATCH_SOURCE = `
  export let caughtMismatch = () => {
    let trace = 0, value = 0
    if (trace < 0) value = 7n
    let out = new BigInt64Array(1)
    try {
      out[(trace = trace + 1, 2)] = value
      return 99
    } catch (error) {
      return trace * 10 + (error.name === 'TypeError' ? 1 : 0)
    }
  }
`

export const BIGINT_TYPED_STORE_CALLS = [
  { fn: 'boxedI64', args: [1], expect: 1 },
  { fn: 'boxedU64', args: [1], expect: 1 },
  { fn: 'rawI64', args: [], expect: 1 },
  { fn: 'rawU64', args: [], expect: 1 },
]

export const BIGINT_TYPED_STORE_THROW_CALLS = [
  { fn: 'mismatchI64', args: [0] },
  { fn: 'mismatchI64', args: [2] },
  { fn: 'mismatchU64', args: [0] },
  { fn: 'mismatchU64', args: [2] },
]
