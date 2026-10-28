/**
 * dsh-lens internals — asar 读取与包名解析。
 *
 * AsarReader 解析 Chromium asar 归档头（16 字节 pickle 前缀 + JSON 目录树），
 * 按目录项的 offset/size 从 base 起读文件内容；头部只解析一次并缓存，
 * fd 全生命周期复用，close 后可重开。
 *
 * 全部只读：不存在任何写副作用。
 */
import { openSync, readSync, closeSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** 内核包在归档里的作用域前缀。 */
export const KERNEL_SCOPE = 'node_modules/@deepseek-ai'

export class AsarReader {
  constructor(asarPath) {
    this.path = asarPath
    this.fd = null
    this.header = null
    this.base = 0
    this.fileCount = null
  }

  open() {
    if (this.header) return this
    // Electron 主进程的 asar 垫片会把裸 .asar 路径当虚拟目录、openSync 报
    // ENOENT「空条目」。开门期间关掉垫片（普通 node 无该属性，赋值无害）。
    const noAsarPrevious = process.noAsar
    process.noAsar = true
    let fd
    try {
      fd = openSync(this.path, 'r')
    } finally {
      process.noAsar = noAsarPrevious
    }
    try {
      const head = Buffer.alloc(16)
      readSync(fd, head, 0, 16, 0)
      const jsonSize = head.readUInt32LE(12)
      const buf = Buffer.alloc(jsonSize)
      readSync(fd, buf, 0, jsonSize, 16)
      this.header = JSON.parse(buf.toString('utf8'))
      this.base = 8 + head.readUInt32LE(4)
    } catch (error) {
      closeSync(fd)
      throw new Error(`dsh-lens: cannot parse asar header of ${this.path}: ${error.message}`)
    }
    this.fd = fd
    return this
  }

  /** 按段取目录节点；文件返回 {offset,size}，目录返回 {files:{...}}，不存在返回 null。 */
  entry(segments) {
    let node = this.header
    for (const segment of segments) {
      if (!node || !node.files || !node.files[segment]) return null
      node = node.files[segment]
    }
    return node
  }

  entryFromPath(path) {
    return this.entry(String(path || '').split('/').filter(Boolean))
  }

  readBuffer(entry) {
    const buffer = Buffer.alloc(entry.size)
    readSync(this.fd, buffer, 0, entry.size, this.base + Number(entry.offset))
    return buffer
  }

  /**
   * 读一个文件条目：归档内按 offset；unpacked 条目（offset 缺失，真身镜像在
   * app.asar.unpacked/<同路径>）回落读磁盘镜像。两者都不是才算真丢。
   */
  readEntry(path, entry) {
    if (entry.offset === undefined) {
      const mirror = join(dirname(this.path), 'app.asar.unpacked', path)
      if (existsSync(mirror)) return readFileSync(mirror)
      throw new Error(`dsh-lens: entry has no offset and no unpacked mirror: ${path}`)
    }
    return this.readBuffer(entry)
  }

  /** 读文本；目录或不存在返回 null。 */
  readText(path) {
    const entry = this.entryFromPath(path)
    if (!entry || entry.files) return null
    return this.readEntry(path, entry).toString('utf8')
  }

  /** 列目录：[{name, dir, size}]，目录在前、名字序。 */
  listDir(path) {
    const entry = this.entryFromPath(path)
    if (!entry || !entry.files) return null
    return Object.entries(entry.files)
      .map(([name, value]) => ({ name, dir: Boolean(value.files), size: value.files ? 0 : value.size }))
      .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
  }

  /** 前缀下所有文件的 [path, entry]，压栈遍历，顺序不保证稳定。 */
  walkFiles(prefix) {
    const root = this.entryFromPath(prefix)
    const out = []
    if (!root) return out
    const stack = [[String(prefix || '').replace(/\/+$/, ''), root]]
    while (stack.length) {
      const [dirPath, node] = stack.pop()
      for (const [name, value] of Object.entries(node.files || {})) {
        const full = dirPath ? `${dirPath}/${name}` : name
        if (value.files) stack.push([full, value])
        else out.push([full, value])
      }
    }
    return out
  }

  countFiles() {
    if (this.fileCount !== null) return this.fileCount
    let count = 0
    const stack = [this.header]
    while (stack.length) {
      const node = stack.pop()
      for (const value of Object.values(node?.files || {})) {
        if (value.files) stack.push(value)
        else count += 1
      }
    }
    this.fileCount = count
    return count
  }

  close() {
    if (this.fd !== null && this.fd !== undefined) closeSync(this.fd)
    this.fd = null
  }
}

/**
 * 定位 app.asar：配置显式路径 > 环境变量 DSH_LENS_ASAR > Electron resourcesPath
 * > execPath 同级 resources。全部落空才抛错——工具报错即可，绝不让插件启动失败。
 */
export function resolveAsarPath(configured) {
  const candidates = []
  if (configured) candidates.push(configured)
  if (process.env.DSH_LENS_ASAR) candidates.push(process.env.DSH_LENS_ASAR)
  if (typeof process.resourcesPath === 'string') candidates.push(join(process.resourcesPath, 'app.asar'))
  candidates.push(join(dirname(process.execPath), 'resources', 'app.asar'))
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate
  }
  throw new Error(`dsh-lens: app.asar not found (tried: ${candidates.join('; ')})`)
}

/**
 * 包名 → 归档内根目录候选。接受 "@deepseek-ai/xxx"、"xxx"（先按内核包、
 * 再按顶层 node_modules 试）。返回在归档里真实存在的目录列表。
 */
export function packageRoots(reader, packageName) {
  const raw = String(packageName || '').trim().replace(/^\/+|\/+$/g, '')
  if (!raw) return []
  const candidates = raw.startsWith('@')
    ? [`node_modules/${raw}`]
    : [`${KERNEL_SCOPE}/${raw}`, `node_modules/${raw}`]
  return candidates.filter((path) => {
    const entry = reader.entryFromPath(path)
    return Boolean(entry && entry.files)
  })
}
