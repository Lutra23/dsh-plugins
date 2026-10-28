'use strict';
/**
 * 改动必要性检查（P4.1 · 2026-10-20）：在写入前判断"这次改动有没有必要"。
 *
 * 为什么存在：本机审计实测 EditCode/CreateFile 中 **11 次（0.40%）的 target 与 replace 完全相同**
 * ——写了等于没写。这类调用不是无害的：它消耗一次写入配额、产生一条开发脉络节点、
 * 回执还显示"✅ 已写入"，让人误以为改动生效（真实案例：以为改了 root 解析逻辑，实际空写）。
 *
 * 设计取舍（按数据定，不按直觉）：
 *  - **不阻断**：0.4% 的频率不足以给 99.6% 的正常调用加闸门。拒绝会误伤边界情形
 *    （例如故意用 replace 规范化空白、或串语法里的合法空步），代价高于收益。
 *  - **只提示 + 给出路**：命中时回执附一句"这次 target 与 replace 相同，确认是否漏改了"，
 *    并提示如何自查。这符合"闸门只喊停会训练出绕行"的反面——要同时给出下一步。
 *  - **串语法安全**：只检查顶层 target/replace；编号参数（op1/target1/...）在引擎侧解析，
 *    本模块不介入（实测 162 次串语法调用中 target===replace 为 0 次，无此风险）。
 *
 * 判据来源：Aegis 的 Change Necessity 四态（no-change / docs-config-only / code-change / needs-clarification），
 * 本机 2,740 次带 target+replace 的真实调用分布。
 */

/** 命中判据：顶层 target 与 replace 完全相同的字符串。 */
function isNoChange(args) {
  const a = args && typeof args === 'object' ? args : {};
  if (typeof a.target !== 'string' || typeof a.replace !== 'string') return false;
  return a.target === a.replace;
}

/** 只有这些命令会写内容，才需要检查。 */
const CONTENT_WRITE_COMMANDS = new Set(['EditCode', 'CreateFile']);

/**
 * 生成提示。未命中返回空串（回执零增长）。
 * @param {object} args 工具入参
 * @returns {string}
 */
function noChangeHint(args) {
  if (!isNoChange(args)) return '';
  return (
    '\n\n- ⚠️ 改动必要性：本次 `target` 与 `replace` 完全相同，**写入后内容不会变化**。\n' +
    '  - 若确实要改：核对 `target` 是否被拼错/含多余空白导致匹配到了别处；用 `ReadCode` 取回当前原文再比一次。\n' +
    '  - 若只是想确认现状：改用 `ReadCode`（只读，不产生改动节点）。\n' +
    '  - 若在规范化空白等边界情形：可忽略本提示，写入照常执行（本检查不阻断）。'
  );
}

/**
 * 汇总统计（给 tools/toolstat.cjs 与审计复用）。
 * @param {Array<{command:string,target?:string,replace?:string}>} calls
 */
function summarizeNoChange(calls) {
  let checked = 0;
  let noChange = 0;
  for (const c of calls || []) {
    if (!c || !CONTENT_WRITE_COMMANDS.has(c.command)) continue;
    if (typeof c.target !== 'string' || typeof c.replace !== 'string') continue;
    checked += 1;
    if (c.target === c.replace) noChange += 1;
  }
  return {
    checked,
    noChange,
    rate: checked ? noChange / checked : 0,
  };
}

module.exports = { isNoChange, noChangeHint, summarizeNoChange, CONTENT_WRITE_COMMANDS };
