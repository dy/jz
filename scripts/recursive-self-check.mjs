#!/usr/bin/env node
/** Full jz×jz gate on dist/jz.wasm: `scripts/kernel-gate.mjs --dist --gate recursive`.
 *  This script consumes dist/ by name; the gate runner never falls back to it. */
import { spawnSync } from 'node:child_process'
const r = spawnSync(process.execPath, [new URL('./kernel-gate.mjs', import.meta.url).pathname, '--dist', '--gate', 'recursive', ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(r.status ?? 1)
