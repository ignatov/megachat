#!/usr/bin/env node
// The command `megachat`. It checks the version of Node.js before it imports `src/main.mjs`, because an older Node.js
// cannot load the imports of that file and gives no clear message. Keep this file in syntax that an old Node.js
// can parse: no static import of `src`, and no `node:` prefix.
import { readFileSync } from 'fs'

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8')
const needed = JSON.parse(read('../package.json')).engines.node.replace(/^>=/, '')
const found = process.versions.node
const older = (left, right) => {
  const a = left.split('.').map(Number)
  const b = right.split('.').map(Number)
  for (let index = 0; index < b.length; index++) {
    if ((a[index] || 0) !== b[index]) return (a[index] || 0) < b[index]
  }
  return false
}

if (older(found, needed)) {
  const key = 'node.old='
  const line = read('../resources/Megachat.properties').split('\n').filter(item => item.indexOf(key) === 0)[0]
  process.stderr.write(`${line.slice(key.length).replace('{0}', found).replace('{1}', needed)}\n`)
  process.exitCode = 1
}
else import('../src/main.mjs')
