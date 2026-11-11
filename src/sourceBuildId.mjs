import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/**
 * The build id of the package in [root], when it is not the bundle. A git checkout, which is a root with a `.git`
 * entry, gives `dev`, so a pull keeps the running daemon. A copy without `.git`, such as an install of npm, gives the
 * version and a digest of `package.json` and of each file in `bin`, `resources` and `src`. So an update of the copy
 * replaces its daemon at the next start.
 *
 * This module has only `node:` imports, so a test can run it on a temporary copy.
 */
export function sourceBuildId(root) {
  if (existsSync(join(root, '.git'))) return 'dev'
  const files = ['bin', 'resources', 'src'].flatMap(directory => readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')))
  const hash = createHash('sha256')
  for (const file of ['package.json', ...files].sort()) hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0')
  return `${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}-${hash.digest('hex').slice(0, 16)}`
}
