'use strict';
// 补丁形状探测器（P0.2 · 2026-10-20）
//
// 动机（本机审计实测）：Trace+FindSymbol 只占 project_forge 调用的 0.6%（40/6701），
// 而 EditCode 占 45.8%（3066/6701）——「该不该往上追 canonical owner」这个判断
// 从未被触发过。工具在，习惯不在；把判断前置到写操作回执里，而不是再加一条规则。
//
// 设计：纯函数，只扫描本次改动文本（不读文件、不调引擎、不联网），命中即给一行提示。
// 依据：Aegis systematic-debugging 的 patch-shape 信号表 + 本机 25,605 次调用审计。
// 定位：这是 advisory 提示，不是闸门——不阻断写入，只把「就地修 vs 追 owner」摆到眼前。

/** 补丁形状信号：命中任一即提示先定位 owner。 */
const SIGNALS = [
  { id: 'keyword-branch', label: '关键词/文本特判', re: /\.(includes|indexOf|startsWith|endsWith|match|test)\s*\(/ },
  { id: 'literal-compare', label: '字面量比较分支', re: /===\s*['"`][^'"`]{2,}/ },
  { id: 'local-guard', label: '局部 guard / 提前返回', re: /if\s*\([^)]{1,80}\)\s*(\{\s*)?return\b/ },
  { id: 'swallow-catch', label: 'try/catch 吞异常', re: /catch\s*(\([^)]*\))?\s*\{\s*(\}|\/\*|return\s*(null|undefined|false)?\s*;?\s*\})/ },
  { id: 'fallback-default', label: 'fallback / 默认值兜底', re: /\?\?\s*(\[\]|\{\}|''|""|0|false)|\|\|\s*(\[\]|\{\}|''|""|0|false)|fallback/i },
  { id: 'compat-branch', label: '兼容分支/旧路径', re: /(legacy|compat|deprecated|backward|oldPath|v1Compat|fallbackPath)/i },
  { id: 'reparse-downstream', label: '下游重解析原始文本', re: /\b(JSON\.parse|parseInt|Number)\s*\(/ },
  { id: 'optional-chain-guard', label: '可选链/空值护栏', re: /\?\.\s*(length|map|filter|forEach|trim|split)/ },
];

const MAX_SIGNALS = 3;
const LINE_CAP = 120;

/** 收集本次编辑涉及的文本（target/replace/content 及其编号串语法变体）。 */
function collectEditText(args) {
  const a = args && typeof args === 'object' ? args : {};
  const out = [];
  for (const [key, value] of Object.entries(a)) {
    if (!/^(target|replace|content|old_string|new_string|before|after)\d*$/.test(key)) continue;
    if (typeof value === 'string' && value) out.push(value);
  }
  return out.join('\n');
}

/** 扫描文本，返回命中的形状信号（最多 MAX_SIGNALS 条，含证据行）。 */
function detectPatchShape(text) {
  const source = typeof text === 'string' ? text : '';
  if (!source.trim()) return [];
  const hits = [];
  for (const signal of SIGNALS) {
    if (hits.length >= MAX_SIGNALS) break;
    for (const rawLine of source.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      if (signal.re.test(line)) {
        hits.push({
          id: signal.id,
          label: signal.label,
          line: line.length > LINE_CAP ? line.slice(0, LINE_CAP) + '…' : line,
        });
        break;
      }
    }
  }
  return hits;
}

/**
 * 生成回执行提示。命中补丁形状时给一行 advisory；未命中返回空串。
 * @param {object} args EditCode/CreateFile 的原始参数
 * @returns {string} 形如 "\n- ⚠️ 补丁形状：… " 或 ''
 */
function patchShapeHint(args) {
  const hits = detectPatchShape(collectEditText(args));
  if (!hits.length) return '';
  const labels = hits.map(h => h.label).join('、');
  const first = hits[0].line;
  return [
    '',
    `- ⚠️ 补丁形状：${labels}`,
    `  - 命中：\`${first}\``,
    '  - 建议先 `Trace` / `FindSymbol` 确认 canonical owner，再决定是否就地修（就地修需给出保留理由与退役触发器）。',
  ].join('\n');
}

module.exports = { SIGNALS, MAX_SIGNALS, collectEditText, detectPatchShape, patchShapeHint };
