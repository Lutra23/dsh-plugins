'use strict';
// 共享路径工具：路径归一化 + 白名单守卫。
// FileOperator 与 ProjectForge 共用，保证两边的路径语义一致。

const fs = require('fs');
const path = require('path');

/**
 * 判断 targetPath 是否位于 parentDir 之内（含其本身）。
 * 使用 path.relative 而非字符串前缀，避免 D:\VCP 误放行 D:\VCP2。
 * win32 下 path.relative 大小写不敏感；跨盘符时返回绝对路径，判为越界。
 */
function isPathInside(targetPath, parentDir) {
    if (!targetPath || !parentDir) return false;
    const rel = path.relative(path.resolve(parentDir), path.resolve(targetPath));
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return false;
    return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 解析为物理路径（跟随符号链接 / junction）。
 * - 存在的路径：realpathSync.native
 * - 不存在的路径：上溯到最近的已存在祖先，realpath 后拼回尾段
 * - 任何异常（权限、坏链、UNC 不可达）：退回 path.resolve，绝不抛出
 */
function physicalPath(input) {
    const resolved = path.resolve(String(input));
    try {
        let existing = resolved;
        const tail = [];
        while (!fs.existsSync(existing)) {
            const parent = path.dirname(existing);
            if (parent === existing) break;
            tail.unshift(path.basename(existing));
            existing = parent;
        }
        const real = fs.realpathSync.native(existing);
        return tail.length ? path.resolve(real, ...tail) : real;
    } catch (_e) {
        return resolved;
    }
}

/**
 * 物理路径版的包含判据：先跟随符号链接，再做字面比较。
 * 白名单守卫与工作区写入闸必须用这个版本；isPathInside 只做字面比较，
 * 会被指向白名单外的 junction/符号链接绕过。
 */
function isPathInsidePhysical(targetPath, parentDir) {
    if (!targetPath || !parentDir) return false;
    const rel = path.relative(physicalPath(parentDir), physicalPath(targetPath));
    if (rel === '') return true;
    if (path.isAbsolute(rel)) return false;
    return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

/**
 * 归一化用户输入路径（与 FileOperator 历史行为保持一致）：
 * - 绝对路径：直接 resolve
 * - 以 / 开头但在当前平台非绝对：映射到 virtualRoot
 * - ./ 或 ../ 开头：相对 relativeRoot
 * - 其他裸相对路径：相对 basePath
 * 每一段都会去除首尾空白，容忍 AI 误加的空格。
 */
function resolveAndNormalizePath(inputPath, options = {}) {
    if (!inputPath || typeof inputPath !== 'string') return inputPath;
    const { basePath = process.cwd(), relativeRoot = basePath, virtualRoot = relativeRoot } = options;
    const original = inputPath.trim();

    if (path.isAbsolute(original)) return path.resolve(original);

    if (original.startsWith('/')) {
        return path.resolve(virtualRoot, original.slice(1));
    }

    const sanitized = path.join(...original.split(/[/\\]+/).map(part => part.trim()));
    const normalized = path.normalize(sanitized);
    const explicitRelative = normalized === '.' || normalized === '..'
        || normalized.startsWith(`.${path.sep}`) || normalized.startsWith(`..${path.sep}`);

    return path.resolve(explicitRelative ? relativeRoot : basePath, normalized);
}

/**
 * 创建白名单守卫。
 * @param {string[]} allowedDirs 允许的根目录；为空表示不限制。
 * @param {object} [options]
 * @param {string[]} [options.readOnlyBypassOps] 允许在白名单外执行的只读操作（仅限绝对路径）。
 */
function createPathGuard(allowedDirs = [], options = {}) {
    const dirs = allowedDirs.map(dir => String(dir).trim()).filter(Boolean).map(dir => path.resolve(dir));
    const readOnlyBypassOps = new Set(options.readOnlyBypassOps || []);

    function isAllowed(targetPath, operationType = 'generic') {
        if (dirs.length === 0) return true;
        const resolved = path.resolve(targetPath);
        if (dirs.some(dir => isPathInsidePhysical(resolved, dir))) return true;
        return readOnlyBypassOps.has(operationType) && path.isAbsolute(String(targetPath));
    }

    function assertAllowed(targetPath, operationType = 'generic') {
        if (!isAllowed(targetPath, operationType)) {
            throw new Error(`Access denied: Path '${targetPath}' is not in allowed directories`);
        }
        return path.resolve(targetPath);
    }

    function addDirectory(dir) {
        const resolved = path.resolve(dir);
        if (!dirs.some(existing => existing.toLowerCase() === resolved.toLowerCase())) dirs.push(resolved);
    }

    return { dirs, isAllowed, assertAllowed, addDirectory };
}

/** 统一使用正斜杠的相对路径，便于 AI 阅读与数据库存储。 */
function toPosixRelative(fromDir, targetPath) {
    return path.relative(fromDir, targetPath).split(path.sep).join('/');
}

module.exports = {
    isPathInside,
    physicalPath,
    isPathInsidePhysical,
    resolveAndNormalizePath,
    createPathGuard,
    toPosixRelative,
};