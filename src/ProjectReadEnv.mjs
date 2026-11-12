import { lstat, realpath } from 'node:fs/promises'
import { dirname, sep } from 'node:path'
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
    this.realRoot ??= await realpath(this.root)
    // The error of a path without a real path must not tell whether a path out of the project exists.
    if (!real.ok) return await this.missingInside(path, context) ? real : this.outside(path)
    return isInside(this.realRoot, real.value) ? real : this.outside(path)
  }

  outside(path) { return err(new FileError('permission_denied', message('error.pi.outside', path), path)) }

  /**
   * Tells whether [path], which has no real path, is a missing path in the project: the nearest directory above it that
   * has a real path is in the project, and the next part of the path does not exist. A part that exists without a real
   * path, such as a broken symbolic link, can point out of the project, so it does not count.
   */
  async missingInside(path, context) {
    const absolute = await this.inner.absolutePath(path, context)
    if (!absolute.ok) return false
    for (let part = absolute.value, parent = dirname(part); parent !== part; part = parent, parent = dirname(parent)) {
      let real
      try { real = await realpath(parent) }
      catch { continue }
      if (!isInside(this.realRoot, real)) return false
      try { await lstat(part) }
      catch { return true }
      return false
    }
    return false
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
  /**
   * The tool `read` reads only through this method. Another process can swap a directory of the path between the check
   * and the open. So after the open, the path must still have the same real path in the project, and the open file
   * must be the file at that real path. Else the read is refused.
   */
  async openBinaryReader(path, _options, context) {
    const real = await this.resolve(path, context)
    if (!real.ok) return real
    const opened = await this.inner.openBinaryReader(real.value, { noFollow: true }, context)
    if (!opened.ok || await this.opensInside(path, real.value, opened.value.file, context)) return opened
    await opened.value.close(context)
    return err(new FileError('permission_denied', message('error.pi.changed', path), path))
  }

  /** Tells whether [path] still has the real path [real] in the project, and the open [file] is the file at [real]. */
  async opensInside(path, real, file, context) {
    try {
      const again = await this.resolve(path, context)
      if (!again.ok || again.value !== real) return false
      const [open, named] = await Promise.all([file.stat({ bigint: true }), lstat(real, { bigint: true })])
      return open.dev === named.dev && open.ino === named.ino
    }
    catch { return false }
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
