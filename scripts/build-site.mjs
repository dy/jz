#!/usr/bin/env node
// Keep the gallery readable before JavaScript runs. Only the marked block is generated.
// Usage: node scripts/build-site.mjs [site-dir] [--check]
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { examples } from '../examples/examples.js'

const dir = process.argv.slice(2).find(arg => arg !== '--check') || fileURLToPath(new URL('../', import.meta.url))
const file = resolve(dir, 'examples/index.html')
const html = readFileSync(file, 'utf8')
const block = /<!-- gallery:start -->[\s\S]*?<!-- gallery:end -->/
if (html.match(/<!-- gallery:(?:start|end) -->/g)?.length !== 2 || !block.test(html))
  throw Error('Expected one gallery block in ' + file)
const esc = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const cards = examples.map(({ name, title, blurb }) => `  <a class="cell" href="./${esc(name)}/">
    <div class="shot"><img src="./thumbs/${esc(name)}.webp" width="760" height="468" loading="lazy" alt="${esc(title)}"></div>
    <div class="cap">
      <span class="name">${esc(name.replace(/-/g, '‑'))}</span>
      <span class="desc">${esc(blurb)}</span>
    </div>
  </a>`).join('\n')
const next = html.replace(block, () => `<!-- gallery:start -->\n${cards}\n<!-- gallery:end -->`)
if (process.argv.includes('--check')) {
  if (next !== html) throw Error('Gallery is stale. Run npm run build:site')
} else if (next !== html) writeFileSync(file, next)
