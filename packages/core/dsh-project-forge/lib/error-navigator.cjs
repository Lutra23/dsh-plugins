'use strict';
/**
 * 错误导航器（P3.2 · 2026-10-20）：给"死胡同"错误补一条出路。
 *
 * 为什么存在：本机审计实测 project_forge 引擎有 73 条 throw，但只有 16 条（22%）
 * 文案里带出路线索（"可用 ListProjects 查询"这类）；其余 57 条只说了"哪里错了"，
 * 不说"接下来怎么办"。宿主侧 lib/index.js 本就有 `下一步：` 渲染逻辑，但它读的是
 * error.next 字段——而引擎从不填该字段（74 处 throw 零处设置），于是那段渲染成了死代码。
 *
 * 设计取舍：
 *  - 纯函数 + 关键词表，不改 vendor/ 的 74 处 throw（那要重启 daemon 且污染上游）；
 *  - 只做"识别 + 补出路"，不伪造建议：命中哪类就给哪类的标准出路；
 *  - 识别不出时返回空串——宁可不说，也不给错的方向（错误建议比没有建议更坏）。
 *
 * 与引擎自带出路的关系：引擎文案里已有出路的（22%）不重复补，避免回执变啰嗦。
 */

/** 已含出路的判据：文案里出现这些词，说明引擎自己说清了下一步。 */
const ALREADY_ACTIONABLE = /(可用|请用|请调|请先|请重新|应形如|重发|改用|先 |先用|必须先|可先|建议|尝试|不知道.*先)/;

/**
 * 出路表：按"错误指纹"匹配，给标准出路。
 * 顺序有意义——越具体的指纹放前面，先命中先返回。
 */
const ROUTES = [
  {
    id: 'missing-project-id',
    re: /缺少 projectId|需要 projectId/,
    next: '先用 ListProjects（可加 workspace）查到目标工程 ID，再带上 projectId 重发。若还没建工程，用 CreateProject 先建。',
  },
  {
    id: 'project-not-found',
    re: /工程 .*不存在或已删除|projectId .*不存在/,
    next: '用 ListProjects 或 SearchProjects 核对工程 ID（工程可能已删除）；确认后用正确的 projectId 重发。',
  },
  {
    id: 'workspace-not-found',
    re: /工作区.*不存在|不在已启用工作区|路径不在已启用工作区/,
    next: '用 ListWorkspaces 查看可用工作区别名；若是工作区外文件，改用绝对路径并确认它落在允许目录内。',
  },
  {
    id: 'external-modified',
    re: /被外部修改|expectedHash|读取时.*写入前/,
    next: '文件在你读取后被改过，写保护已拦下本次写入。先 ReadCode 重新读取当前内容，确认改动仍在需要后，用新内容重发。',
  },
  {
    id: 'too-large-or-binary',
    re: /超过可编辑上限|二进制或 UTF-16|不能按文本编辑/,
    next: '该文件不适合用 EditCode 直接改。改用 ops_bash 处理，或先在源头把它拆小/转码。',
  },
  {
    id: 'encoding-failed',
    re: /无法以原编码.*写回|缺少 iconv-lite/,
    next: '目标文件编码无法原样写回，写入已放弃（避免乱码）。先用 ops_bash 的 file/iconv 确认编码，或转换编码后再改。',
  },
  {
    id: 'needs-param',
    re: /需要 (name|query|conclusion|projectIds|reason|evidence|todo)/,
    next: '补上被点名的必填参数后重发。各命令的必填项可用 Help 命令按需查（project_forge command:"Help"）。',
  },
  {
    id: 'enum-invalid',
    re: /必须是|只能是|无效：“|应形如/,
    next: '取值不在允许集合内。用 Help 查该参数的可选值，或参考报错里给出的形如示例重发。',
  },
  {
    id: 'trash-failed',
    re: /移到回收站失败|文件未删除/,
    next: '删除未生效（文件仍在原地）。用 ops_bash 确认文件是否被占用或只读，排除后重试 RemoveFile。',
  },
  {
    id: 'task-state',
    re: /只有进行中任务|未显式开始|禁止 pending 直接完成|修订冲突|revision/,
    next: '任务状态不允许此操作。先 GetProject 读当前 revision 与任务状态，再按报错指出的状态转换重发（例如先 TaskAction start 再 complete）。',
  },
  {
    id: 'blocked-root',
    re: /blockedReason|工作区.*被阻止/,
    next: '工作区当前不可写。用 ListWorkspaces 查看该工作区的 blockedReason 与启用状态。',
  },
  {
    id: 'file-not-found',
    re: /文件不存在|路径不存在|ENOENT/,
    next: '目标文件不在该路径。先用 ListWorkspaces 确认工程根与工作区别名，或用 ops_bash 的 ls/find 核对实际路径，再重发。',
  },
  {
    id: 'ticket-expired',
    re: /票据.*不存在或已过期|ticketId.*过期/,
    next: '候选票据已失效（30 分钟有效，插件重启会清空）。重新提交 EditCode 触发一次候选选择，或改用更完整的限定名一次命中。',
  },
];

/**
 * 从错误文案推断出路。返回空串表示"识别不出，宁可不给建议"。
 * @param {string} message 引擎/宿主抛出的错误文案
 * @returns {string} 出路文案（不含"下一步："前缀）
 */
function suggestNext(message) {
  const text = typeof message === 'string' ? message : '';
  if (!text) return '';
  // 引擎自己已给出出路时，不重复补——避免回执变成两段同义话。
  if (ALREADY_ACTIONABLE.test(text)) return '';
  for (const route of ROUTES) {
    if (route.re.test(text)) return route.next;
  }
  return '';
}

module.exports = { suggestNext, ROUTES, ALREADY_ACTIONABLE };
