// `node --import ./test/_mutant.mjs <test>` with JZ_MUTANT=<name> (test/_mutations.js)
// or JZ_MUTANT_EDITS=<json: module suffix → [[find, replace], …]> runs the test
// with one compiler module's source edited as Node loads it. Test-only: the
// tree on disk is untouched, and an edit whose find is absent or ambiguous
// fails the load.
import { register } from 'node:module'
import { MUTANTS } from './_mutations.js'

const name = process.env.JZ_MUTANT
const edits = name ? MUTANTS[name]?.edits : process.env.JZ_MUTANT_EDITS ? JSON.parse(process.env.JZ_MUTANT_EDITS) : null
if (!edits) throw new Error(`_mutant: ${name ? `unknown mutant ${name}` : 'set JZ_MUTANT or JZ_MUTANT_EDITS'}`)
register('./_mutant-hooks.mjs', import.meta.url, { data: { edits } })
