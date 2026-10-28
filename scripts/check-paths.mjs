// 硬编码路径守卫：源码与文档里不许出现指向某台机器的绝对路径。
// 示例 / 夹具路径走白名单；URL（https://、file:///）由 lookbehind 排除。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BS = String.fromCharCode(92);
const R1 = BS + BS + '+';            // 正则里的「一个或多个反斜杠」
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pathRe = new RegExp('(?<![A-Za-z0-9+.-])[A-Z]:[' + BS + BS + '/]');

const allow = [
  new RegExp('C:' + R1 + 'Users' + R1 + '(me|user|a|x|pics)'),
  new RegExp('C:' + R1 + '(Program Files|Windows|proj|kb|a)'),
  new RegExp('D:' + R1 + '(videos|Path|YourPath|dl|pics|report|docs|samples)'),
  new RegExp('D:' + R1 + '(报告|表|数据)'),
  new RegExp('E:' + R1 + 'samples'),
  /D:\/AI-XG/,
];

const skipDir = new Set(['node_modules', 'vendor', 'dist', '.git']);
const skipFile = /(package-lock\.json$|\.d\.ts$|CHANGELOG\.md$|\.map$)/;
const skipSeg = ['/test/', '/docs/', '/examples/', '/assets/', '/.build/'];
const exts = new Set(['.js', '.cjs', '.mjs', '.ts', '.md', '.json', '.yml', '.yaml', '.ps1']);

const hits = [];
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!skipDir.has(e.name)) walk(p); continue; }
    if (skipFile.test(e.name) || !exts.has(path.extname(e.name))) continue;
    const norm = p.split(BS).join('/');
    if (skipSeg.some(s => norm.includes(s))) continue;
    fs.readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
      if (!pathRe.test(line)) return;
      if (allow.some(re => re.test(line))) return;
      if (line.includes('C:' + BS + '...') || line.includes('C:' + BS + BS + '...')) return;
      hits.push(`${path.relative(root, p)}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
}
walk(path.join(root, 'packages'));

if (hits.length) {
  console.error(`hardcoded paths found: ${hits.length}`);
  for (const h of hits) console.error('  ' + h);
  process.exit(1);
}
console.log('OK: no hardcoded local paths in packages/ (examples whitelisted)');
