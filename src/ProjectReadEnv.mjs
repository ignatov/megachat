import { realpath } from 'node:fs/promises'
import { sep } from 'node:path'
import { err, ExecutionError, FileError, ok } from '@earendil-works/pi-durable/env'
import { NodeExecutionEnv } from '@earendil-works/pi-durable/env/node'
import { message } from './messages.mjs'

/** Tells whether the real path [path] is the real directory [root] or a path below it. */
export const isInside = (root, path) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`)

/**
 * The execution environment of a pi child: it reads the files of one project directory and does nothing else. Each
 * read goes through the real path, so `..`, an absolute path and a symbolic link cannot lead out of the directory. The
 * read then opens that real path, and a symbolic link at its end is refused. Each write, command, watch and temporary
 * file is refused. The read-only tools need no sandbox, because this environment is the only way to a file.
 */
export class ProjectReadEnv {
  constructor(root) {
    this.root = root
    this.inner = new NodeExecutionEnv({ cwd: root })
    this.id = this.inner.id
    this.cwd = root
  }

  /** The real path of [path] when it is in the project, else a failed result. */
  async resolve(path, context) {
    const real = await this.inner.canonicalPath(path, context)
    if (!real.ok) return real
    this.realRoot ??= await realpath(this.root)
    return isInside(this.realRoot, real.value) ? real
      : err(new FileError('permission_denied', message('error.pi.outside', path), path))
  }

  async checked(path, context, read) {
    const real = await this.resolve(path, context)
    return real.ok ? read(real.value) : real
  }

  absolutePath(path, context) { return this.inner.absolutePath(path, context) }
  joinPath(parts, context) { return this.inner.joinPath(parts, context) }
  canonicalPath(path, context) { return this.resolve(path, context) }
  async exists(path, context) { return ok((await this.resolve(path, context)).ok) }
  fileInfo(path, context) { return this.checked(path, context, real => this.inner.fileInfo(real, context)) }
  readTextFile(path, context) { return this.checked(path, context, real => this.inner.readTextFile(real, context)) }
  readTextLines(path, options, context) { return this.checked(path, context, real => this.inner.readTextLines(real, options, context)) }
  readBinaryFile(path, context) { return this.checked(path, context, real => this.inner.readBinaryFile(real, context)) }
  openTextLineReader(path, context) { return this.checked(path, context, real => this.inner.openTextLineReader(real, context)) }
  openBinaryReader(path, _options, context) {
    return this.checked(path, context, real => this.inner.openBinaryReader(real, { noFollow: true }, context))
  }
  listDir(path, context) { return this.checked(path, context, real => this.inner.listDir(real, context)) }
  openDirReader(path, context) { return this.checked(path, context, real => this.inner.openDirReader(real, context)) }

  async refused(path) { return err(new FileError('permission_denied', message('error.pi.readOnly'), path)) }
  writeFile(path) { return this.refused(path) }
  appendFile(path) { return this.refused(path) }
  truncateFile(path) { return this.refused(path) }
  flushFile(path) { return this.refused(path) }
  renameFile(path) { return this.refused(path) }
  createDir(path) { return this.refused(path) }
  remove(path) { return this.refused(path) }
  createTempDir() { return this.refused() }
  createTempFile() { return this.refused() }
  watch() { return this.refused() }
  async exec() { return err(new ExecutionError('spawn_error', message('error.pi.readOnly'))) }
  async cleanup() {}
}
