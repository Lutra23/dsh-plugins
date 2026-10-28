'use strict';
/**
 * 退役触发器检查（P4.2 · 2026-10-20）：新增兼容/fallback 分支时，要求说明"何时删"。
 *
 * 为什么存在：本机审计实测 3,591 次内容编辑中 **67 次（1.87%）引入 compat/fallback 分支**，
 * 其中只有 **3 次（4.5%）提到退役触发器**——95.5% 的兼容分支没有退役计划。
 * 兼容代码本身不是错；**没有退役计划的兼容代码**才是熵的来源（它永久占着一条路径，
 * 且没人知道何时能删）。Aegis 的 anti-entropy 对此的处理是 delete-first + 退役触发器，
 * 但它的 Deferred Ledger 实测挂账 0 条——说明"靠自觉记账"这条路走不通。
 *
 * 设计取舍（按数据定，不按教条）：
 *  - **不阻断**：1.87% 的频率；且"兼容分支"往往是正确的工程决定（跨版本、跨宿主）。
 *    阻断它等于惩罚正确的做法。真正的目标不是禁止，而是**让退役条件被写下来**。
 *  - **只提示 + 给模板**：命中且未提退役时，附一句可照抄的写法，把"何时删"变成一次填空，
 *    而不是一次思考负担。这是降低摩擦，不是增加摩擦。
 *  - **与 patch-shape 共用判据**：compat 信号的定义在 patch-shape.cjs（单一 owner），
 *    本模块只负责"是否已说明退役"，避免两处定义漂移。
 *
 * 判据来源：Aegis anti-entropy-governance 的 Retained Object / Reason / Observation Metrics /
 * Retirement Timing 四字段；本机 3,591 次真实编辑分布。
 */
const path = require('node:path');
const { detectPatchShape, collectEditText } = require(path.join(__dirname, 'patch-shape.cjs'));

/** 已说明退役的判据（写在哪都行：reason 或改动文本里的注释）。 */
const RETIREMENT_MENTION = /(退役|何时删|何时移除|临时兼容|长期保留|永久保留|retire|retirement|remove this|remove when|remove after|temporary|TODO.*删|deprecated since|待上游|等.*修好.*删)/i;

/** 兼容/兜底类信号（与 patch-shape 的 id 对齐，不重复定义正则）。 */
const COMPAT_SIGNAL_IDS = new Set(['compat-branch', 'fallback-default', 'swallow-catch']);

/** 只有内容写命令才需要检查。 */
const CONTENT_WRITE_COMMANDS = new Set(['EditCode', 'CreateFile']);

/**
 * 判断这次改动是否"引入了兼容分支但没写退役条件"。
 * @param {object} args 工具入参
 * @returns {{hit:boolean, signals:string[]}}
 */
function inspectRetirement(args) {
  const a = args && typeof args === 'object' ? args : {};
  if (!CONTENT_WRITE_COMMANDS.has(a.command)) return { hit: false, signals: [] };
  const text = collectEditText(a);
  if (!text.trim()) return { hit: false, signals: [] };
  const signals = detectPatchShape(text)
    .map((h) => h.id)
    .filter((id) => COMPAT_SIGNAL_IDS.has(id));
  if (!signals.length) return { hit: false, signals: [] };
  const blob = String(a.reason || '') + '\n' + text;
  if (RETIREMENT_MENTION.test(blob)) return { hit: false, signals };
  return { hit: true, signals };
}

/**
 * 生成提示。未命中返回空串（回执零增长）。
 * @param {object} args 工具入参
 * @returns {string}
 */
function retirementHint(args) {
  const { hit, signals } = inspectRetirement(args);
  if (!hit) return '';
  const labels = signals.join('、');
  return (
    `\n\n- ⚠️ 退役触发器缺失：本次改动命中「${labels}」，但未说明**何时移除**。\n` +
    '  - 兼容代码本身没问题；问题是**没有退役条件的兼容代码会永久留下**（实测 67 次兼容改动里仅 4.5% 提过退役）。\n' +
    '  - 在 `reason` 末尾补一句即可（可照抄）：`退役触发：<什么条件下删>，验证方式：<怎么确认可以删>`。\n' +
    '  - 若这条分支本就长期保留（如跨版本契约），写 `长期保留：<理由>` 也算已说明。\n' +
    '  - 本检查**不阻断**写入；写入照常执行。'
  );
}

/**
 * 汇总统计（审计复用）。
 * @param {Array<object>} calls 工具调用入参数组
 */
function summarizeRetirement(calls) {
  let withCompat = 0;
  let missing = 0;
  for (const c of calls || []) {
    const { hit, signals } = inspectRetirement(c);
    if (!signals.length) continue;
    withCompat += 1;
    if (hit) missing += 1;
  }
  return {
    withCompat,
    missing,
    rate: withCompat ? missing / withCompat : 0,
  };
}

module.exports = { inspectRetirement, retirementHint, summarizeRetirement, RETIREMENT_MENTION, COMPAT_SIGNAL_IDS };
