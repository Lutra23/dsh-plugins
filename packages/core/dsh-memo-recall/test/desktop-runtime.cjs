// Isolated host-loader and real preStep/runtime-context compatibility check.
// Run with the installed Electron binary, ELECTRON_RUN_AS_NODE=1 and --expose-internals.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const asarRoot = process.env.DSH_KERNEL_ROOT;
if (!asarRoot) { console.error('[skip] set DSH_KERNEL_ROOT=<...>/resources/app.asar'); process.exit(2); }
const base = asarRoot.replace(/[\/]+$/, '') + '/dsh/node_modules/@deepseek-ai/';
(async () => {
  const boot = await import(pathToFileURL(base + 'dsh-app-boot/lib/index.js'));
  const { Context } = await import(pathToFileURL(base + 'cordis/lib/index.js'));
  const { ModuleLoader } = await import(pathToFileURL(base + 'cordis-plugin-loader/lib/index.js'));
  const profile = boot.loadProfileDirectory('dsh', require('node:os').homedir() + '/.dsh/profiles/desktop', base + 'dsh/package.json');
  const resolution = await boot.createRuntimeResolution({ installAnchor: base + 'dsh/package.json', profile });
  const ctx = new Context();
  new boot.PluginPackages(ctx, { resolution });
  const module = await ModuleLoader.fromInternal().import('@dsh-external/dsh-memo-recall', pathToFileURL(profile.dir + '/').href, {});
  const registered = [];
  module.default.apply({ on: (name, fn) => registered.push({ name, fn }), subprocess: {}, fs: {}, logger: { warn() {} } }, { debug: false });
  assert.deepEqual(registered.map(r => r.name), ['session/event', 'agent/pre-step']);

  const { Session, KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(base + 'dsh-session/lib/index.js'));
  const { releasedV4SessionFormatCodec: codec, restoreReleasedV4Artifact: restore } = await import(pathToFileURL(base + 'dsh-session-format-v3-to-v4/lib/index.js'));
  const prompt = await import(pathToFileURL(base + 'dsh-system-prompt/lib/index.js'));
  const llm = await import(pathToFileURL(base + 'dsh-llm/lib/index.js'));
  const sessionModule = await import(pathToFileURL(base + 'dsh-session/lib/index.js'));
  const loopSource = fs.readFileSync(base + 'dsh-agent-loop/lib/index.js', 'utf8');
  // Evaluate the installed method/class unchanged, exposing only their normal
  // imports; the inbox, assembly and provider are deterministic offline doubles.
  const method = loopSource.slice(loopSource.indexOf('\tasync preStep('), loopSource.indexOf('\t/** Whether the assembled tool schemas'));
  const runtimeStart = loopSource.indexOf('var RuntimeContextProjection = class');
  const runtimeEnd = loopSource.indexOf('\n//#endregion', runtimeStart);
  const scope = {
    createUserMessage: llm.createUserMessage,
    renderContextSections: prompt.renderContextSections, joinContextSections: prompt.joinContextSections,
    assembleContextFor: (agent, signal) => ({ agent, signal }),
    eventsNewestFirst: session => [...session.snapshotEvents()].reverse(),
    isOwned: message => message.source.kind === 'runtime-context',
    textOf: message => message.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    isReplacementSurfaceEvent: sessionModule.isReplacementSurfaceEvent,
    SOURCE: 'runtime-context', CLEARED: 'Current runtime context: none. Earlier runtime-context snapshots no longer apply.',
  };
  const preStep = vm.runInNewContext('({' + method + '}).preStep', scope);
  const Runtime = vm.runInNewContext(loopSource.slice(runtimeStart, runtimeEnd) + '\nRuntimeContextProjection', scope);
  const session = new Session('memo-runtime-offline');
  session.append('turn/start', { turn: 1 });
  session.append('step/start', { turn: 1, step: 1 });
  session.append('system/message', { turn: 1, step: 1, message: llm.createSystemMessage('system stable') }, { surfaceOp: 'append' });
  session.append('step/end', { turn: 1, step: 1, reason: { kind: 'completed' } });
  const hooks = [];
  const tracker = module.createUserMessageTracker();
  const append = session.append.bind(session);
  session.append = (...args) => { const e = append(...args); tracker.observe(session, e); for (const fn of hooks) fn(session, e); return e; };
  let lookups = 0, time = 'TIME_A', pending = [];
  let recallText = '--- (来源: 测试, 相关性: 99%(混合))\n[路径: file:///test/demo.md]\n# TEST_MARKDOWN\n正文无需时间戳\nTag: test';
  const engine = module.createRecallEngine({ tracker, config: { timeoutMs: 50 }, callRecall: async () => { lookups++; return recallText; } });
  const agent = {
    session, phase: { kind: 'running', abort: new AbortController() },
    inbox: { claim: () => pending.splice(0) },
    loopCtx: { systemPrompt: { assemble: async () => ({ sections: [], contexts: [{ name: 'time', text: time }], variables: {}, tools: [] }) } },
  };
  agent.runtimeContext = new Runtime({ on: (_name, fn) => hooks.push(fn) }, session);
  agent.dispatch = { waterfall: (_name, payload, next) => engine.listener({ ...payload, agent }, next) };
  function validate() {
    const events = session.snapshotEvents();
    for (const event of events) codec.encodeEvent(event);
    restore({ header: { ...session.header, delegationDepth: 0 }, inheritedEventCount: 0, events }, KNOWN_SESSION_EVENT_TYPES);
  }
  let stepNumber = 1;
  async function step() {
    const position = { turn: 1, step: ++stepNumber };
    const d = await preStep.call(agent, 'next-step', position);
    validate(); // The retire event must be valid BEFORE the next step starts.
    session.append('step/start', position);
    for (const m of d.messages) session.append('user/message', m, { surfaceOp: 'append' });
    session.append('step/end', { ...position, reason: { kind: 'completed' } });
    validate(); return d;
  }
  pending.push(llm.createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }));
  await step(); const memo = session.deriveMessages().find(m => m.source.kind === 'memo-recall'); assert(memo);
  assert.match(JSON.stringify(memo), /TEST_MARKDOWN/);
  assert.match(JSON.stringify(memo), /正文无需时间戳/);
  assert.equal((await step()).messages.length, 0);
  time = 'TIME_B'; await step(); assert.equal(lookups, 1);
  assert.equal(session.deriveMessages().filter(m => m.source.kind === 'memo-recall').length, 1);
  assert.equal(session.deriveMessages().find(m => m.source.kind === 'memo-recall').id, memo.id);
  pending.push(llm.createUserMessage({ content: [{ type: 'text', text: 'next' }], source: { kind: 'user' } }));
  await step(); assert.equal(lookups, 2); assert(!session.deriveMessages().some(m => m.id === memo.id));
  assert.equal(session.deriveMessages().filter(m => m.source.kind === 'memo-recall').length, 1);
  recallText = '--- (来源: 测试, 相关性: 99%(混合))\n[路径: file:///test/empty.md]\n[2026-10-08] - test\nTag: empty';
  pending.push(llm.createUserMessage({ content: [{ type: 'text', text: 'empty recall' }], source: { kind: 'user' } }));
  await step(); assert.equal(lookups, 3);
  assert.equal(session.deriveMessages().filter(m => m.source.kind === 'memo-recall').length, 0);
  await step(); assert.equal(lookups, 3);
  // --- 通道 B（脉冲透镜）：真 preStep + 真 Session + 官方 codec 校验 ---
  // 前提：宿主把 tool/call 作为纯日志事件追加（不带 surfaceOp），surface 只承载消息层——
  // 脉冲通道靠日志尾窗配对 call↔result，这里正是被真实 Session 证伪过一次的地方。
  recallText = '--- (来源: 溟月的知识, 相关性: 82%(混合))\n[路径: file:///溟月的知识/2026-10-13-01_54_35-直觉卡·报错行是案发现场不是凶手.txt]\n[2026-10-13] - 溟月\n[01:54] 别在报错行打补丁，顺着调用栈逆流追三层。\nTag: 报错定位, TypeError, EditCode, if (';
  // 播一个完整的工具步：消息必须落在打开的步骤里（官方生命周期校验只认这个形状），
  // 关步后再由下一拍 preStep 读日志尾巴——与真实 turn 循环同序。
  const pulsePosition = { turn: 1, step: ++stepNumber };
  session.append('step/start', pulsePosition);
  const pulseArgs = '{"path":"lib/a.js"}';
  session.append('assistant/message', { ...pulsePosition, message: llm.createAssistantMessage({ content: [{ type: 'text', text: '这段的边界处理改一下' }, { type: 'tool-call', id: 'pulse-call', name: 'EditCode', arguments: pulseArgs }], source: { provider: 'offline', model: 'offline' } }) }, { surfaceOp: 'append' });
  const pulseCall = session.append('tool/call', { ...pulsePosition, callId: 'pulse-call', name: 'EditCode', arguments: pulseArgs });
  session.append('tool/result', { ...pulsePosition, message: llm.createToolResultMessage({ callId: 'pulse-call', content: [{ type: 'text', text: '+  if (err) return null' }], isError: false }) }, { surfaceOp: 'append', sourceEventSeqs: [pulseCall.seq] });
  session.append('step/end', { ...pulsePosition, reason: { kind: 'completed' } });
  validate();
  assert.ok(!session.surface.nodes.map(seq => session.log[seq].type).includes('tool/call'), '前提：call 不在 surface 上');
  const eventsBefore = session.snapshotEvents().map(e => JSON.stringify(e));
  const lookupsBefore = lookups;
  const issueDecision = await step(); // 发射拍：只把查询发出去，不等待（异步取用，关键路径零时延）
  assert.ok(!issueDecision.messages.some(m => m.source && m.source.kind === 'memo-recall-pulse'), '发射拍不得注入脉冲');
  await new Promise(resolve => setTimeout(resolve, 0)); // 让在途查询结算
  const pulseDecision = await step(); // 取用拍：下一拍 preStep 取用落定结果（step 内部对全部事件跑官方 codec/session-format 校验）
  const pulse = pulseDecision.messages.find(m => m.source && m.source.kind === 'memo-recall-pulse');
  assert.ok(pulse, '通道 B 应在下一拍注入一枚脉冲');
  assert.equal(pulseDecision.messages[pulseDecision.messages.length - 1].source.kind, 'memo-recall-pulse', '脉冲必须在消息最尾部');
  assert.ok(pulse.content[0].text.startsWith('【直觉闪现·非事实·勿引用·勿保留】'), pulse.content[0].text);
  assert.match(JSON.stringify(pulse), /直觉卡·报错行是案发现场不是凶手/);
  assert.equal(lookups, lookupsBefore + 1, '脉冲查询恰好一次（通道 A 走缓存）');
  const eventsAfter = session.snapshotEvents().map(e => JSON.stringify(e));
  assert.deepEqual(eventsAfter.slice(0, eventsBefore.length), eventsBefore, '既有历史事件零改写（前缀缓存零分叉）');
  assert.ok(eventsAfter.length > eventsBefore.length, '只允许追加');
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } }); validate();
  await ctx.fiber.dispose();
  console.log(JSON.stringify({ passed: true, pluginVersion: JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'))).version, installedKernel: JSON.parse(fs.readFileSync(base + 'dsh-agent-loop/package.json')).version, checks: ['desktop-profile module import', 'host hook registration', 'installed preStep method', 'installed RuntimeContextProjection', 'installed Session surface', 'first user admission', 'Markdown body injection', 'stable tool steps', 'unrelated dynamic contexts', 'boundary replacement', 'empty body clearing and caching', 'pulse lens injection after tool step', 'append-only history (prefix intact)'], modelRequests: 0, lightMemoRequests: 0 }, null, 2));
  process.exit(0);
})().catch(error => { console.error(error.stack); process.exit(1); });
