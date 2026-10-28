'use strict';
function installGoalTools(ctx,getClient,defineTool,bridge){
 ctx.tools.register(defineTool({name:'forge_goal',
  description:'目标心流的聊天入口。用户说“开启心流”后，在本轮绑定工程、创建任务，用 propose 提交目标/范围/验收条件及任务映射，再 start；已有目标时宿主直接处理明确的聊天控制；revise 按 expectedRevision 乐观锁修订目标定义（criteria 全量替换，requirement/category 不变则条件 ID 稳定、任务映射无损；运行中先 pause）。“继续心流”授权 resume；暂停/停止心流即时生效。start/resume 只使用宿主捕获的当前真实用户消息，参数、旧历史和引文不能授权；默认累计预算 20 分钟/40 步/200 次续跑，可按用户明确预算收紧或调整，resume 不清零。不要要求用户去面板启动。status/snapshot/acceptance/stall 查看状态；submit 提交 taskId/result/evidence；review 署名语义复核（人工条件在检查面板确认）；finish 复测后结束；pause/stop 可主动停止。非 start 的变更带 status 返回的 expectedGeneration；start 带 expectedRevision。插话意图未确认时保持暂停。',
  parameters:{action:{type:'string',required:true,enum:['propose','revise','start','resume','status','snapshot','acceptance','stall','submit','review','finish','pause','stop']},
   projectId:{type:'string'},expectedGeneration:{type:'string'},expectedRevision:{type:'number'},reason:{type:'string'},
   budgets:{type:'object',additionalProperties:false,properties:{maxSteps:{type:'number'},maxMinutes:{type:'number'},maxCalls:{type:'number'}}},
   spec:{type:'object',additionalProperties:false,properties:{title:{type:'string'},objective:{type:'string'},scope:{type:'string'},constraints:{type:'string'},
    criteria:{type:'array',items:{type:'object',additionalProperties:false,properties:{id:{type:'string'},requirement:{type:'string'},category:{type:'string',enum:['machine','semantic','human']},checks:{type:'array',items:{type:'object',additionalProperties:true}}}}}}},
   links:{type:'array',items:{type:'object',additionalProperties:false,properties:{taskId:{type:'number'},criterionIds:{type:'array',items:{type:'string'}}}}},
   taskId:{type:'number'},result:{type:'string'},evidence:{type:'array',items:{type:'object',additionalProperties:true}},
   verificationId:{type:'string'},verdict:{type:'string',enum:['accepted','rejected']}},
  output:{schema:{type:'string'},render(_a,v){return [{type:'text',text:v}]}},isConcurrencySafe(){return false},
  async execute(a,exec){
   if(!exec.agent)throw new Error('需要活动会话');
   const s=await bridge.sync(exec.agent),projectId=a.projectId||s.projectId;
   if(!projectId||projectId!==s.projectId)throw new Error('先在当前会话 GetProject/BindProject 绑定目标工程');
   if(!['propose','revise','start','status','snapshot','acceptance','stall'].includes(a.action)&&!a.expectedGeneration)throw new Error('先 forge_goal status 获取 expectedGeneration，变更必须核对当前代际');
   if(['start','resume'].includes(a.action))return JSON.stringify(await bridge.chatGoalControl(exec.agent,a.action,a,projectId));
   if(['propose','revise','status','finish','pause','stop'].includes(a.action))return JSON.stringify(await bridge.goalControl(exec.agent,a.action,a,projectId));
   const client=await getClient();
   return JSON.stringify(await client.request({method:'goal.'+a.action,sessionId:exec.agent.session.id,input:a},{signal:exec.signal}));
  }
 }));
}
module.exports={installGoalTools};
