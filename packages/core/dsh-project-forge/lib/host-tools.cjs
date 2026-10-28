'use strict';
// CC08: the model-side tools — registered HOST-SIDE on purpose.
//
//   * The session identity comes from `exec.agent.session` (the official
//     channel todo_checkpoint uses): the model never passes a session path
//     (§7.1 "sessionId、工作区、调用者身份由宿主取得").
//   * The plugin package is the same dynamic import context-panel uses, so
//     the panel's pins and the tool's compact see ONE shared service.
//   * forge_blueprint reads its document through the engine client that
//     already lives here (documents.read); the pure parsing stays in the
//     plugin package.
//
// compact is an explicit reviewed action. The Forge engine disables the
// unguarded stock selector; runtime hooks provide pressure reminders.

const { loadPluginModule } = require('./context-panel.cjs');
const { resolveContextEngine } = require('./context-engine.cjs');

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

// 结构化错误 -> 模型可见文本。
// 动机(2026-10-18 实证):ForgeContextError 的 code/nextAction/detail 是类字段(可枚举),
// 而 message 是 Error 的内建不可枚举属性;宿主只取 message 拼 "Error: <message>",
// 于是 nextAction 设计了却从未抵达模型。这里把路标拼进文本。
function describeThrown(error) {
  const message = String((error && error.message) || error);
  const code = error && typeof error.code === 'string' ? error.code : null;
  const next = error && typeof error.nextAction === 'string' ? error.nextAction : null;
  let line = code ? `Error [${code}]: ${message}` : `Error: ${message}`;
  if (next) line += ` · next=${next}`;
  const detail = error && error.detail;
  if (detail && typeof detail === 'object') {
    const keys = Object.keys(detail);
    if (keys.length > 0) {
      let brief;
      try { brief = JSON.stringify(detail); } catch { brief = ''; }
      if (brief && brief !== '{}') line += ` · detail=${brief.length > 400 ? brief.slice(0, 400) + '…' : brief}`;
    }
  }
  return line;
}

function installHostTools(ctx, engineClient, defineTool, taskBridge) {
  const owner = ctx.root || ctx;
  if (owner.__forgeContextTools) return;
  owner.__forgeContextTools = true;
  ctx.effect(() => () => { delete owner.__forgeContextTools; }, 'forge-context host tools');

  const json = value => JSON.stringify(value, null, 2);
  const summarySchema = {
        type: 'object', additionalProperties: false,
        properties: {
          summary: { type: 'string' },
          requirements: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            origin: { type: 'string', enum: ['user', 'project', 'tool-fact', 'agent-inference', 'retrieved'] },
            text: { type: 'string' }, sourceRefs: { type: 'array', items: { type: 'number' } },
          } } },
          taskRefs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            taskId: { type: 'number' }, status: { type: 'string', enum: ['pending', 'doing', 'done', 'blocked', 'paused', 'cancelled', 'skipped'] } } } },
          decisions: { type: 'array', items: { type: 'string' } },
          evidenceRefs: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            path: { type: 'string' }, contentHash: { type: 'string' }, taskId: { type: 'number' },
            validity: { type: 'string', enum: ['current', 'expired', 'unhashed', 'unreadable', 'declared'] } } } },
          openIssues: { type: 'array', items: { type: 'string' } },
          supersededOpenIssues: { type: 'array', items: { type: 'string' } },
          nextAction: { type: 'string' },
          droppedUserSeqs: { type: 'array', items: { type: 'number' } },
          droppedReasons: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            seq: { type: 'number' }, reason: { type: 'string' } } } },
          supersededRequirements: { type: 'array', items: { type: 'number' } },
          files: { type: 'array', items: { type: 'string' } },
          pinned: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
            seq: { type: 'number' }, reason: { type: 'string' }, text: { type: 'string' } } } },
        },
      };

  const forgeContextTool = {
    name: 'forge_context',
    description: [
      '当前会话的上下文整理面：看压力/保护/候选，提交摘要压缩，检索与分页读原文，固定内容。日常可用，无需工程绑定或心流。',
      '',
      '动作：status（压力/焦点/保护计数）；candidates（候选，内嵌真实用户消息 userMessages 与 substantiveUserSeqs）；compact / compact_batch（批量优先，1–8 项，sourceSeqs/snapshotId 可省）。',
      'preview（干跑，同一套候选与哈希校验，不写历史）；receipt（完整账本）；blocks / user_messages / search / read（分页读原文）；evidence（只读核验文件）；pin / unpin。',
      '',
      '不写会踩的三处：',
      '1. 身份有两套——candidates 给 span:，status 给 snap:，混用会被拒；显式传 snapshotId 时用 candidates 的 span: 身份。',
      '2. requirements[].sourceRefs 必须填所选 sourceSeqs 的精确成员，不能按首尾区间猜编号，也不能填 step/start、任务 ID 或工具调用 ID；无可靠定位就整个省略。',
      '3. evidenceRefs 的 current 只证明核验当时字节一致，不证明工程验收通过。',
      '',
      '部分成功不回滚：看 remainingOperationIds / failures 再决定。重试同一 operationId 必须同序同参。',
      '错误回执带 next= 路标，照它走，不要重复灌水。',
    ].join('\n'),    parameters: {
      action: { type: 'string', enum: ['status', 'candidates', 'compact', 'compact_batch', 'receipt', 'preview', 'blocks', 'user_messages', 'search', 'read', 'evidence', 'pin', 'unpin'], required: true },
      paths: { type: 'array', items: {type:'string'} },
      candidateId: { type: 'string' }, snapshotId: { type: 'string' },
      sourceSeqs: { type: 'array', items: { type: 'number' } },
      operationId: { type: 'string' },
      summary: summarySchema,
      autoDraft: { type: 'boolean' },
      items: {type: 'array', items:{type:'object', additionalProperties:false, properties:{candidateId:{type:'string',required:true},snapshotId:{type:'string'},sourceSeqs:{type:'array',items:{type:'number'}},autoDraft:{type:'boolean'},summary:summarySchema}}},
      query: { type: 'string' }, blockId: { type: 'string' },
      offset: { type: 'number' }, scope: { type: 'string', enum: ['all','surface','candidate'] },
      order: { type: 'string', enum: ['newest','oldest'] }, withText: { type: 'boolean' },
      cursor: { type: 'object', additionalProperties: true }, limit: { type: 'number' }, maxTokens: { type: 'number' },
      seq: { type: 'number' }, purpose: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }]; } },
    isConcurrencySafe() { return false; },
    async executeInner(a, exec) {
      if (!exec.agent) fail('需要会话上下文', 'SESSION_NOT_LIVE');
      await taskBridge?.contextRuntime?.guardTool({...exec,name:'forge_context',arguments:a});
      const session = exec.agent.session;
      let syncError;
      if (['status','candidates','compact','compact_batch'].includes(a.action)&&(!taskBridge?.needsSync||taskBridge.needsSync(exec.agent))) {
        try {await taskBridge?.sync(exec.agent)} catch(error) {syncError=error.message||String(error)}
      }
      if(a.action==='status')await (await import('./context-runtime.js')).measureContext(ctx,exec.agent,exec.signal);
      const mod = await loadPluginModule();
      const service = mod.getSharedPanelService();
      const handle = service.handle(session);
      switch (a.action) {
        case 'status': return json({...handle.status(),engine:resolveContextEngine(ctx,exec.agent).info,...(syncError?{taskSync:{state:'unavailable',reason:syncError}}:{})});
        case 'candidates': {const result=handle.candidates(a.limit);service.automaticOf(session.id).candidates(result.candidates.length);return json({...result,...(syncError?{taskSync:{state:'unavailable',reason:syncError}}:{})});}
        case 'receipt': return json(mod.readCompressionReceipt(session,String(a.operationId||'')));
        case 'evidence': return json({evidenceRefs:mod.fingerprintEvidence(a.paths,session.header?.cwd,exec.signal),writes:0,
          note:'只核对当前文件字节；可将 path/contentHash/validity 放入摘要 evidenceRefs，提交时宿主会再次核验。'});
        case 'preview': {
          // N1: resolve through the same issued-candidate backfill as compact
          // (resolveCompactParams), so candidateId alone is a valid submission
          // and the span:/snap: identity confusion cannot dead-end a dry run.
          // items[] batch dry-run (C3): every verdict in one round trip, zero writes.
          const {engine}=resolveContextEngine(ctx,exec.agent);
          const deps={engine,sessions:exec.agent.ctx?.get('sessions')??ctx.get('sessions'),
            evidenceRoot:session.header?.cwd,pinnedSeqs:service.pinnedSeqsOf(session.id)};
          if(Array.isArray(a.items)&&a.items.length){
            if(a.items.length>8)fail('preview 批量干跑至多 8 个 items','INVALID_REQUEST');
            const results=[];
            for(let i=0;i<a.items.length;i++){
              const item=a.items[i]||{};
              if(!item.candidateId){results.push({index:i,ok:false,code:'INVALID_REQUEST',message:'items[].candidateId 必填'});continue;}
              try{
                const params=mod.resolveCompactParams(session,{...item,operationId:`preview-${i}`});
                results.push({index:i,candidateId:item.candidateId,ok:true,preview:await mod.previewCompaction(deps,session,params,exec.signal)});
              }catch(error){
                results.push({index:i,candidateId:item.candidateId,ok:false,code:String(error.code||'PREVIEW_FAILED'),message:String(error.message||error)});
              }
            }
            return json({mode:'preview-batch',writes:0,items:results,
              ok:results.filter(r=>r.ok).length,failed:results.filter(r=>!r.ok).length,
              note:'批量干跑：逐项只读预览，全部结论一次返回，不写日志不调模型。ok 项按原顺序交给 compact_batch 提交（提交时重新校验）。'});
          }
          if(!a.candidateId)fail('preview 需要 candidateId（或 1–8 个 items 批量干跑）','INVALID_REQUEST');
          const params=mod.resolveCompactParams(session,{candidateId:a.candidateId,snapshotId:a.snapshotId,
            sourceSeqs:a.sourceSeqs,summary:a.summary,autoDraft:a.autoDraft===true,operationId:a.operationId||`preview-${Date.now().toString(36)}`});
          return json(await mod.previewCompaction(deps,session,params,exec.signal));
        }
        case 'compact': case 'compact_batch': {
          const {measureContext}=await import('./context-runtime.js');
          const before=(await measureContext(ctx,exec.agent,exec.signal)).reading;
          const tidy=service.automaticOf(session.id),generation=tidy.view().generation,maintaining=tidy.active();
          await taskBridge?.contextRuntime?.guardTool({...exec,name:'forge_context',arguments:a});
          // Resolve through this agent's preset scope, never a process-global owner.
          const {engine,info}=resolveContextEngine(ctx,exec.agent);
          if (!info.configured) fail(info.reason, 'ENGINE_UNAVAILABLE');
          const normalize=(item,id)=>mod.resolveCompactParams(session,{...item,operationId:id});
          const batch=a.action==='compact_batch';
          if(batch&&(!/^[a-zA-Z0-9_-]{1,80}$/.test(a.operationId||'')||!Array.isArray(a.items)||!a.items.length||a.items.length>8))
            fail('compact_batch 需要稳定 operationId（1–80 字符）和 1–8 个 items','INVALID_REQUEST');
          const requests=batch?a.items.map((item,i)=>normalize(item,`${a.operationId}-${i}`)):[normalize(a,a.operationId||`op-${Date.now().toString(36)}`)];
          const deps={engine,sessions:exec.agent.ctx?.get('sessions')??ctx.get('sessions'),noGain:service.noGainOf(session.id),
            pinnedSeqsNow:()=>service.pinnedSeqsOf(session.id),evidenceRoot:session.header?.cwd};
          let outcome,previous=before,after=before;
          // C6: a refused attempt that wrote nothing must not spend the
          // maintenance window. Time the attempt here; the refund itself is
          // AutoTidy's call so the policy stays in one place.
          let attemptStartedAt=Date.now();
          // Refund only when the attempt provably wrote nothing. A batch that
          // committed some items did real work and keeps its clock; a batch
          // rejected in preflight, or a single compact that threw before the
          // transaction, did not.
          const refundZeroWrite=()=>{
            if(!maintaining)return 0;
            const refunded=tidy.refundZeroWrite(attemptStartedAt,Date.now());
            attemptStartedAt=Date.now();
            return refunded;
          };
          const remeasure=async result=>{
            after=(await measureContext(ctx,exec.agent,exec.signal,[],{deferAutomatic:true})).reading;
            const comparable=previous.state==='known'&&after.state==='known'&&previous.value.routeKey===after.value.routeKey;
            if(maintaining&&result.receipt.afterSeq>result.receipt.beforeSeq){
              tidy.committed(result.receipt,comparable?previous.value.requestTokens:null,comparable?after.value.requestTokens:null,generation);
              tidy.observe(after);
            }
            previous=after;
            // 「达标即停」：remeasure 的返回值就是 compactBatchWithSummaries 的
            // afterCommit 信号。此前这里只看 tidy 是否还活着，于是 stoppedReason
            // 里那句「宿主复测已达目标」从来没有判据支撑——批次必然把候选压完。
            // 达标线取 tidy 的 targetHigh（及格线），不是 targetLow：及格线到了就该
            // 让位给真实工作，继续下压属于「软引导」而非停止条件。
            const reachedTarget=after.state==='known'&&after.value.requestTokens<=mod.workBudget(after.value).targetHigh;
            const stillWanted=!maintaining||(tidy.active()&&tidy.view().generation===generation);
            const proceed=stillWanted&&!reachedTarget;
            if(maintaining&&proceed)tidy.beginCompact();
            return proceed;
          };
          if(maintaining)tidy.beginCompact();
          try {
            const signal=maintaining?AbortSignal.any([tidy.signal(),...(exec.signal?[exec.signal]:[])]):exec.signal;
            if(batch){
              outcome=await mod.compactBatchWithSummaries(deps,session,requests,signal,remeasure);
              if(outcome.failure&&maintaining){
                const refunded=outcome.outcomes.length===0?refundZeroWrite():0;
                tidy.failed(outcome.failure.message,{code:outcome.failure.code,tool:'forge_context',action:'compact_batch',...(refunded>0?{refundedMs:refunded}:{})});
              }
            }else {outcome=await mod.compactWithSummary(deps,session,requests[0],signal);await remeasure(outcome);}
          }catch(error){
            if(maintaining&&tidy.view().generation===generation){
              const refunded=refundZeroWrite();
              tidy.failed(String(error.message||error.code),{code:String(error.code||'COMPACT_FAILED'),tool:'forge_context',action:a.action,...(refunded>0?{refundedMs:refunded}:{})});
            }
            throw error;
          }
          finally{if(maintaining)tidy.endCompact(generation);}
          // Final measurement also covers an interrupted/partially committed batch.
          after=exec.signal?.aborted?mod.unavailable('批次已取消；保留已确认回执，未追加复测。'):(await measureContext(ctx,exec.agent,exec.signal,[],{deferAutomatic:true})).reading;
          const measured=before.state==='known'&&after.state==='known'&&Number.isFinite(before.value.requestTokens)&&Number.isFinite(after.value.requestTokens)&&before.value.requestTokens>=0&&after.value.requestTokens>=0&&before.value.routeKey===after.value.routeKey;
          const view=batch?{...outcome,outcomes:outcome.outcomes.map(mod.compactOutcomeView)}:mod.compactOutcomeView(outcome);
          if(batch?outcome.outcomes.length>0:outcome.receipt.status==='committed')mod.queueCompressionCleanup(session,exec.callId);
          // R3-5: the ONE number first. gain (text estimate) and
          // shadowedTokenCount (visible nodes) stay in the receipt as
          // supporting detail, but the caller should not have to adjudicate
          // three co-equal metrics every time.
          const reduction=measured?before.value.requestTokens-after.value.requestTokens:null;
          return json({primaryReduction:{value:reduction,metric:'host-request-delta',comparable:measured,
            note:measured?'本轮宿主请求实测净变化，汇报用这个数。':'本轮路由切换/复测失败，无可比实测；看 gain 估算并复测。'},
            ...view,automatic:tidy.view(),...(syncError?{taskSync:{state:'unavailable',reason:syncError}}:{}),hostMeasurement:{comparable:measured,
            metric:'host-request-delta',
            beforeTokens:before.state==='known'?before.value.requestTokens:null,afterTokens:after.state==='known'?after.value.requestTokens:null,
            reclaimedTokens:reduction,
            measuredRequestReductionTokens:reduction,
            sourceBefore:before.state==='known'?before.value.source:null,sourceAfter:after.state==='known'?after.value.source:null,
            note:'主指标为同路由下本次事务的宿主请求 beforeTokens - afterTokens；包含请求计量变化，不等于候选正文体积。gain.reclaimedTokens 仅为正文估算差值；shadowedTokenCount 是被替换的可见节点 heuristicTokens 之和，不扣摘要、不重复遍历祖先；三者不能相加。'}});
        }
        case 'search': {
          if (!String(a.query || '').trim()) fail('搜索词不能为空', 'INVALID_REQUEST');
          if(a.scope==='candidate'&&!a.candidateId)fail('scope=candidate 需要 candidateId','INVALID_REQUEST');
          return json(handle.search(String(a.query), a.limit, {offset:a.offset,...(a.scope==='surface'?{onSurface:true}:{}),...(a.scope==='candidate'?{seqs:mod.issuedCandidate(session,a.candidateId).sourceSeqs}:{})}));
        }
        case 'blocks': {
          const all=handle.blocks(),offset=Number.isSafeInteger(a.offset)&&a.offset>=0?a.offset:0,limit=Number.isSafeInteger(a.limit)?Math.max(1,Math.min(a.limit,100)):20;
          return json({...all,blocks:all.blocks.slice(offset,offset+limit),total:all.blocks.length,nextOffset:offset+limit<all.blocks.length?offset+limit:null});
        }
        case 'user_messages': {
          const options={...(a.order?{order:a.order}:{}),...(a.withText===false?{withText:false}:{}),
            ...(Number.isSafeInteger(a.offset)&&a.offset>=0?{offset:a.offset}:{}),
            ...(Number.isSafeInteger(a.limit)?{limit:a.limit}:{})};
          return json(handle.userMessages(options));
        }
        case 'read': {
          if(a.seq!==undefined&&(!Number.isSafeInteger(a.seq)||a.seq<0))fail('seq 必须是非负整数','INVALID_REQUEST');
          const blockId=a.blockId||(a.seq!==undefined?String(a.seq):undefined);
          if(!blockId&&!a.cursor)fail('read 需要 seq、blockId 或 cursor；可先用 blocks/search 查找','INVALID_REQUEST');
          if(a.blockId&&a.seq!==undefined&&Number(a.blockId.replace(/^b:/,''))!==a.seq)fail('seq 与 blockId 不一致','INVALID_REQUEST');
          if(a.offset!==undefined&&(!Number.isSafeInteger(a.offset)||a.offset<0||a.cursor))fail('offset 须为非负整数，且不能与 cursor 同传','INVALID_REQUEST');
          const cursor=a.cursor||(a.offset!==undefined?{blockSeq:Number(String(blockId).replace(/^b:/,'')),offset:a.offset}:undefined);
          if(blockId&&cursor&&Number(String(blockId).replace(/^b:/,''))!==cursor.blockSeq)fail('正文定位与 cursor 不一致','INVALID_REQUEST');
          return json(handle.read(blockId||'',cursor,a.maxTokens));
        }
        case 'pin': {
          if (!Number.isInteger(a.seq)) fail('缺少要固定的 seq', 'INVALID_REQUEST');
          const result=handle.pin(a.seq, String(a.purpose || '模型固定'));
          return json({...result,durability:await (exec.agent.ctx?.get('sessions')??ctx.get('sessions'))?.flush(session)?'confirmed':'unconfirmed'});
        }
        case 'unpin': {const result=handle.unpin(Number(a.seq));return json({...result,durability:await (exec.agent.ctx?.get('sessions')??ctx.get('sessions'))?.flush(session)?'confirmed':'unconfirmed'});}
        default: fail('未知动作', 'INVALID_REQUEST');
      }
    },
    // 统一出口:把 ForgeContextError 的结构化路标拼进模型可见文本(见 describeThrown)。
    // 宿主会解构 execute 单独调用,this 为 undefined —— 必须用闭包引用,不能用 this.executeInner。
    async execute(a, exec) {
      try {
        return await forgeContextTool.executeInner(a, exec);
      } catch (error) {
        if (error && typeof error === 'object' && (typeof error.code === 'string' || typeof error.nextAction === 'string')) {
          return describeThrown(error);
        }
        throw error;
      }
    },  };
  ctx.tools.register(defineTool(forgeContextTool));

  const forgeBlueprintTool = {
    name: 'forge_blueprint',
    description: [
      '施工图文档的分层读取与版本化精简。',
      '',
      '动作（action）：',
      '- outline：执行摘要、稳定工作包目录、sourceHash 与新鲜度。',
      '- read：按 workItemId（表行+提及）或 sectionId 读选节；view=full 显式分页读全文。',
      '- revise：expectedHash 乐观锁的结构化精简（守门：工作包 ID 不可增删、验收文本必须原样存活；越权变更走 project_forge replan）。',
      '- versions / restore：查看持久旧版本；回退需要 versionId、当前 expectedHash 和 reason，回退也保存现有正文。',
      '',
      'documentId 从 outline 结果或面板获得；文档正文由宿主从施工图登记表读取。',
    ].join('\n'),
    parameters: {
      action: { type: 'string', enum: ['outline', 'read', 'revise', 'versions', 'restore'], required: true },
      documentId: { type: 'string', required: true },
      workItemId: { type: 'string' }, sectionId: { type: 'string' },
      view: { type: 'string', enum: ['full'] },
      cursor: { type: 'object', additionalProperties: true }, budgetTokens: { type: 'number' },
      expectedHash: { type: 'string' }, revisedMarkdown: { type: 'string' }, reason: { type: 'string' },
      versionId: { type: 'string' },
    },
    output: { schema: { type: 'string' }, render(_a, v) { return [{ type: 'text', text: String(v) }]; } },
    isConcurrencySafe(a) { return a?.action !== 'revise' && a?.action !== 'restore'; },
    async executeInner(a) {
      if (!a.documentId) fail('缺少 documentId', 'INVALID_REQUEST');
      const mod = await loadPluginModule();
      const client = await engineClient();
      const doc = await client.request({ method: 'panel', action: 'documents.read', params: { id: a.documentId } });
      if (!doc || doc.missing) fail('施工图不存在或文件已移除', 'INVALID_REQUEST');
      switch (a.action) {
        case 'versions': return json(await client.request({method:'panel',action:'documents.versions',params:{id:a.documentId}}));
        case 'restore': {
          if (!a.versionId || !a.expectedHash || !a.reason) fail('restore 需要 versionId、expectedHash 和 reason','INVALID_REQUEST');
          const result=await client.request({method:'panel',action:'documents.restore',params:{id:a.documentId,versionId:a.versionId,expectedHash:a.expectedHash,reason:a.reason}});
          return json({saved:result.saved,sourceHash:mod.parseBlueprint(result.markdown).sourceHash});
        }
        case 'outline': return json(mod.blueprintOutline(a.documentId, doc.markdown));
        case 'read': return json(mod.readBlueprint(a.documentId, doc.markdown, {
          ...(a.workItemId ? { workItemId: a.workItemId } : {}),
          ...(a.sectionId ? { sectionId: a.sectionId } : {}),
          ...(a.view ? { view: a.view } : {}),
          ...(a.cursor ? { cursor: a.cursor } : {}),
          ...(a.budgetTokens ? { budgetTokens: a.budgetTokens } : {}),
        }));
        case 'revise': {
          if (!a.expectedHash || !a.revisedMarkdown || !a.reason) fail('revise 需要 expectedHash、revisedMarkdown 与 reason', 'INVALID_REQUEST');
          const vault = mod.createBlueprintVault();
          const plan = vault.plan(a.documentId, doc.markdown, a.expectedHash, a.revisedMarkdown, a.reason);
          const result = await client.request({ method: 'panel', action: 'documents.rewrite', params: { id: a.documentId, markdown:plan.newMarkdown, expectedHash:a.expectedHash, reason:a.reason } });
          const saved = result.saved;
          return json({ saved: { versionId: saved.versionId, hash: saved.hash, reason: saved.reason }, plan: { newSourceHash: plan.newSourceHash, refMapping: plan.refMapping } });
        }
        default: fail('未知动作', 'INVALID_REQUEST');
      }
    },
    // 统一出口:与 forge_context 同款。fail() 的 code 是可枚举类字段,
    // 而 Error.message 不可枚举、宿主只取 message —— 不加这层,code 永远到不了模型。
    async execute(a, exec) {
      try {
        return await forgeBlueprintTool.executeInner(a, exec);
      } catch (error) {
        if (error && typeof error === 'object' && typeof error.code === 'string') {
          return describeThrown(error);
        }
        throw error;
      }
    },
  };
  ctx.tools.register(defineTool(forgeBlueprintTool));
}

module.exports = { installHostTools };
