'use strict';
// Runtime capability, not header identity or a hard-coded list of mode names.
function resolveContextEngine(ctx,agent){
 const local=agent?.ctx?.get?.('agentPresets'),host=ctx?.get?.('agentPresets');
 const registry=local?.serviceFor?local:host;
 const preset=local?.composedPreset?.(agent?.ctx)??host?.composedPreset?.(agent?.ctx)
  ??agent?.ctx?.get?.('sessionProjections')?.stateOf?.(agent?.session,'agentPreset')??agent?.session?.header?.agentPreset??null;
 const engine=registry?.serviceFor?registry.serviceFor(agent,'compaction'):agent?.ctx?.get?.('compaction');
 const configured=typeof engine?.offerAuthoredSummary==='function';
 return {engine,info:{preset,configured,implementation:engine?.constructor?.name??null,
  reason:configured?'当前会话已装配受保护的压缩服务':`当前实际预设 ${preset??'未知'} 未装配受保护的压缩服务；请检查预设接入并重新加载宿主。`}};
}
module.exports={resolveContextEngine};
