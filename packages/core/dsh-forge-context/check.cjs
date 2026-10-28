// 0.0.9 自检：确认当前发布物确实包含本版功能，且旧行为已经退场。
//
// 这个文件随 tgz 分发，只能在解包目录运行；它不读 src、不依赖宿主内核。
// esbuild 会把中文转成 \uXXXX，先把 dist 里的转义解码再检索。
const fs = require('node:fs');

const BACKSLASH = String.fromCharCode(92);
const dist = fs.readFileSync('dist/index.js', 'utf8').replace(
  new RegExp(BACKSLASH + BACKSLASH + 'u([0-9a-fA-F]{4})', 'g'),
  (_m, hex) => String.fromCharCode(parseInt(hex, 16)),
);

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const EXPECTED_VERSION = '0.0.9';
if (pkg.version !== EXPECTED_VERSION) {
  console.log(`FAIL  包版本应为 ${EXPECTED_VERSION}，实际 ${String(pkg.version)}`);
  process.exit(1);
}

// 必须存在：0.0.6 的旧能力 + 0.0.7/0.0.8/0.0.9 的新能力。
const present = {
  '硬令牌区块标题（程序自动保留）': '—— 硬令牌（程序自动保留，非模型转录）——',
  '硬令牌渲染器': 'serializeHardTokenBlock',
  'pinned 只认 span 内的 seq': 'is not in this span',
  '提醒阈值 30%': 'REMIND_RATIO = 0.3',
  '及格线 20%': 'TARGET_HIGH_RATIO = 0.2',
  '工作预算基数 1M（esbuild 写作 1e6）': 'DEFAULT_WORK_BUDGET_TOKENS = 1e6',
  'autoDraft 机械摘要轨道': 'autoDraft',
  'supersededRequirements 退役通道': 'supersededRequirements',
  'supersededOpenIssues 退役通道': 'supersededOpenIssues',
  '增长门 growthSinceLastFold': 'growthSinceLastFold',
  'T2 候选包含上级摘要': 'containsPriorSummary',
  'T2 蒸馏建议': 'distillRecommended',
  'path 存活探针': 'pathLiveness',
  '候选失效锚点 userAdmissionSeq': 'userAdmissionSeq',
};

// 必须消失：这些串在旧版里意味着“让模型手抄”或“回显全文”。
const absent = {
  '旧的 pinned 逐字比对拒绝': 'is not verbatim',
  '旧的 preview 全量回显': 'summaryPreview',
};

let bad = 0;
for (const [label, needle] of Object.entries(present)) {
  const ok = dist.includes(needle);
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  应有  ' + label);
  if (!ok) bad += 1;
}
for (const [label, needle] of Object.entries(absent)) {
  const ok = !dist.includes(needle);
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  应无  ' + label);
  if (!ok) bad += 1;
}

console.log(`${EXPECTED_VERSION} 改动已入包: ${bad === 0}`);
process.exit(bad === 0 ? 0 : 1);
