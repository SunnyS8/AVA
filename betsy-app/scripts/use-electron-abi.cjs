#!/usr/bin/env node
/**
 * Restore the Electron-ABI native binary (after running vitest).
 * Looks for .electron-abi backup; falls back to prebuild-install.
 */
const { copyFileSync, existsSync } = require('node:fs')
const { resolve } = require('node:path')
const { execSync } = require('node:child_process')

const here = __dirname
const target = resolve(here, '..', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node')
const electronAbiBackup = target + '.electron-abi'

if (existsSync(electronAbiBackup)) {
  copyFileSync(electronAbiBackup, target)
  console.log('use-electron-abi: restored .electron-abi binary')
} else {
  console.log('use-electron-abi: no backup — running prebuild-install for electron')
  const cwd = resolve(here, '..', 'node_modules', 'better-sqlite3')
  // Match the Electron version we're shipping (see package.json devDependencies.electron).
  // Electron 33 = ABI 130.
  execSync('npx prebuild-install --runtime=electron --target=33.4.11 --abi=130', {
    stdio: 'inherit',
    cwd,
  })
  if (existsSync(target)) {
    copyFileSync(target, electronAbiBackup)
    console.log('use-electron-abi: cached fresh binary as .electron-abi')
  }
}
