// Read-only evidence hook: substitute one committed summary implementation,
// snapshot its complete fact graph at publication, leave readers unchanged.
import {readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {resolve} from 'node:path'
import {fileURLToPath, pathToFileURL} from 'node:url'
const root = resolve(process.env.JZ_FACT_ROOT || fileURLToPath(new URL('../..', import.meta.url)))
const target = pathToFileURL(resolve(root, 'src/summary/index.js')).href
export async function load(url, context, next) {
  if (url !== target) return next(url, context)
  let source = process.env.JZ_FACT_REV
    ? execFileSync('git', ['show', `${process.env.JZ_FACT_REV}:src/summary/index.js`], {cwd:root, encoding:'utf8'})
    : readFileSync(new URL(url), 'utf8')
  const needle = '  return summaryQueries(queryFacts)'
  if (source.split(needle).length !== 2) throw Error('summary return anchor drift')
  source = source.replace(needle, '  globalThis.captureFacts(queryFacts)\n' + needle)
  return {format:'module', source, shortCircuit:true}
}
