#!/usr/bin/env node
/**
 * Swap better-sqlite3's native binary to the Node-ABI version (for running vitest).
 * Looks for .node-abi backup; falls back to copying from repo root's node_modules.
 *
 * Dev-only helper for Windows without VS C++ build tools — uses the root project's
 * already-compiled Node-ABI binary as the source.
 */
const { copyFileSync, existsSync } = require('node:fs')
const { resolve } = require('node:path')

const here = __dirname
const target = resolve(here, '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
const nodeAbiBackup = target + '.node-abi'
const rootSrc = resolve(here, '..', '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')

if (existsSync(nodeAbiBackup)) {
  copyFileSync(nodeAbiBackup, target)
  console.log('use-node-abi: restored .node-abi binary')
} else if (existsSync(rootSrc)) {
  copyFileSync(rootSrc, target)
  copyFileSync(target, nodeAbiBackup)
  console.log('use-node-abi: copied node-abi binary from root node_modules and cached')
} else {
  console.error('ERROR: no source for node-abi binary. Run npm install in repo root first.')
  process.exit(1)
}
