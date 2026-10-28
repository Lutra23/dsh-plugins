'use strict';
// 符号引用扫描（v1）：字面预筛 -> 仅命中文件取 outline -> 词法 mask 分类 -> 配额分桶。
// 设计约束：不依赖 LSP，置信度按“物理证据”分级，不虚构 semantic 档。

const fs = require('fs');
const path = require('path');
const SR = require('./symbolResolver');
const AR = require('./aliasResolver');

const SKIP_DIRS = new Set(['node_modules', '.git', 'bin', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', '.serena', '.idea', '.vscode', 'target']);
const TEST_DIRS = new Set(['test', 'tests', 'spec', 'specs', '__tests__', 'fixtures', 'e2e', 'bench', 'benchmarks']);
const EXT = new Set(['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'py', 'rs', 'go', 'java', 'cs', 'lua']);
// 文本长度闸（UTF-16 码元）：超过 ~2MB 字节的源码文件几乎不可能是手写业务代码，读它只会白烧 I/O。
const MAX_BYTES = 1024 * 1024;
const B = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const RANK = { 'import-bound': 0, 'code-lexical': 1, 'dispatch-key': 2, 'non-code': 3 };

function isWordChar(ch) { return !!ch && /[A-Za-z0-9_$]/.test(ch); }

function walk(root, dir, out) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_e) { return out; }
    for (const e of entries) {
        if (e.isSymbolicLink()) continue;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, p, out); }
        else out.push(p);
    }
    return out;
}

function relOf(root, abs) { return path.relative(root, abs).split(path.sep).join('/'); }

function isTestPath(rel) {
    return rel.split('/').some(seg => TEST_DIRS.has(seg.toLowerCase()));
}

function hasExt(file) {
    const i = file.lastIndexOf('.');
    return i > 0 && EXT.has(file.slice(i + 1).toLowerCase());
}

/** 0.02ms 级预筛：文件里连这个词都没有，直接跳过，绝不调侧车。 */
function fastBoundaryMatch(text, name) { return text.indexOf(name) !== -1; }

/**
 * 词法 mask：返回与 text 等长的 Uint8Array，1=代码区，0=字符串/注释区。
 * v1 已知边界：模板字符串整体按非代码处理（${} 内代码会漏），正则字面量按代码处理（可能误报）。
 */
function regexStart(text, i) {
    let k = i - 1;
    while (k >= 0 && (text[k] === ' ' || text[k] === TAB)) k--;
    if (k < 0) return true;
    const p = text[k];
    if (p === NL) return true;
    return '=(,:;[!&|?{}'.indexOf(p) !== -1;
}

function maskNonCode(text) {
    const n = text.length;
    const code = new Uint8Array(n);
    const stack = []; // {ret, depth}：字符串/注释/模板/正则的返回态；模板表达式用 depth 计花括号
    let st = 0;       // 0 code 1 line 2 block 3 single 4 double 5 template 6 regex 7 template-expr
    let inClass = false;
    for (let i = 0; i < n; i++) {
        const c = text[i], c2 = text[i + 1];
        if (st === 0 || st === 7) {
            if (c === '/' && c2 === '/') { stack.push({ ret: st }); st = 1; i++; continue; }
            if (c === '/' && c2 === '*') { stack.push({ ret: st }); st = 2; i++; continue; }
            if (c === '/' && regexStart(text, i)) { stack.push({ ret: st }); st = 6; inClass = false; continue; }
            if (c === "'") { stack.push({ ret: st }); st = 3; continue; }
            if (c === '"') { stack.push({ ret: st }); st = 4; continue; }
            if (c === '`') { stack.push({ ret: st }); st = 5; continue; }
            if (st === 7) {
                const top = stack[stack.length - 1];
                if (c === '{') { top.depth++; code[i] = 1; continue; }
                if (c === '}') {
                    if (top.depth === 0) { st = stack.pop().ret; continue; }
                    top.depth--; code[i] = 1; continue;
                }
            }
            code[i] = 1;
        } else if (st === 1) {
            if (c === NL) { st = stack.pop().ret; code[i] = 1; }
        } else if (st === 2) {
            if (c === '*' && c2 === '/') { st = stack.pop().ret; i++; }
        } else if (st === 5) {
            if (c === B) { i++; continue; }
            if (c === '`') { st = stack.pop().ret; continue; }
            if (c === '$' && c2 === '{') { stack.push({ ret: 5, depth: 0 }); st = 7; i++; continue; }
        } else if (st === 6) {
            if (c === B) { i++; continue; }
            if (c === NL) { st = stack.pop().ret; continue; }
            if (c === '[') { inClass = true; continue; }
            if (c === ']') { inClass = false; continue; }
            if (c === '/' && !inClass) st = stack.pop().ret;
        } else {
            if (c === B) { i++; continue; }
            if (c === NL) { st = stack.pop().ret; code[i] = 1; continue; }
            if ((st === 3 && c === "'") || (st === 4 && c === '"')) st = stack.pop().ret;
        }
    }
    return code;
}

function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === NL) starts.push(i + 1);
    return starts;
}

function occurrences(line, name) {
    const out = [];
    let i = 0;
    while ((i = line.indexOf(name, i)) !== -1) {
        if (!isWordChar(line[i - 1]) && !isWordChar(line[i + name.length])) out.push(i);
        i += name.length;
    }
    return out;
}

function isDispatchKey(line, idx, name) {
    let j = idx + name.length;
    while (j < line.length && (line[j] === ' ' || line[j] === TAB)) j++;
    if (line[j] !== ':' || line[j + 1] === ':') return false;
    let k = idx - 1;
    while (k >= 0 && (line[k] === ' ' || line[k] === TAB)) k--;
    return k < 0 || line[k] === '{' || line[k] === ',';
}

function looksLikeImporter(text, declBase, aliasMap, declAbs, fromAbs) {
    const lines = text.split(NL);
    const limit = Math.min(lines.length, 120);
    for (let i = 0; i < limit; i++) {
        const ln = lines[i];
        if (ln.indexOf('import') === -1 && ln.indexOf('require(') === -1 && ln.indexOf('from ') === -1) continue;
        // 先按 paths/baseUrl（裸说明符）或引用文件目录（相对说明符）解析真实模块路径；解析不出再退回 basename 粗判。
        if (declAbs && AR.lineImportsDecl(ln, aliasMap, declAbs, fromAbs)) return true;
        if (ln.indexOf(declBase) !== -1) return true;
    }
    return false;
}

/**
 * 扫描引用。
 * @param {{indexer, root, name, path?, limit?, budgetMs?, maxPerFile?}} opts
 */
async function findReferences(opts) {
    const indexer = opts.indexer;
    const root = path.resolve(opts.root);
    const name = String(opts.name || '').trim();
    if (!name) throw new Error('References 需要 name');
    const limit = Math.max(1, Number(opts.limit) || 50);
    const budgetMs = Math.max(0, Number(opts.budgetMs) || 4000);
    const maxPerFile = Math.max(1, Number(opts.maxPerFile) || 5);
    const t0 = Date.now();
    const elapsed = () => Date.now() - t0;

    let files;
    if (opts.path) {
        const abs = path.resolve(root, opts.path);
        files = fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? walk(root, abs, []) : [abs];
    } else {
        files = walk(root, root, []);
    }
    files = files.filter(hasExt);
    files.sort((a, b) => {
        const ra = relOf(root, a), rb = relOf(root, b);
        const ta = isTestPath(ra) ? 1 : 0, tb = isTestPath(rb) ? 1 : 0;
        return ta - tb || ra.localeCompare(rb);
    });

    const raw = [];
    let scanned = 0;
    let degraded = false;
    let skippedFiles = 0;
    // 预筛是 I/O 瓶颈（5813 文件串行读盘 14.5s）：改分批并发读，预算与分类语义不变。
    const READ_BATCH = 32;
    for (let fi = 0; fi < files.length; fi += READ_BATCH) {
        if (elapsed() > budgetMs) { degraded = true; skippedFiles = files.length - scanned; break; }
        const batch = files.slice(fi, fi + READ_BATCH);
        const texts = await Promise.all(batch.map(abs => fs.promises.readFile(abs, 'utf8').catch(() => null)));
        for (let bi = 0; bi < batch.length; bi++) {
            const text = texts[bi];
            if (text === null) continue;
            scanned++;
            if (text.length > MAX_BYTES) continue;
            if (!fastBoundaryMatch(text, name)) continue;
            const rel = relOf(root, batch[bi]);
            const code = maskNonCode(text);
            const starts = lineStarts(text);
            const lines = text.split(NL);
            for (let li = 0; li < lines.length; li++) {
                const idxs = occurrences(lines[li], name);
                if (!idxs.length) continue;
                for (const idx of idxs) {
                    raw.push({ rel, line: li + 1, idx, code: code[starts[li] + idx] === 1, text: lines[li] });
                }
            }
        }
    }

    // 仅对“代码区命中”的文件取 outline（声明识别 + 作用域链）
    const codeFiles = [...new Set(raw.filter(h => h.code).map(h => h.rel))];
    const outlineByFile = new Map();
    let outlined = 0;
    for (const rel of codeFiles) {
        if (elapsed() > budgetMs) { degraded = true; skippedFiles = Math.max(skippedFiles, codeFiles.length - outlined); break; }
        const abs = path.join(root, rel);
        let text;
        try { text = fs.readFileSync(abs, 'utf8'); } catch (_e) { continue; }
        const o = await indexer.outline(text, rel);
        outlined++;
        if (o) outlineByFile.set(rel, o);
    }

    const declarations = [];
    const usages = [];
    const imports = [];
    let nonCode = 0;
    for (const h of raw) {
        if (!h.code) { nonCode++; continue; }
        const t = h.text.trim();
        if (t.startsWith('import ') || t.indexOf('require(') !== -1) {
            imports.push({ file: h.rel, line: h.line, snippet: t.slice(0, 120) });
            continue;
        }
        const o = outlineByFile.get(h.rel);
        const symbols = o ? o.symbols : [];
        const dispatch = isDispatchKey(h.text, h.idx, name);
        const declSym = dispatch ? null : symbols.find(s => s.name === name && s.start === h.line);
        if (declSym) {
            declarations.push({ file: h.rel, line: h.line, qualified: declSym.qualified || declSym.name, kind: declSym.kind });
            continue;
        }
        const chain = symbols.length ? SR.enclosingChain(symbols, h.line) : null;
        usages.push({ file: h.rel, line: h.line, chain, snippet: t.slice(0, 120), dispatch, test: isTestPath(h.rel), confidence: dispatch ? 'dispatch-key' : null });
    }

    let declBase = null;
    let declAbsSet = null;
    if (declarations.length) {
        const bn = path.basename(declarations[0].file);
        const dot = bn.lastIndexOf('.');
        declBase = dot > 0 ? bn.slice(0, dot) : bn;
        declAbsSet = new Set(declarations.map(d => path.join(root, d.file)));
    }
    // 别名表按引用文件所在目录向上取（缓存到目录级）：扫描根可能含多个子项目，各自有 tsconfig。
    const aliasCache = new Map();
    const aliasFor = (fileAbs) => {
        const dir = path.dirname(fileAbs);
        if (aliasCache.has(dir)) return aliasCache.get(dir);
        const m = AR.loadAliasMapNear(dir, root);
        aliasCache.set(dir, m);
        return m;
    };
    const importerCache = new Map();
    const declFiles = new Set(declarations.map(d => d.file));
    for (const u of usages) {
        if (u.confidence === 'dispatch-key') continue;
        if (declFiles.has(u.file)) { u.confidence = 'import-bound'; continue; }
        if (!declBase) { u.confidence = 'code-lexical'; continue; }
        if (!importerCache.has(u.file)) {
            let t = '';
            try { t = fs.readFileSync(path.join(root, u.file), 'utf8'); } catch (_e) { /* ignore */ }
            const fromAbs = path.join(root, u.file);
            importerCache.set(u.file, looksLikeImporter(t, declBase, aliasFor(fromAbs), declAbsSet, fromAbs));
        }
        u.confidence = importerCache.get(u.file) ? 'import-bound' : 'code-lexical';
    }

    usages.sort((a, b) => (RANK[a.confidence] - RANK[b.confidence]) || (a.test - b.test) || a.file.localeCompare(b.file) || a.line - b.line);

    const perFile = new Map();
    const kept = [];
    const folded = [];
    for (const u of usages) {
        const n = perFile.get(u.file) || 0;
        if (n < maxPerFile) { kept.push(u); perFile.set(u.file, n + 1); }
        else folded.push(u);
    }
    const truncated = kept.length > limit;
    const shown = kept.slice(0, limit);
    const counts = { 'import-bound': 0, 'code-lexical': 0, 'dispatch-key': 0, 'non-code': nonCode };
    for (const u of usages) counts[u.confidence]++;
    const foldByFile = new Map();
    for (const u of folded) foldByFile.set(u.file, (foldByFile.get(u.file) || 0) + 1);

    return {
        name, root, declarations, imports, usages: shown,
        folded: [...foldByFile.entries()].map(([file, n]) => ({ file, n })),
        counts, filesScanned: scanned, filesSkippedByBudget: skippedFiles, totalFiles: files.length,
        elapsedMs: elapsed(), budgetMs, degraded, truncated, limit, maxPerFile,
    };
}

function renderReferences(r) {
    const lines = [];
    lines.push('## References · ' + r.name);
    if (r.declarations.length) {
        lines.push('- 声明：' + r.declarations.map(d => d.file + ':' + d.line + ' (' + d.kind + ')').join('、'));
    } else {
        lines.push('- 声明：扫描范围内未找到（可能是外部符号或命名不同）');
    }
    lines.push('- 引用 ' + r.usages.length + ' 处（展示） · import-bound ' + r.counts['import-bound'] + ' · code-lexical ' + r.counts['code-lexical'] + ' · dispatch-key ' + r.counts['dispatch-key'] + ' · 导入 ' + r.imports.length + ' · 字符串/注释 ' + r.counts['non-code'] + '（未计入）');
    lines.push('- 扫描 ' + r.filesScanned + '/' + r.totalFiles + ' 文件 · 用时 ' + r.elapsedMs + 'ms · 预算 ' + r.budgetMs + 'ms · degraded=' + r.degraded + ' · truncated=' + r.truncated);
    if (r.degraded) lines.push('- 预算耗尽：结果不完整，可提高 budgetMs 或缩窄 path');
    for (const conf of ['import-bound', 'code-lexical', 'dispatch-key']) {
        const group = r.usages.filter(u => u.confidence === conf);
        if (!group.length) continue;
        lines.push('### ' + conf + ' (' + group.length + ')');
        for (const u of group) lines.push('- ' + u.file + ':' + u.line + (u.chain ? ' [' + u.chain + ']' : '') + ' ' + u.snippet);
    }
    if (r.imports.length) {
        lines.push('### 导入（' + r.imports.length + '）');
        for (const i of r.imports) lines.push('- ' + i.file + ':' + i.line + ' ' + i.snippet);
    }
    if (r.folded.length) {
        lines.push('### 折叠（单文件超过 ' + r.maxPerFile + ' 处）');
        for (const f of r.folded) lines.push('- ' + f.file + ' (+' + f.n + ' more in this file)');
    }
    return lines.join(NL);
}

module.exports = { findReferences, renderReferences, maskNonCode, fastBoundaryMatch, isDispatchKey, looksLikeImporter, walk };
