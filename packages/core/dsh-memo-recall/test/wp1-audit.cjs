// WP1 评估探针：会话日志 tool/result 体积与连续重复行折叠收益统计（HarnessPro _compact_text 语义）
const zlib = require('zlib'); const fs = require('fs'); const path = require('path');
const root = process.argv[2] || require('node:os').homedir() + '/.dsh/sessions';
const MAX_SESSIONS = Number(process.argv[3]) || 20;
const dirs = [];
for (const ws of fs.readdirSync(root)) {
  const wsDir = path.join(root, ws);
  for (const s of fs.readdirSync(wsDir)) {
    const f = path.join(wsDir, s, 'session.v4.jsonl.zstd');
    if (fs.existsSync(f)) dirs.push({ f, mtime: fs.statSync(f).mtimeMs });
  }
}
dirs.sort((a, b) => b.mtime - a.mtime);
const files = dirs.slice(0, MAX_SESSIONS).map(d => d.f);
// HarnessPro _compact_text 语义：连续重复行折叠为 "line" + "[previous line repeated N more times]"
function foldConsecutive(lines) {
  const out = []; let i = 0;
  while (i < lines.length) {
    let j = i + 1; while (j < lines.length && lines[j] === lines[i]) j++;
    out.push(lines[i]); if (j - i > 1) out.push(`[previous line repeated ${j - i - 1} more times]`);
    i = j;
  }
  return out;
}
const perTool = {}; let grandChars = 0, grandFolded = 0, results = [];
for (const f of files) {
  let text; try { text = zlib.zstdDecompressSync(fs.readFileSync(f)).toString('utf8'); } catch { continue }
  const callNames = {};
  for (const line of text.split('\n')) {
    if (!line) continue;
    let rec; try { rec = JSON.parse(line); } catch { continue }
    if (rec.type === 'tool/call') { const d = rec.data || {}; callNames[d.callId] = d.name || '?'; }
    if (rec.type === 'tool/result') {
      const msg = (rec.data && rec.data.message) || {};
      const t = (msg.content || []).map(c => c.text || '').join('\n');
      if (!t) continue;
      const name = callNames[msg.toolCallId || (msg.source && msg.source.callId)] || '(unknown)';
      const lines = t.split('\n');
      const folded = foldConsecutive(lines);
      const orig = t.length, after = folded.join('\n').length;
      perTool[name] = perTool[name] || { count: 0, chars: 0, folded: 0, maxSingle: 0 };
      const p = perTool[name];
      p.count++; p.chars += orig; p.folded += after; p.maxSingle = Math.max(p.maxSingle, orig);
      grandChars += orig; grandFolded += after;
      results.push({ name, chars: orig, save: orig - after, ratio: orig ? (orig - after) / orig : 0 });
    }
  }
}
console.log(`sessions=${files.length} tool/results=${results.length}`);
console.log(`total_chars=${grandChars} folded_chars=${grandFolded} saved=${grandChars - grandFolded} (${(100 * (grandChars - grandFolded) / (grandChars || 1)).toFixed(1)}%)`);
console.log('\n== per tool (by total chars desc) ==');
const tools = Object.entries(perTool).sort((a, b) => b[1].chars - a[1].chars).slice(0, 15);
for (const [name, p] of tools) {
  const savePct = (100 * (p.chars - p.folded) / (p.chars || 1)).toFixed(1);
  console.log(`${name.padEnd(28)} n=${String(p.count).padStart(4)} chars=${String(p.chars).padStart(9)} max=${String(p.maxSingle).padStart(8)} 折叠省=${savePct}%`);
}
console.log('\n== top 10 largest results ==');
results.sort((a, b) => b.chars - a.chars).slice(0, 10).forEach(r => console.log(`${r.name.padEnd(28)} chars=${String(r.chars).padStart(8)} 连续重复行占比=${(r.ratio * 100).toFixed(1)}%`));
