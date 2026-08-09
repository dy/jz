// Fresh-process compile worker for test/session-reentrancy.js: a brand-new node
// process, so its output can only reflect this ONE compile — no prior compile in
// the same process could have left state behind, module-scope or otherwise. argv[2]
// is base64(JSON({src, opts})); stdout is base64(wasm bytes), nothing else.
import { compile } from '../index.js'

const { src, opts } = JSON.parse(Buffer.from(process.argv[2], 'base64').toString('utf8'))
const bytes = compile(src, opts)
process.stdout.write(Buffer.from(bytes).toString('base64'))
