'use strict';
// CC07: the `context.*` panel actions — host-process only.
//
// The embedded panel's `panel` method reaches THIS module through
// task-bridge (its `live` map holds the active agents and their sessions).
// The daemon never participates: it holds no Session and must not (§3), which
// is also why runtime-api's copy of `context.*` answers with a clear
// degradation instead of proxying.
//
// The plugin package is resolved lazily: `@dsh-external/dsh-forge-context`
// is a separate install (CC08 wires it into the profile). Until then every
// action degrades with FORGE_CONTEXT_UNAVAILABLE — the panel shows the
// reason, nothing half-loads. A failed resolution is NOT cached, so once the
// package appears the next panel call finds it without a code change.
//
// A25's identity gate: the session must be in the live map. A request naming
// a session this host does not hold is refused with SESSION_NOT_LIVE —
// cross-session data never leaks just because an id was typed in.

let servicePromise = null;

function loadPluginModule() {
  if (servicePromise === null) {
    servicePromise = import('@dsh-external/dsh-forge-context');
    // A failed load is retried on the next action (install-then-use, §14).
    servicePromise.catch(() => { servicePromise = null; });
  }
  return servicePromise;
}

function loadService() {
  return loadPluginModule().then(mod => {
    if (!mod || typeof mod.getSharedPanelService !== 'function') {
      throw new Error('包未导出 getSharedPanelService');
    }
    return mod.getSharedPanelService();
  });
}

function fail(message, code) {
  throw Object.assign(new Error(message), { code });
}

async function handleContextPanel(live, msg) {
  const p = msg.params || {};
  let service;
  try {
    service = await loadService();
  } catch (error) {
    fail('上下文插件未加载：' + (error && error.message ? error.message : error), 'FORGE_CONTEXT_UNAVAILABLE');
  }
  // A25: identity comes from the live map, never from trusting the id.
  const agent = live.get(p.sessionId);
  if (!agent || !agent.session) {
    fail('该会话不在本次 DSH 运行中；上下文数据只属于持有它的宿主进程，断线或重启后请重新打开', 'SESSION_NOT_LIVE');
  }
  const handle = service.handle(agent.session);
  switch (msg.action) {
    case 'context.status': await (await import('./context-runtime.js')).measureContext(agent.ctx||{},agent);return {...handle.status(),engine:require('./context-engine.cjs').resolveContextEngine(agent.ctx,agent).info};
    case 'context.candidates': return handle.candidates(p.limit);
    case 'context.blocks': return handle.blocks();
    case 'context.search': {
      if (!String(p.query || '').trim()) fail('搜索词不能为空', 'INVALID_REQUEST');
      return handle.search(String(p.query), p.limit);
    }
    case 'context.read': {
      if (!p.blockId) fail('缺少 blockId', 'INVALID_REQUEST');
      return handle.read(String(p.blockId), p.cursor ?? null, p.maxTokens);
    }
    case 'context.readFull': {
      if (!p.blockId) fail('缺少 blockId', 'INVALID_REQUEST');
      // Explicit whole-block text for a human (§11 看原文)；仍无模型路径。
      return handle.readBlockFull(String(p.blockId));
    }
    case 'context.pin': {
      if (!Number.isInteger(p.seq)) fail('缺少要固定的 seq', 'INVALID_REQUEST');
      const result=handle.pin(p.seq, String(p.purpose || '面板固定'), p.expectedRevision);
      return {...result,durability:await agent.ctx?.get('sessions')?.flush(agent.session)?'confirmed':'unconfirmed'};
    }
    case 'context.unpin': {const result=handle.unpin(Number(p.seq), p.expectedRevision);return {...result,durability:await agent.ctx?.get('sessions')?.flush(agent.session)?'confirmed':'unconfirmed'};}
    case 'context.request-summary': {
      if(!(await import('./context-runtime.js')).isContextAgent(agent))fail('当前预设尚未装配上下文整理服务，请检查插件接入', 'CONTEXT_PRESET_REQUIRED');
      // 用户明确发起的整理请求：先入队，由宿主适配在安全点送达（§8/§11）。
      const already=service.pendingSummaries(String(p.sessionId)).length>0;
      const request=service.requestSummary(String(p.sessionId));
      if(!already&&agent.status==='idle'&&typeof agent.followup==='function') {
        const {summaryRequestMessage}=await import('./context-runtime.js');
        agent.followup(summaryRequestMessage(request));
      }
      return request;
    }
    case 'context.cancel-summary': {
      const cancelled=service.cancelSummary(String(p.requestId || ''), agent.session.id);
      const tidy=service.automaticOf(agent.session.id);
      if(cancelled&&tidy.active()&&tidy.view().manual)tidy.pause('用户取消了待送达的整理请求。');
      return { cancelled };
    }
    case 'context.pause-tidy': {
      for(const r of service.pendingSummaries(agent.session.id))service.cancelSummary(r.requestId,agent.session.id);
      const tidy=service.automaticOf(agent.session.id);tidy.pause('用户暂停整理；从面板请求整理可重新开始。');
      return { automatic: tidy.view() };
    }
    case 'context.pending-summaries': {
      return { requests: service.pendingSummaries(String(p.sessionId)) };
    }
    default: fail('未知上下文面板动作：' + msg.action, 'INVALID_REQUEST');
  }
}

function isContextAction(action) {
  return typeof action === 'string' && action.startsWith('context.');
}

module.exports = { handleContextPanel, isContextAction, loadService, loadPluginModule };
