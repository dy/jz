#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

// The self-compiler reads the arena through kernel intrinsics; a JS host owns
// its memory and takes no checkpoint (scripts/native-arena.js, the one list).
import { installNativeArena } from '../../scripts/native-arena.js'
installNativeArena()

const file = process.argv[2]
if (!file) { console.error('usage: run-v8.mjs <case.js>'); process.exit(2) }
const mod = await import(pathToFileURL(file))
mod.main()
