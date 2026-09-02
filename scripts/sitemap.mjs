#!/usr/bin/env node
// Sitemap for the Pages deploy: the site pages plus every example page, read from the
// assembled site dir so it never drifts from what is actually served.
// Usage: node scripts/sitemap.mjs _site > _site/sitemap.xml
import { readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] || '.'
const ORIGIN = 'https://jz.js.org'
const pages = ['', 'repl/', 'examples/', 'bench/', 'floatbeat/']
const examples = readdirSync(join(dir, 'examples'), { withFileTypes: true })
  .filter(d => d.isDirectory() && existsSync(join(dir, 'examples', d.name, 'index.html')))
  .map(d => `examples/${d.name}/`)
  .sort()

process.stdout.write(
  '<?xml version="1.0" encoding="UTF-8"?>\n' +
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
  [...pages, ...examples].map(p => `  <url><loc>${ORIGIN}/${p}</loc></url>\n`).join('') +
  '</urlset>\n'
)
