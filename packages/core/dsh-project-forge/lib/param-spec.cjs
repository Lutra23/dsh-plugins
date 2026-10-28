'use strict';
/**
 * project_forge 参数的唯一真源（渐进式披露）。
 *
 * 为什么存在：`project_forge` 有 60+ 个扁平参数，每个参数的 description 都写着
 * 「哪些命令用它、注意什么」。这些散文如果常驻工具 schema，就是每一次请求都要付的
 * 固定税（实测描述占该工具参数块的 57%）。于是拆成两个视图：
 *
 *   - 注册视图（slim）：只留 type/required/enum —— 够模型把调用发对；
 *   - 查询视图（full）：完整描述，由 command:"Help" 按需取回（一次几百 token）。
 *
 * 两个视图由本文件的同一份 FULL 派生，永远不分叉——改描述只需改这里一处。
 */

const COMMANDS = [
  'ListWorkspaces', 'CreateProject', 'ListProjects', 'SearchProjects', 'GetProject', 'BindProject', 'UpdateTodos', 'TaskAction', 'SubmitReport',
  'DeleteProjects', 'RestoreProjects', 'PurgeProjects',
  'ReadCode', 'Outline', 'FindSymbol', 'Trace', 'References', 'Memory',
  'EditCode', 'ResolveEdit', 'CreateFile', 'RemoveFile', 'MoveFile', 'MoveCode', 'CopyCode',
  'Rollback', 'SearchHistory', 'GetNodeDiff',
  'Help', 'Version',
]

/** 完整声明：注册视图与 Help 都由它派生。 */
const FULL = {
        command: { type: 'string', required: true, enum: COMMANDS, description: '要执行的命令。' },
        operationId: { type: 'string', description: '可选幂等操作 ID；同一操作重连沿用。结果不明时先查询，禁止另起 ID 自动重试。' },
        taskAction:{type:'string',enum:['start','resume','handoff','progress','complete','advance','pause','block','cancel','skip','replan'],description:'TaskAction 的结构化动作；handoff 是跨会话接力，advance 是完成当前项并开始下一项'},
        expectedOwner:{type:'string',description:'handoff 必填：GetProject 中当前任务的 owner，防止转移已被别人接走的任务'},
        targetSessionId:{type:'string',description:'handoff 可选：接手会话；省略即当前调用会话。不能让无关会话替别人交接'},
        taskId:{oneOf:[{type:'integer'},{type:'string'}],description:'GetProject 返回的持久任务 ID；纯数字字符串自动折算'},
        expectedRevision:{type:'integer',description:'任务当前 revision'},
        nextTaskId:{oneOf:[{type:'integer'},{type:'string'}],description:'advance 的下一任务 ID；纯数字字符串自动折算'},
        nextExpectedRevision:{type:'integer',description:'下一任务 revision'},
        evidence:{oneOf:[{type:'string'},{type:'object',properties:{},additionalProperties:true}],description:'完成证据 JSON：{"summary":"做成了什么","check":"怎么核对的","result":"passed"}——传对象或 JSON 字符串皆可（对象会自动序列化，两种写法等价）。refs 可省略——省略时按本任务名下已提交节点自动装配路径与当前哈希（无节点才报错）。research 任务可用 source/url/finding。'},
        criteria:{type:'string',description:'replan 设置验收条件；请具体说明交付标准'},
        dependencies:{type:'string',description:'replan 设置前置 taskId 数组 JSON，例如 [12,13]；必须先通过前置任务验收'},
        traceMode: { type: 'string', enum: ['static','registry-assisted'], description: 'Trace 模式：static 不执行项目代码；省略保留旧声明增强行为。' },
        projectId: { type: 'string', description: '工程 ID（CreateProject 返回；ListProjects 可查）。除 ListWorkspaces / CreateProject / ListProjects 外均必需。' },
        path: { type: 'string', description: 'ReadCode/Outline/EditCode/CreateFile/RemoveFile 的单个文件路径（相对工程根），可写 src/a.js:40-80 指定行范围，或 src/a.js#Store.put 按符号。' },
        paths: { type: 'string', description: 'ReadCode/Outline/RemoveFile 的多个文件：换行或逗号分隔，每项都可带 :M-N 或 #符号。' },
        glob: { type: 'string', description: 'ReadCode 的通配批量读取（如 shots/*.png）；FindSymbol/Trace 可用来限定范围。' },
        name: { type: 'string', description: 'CreateProject 的工程名；FindSymbol/References 的符号名。' },
        workspace: { type: 'string', description: 'CreateProject 的工作区别名；ListProjects 可写 all。' },
        dir: { type: 'string', description: 'CreateProject 的工作区内子目录（作为工程根），也可写白名单内的绝对路径。' },
        todos: { type: 'string', description: 'CreateProject 的初始待办；UpdateTodos 的 add 新增项。换行或逗号分隔。' },
        query: { type: 'string', description: 'ListProjects 按名称/ID 过滤；ReadCode 的 find 参数（在所选文件中查找文本）。' },
        includeDeleted: { type: 'boolean', description: 'ListProjects 包含已删除工程。' },
        timeline: { type: 'integer', description: 'GetProject 显示的开发脉络条数（默认 8）。' },
        done: { type: 'string', description: 'UpdateTodos：标为完成的序号列表（如 1,3）。' },
        doing: { type: 'string', description: 'UpdateTodos：标为进行中的序号列表。' },
        pending: { type: 'string', description: 'UpdateTodos：退回待办的序号列表。' },
        blocked: { type: 'string', description: 'UpdateTodos：标为受阻的序号列表。' },
        remove: { type: 'string', description: 'UpdateTodos：删除的序号列表。' },
        seq: { type: 'string', description: 'UpdateTodos：要修改的单项序号（配合 title / note）。' },
        title: { type: 'string', description: 'UpdateTodos：新的待办标题。' },
        note: { type: 'string', description: 'UpdateTodos：待办备注。' },
        content: { type: 'string', description: 'EditCode/CreateFile 的新内容；SubmitReport 的验收结论；Memory mode=write 的记忆正文。' },
        memoryId: { type: 'string', description: 'Memory 的记忆 id（省略为 00-architecture）：list 无需，read/write 可选。' },
        reason: { type: 'string', description: '本次改动的原因（EditCode/CreateFile/RemoveFile/MoveFile/MoveCode/CopyCode/Rollback 必需）。会进入开发脉络。' },
        todo: { type: 'string', description: '本次改动所属的待办序号（有任务的工程写操作必填）；首次写到该项即自动认领，不必先 TaskAction start。' },
        op: { type: 'string', description: 'EditCode 单步操作：replace / insert / delete / target / replace。' },
        start: { type: 'string', description: 'EditCode：替换/删除的起始行号；ReadCode：起始行（配合 end 或单独用读到文件末尾）。' },
        end: { type: 'string', description: 'EditCode：替换/删除的结束行号；ReadCode：结束行（单独用等价于 head:end）。' },
        lines: { type: 'string', description: 'EditCode：行范围 M-N；ReadCode：行范围 head:N、tail:N、M-N、N。' },
        target: { type: 'string', description: 'EditCode：要替换的原文（精确匹配；支持首尾锚定，多处命中返回候选）。' },
        replace: { type: 'string', description: 'EditCode：替换后的文本。' },
        after: { type: 'string', description: 'EditCode/MoveCode/CopyCode：插入到该行之后（0 为文件开头，end 为末尾），或 after=symbol:名称。' },
        before: { type: 'string', description: 'EditCode/MoveCode/CopyCode：插入到该行之前，或 before=symbol:名称。' },
        expect: { type: 'string', description: 'EditCode：该行原文，用于行号漂移时在 ±20 行内自动校正。' },
        symbol: { type: 'string', description: 'EditCode/MoveCode/CopyCode：符号限定名（如 Store.put），无需行号。' },
        range: { type: 'string', description: 'EditCode/ReadCode：range=body 表示从签名行起（不含前置注释）。' },
        pick: { type: 'string', description: 'EditCode：候选序号（预选歧义）；ResolveEdit：选择（如 2、1,3、all、2:1;5:3）。' },
        line: { type: 'string', description: 'EditCode：近似行号提示，用于同名多处时消歧。' },
        mode: { type: 'string', description: 'EditCode：atomic（默认，全部成功才写）/ bestEffort（跳过失败步骤）。Memory：list / read / write / bootstrap（给老工程补建架构记忆，已存在则不覆盖）/ rebuild（强制重建）。注意 Memory 用 mode 而非 action（action 是命令别名，会冲突）。' },
        revertOnSyntaxError: { type: 'boolean', default: true, description: '引入语法错误时不写入。默认 true（引擎侧默认为 false，由插件在 DSH 边界翻正）；显式传 false 关闭。EditCode / CreateFile / MoveCode / CopyCode 支持。' },
        overwrite: { type: 'boolean', description: 'CreateFile：文件已存在时整体覆盖（旧内容仍存快照）。' },
        from: { type: 'string', description: 'MoveFile/MoveCode/CopyCode 的源：文件，或 src/a.js:40-60、src/a.js#calc。' },
        to: { type: 'string', description: 'MoveFile/MoveCode/CopyCode 的目标文件（省略则同文件）。' },
        indent: { type: 'string', description: 'MoveCode/CopyCode：auto（默认）/ keep / 绝对空格数 / +N / -N。' },
        ticketId: { type: 'string', description: 'ResolveEdit：EditCode 返回的歧义票据 ID。' },
        outlineDepth: { type: 'integer', description: 'Outline：只显示前 N 层。' },
        kind: { type: 'string', description: 'Outline/FindSymbol：按类别过滤（如 function,method）。' },
        exact: { type: 'boolean', description: 'FindSymbol：只返回全等或限定名后缀。' },
        limit: { type: 'integer', description: 'FindSymbol/SearchHistory：返回条数上限。' },
        scope: { type: 'string', description: 'FindSymbol/Trace：scope=workspace 扩大到所属工作区根。' },
        traceTarget: { type: 'string', description: 'Trace 的目标：ipc:通道名 / api:API名 / global:名称 / page:x.html / file:相对路径。' },
        batch: { type: 'string', description: 'Rollback/SearchHistory/GetNodeDiff：批次（如 b12；Rollback 可写 last）。' },
        node: { type: 'string', description: 'Rollback/GetNodeDiff：节点（如 n34；Rollback 写 toNode=nX 恢复整个工程）。' },
        dryRun: { type: 'boolean', description: 'Rollback：只预演不执行。' },
        force: { type: 'boolean', description: 'Rollback：确认覆盖外部修改或后续改动。Memory bootstrap/rebuild：强制覆盖已有记忆（等价 mode=rebuild）。' },
        file: { type: 'string', description: 'SearchHistory：路径通配（如 src/*.js）。' },
        keyword: { type: 'string', description: 'SearchHistory：匹配 reason、摘要与路径。' },
        byMaid: { type: 'string', description: 'SearchHistory：按操作者署名过滤。' },
        opFilter: { type: 'string', description: 'SearchHistory：按操作类型过滤（create/edit/delete/move/rollback/external）。' },
        since: { type: 'string', description: 'SearchHistory：起始时间（ISO）。' },
        until: { type: 'string', description: 'SearchHistory：结束时间（ISO）。' },
        maxLines: { type: 'integer', description: 'GetNodeDiff：diff 最大行数（默认 400）。' },
        conclusion: { type: 'string', description: 'SubmitReport：验收结论（必需）。' },
        issues: { type: 'string', description: 'SubmitReport：遗留问题。' },
        status: { type: 'string', enum: ['review', 'accepted', 'active'], description: 'SubmitReport：review（默认待验收）/ accepted（已验收）/ active（退回继续施工）。' },
        projectIds: { type: 'string', description: 'DeleteProjects/RestoreProjects/PurgeProjects：ID 列表。' },
        confirm: { type: 'boolean', description: 'PurgeProjects：确认永久清除。' },
        showLine: { type: 'boolean', description: 'ReadCode：是否显示行号（默认 true）。' },
        context: { type: 'integer', description: 'ReadCode：按符号读取时前后各多读 N 行。' },
        minify: { type: 'boolean', description: '压缩返回：只回结论与 diff 摘要，省 token。' },
};

/**
 * 热参数：实测频率（10517 次真实调用，跨全部会话日志统计）里排前 24 的——
 * 累计占参数使用总量的 ~91%。它们的 description 常驻注册视图：
 * 这些参数几乎每次调用都出现，让模型为它们多查一次 Help 得不偿失。
 * 其余冷参数的描述折叠进 Help，按需取回。
 * 数据来源：session-grep 扫 ~/.dsh/sessions 全量 tool/call 后按参数聚合。
 */
const HOT_PARAMS = new Set([
  'command', 'projectId', 'path', 'target', 'replace', 'op', 'taskId', 'taskAction',
  'expectedRevision', 'evidence', 'lines', 'content', 'showLine', 'mode',
  'note', 'start', 'end', 'todos', 'conclusion', 'status', 'workspace',
  'nextTaskId', 'nextExpectedRevision', 'timeline', 'reason', 'todo',
]);

/** 注册视图：全部参数保留名字/类型/必填/枚举；描述只给热参数，冷参数留给 Help。 */
function slimParams() {
  const out = {};
  for (const [name, spec] of Object.entries(FULL)) {
    const { description, default: _def, ...rest } = spec;
    if (HOT_PARAMS.has(name) && description) rest.description = description;
    out[name] = rest;
  }
  return out;
}

/**
 * 命令摘要（P2.1 · 2026-10-20）：给工具 description 用的压缩视图。
 *
 * 为什么存在：28 个命令名在 schema 的 enum 里已完整列出，description 里再逐条
 * 抄一遍等于每次请求都付两份（实测重复 366 字符）。本函数只给「命令名 + 按用途分组」，
 * 模型从 enum 取具体命令名，description 负责说明"有哪些类别、各自干什么"。
 */
function commandSummary() {
  const groups = [
    ['工程', ['ListWorkspaces', 'CreateProject', 'ListProjects', 'SearchProjects', 'GetProject', 'BindProject', 'DeleteProjects', 'RestoreProjects', 'PurgeProjects']],
    ['任务', ['UpdateTodos', 'TaskAction', 'SubmitReport']],
    ['读', ['ReadCode', 'Outline', 'FindSymbol', 'Trace']],
    ['写', ['EditCode', 'ResolveEdit', 'CreateFile', 'RemoveFile', 'MoveFile', 'MoveCode', 'CopyCode']],
    ['回退/历史', ['Rollback', 'SearchHistory', 'GetNodeDiff']],
    ['元', ['Help', 'Version', 'Memory']],
  ];
  return groups.map(([label, names]) => `${label}：${names.join('/')}`).join('；');
}

/** Help 视图：逐参数渲染「名字 (类型[, 必填])：描述」。 */
function renderParamHelp(names) {
  const pick = names && names.length ? names : Object.keys(FULL);
  const lines = [];
  for (const name of pick) {
    const spec = FULL[name];
    if (!spec) { lines.push('- ' + name + '：（无此参数）'); continue; }
    const bits = [spec.type || 'any'];
    if (spec.required) bits.push('必填');
    if (Array.isArray(spec.enum)) bits.push('可选值 ' + spec.enum.join('|'));
    else if (typeof spec.enum === 'object' && spec.enum !== null) bits.push('可选值见 command 列表');
    if (spec.default !== undefined) bits.push('默认 ' + JSON.stringify(spec.default));
    lines.push('- ' + name + '（' + bits.join('，') + '）：' + (spec.description || ''));
  }
  return lines.join('\n');
}

module.exports = { COMMANDS, FULL, slimParams, renderParamHelp, commandSummary };
