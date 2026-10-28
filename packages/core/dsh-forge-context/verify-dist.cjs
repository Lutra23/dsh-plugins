// 发版前 dist 验收：逐条断言新逻辑真的进了包。
//
// 为什么不能直接 grep 中文：esbuild 把非 ASCII 转成「反斜杠 + u + 4hex」存进 dist，
// 拿原文 includes 必然 0 命中——那不是没打进去，是观察姿势问题。
// 为什么用 String.fromCharCode(92) 拼反斜杠：转义在 shell、JS 字符串、正则里各要写一次，
// 层数差一个就静默失效；拼出来就绕开全部三层。
const fs = require('node:fs');

const BACKSLASH = String.fromCharCode(92);
const dist = fs.readFileSync('dist/index.js', 'utf8');
const decoded = dist.replace(
  new RegExp(BACKSLASH + BACKSLASH + 'u([0-9a-fA-F]{4})', 'g'),
  (_m, h) => String.fromCharCode(parseInt(h, 16)),
);

const probes = {
  // WP2 签发即预检
  'WP2 字段 submittable': 'submittable',
  'WP2 字段 blockedBy': 'blockedBy',
  'WP2 阻断码 split-tool-pair': 'split-tool-pair',
  'WP2 阻断码 opens-mid-exchange': 'opens-mid-exchange',
  'WP2 阻断码 unpairable': 'unpairable',
  'WP2 阻断码 off-surface': 'off-surface',
  // WP12: 判据同源 —— 签发侧与提交侧必须各调一次同一个 admitVerdict，
  // 而不是各自维护一套「连续性/配对」规则。旧断言盯的是 tools.ts 直接调配对
  // 守卫的形态，那种重复实现被删掉正是修好的证据，所以这里改盯结构不变量：
  // 全产物恰好两处调用点（提交侧 admitCandidate、签发侧 pairingPrecheck）。
  'WP12 唯一判据存在': 'function admitVerdict(session, candidate)',
  'WP12 签发侧复用同一判据': 'admitVerdict(session, { candidateId: "", snapshotId: "", sourceSeqs: seqs })',
  'WP12 阻断码 not-contiguous': 'not-contiguous',
  'WP2 构造处展开': 'pairingPrecheck(session, run)',
  // 0.0.5 三条失败路径修正
  'P0-1 孤儿结果分支': 'orphan tool result',
  'P0-1 seq离面分支': 'is not on the current surface',
  'P0-2 澄清tool-call': '补 tool-call 解决不了它',
  'P1 熔断消息': '同一类校验连续拒绝',
  'P1 阈值常量': 'maxConsecutiveRefusals',
  // 0.0.3/0.0.4 既有能力，防回归
  'WP3 轮有界 tailRounds': 'tailRounds',
  'WP4 PTL 重试': 'dropOldestRounds',
  'WP5 覆盖校验': 'droppedUserSeqs',
  'WP1 压后回填': 'buildRehydrateBlock',
  // 到及格线必须放闸门（认 targetHigh），否则候选耗尽时 phase 卡 active、写入永久锁死；
  // 及格线 200K（0.4×500K = 窗口 20%），目标线 150K（0.3）。两处都调同一个
  // reachedTargetHigh（含 2% 容差），避免「status 说还差、auto-tidy 说完成」的漂移。
  '停止判据调唯一判据': /reachedTargetHigh\(workBudget\(value\), value\.requestTokens\)/,
  'needTokens 认及格线': /needTokens = reached \? 0 : used - budget\.targetHigh/,
  'optionalDeepTokens 单列不驱动行动': /optionalDeepTokens = Math\.max\(0, used - budget\.targetLow\)/,
  'hint 达标即停': '已达标',
  'hint 提示回到工程': '不要再调 candidates/preview/compact',
  '!hint 无重复号召': '继续往下压',
  // WP5 死锁逃生口：闸门落下后必须有出路
  'WP5 escape 状态': /["']escape["']/,
  'WP5 出口 pin-and-skip': 'pin-and-skip',
  'WP5 出口 force-unlock': 'force-unlock',
  'WP5 出口 panel-tidy': 'panel-tidy',
  'WP5 forceUnlock 方法': 'forceUnlock',
  'WP5 审计理由字段': 'forcedUnlockReason',
  'WP5 安全候选数入参': 'safeCandidateCount',
  // WP6 首条用户消息抽取式保护（不做硬保护）
  'WP6 逐字保留段标题': '逐字保留（未经概括，可直接引用）',
  // WP15: 拒绝抄写不再是校验对象——原文由程序从 nodeTexts 填。
  // 断言只能盯运行时会出现的字面量：类型名（PinnedRequest）构建即擦除，压缩也会
  // 改写 `completedByHost.push('pinned')` 这种表达式，两者都不该作为探针。
  'WP15 span 外仍拒绝': 'is not in this span, so its text is unknown',
  'WP15 pinned 字段名': 'pinnedSeq',
  'WP6 候选首条标记': 'containsFirstUserMessage',
  'WP6 原文入参': 'nodeTexts',
  // WP7 摘要长出可操作字段
  'WP7 涉及文件段': '—— 涉及文件 ——',
  'WP7 如何找回(有区间)': '本块遮蔽了 seq',
  'WP7 如何找回(兜底)': '如何找回：',
  'WP7 区间折叠函数': 'toClosedRanges',
  'WP7 遮蔽区间入参': 'shadowedRanges',
  // WP13 硬令牌改程序自动附加
  'WP13 令牌模式表': 'HARD_TOKEN_PATTERNS',
  'WP13 抽取器(带类别)': 'extractHardTokenEntries',
  'WP13 区块渲染器': 'serializeHardTokenBlock',
  'WP13 路径形状校验': 'normalisePathToken',
  'WP13 区块标题': '—— 硬令牌（程序自动保留，非模型转录）——',
  'WP13 块字段': 'hardTokens',
  'WP13 闸门比对漂移': 'hardTokens block drifted from the extraction',
  // 旧实现必须真的离场：覆盖率闸门与它的拒绝文案都在 dist 里消失。
  '!WP13 覆盖率闸门已删除': 'checkHardTokenCoverage',
  '!WP13 抄写式拒绝已删除': '摘要漏掉了',
  '!WP13 覆盖率阈值已删除': 'HARD_TOKEN_MIN_COVERAGE',
  // WP9 相邻候选合并为单区间
  'WP9 合并函数': 'mergeAdjacentCandidates',
  'WP9 直通返回': 'return [...candidates];',
  'WP9 合并残骸已移除': /mergeAdjacentCandidates[\s\S]{0,200}return \[\.\.\.candidates\]/,
};

let pass = 0;
const failed = [];
const matches = (probe) => (probe instanceof RegExp ? probe.test(decoded) : decoded.includes(probe));
for (const [rawName, probe] of Object.entries(probes)) {
  // `!名字` 表示这条必须不成立（如已删除的文案不该再出现）。
  const negated = rawName.startsWith('!');
  const name = negated ? rawName.slice(1) : rawName;
  const hit = matches(probe);
  if (hit !== negated) pass += 1;
  else failed.push(negated ? name + '（应不存在却出现了）' : name);
}

for (const name of failed) console.log('FAIL  ' + name);
console.log(String(pass) + ' pass / ' + String(failed.length) + ' fail  (共 ' + String(Object.keys(probes).length) + ' 条)');
process.exit(failed.length === 0 ? 0 : 1);
