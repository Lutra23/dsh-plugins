import fs from 'node:fs/promises'
import path from 'node:path'
import {randomBytes} from 'node:crypto'
import {fileURLToPath} from 'node:url'

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const PREFIX='/api/project-forge/view/'
const mounted=new WeakSet()

// DSH 0.2.0-rc.2 Connection.fetch routes are behind the official Host/Origin
// fence and signed browser authentication, including dsh-app desktop forwarding.
export function installDshPanel(ctx,getClient,taskBridge){
  const owner=ctx.root||ctx
  if(mounted.has(owner))return
  mounted.add(owner)
  ctx.effect(()=>()=>mounted.delete(owner),'forge: panel ownership')
  return ctx.inject(['connection'],scoped=>{
    const connection=scoped.get('connection')
    if(!connection?.fetch?.register)return
    const csrf=randomBytes(24).toString('hex')
    const headers={'cache-control':'no-store','x-content-type-options':'nosniff','referrer-policy':'no-referrer'}
    const json=(value,status=200)=>Response.json(value,{status,headers})
    const route=(name,methods,fetch,requestBody='buffered')=>connection.fetch.register({path:PREFIX+name,methods,requestBody,fetch})
    const disposers=[]
    try{
      disposers.push(route('page', ['GET'],async()=>{
        const html=(await fs.readFile(path.join(ROOT,'ui/index.html'),'utf8')).replace('<body>','<body class="embedded">')
        return new Response(html,{headers:{...headers,'content-type':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"}})
      }))
      for(const name of ['panel.js','panel.css'])disposers.push(route(name,['GET'],async()=>new Response(await fs.readFile(path.join(ROOT,'ui',name)),{headers:{...headers,'content-type':name.endsWith('.js')?'application/javascript; charset=utf-8':'text/css; charset=utf-8'}})))
      disposers.push(route('session',['GET'],async()=>json({csrf,embedded:true})))
      disposers.push(route('entry',['GET'],async()=>{try{return json({...await (await getClient()).request({method:'panel.entry'}),panelId:'project-forge',version:'0.4.0-local.1'})}catch(error){return json({error:error.message},503)}}))
      disposers.push(route('api',['POST'],async request=>{
        if(request.headers.get('x-forge-csrf')!==csrf)return json({ok:false,error:'请重新打开施工图页面'},403)
        if(!request.headers.get('content-type')?.startsWith('application/json'))return json({ok:false,error:'JSON required'},415)
        try{
          // Streamed route enforces its own bound before buffering a request.
          const reader=request.body?.getReader(),chunks=[];let size=0
          if(!reader)throw new Error('请求为空')
          for(;;){const {value,done}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024){await reader.cancel();return json({ok:false,error:'请求过大'},413)}chunks.push(Buffer.from(value))}
          const msg=JSON.parse(Buffer.concat(chunks).toString('utf8'))
          if(!msg||Array.isArray(msg)||!['panel','operations','cancel','status','inspect','revision'].includes(msg.method))return json({ok:false,error:'此窗口不开放该动作'},403)
          delete msg.workspaces;delete msg.fault;delete msg.args
          const result=taskBridge&&msg.method==='panel'?await taskBridge.panel(msg):await (await getClient()).request(msg)
          return json({ok:true,result})
        }catch(error){return json({ok:false,error:error.message,code:error.code,receipt:error.receipt},['REVISION_CONFLICT','FILE_CONFLICT'].includes(error.code)?409:400)}
      },'streaming'))
    }catch(error){for(const dispose of disposers.reverse())dispose();throw error}
    return ()=>{for(const dispose of disposers.reverse())dispose()}
  })
}
