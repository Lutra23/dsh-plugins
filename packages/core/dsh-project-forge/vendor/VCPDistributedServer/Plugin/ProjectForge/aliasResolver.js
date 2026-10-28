'use strict';
// tsconfig/jsconfig 别名解析：把 @/foo、~lib/bar 这类说明符映射回真实文件。
//
// 为什么存在：references.js 的 import-bound 判定原先只认"行里含声明文件 basename"，
// 一旦项目用 paths 别名（@core/fs -> shared/fileKit/paths.js）或跨包指向，行里根本没有
// basename，于是一条真实导入被降级成 code-lexical。这是纯结构信息缺失，不需要 LSP。
//
// 设计约束（与 indexerClient 同哲学）：
// - 零常驻：只读配置，不建索引，不启进程；
// - 增强项不是依赖项：任何解析失败返回 null，调用方退回原有相对路径判定；
// - 不做 tsconfig 全语义（不展开多层 extends、不处理 project references），只取 baseUrl + paths。

const fs = require('fs');
const path = require('path');

const CONFIG_NAMES = ['tsconfig.json', 'jsconfig.json'];
const BS = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const TAB = String.fromCharCode(9);
const WS = ' ' + TAB + NL + String.fromCharCode(13);
const EXTS = ['', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json'];
const SPEC_MARKERS = ['require(', 'from ', 'import('];

// 去掉行注释与块注释，保留字符串内容（JSONC 常见形态）。
function stripComments(raw) {
    let out = '';
    let i = 0;
    const n = raw.length;
    let str = 0;
    while (i < n) {
        const c = raw[i];
        const c2 = raw[i + 1];
        if (str === 1) {
            out += c;
            if (c === '"' && raw[i - 1] !== BS) str = 0;
            i++;
            continue;
        }
        if (str === 2) {
            out += c;
            if (c === "'" && raw[i - 1] !== BS) str = 0;
            i++;
            continue;
        }
        if (c === '"') { str = 1; out += c; i++; continue; }
        if (c === "'") { str = 2; out += c; i++; continue; }
        if (c === '/' && c2 === '/') { while (i < n && raw[i] !== NL) i++; continue; }
        if (c === '/' && c2 === '*') {
            i += 2;
            while (i < n && !(raw[i] === '*' && raw[i + 1] === '/')) i++;
            i += 2;
            continue;
        }
        out += c;
        i++;
    }
    return out;
}

// 去掉对象/数组末尾的多余逗号，让 JSON.parse 能吃。
function stripTrailingCommas(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (c === ',') {
            let j = i + 1;
            while (j < s.length && WS.indexOf(s[j]) !== -1) j++;
            if (s[j] === '}' || s[j] === ']') continue;
        }
        out += c;
    }
    return out;
}

function readJsonc(file) {
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(stripTrailingCommas(stripComments(raw)));
    } catch (_e) {
        return null;
    }
}

/**
 * 读取工程根的别名配置。
 * @returns {{configFile:string, baseUrl:string, paths:Object|null}|null}
 */
function loadAliasMap(root) {
    const dir = path.resolve(root);
    for (const name of CONFIG_NAMES) {
        const file = path.join(dir, name);
        if (!fs.existsSync(file)) continue;
        const cfg = readJsonc(file);
        if (!cfg) continue;
        let co = cfg.compilerOptions || {};
        // 只展开一层相对 extends，够覆盖绝大多数工程；失败就只用自身配置。
        const ext = cfg.extends;
        if (typeof ext === 'string' && (ext.startsWith('./') || ext.startsWith('../'))) {
            const parent = readJsonc(path.resolve(path.dirname(file), ext));
            if (parent && parent.compilerOptions) {
                co = Object.assign({}, parent.compilerOptions, co);
            }
        }
        const baseUrl = co.baseUrl ? path.resolve(path.dirname(file), co.baseUrl) : path.dirname(file);
        return { configFile: file, baseUrl, paths: co.paths || null };
    }
    return null;
}

/**
 * 从 startDir 逐级向上找最近的 tsconfig/jsconfig（到 stopDir 为止）。
 * 用途：扫描根可能包含多个子项目，别名配置在子项目根，只在 root 找会整体失效。
 */
function loadAliasMapNear(startDir, stopDir) {
    let dir = path.resolve(startDir);
    const stop = stopDir ? path.resolve(stopDir) : null;
    while (true) {
        const m = loadAliasMap(dir);
        if (m) return m;
        if (stop && dir === stop) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

/** 把一条 import 说明符按 paths / baseUrl 展开成若干候选绝对路径。 */
function resolveSpec(aliasMap, spec) {
    const out = [];
    if (!aliasMap || !spec) return out;
    const baseUrl = aliasMap.baseUrl;
    const paths = aliasMap.paths;
    if (paths && typeof paths === 'object') {
        for (const key of Object.keys(paths)) {
            const targets = Array.isArray(paths[key]) ? paths[key] : [paths[key]];
            const star = key.indexOf('*');
            if (star === -1) {
                if (spec === key) for (const t of targets) out.push(path.resolve(baseUrl, t));
                continue;
            }
            const pre = key.slice(0, star);
            const suf = key.slice(star + 1);
            if (spec.length < pre.length + suf.length) continue;
            if (!spec.startsWith(pre) || !spec.endsWith(suf)) continue;
            const mid = spec.slice(pre.length, spec.length - suf.length);
            for (const t of targets) out.push(path.resolve(baseUrl, String(t).replace('*', mid)));
        }
    }
    out.push(path.resolve(baseUrl, spec));
    return out;
}

function sameFile(candidate, declAbs) {
    const c = path.resolve(candidate);
    const d = path.resolve(declAbs);
    if (c === d) return true;
    for (const e of EXTS) if (c + e === d) return true;
    for (const e of EXTS) {
        if (!e) continue;
        if (path.join(c, 'index' + e) === d) return true;
    }
    return false;
}

function isRelativeSpec(spec) {
    return spec === '.' || spec === '..' || spec.startsWith('./') || spec.startsWith('../');
}

/** 候选路径是否指向声明的任一处（支持单值或 Set）。 */
function matchesAnyDecl(candidate, declTarget) {
    if (declTarget instanceof Set) {
        for (const d of declTarget) if (sameFile(candidate, d)) return true;
        return false;
    }
    return sameFile(candidate, declTarget);
}

/** 该说明符是否指向声明文件；相对说明符按 fromAbs 所在目录解析。 */
function specMatchesDecl(aliasMap, spec, declTarget, fromAbs) {
    if (!spec || !declTarget) return false;
    if (isRelativeSpec(spec) && fromAbs) {
        return matchesAnyDecl(path.resolve(path.dirname(fromAbs), spec), declTarget);
    }
    if (!aliasMap) return false;
    const cands = resolveSpec(aliasMap, spec);
    for (const c of cands) if (matchesAnyDecl(c, declTarget)) return true;
    return false;
}

/** 从一行源码里抽出所有模块说明符（require / from / import()）。 */
function specifiersIn(line) {
    const out = [];
    for (const mk of SPEC_MARKERS) {
        let from = 0;
        while (true) {
            const at = line.indexOf(mk, from);
            if (at === -1) break;
            from = at + mk.length;
            let k = from;
            while (k < line.length && WS.indexOf(line[k]) !== -1) k++;
            const q = line[k];
            if (q !== '"' && q !== "'") continue;
            const end = line.indexOf(q, k + 1);
            if (end === -1) continue;
            out.push(line.slice(k + 1, end));
        }
    }
    return out;
}

/** 一行的任一说明符解析后指向声明文件，即为真导入。 */
function lineImportsDecl(line, aliasMap, declAbs, fromAbs) {
    const specs = specifiersIn(line);
    for (const s of specs) if (specMatchesDecl(aliasMap, s, declAbs, fromAbs)) return true;
    return false;
}

module.exports = { loadAliasMap, loadAliasMapNear, resolveSpec, specMatchesDecl, specifiersIn, lineImportsDecl, sameFile };
