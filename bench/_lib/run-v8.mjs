#!/usr/bin/env node
import { pathToFileURL } from 'node:url'

const file = process.argv[2]
if (!file) { console.error('usage: run-v8.mjs <case.js>'); process.exit(2) }
const mod = await import(pathToFileURL(file))
mod.main()
