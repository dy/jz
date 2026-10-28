// A real program, compiled as it is: guest271314's runtime-agnostic WebSocket
// server (test/fixtures/websocket-server, verbatim). It keeps its frames in a
// resizable ArrayBuffer, tests its streams with `instanceof WritableStream`,
// reads them with `for await`, answers the handshake through `crypto.subtle`
// and `new Response(...).body.pipeTo(...)`, or through the bundled SHA-1 module
// it imports dynamically where the host has no `crypto.subtle`. Node constructs
// the class the program exports, compiled by jz, with `new`, as it constructs
// the same class run as plain JS; drives both with host streams; and the bytes
// each writes must be the same.
import test from 'tst'
import { is, ok } from 'tst/assert.js'
import { readFileSync } from 'node:fs'
import jz from '../index.js'
import { levels, onWasi } from './_matrix.js'
import { WebSocketConnection } from './fixtures/websocket-server/websocket-server.js'

const dir = new URL('./fixtures/websocket-server/', import.meta.url)
const source = readFileSync(new URL('websocket-server.js', dir), 'utf8')
const modules = { './sha1-uint8array.min.js': readFileSync(new URL('sha1-uint8array.min.js', dir), 'utf8') }
// One compile per level, shared by both tests (a large program: two seconds each).
const compiled = new Map()
const compiledAt = (optimize) => compiled.get(optimize) ?? compiled.set(optimize, jz(source, { modules, optimize }).exports.WebSocketConnection).get(optimize)

// A client frame: FIN, the opcode, the mask bit and a 7-bit, 16-bit (126) or
// 64-bit (127) length, the key, the payload XORed with it.
const frame = (opcode, payload, key = [0x37, 0xfa, 0x21, 0x3d]) => {
  const n = payload.length
  const head = n < 126 ? [0x80 | opcode, 0x80 | n] : n < 65536 ? [0x80 | opcode, 0x80 | 126, n >> 8, n & 255]
    : [0x80 | opcode, 0x80 | 127, 0, 0, 0, 0, n >>> 24 & 255, n >>> 16 & 255, n >>> 8 & 255, n & 255]
  const out = new Uint8Array(head.length + 4 + n)
  out.set(head)
  out.set(key, head.length)
  for (let i = 0; i < n; i++) out[head.length + 4 + i] = payload[i] ^ key[i % 4]
  return out
}
const text = (s) => new TextEncoder().encode(s)
const hex = (chunks) => chunks.map(c => Buffer.from(c).toString('hex'))

// Feed `chunks` to one connection, let it answer, and return every chunk it wrote.
const session = async (Connection, chunks, after) => {
  const input = new TransformStream(), output = new TransformStream()
  const conn = new Connection(input.readable, output.writable)
  const written = []
  const reading = (async () => { for await (const c of output.readable) written.push(c) })()
  const done = conn.processWebSocketStream()
  const w = input.writable.getWriter()
  for (const c of chunks) await w.write(c)
  if (after) await after(conn)
  await w.close()
  await done
  await new Promise(r => setTimeout(r, 20))
  void reading
  return hex(written)
}

// console.log/trace of the specimen go quiet.
const quiet = async (f) => {
  const { log, trace } = console
  console.log = console.trace = () => {}
  try { return await f() } finally { console.log = log; console.trace = trace }
}

const big = new Uint8Array(70000).map((_, i) => i * 7 & 255)
const SESSIONS = {
  // text, binary, ping, a 126-length and a 127-length (64-bit) frame, then close
  frames: [frame(1, text('hello')), frame(2, new Uint8Array([1, 2, 3, 250])), frame(9, text('ping')),
    frame(1, new Uint8Array(300).map((_, i) => 65 + i % 26)), frame(2, big), frame(8, new Uint8Array([3, 232, 98, 121, 101]))],
  // frames split across chunks and several frames in one chunk: the buffer grows and shrinks
  split: (() => {
    const a = frame(1, text('split me')), b = frame(2, new Uint8Array(200).fill(9)), c = frame(9, new Uint8Array(0)), d = frame(8, new Uint8Array(0))
    const all = new Uint8Array([...a, ...b, ...c])
    return [all.subarray(0, 3), all.subarray(3, 11), all.subarray(11, 140), all.subarray(140), d]
  })(),
  // the server's own send() of bytes and of a string, then the client's close
  sends: [frame(1, text('x'))],
  // an opcode the server does not know closes with 1002
  unknown: [frame(3, text('?'))],
}

test('the WebSocket server compiled by jz writes, frame for frame, what it writes as plain JS', { timeout: 120000 }, async () => {
  if (onWasi()) return
  for (const optimize of levels(0, 2, 3, 'size')) {
    const Connection = compiledAt(optimize)
    for (const [name, chunks] of Object.entries(SESSIONS)) {
      const after = name === 'sends' ? async (conn) => { await conn.send(new Uint8Array([4, 5, 6])); await conn.send('hi'); return conn.close(1000, 'bye') } : null
      const want = await quiet(() => session(WebSocketConnection, chunks, after))
      const got = await quiet(() => session(Connection, chunks, after))
      ok(want.length > 0, `${name}: the plain run writes`)
      is(got, want, `O${optimize} ${name}: the same chunks, byte for byte`)
    }
  }
})

test('the handshake answers through crypto.subtle, or the bundled SHA-1 without it, as plain JS does', { timeout: 120000 }, async () => {
  if (onWasi()) return
  const key = 'dGhlIHNhbXBsZSBub25jZQ=='   // RFC 6455's sample: the accept value is s3pPLMBiTxaQ9kYGzzhZRbK+xOo=
  const run = async (Connection, viaWriter) => {
    const t = new TransformStream(), out = []
    const reading = (async () => { for await (const c of t.readable) out.push(c) })()
    const writer = viaWriter ? t.writable.getWriter() : null
    await Connection.hashWebSocketKey(key, writer ?? t.writable)
    if (writer) await writer.close(); else await t.writable.close()
    await reading
    return Buffer.concat(out.map(c => Buffer.from(c))).toString()
  }
  const plainSubtle = await quiet(() => run(WebSocketConnection, false))
  ok(plainSubtle.includes('s3pPLMBiTxaQ9kYGzzhZRbK+xOo='), 'the plain run accepts the sample key')
  const crypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  for (const optimize of levels(0, 2, 3, 'size')) {
    const Connection = compiledAt(optimize)
    is(await quiet(() => run(Connection, false)), plainSubtle, `O${optimize} crypto.subtle, a WritableStream`)
    // no crypto.subtle: the dynamic import of the SHA-1 module, a writer
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true })
    try {
      const want = await quiet(() => run(WebSocketConnection, true)), got = await quiet(() => run(Connection, true))
      ok(want.includes('s3pPLMBiTxaQ9kYGzzhZRbK+xOo='), 'the plain fallback accepts the sample key')
      is(got, want, `O${optimize} the bundled SHA-1, a writer`)
    } finally { Object.defineProperty(globalThis, 'crypto', crypto) }
  }
})
