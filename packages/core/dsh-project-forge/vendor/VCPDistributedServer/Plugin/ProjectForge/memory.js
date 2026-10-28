'use strict';
// 工程记忆（资产化）：每个工程一份架构记忆，落在 <root>/.forge/memories/。
//
// 为什么存在：forge 的账本只记"改了哪些文件、为什么改"，不记"这个工程长什么样"。
// 跨会话接手时，模型每次都要重新 walk 一遍目录、翻 package.json。把这份结论沉淀成
// 可寻址的文本，就能直接读，且能被 mem: 引用互相指向（引用完整性可校验）。
//
// 设计约束（与 indexerClient / aliasResolver 同哲学）：
// - 零常驻：按需读写小文件，不建索引、不启进程；
// - 增强项不是依赖项：任何失败返回 null 或抛出受控错误，不阻断 CreateProject / 编辑流程；
// - 写入走 OP（继承路径守卫与操作账本），不另开裸写通道；
// - 不做相似度自动修复（Serena 那套 781 行引用分析），只做"引用是否指向存在的记忆"这一项校验。

const fs = require('fs');
const path = require('path');

const MEM_REL = '.forge/memories';
const ARCHIVE_ID = '00-architecture';
const MEM_PREFIX = 'mem:';
const MAX_TEXT_BYTES = 256 * 1024;
const MAX_LIST_FILES = 200;
const MAX_TOP_DIRS = 20;

function memDir(root) {
    return path.join(root, MEM_REL);
}

function memFile(root, id) {
    return path.join(memDir(root), id + '.md');
}

function isSafeIdChar(ch) {
    const c = ch.codePointAt(0);
    if (c >= 48 && c <= 57) return true;
    if (c >= 65 && c <= 90) return true;
    if (c >= 97 && c <= 122) return true;
    if (c === 95 || c === 45) return true;
    if (c >= 0x4e00 && c <= 0x9fff) return true;
    return false;
}

function safeId(id) {
    const raw = String(id == null ? '' : id).trim();
    if (!raw) return ARCHIVE_ID;
    let out = '';
    for (const ch of raw) out += isSafeIdChar(ch) ? ch : '-';
    out = out.replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
    if (!out) throw new Error('记忆 id 无效（' + raw + '）：请使用字母、数字、中文、下划线或连字符');
    return out;
}

/** 列出该工程的记忆文件 id（不含扩展名）。 */
function listIds(root) {
    try {
        const dir = memDir(root);
        if (!fs.existsSync(dir)) return [];
        return fs.readdirSync(dir)
            .filter(n => n.endsWith('.md'))
            .slice(0, MAX_LIST_FILES)
            .map(n => n.slice(0, -3))
            .sort();
    } catch (_e) {
        return [];
    }
}

/** 读一份记忆；不存在返回 null。 */
function readMemory(root, id) {
    const file = memFile(root, safeId(id));
    try {
        const text = fs.readFileSync(file, 'utf8');
        return { id: safeId(id), file, text, bytes: Buffer.byteLength(text, 'utf8') };
    } catch (_e) {
        return null;
    }
}

/**
 * 校验正文里的 mem: 引用是否指向存在的记忆。
 * 只认 `mem:<id>` 形态；`mem:<id>#锚点` 里的锚点忽略。
 */
function checkRefs(text, existingIds) {
    const ids = new Set(existingIds || []);
    const found = [];
    const s = String(text || '');
    let at = 0;
    while (true) {
        const i = s.indexOf(MEM_PREFIX, at);
        if (i === -1) break;
        at = i + MEM_PREFIX.length;
        let j = at;
        while (j < s.length) {
            const c = s[j];
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '-' || c === '.') j++;
            else break;
        }
        if (j === at) continue;
        found.push(s.slice(at, j));
    }
    const missing = [];
    for (const id of found) if (!ids.has(id)) missing.push(id);
    return { referenced: Array.from(new Set(found)), missing: Array.from(new Set(missing)) };
}

/**
 * 写一份记忆。requires OP（operations.cjs）以继承路径守卫。
 * @returns {{id:string, file:string, bytes:number, refs:Object}}
 */
async function writeMemory(OP, root, id, content) {
    const text = String(content == null ? '' : content);
    if (Buffer.byteLength(text, 'utf8') > MAX_TEXT_BYTES) {
        throw new Error('记忆超过 ' + Math.round(MAX_TEXT_BYTES / 1024) + 'KB 上限，请拆分到多份记忆');
    }
    const sid = safeId(id);
    const dir = memDir(root);
    await OP.mkdir(dir, { recursive: true });
    await OP.writeFile(memFile(root, sid), Buffer.from(text, 'utf8'));
    const refs = checkRefs(text, listIds(root));
    return { id: sid, file: memFile(root, sid), bytes: Buffer.byteLength(text, 'utf8'), refs };
}

/** 读 package.json（容错，返回 null）。 */
function readPackageJson(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch (_e) {
        return null;
    }
}

/** 顶层目录清单 + 文件数，只统计一层，避免 walk 整个大仓。 */
function topLevelSummary(root) {
    const out = [];
    try {
        const entries = fs.readdirSync(root, { withFileTypes: true });
        for (const e of entries) {
            if (out.length >= MAX_TOP_DIRS) break;
            if (e.name.startsWith('.')) continue;
            if (e.isDirectory()) {
                let n = 0;
                try { n = fs.readdirSync(path.join(root, e.name)).length; } catch (_e) { n = 0; }
                out.push({ name: e.name + '/', entries: n });
            }
        }
    } catch (_e) {
        return out;
    }
    return out;
}

/**
 * 生成架构记忆正文。只读一层目录 + package.json，不 walk 全仓。
 */
function localStamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
        ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

function buildArchitecture(project, root) {
    const now = localStamp();
    const pkg = readPackageJson(root);
    const dirs = topLevelSummary(root);
    const lines = [];
    lines.push('# 架构记忆：' + (project && project.name ? project.name : path.basename(root)));
    lines.push('');
    lines.push('- 生成时间：' + now + '（由 CreateProject 自动生成，可覆盖）');
    lines.push('- 工程根：`' + root + '`');
    if (project && project.id) lines.push('- projectId：`' + project.id + '`');
    lines.push('');
    lines.push('## 顶层目录');
    if (!dirs.length) lines.push('- （空目录或无法读取）');
    for (const d of dirs) lines.push('- `' + d.name + '` — 直接子项 ' + d.entries + ' 个');
    lines.push('');
    lines.push('## 构建与运行');
    if (pkg) {
        if (pkg.name) lines.push('- 包名：`' + pkg.name + '`' + (pkg.version ? ' @ ' + pkg.version : ''));
        if (pkg.main) lines.push('- 入口（main）：`' + pkg.main + '`');
        if (pkg.type) lines.push('- 模块形态：`' + pkg.type + '`');
        const scripts = pkg.scripts || {};
        const names = Object.keys(scripts).slice(0, 12);
        if (names.length) {
            lines.push('- scripts：');
            for (const n of names) lines.push('  - `' + n + '` → `' + String(scripts[n]).slice(0, 160) + '`');
        } else {
            lines.push('- scripts：（无）');
        }
    } else {
        lines.push('- （未找到 package.json，非 Node 工程或根目录不是包根）');
    }
    lines.push('');
    lines.push('## 引用锚点');
    lines.push('- 本文件可被其它记忆以 `' + MEM_PREFIX + ARCHIVE_ID + '` 引用；写在 reason 或记忆正文里即可建立引用边。');
    lines.push('- 改名/移动记忆文件会造成引用断链，Memory 命令写入时会回报 `missing`。');
    lines.push('');
    return lines.join('\n');
}

/** 确保架构记忆存在；已存在则不覆盖。返回 true 表示本次新建。 */
async function ensureArchitecture(OP, project, root) {
    const sid = ARCHIVE_ID;
    if (fs.existsSync(memFile(root, sid))) return false;
    const text = buildArchitecture(project, root);
    await writeMemory(OP, root, sid, text);
    return true;
}

/**
 * 补建 / 重建架构记忆（给 CreateProject 之前就存在的老工程用）。
 * 默认不覆盖已有档案；force=true 才重写。
 * @returns {{existed:boolean, written:boolean, file:string, bytes?:number}}
 */
async function bootstrapArchitecture(OP, project, root, force) {
    const file = memFile(root, ARCHIVE_ID);
    const existed = fs.existsSync(file);
    if (existed && !force) return { existed: existed, written: false, file: file };
    const text = buildArchitecture(project, root);
    const r = await writeMemory(OP, root, ARCHIVE_ID, text);
    return { existed: existed, written: true, file: r.file, bytes: r.bytes };
}

module.exports = {
    MEM_REL,
    ARCHIVE_ID,
    MEM_PREFIX,
    memDir,
    memFile,
    listIds,
    readMemory,
    checkRefs,
    writeMemory,
    buildArchitecture,
    ensureArchitecture,
    bootstrapArchitecture,
};
