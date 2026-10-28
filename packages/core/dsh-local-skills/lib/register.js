import { defineTool } from '@deepseek-ai/dsh-tools'
import { measureContext } from './measure.js'
const numeric = ['totalTokens','baselineTokens','surfaceTokens','surfaceDeltaTokens','logRevision']
const optional = ['windowTokens','usedPercent','remainingTokens','overWindowTokens']
const strings = ['baselineKind','modelId','providerId','capacityStatus','windowSource']
export default {
  name:'local-ctx-meter', inject:['tools','tokenMeter'],
  apply(ctx) {
    ctx.tools.register(defineTool({
      name:'ctx_meter',
      description:'读取当前会话上下文占用和实际请求模型窗口，包含工具 schema。容量未知时只返回占用量，不猜测为 1M。windowTokens 可显式覆盖为正整数。余量未扣除未来输出预算；baselineKind 区分 usage 与估算。',
      parameters:{windowTokens:{type:'integer',description:'可选的显式模型窗口容量，必须为正整数。'}},
      output:{schema:{type:'object',additionalProperties:false,properties:{
        ...Object.fromEntries(numeric.map(k=>[k,{type:'number',required:true}])),
        ...Object.fromEntries(optional.map(k=>[k,{type:'number'}])),
        ...Object.fromEntries(strings.map(k=>[k,{type:'string',required:true}]))
      }},render:(_a,v)=>[{type:'text',text:`ctx ${v.totalTokens.toLocaleString()} tokens · ${v.providerId}/${v.modelId} · `+
        (v.capacityStatus==='known'?`${v.windowTokens.toLocaleString()} 窗口，已用 ${v.usedPercent}%，余量 ${v.remainingTokens.toLocaleString()}（未扣未来输出）`:'窗口未知')+
        ` · baseline=${v.baselineKind} · window=${v.windowSource}`}]},
      execute(args,exec){return Promise.resolve(measureContext(ctx.tokenMeter,exec.agent?.session,args))}
    }))
  }
}
