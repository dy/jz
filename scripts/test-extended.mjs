#!/usr/bin/env node
import { runTasks, extendedTasks } from './test-tasks.mjs'
const results = await runTasks(extendedTasks())
process.exitCode = results.some(r => r.code !== 0) ? 1 : 0
