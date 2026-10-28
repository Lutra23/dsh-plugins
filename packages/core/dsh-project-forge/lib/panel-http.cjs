'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function startHttp({api,root,key,onShutdown}){
 const sessions=new Map();let origin;
 const json=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  try{
   if(req.headers.host!==new URL(origin).host)return json(res,403,{error:'Invalid host'});
   const url=new URL(req.url,origin);
   if(url.pathname==='/'&&req.method==='GET'){
    if(!['none','same-origin'].includes(req.headers['sec-fetch-site'])||req.headers['sec-fetch-mode']!=='navigate')return json(res,403,{error:'请从本机施工图入口打开'});
    const id=crypto.randomBytes(32).toString('hex'),csrf=crypto.randomBytes(24).toString('hex');
    if(sessions.size>=30)sessions.delete(sessions.keys().next().value);
    sessions.set(id,{csrf,expires:Date.now()+24*3600000});
    res.setHeader('Set-Cookie',`pf_session=${id}; HttpOnly; SameSite=Strict; Path=/`);
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});return res.end(fs.readFileSync(path.join(root,'ui','index.html')));
   }
   const session=sessions.get(/(?:^|;\s*)pf_session=([a-f0-9]+)/.exec(req.headers.cookie||'')?.[1]);
   const valid=session&&session.expires>Date.now();
   if(url.pathname==='/session'&&req.method==='GET'){
    if(!valid||req.headers['sec-fetch-site']!=='same-origin')return json(res,403,{error:'会话已过期，请重新打开窗口'});
    return json(res,200,{csrf:session.csrf});
   }
   if(['/panel.js','/panel.css'].includes(url.pathname)&&req.method==='GET'){
    if(!valid)return json(res,403,{error:'Session required'});
    res.writeHead(200,{'Content-Type':url.pathname.endsWith('.js')?'application/javascript; charset=utf-8':'text/css; charset=utf-8','Cache-Control':'no-store'});
    return res.end(fs.readFileSync(path.join(root,'ui',url.pathname.slice(1))));
   }
   if(req.method!=='POST'||!['/rpc','/api'].includes(url.pathname))return json(res,404,{error:'Not found'});
   if(url.pathname==='/rpc'){
    if(req.headers['x-forge-key']!==key||req.headers.origin)return json(res,403,{error:'Unauthorized'});
   }else if(!valid||req.headers.origin!==origin||req.headers['x-forge-csrf']!==session.csrf)return json(res,403,{error:'会话或来源校验失败'});
   if(!String(req.headers['content-type']).startsWith('application/json'))return json(res,415,{error:'JSON required'});
   const chunks=[];let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>8*1024*1024)return json(res,413,{error:'请求过大'});chunks.push(chunk);}
   const msg=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(url.pathname==='/rpc'&&msg.method==='shutdown'&&onShutdown){api.stopAccepting();json(res,200,{ok:true,result:{closing:true}});setImmediate(onShutdown);return;}
   if(url.pathname==='/api'){
    if(!['panel','operations','cancel','status','inspect','revision'].includes(msg.method))return json(res,403,{error:'此窗口不开放该动作'});
    delete msg.workspaces;delete msg.fault;delete msg.args;
   }
   const result=await api.dispatch(msg);return json(res,200,{ok:true,result});
  }catch(e){return json(res,e.code==='REVISION_CONFLICT'||e.code==='FILE_CONFLICT'?409:400,{ok:false,error:e.message,code:e.code,receipt:e.receipt,...(e.next?{next:e.next}:{})});}
 });
 return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>{origin=`http://127.0.0.1:${server.address().port}`;resolve({server,origin});});});
}
module.exports={startHttp};
