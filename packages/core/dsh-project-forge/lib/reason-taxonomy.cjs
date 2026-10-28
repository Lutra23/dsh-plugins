'use strict';
// P1.1 reason 枚举前缀（2026-10-20）
//
// 动机：审计实测 reason 全期出现 3,728 次，全是自由文本——无法聚合
// 「这次改动属于哪一类必要性」（Change Necessity 的分布是空白的）。
// 本模块提供三件事：① 六个前缀的词表与解析；② 每会话只提醒一次的软提示；
// ③ 零阻断——reason 缺前缀照样写入，只是回执里多一行建议。
//
// 为什么不做硬校验：reason 是必填项，若在宿主侧直接拒绝会打断施工；
// 且真正的必填校验在 vendor/args.js 的 requireReason（上游副本，改动要重启 daemon）。
// 软提示 + 词表教学（工具描述里写明）足以在数天内把采纳率拉起来，且可随时撤回。

/** 六个前缀：覆盖 Change Necessity 的四档 + 两类常见旁路。 */
const PREFIXES = ['code-change', 'docs', 'config', 'minimal-fix', 'delete', 'test'];

/** 每类前缀的一句话释义（进提示与文档，避免只给词不给判据）。 */
const PREFIX_MEANING = {
  'code-change': '功能性改动：新增/修正行为，需要跑测试证明',
  docs: '只动文档/注释/说明，不改运行时行为',
  config: '只动配置/清单/默认值，不新增代码路径',
  'minimal-fix': '最小修补：症状级或局部兜底，未追到 canonical owner',
  delete: '删除：移除旧 owner/fallback/死代码',
  test: '只动测试：补用例或修断言，不动被测实现',
};

/** 前缀解析：`code-change: 说明` → { prefix, valid, text }。 */
function parseReason(reason) {
  const raw = typeof reason === 'string' ? reason : '';
  const m = /^\s*([A-Za-z][A-Za-z-]*)\s*:\s*([\s\S]*)$/.exec(raw);
  if (!m) return { prefix: null, valid: false, text: raw.trim() };
  const prefix = m[1].toLowerCase();
  return { prefix, valid: PREFIXES.includes(prefix), text: m[2].trim() };
}

/** 提示文案：给词表 + 释义 + 可照抄的写法（缺前缀时用）。 */
function buildHintText() {
  const lines = PREFIXES.map((p) => `\`${p}:\`（${PREFIX_MEANING[p]}）`);
  return [
    '',
    '- ⚠️ reason 建议带枚举前缀（本次已按原文记录，未阻断）：',
    `  ${lines.join('　')}`,
    '  写法：`reason:"minimal-fix: 先补 guard 止血，owner 待追"`',
  ].join('\n');
}

/**
 * 每会话只提醒一次的软提示。
 * 关键设计：绝不每次写操作都弹——全期 3,066 次 EditCode，逐次提示等于噪声源。
 * 一个会话提醒一次即够（人/模型看一次就会调整），此后静默。
 */
function createReasonReminder() {
  const reminded = new Set();
  return {
    /** 测试与热重载用：清掉已提醒标记。 */
    reset() {
      reminded.clear();
    },
    /** 已提醒过的会话数（诊断用）。 */
    size() {
      return reminded.size;
    },
    /**
     * 生成提示；带合法前缀、无 reason、或本会话已提醒过 → 返回空串（零噪声）。
     * @param {object} args 工具入参（含 reason）
     * @param {string|undefined} sessionId 会话 id；缺省归入 global 桶
     */
    build(args, sessionId) {
      const reason = args && typeof args.reason === 'string' ? args.reason : '';
      if (!reason) return '';
      if (parseReason(reason).valid) return '';
      const key = sessionId ? String(sessionId) : 'global';
      if (reminded.has(key)) return '';
      reminded.add(key);
      return buildHintText();
    },
  };
}

/** 统计一批 reason 的采纳情况（供审计脚本复用，避免正则散落各处）。 */
function summarizeReasons(reasons) {
  const byPrefix = Object.create(null);
  let valid = 0;
  let total = 0;
  for (const reason of reasons) {
    if (typeof reason !== 'string' || !reason.trim()) continue;
    total += 1;
    const { prefix, valid: ok } = parseReason(reason);
    if (ok) {
      valid += 1;
      byPrefix[prefix] = (byPrefix[prefix] || 0) + 1;
    } else {
      byPrefix['(无前缀)'] = (byPrefix['(无前缀)'] || 0) + 1;
    }
  }
  return { total, valid, rate: total ? valid / total : 0, byPrefix };
}

module.exports = { PREFIXES, PREFIX_MEANING, parseReason, buildHintText, createReasonReminder, summarizeReasons };
