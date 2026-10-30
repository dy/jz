#!/usr/bin/env node
// Build Static Hermes at the benchmark's pinned revision of facebook/hermes's
// static_h branch, which has no release: the shermes compiler and the VM and
// console libraries its executables link. Needs cmake, a C++17 compiler, curl
// and tar; CMAKE_GENERATOR picks the generator (Ninja where it is installed).
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import { join, resolve } from 'node:path'

const rev = 'c37388faf49933400d2ddf0f0d8913bc3d1ba32f'
if (!process.argv[2]) throw new Error('usage: node scripts/install-shermes.mjs <directory>')
const root = resolve(process.argv[2]), src = join(root, 'src'), build = join(root, 'build')
mkdirSync(src, { recursive: true })
const run = (cmd, args) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit' })
const archive = join(root, 'source.tar.gz')
run('curl', ['-fsSL', '--retry', '2', '-o', archive, `https://codeload.github.com/facebook/hermes/tar.gz/${rev}`])
run('tar', ['xzf', archive, '--strip-components=1', '-C', src])
rmSync(archive)
run('cmake', ['-S', src, '-B', build, '-DCMAKE_BUILD_TYPE=Release'])
run('cmake', ['--build', build, '--parallel', String(availableParallelism()), '--target', 'shermes', 'hermesvm', 'shermes_console'])
// `shermes --version` names only its LLVM fork; the launcher names the source.
const launcher = join(root, 'shermes')
writeFileSync(launcher, `#!/bin/sh
if [ "$1" = "--version" ]; then echo 'shermes static_h ${rev}'; exit 0; fi
exec '${join(build, 'bin', 'shermes')}' "$@"
`)
chmodSync(launcher, 0o755)
console.log(`SHERMES_BIN=${launcher}`)
