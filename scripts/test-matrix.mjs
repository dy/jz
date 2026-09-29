#!/usr/bin/env node
import { runTasks, matrixTasks } from './test-tasks.mjs'
const results = await runTasks(matrixTasks())
process.exitCode = results.some(r => r.code !== 0) ? 1 : 0
