#!/usr/bin/env node
// Build the benchmark's pinned source revision; the npm release trails main.
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const rev = '6d1907aa06d8da25b19dc0981ac25e02ed22dd14'
const helperVersion = '0.1.7'
const host = `${process.platform}-${process.arch}${process.platform === 'linux' ? '-gnu' : ''}`
if (!process.argv[2]) throw new Error('usage: node scripts/install-scriptc.mjs <directory>')
if (!['darwin-arm64', 'linux-x64-gnu'].includes(host)) throw new Error(`unsupported benchmark host: ${host}`)
if (process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime)
  throw new Error('the Linux benchmark toolchain requires glibc')
const root = resolve(process.argv[2]), src = join(root, rev)
mkdirSync(src, { recursive: true })
const run = (cmd, args, env = process.env) => execFileSync(cmd, args, { cwd: src, stdio: 'inherit', env })
const archive = join(root, 'source.tar.gz')
run('curl', ['-fsSL', '--retry', '2', '-o', archive, `https://github.com/vercel-labs/scriptc/archive/${rev}.tar.gz`])
run('tar', ['xzf', archive, '--strip-components=1'])
run('npx', ['--yes', 'pnpm@11.1.3', 'install', '--frozen-lockfile'])
// The published LLVM 22 helper has the same native host lowering. Changes
// since 0.1.7 add cross-target backends and Android TLS, unused by this lane.
const pack = JSON.parse(execFileSync('npm', ['pack', `@scriptc/llvm-${host}@${helperVersion}`, '--json'], {
  cwd: src, encoding: 'utf8',
}))[0].filename
run('tar', ['xzf', pack, '-C', join(src, `packages/llvm-${host}`), '--strip-components=1', 'package/bin'])
run('node', [join(src, `packages/runtime-${host}/scripts/build.mjs`)], {
  ...process.env, CC: process.env.CC || (process.platform === 'darwin' ? '/usr/bin/clang' : 'clang'),
})
run('npx', ['--yes', 'pnpm@11.1.3', '-r', '--filter', './packages/*', 'run', 'build'])
const version = JSON.parse(readFileSync(join(src, 'packages/cli/package.json'))).version
const launcher = join(root, 'scriptc')
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'"
writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then
  printf '%s\\n' ${quote(`${version} [git ${rev}]`)}
  exit 0
fi
exec node ${quote(join(src, 'packages/cli/dist/main.js'))} "$@"
`)
chmodSync(launcher, 0o755)
rmSync(archive)
rmSync(join(src, pack))
console.log(`SCRIPTC_BIN=${launcher}`)
