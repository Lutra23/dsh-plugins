// Run with the installed Electron Node runtime; no model or recall service calls.
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL}=require('node:url');
const asarRoot=process.env.DSH_KERNEL_ROOT;
if(!asarRoot){console.error('[skip] set DSH_KERNEL_ROOT=<...>/resources/app.asar');process.exit(2);}
const base=asarRoot.replace(/[\/]+$/,'')+'/dsh/node_modules/@deepseek-ai/';
(async()=>{
 const {Session,KNOWN_SESSION_EVENT_TYPES}=await import(pathToFileURL(base+'dsh-session/lib/index.js'));
 const {releasedV4SessionFormatCodec:codec,restoreReleasedV4Artifact:restore}=await import(pathToFileURL(base+'dsh-session-format-v3-to-v4/lib/index.js'));
 const {reconcileMemo}=await import(pathToFileURL(path.resolve(__dirname,'../lib/boundaries.js')));
 const user=(id,text,source={kind:'user'})=>({id,role:'user',content:[{type:'text',text}],source});
 function fixture(){const s=new Session('format-fixture');s.append('turn/start',{turn:1});s.append('step/start',{turn:1,step:1});s.append('user/message',user('user','question'),{surfaceOp:'append'});s.append('user/message',user('memo','OLD_MEMO',{kind:'memo-recall',version:1,boundaryKey:'old'}),{surfaceOp:'append'});s.append('step/end',{turn:1,step:1,reason:{kind:'completed'}});return s;}
 const headerOf=s=>({...s.header,delegationDepth:0});
 function artifact(s){return {header:headerOf(s),inheritedEventCount:0,events:s.snapshotEvents()};}
 // Both defects are independently reproduced: missing coordinates on write,
 // and a superficially repaired developer message outside a started step.
 const bad=fixture();const retired=bad.append('developer/message',{message:{id:'old-retire',role:'developer',content:[],source:{kind:'memo-recall'}}},{surfaceOp:{op:'replace',startSeq:3,endSeq:3},sourceEventSeqs:[3]});
 assert.throws(()=>codec.encodeEvent(retired),/developer\/message turn must be a non-negative safe integer/);
 const patched=artifact(bad);patched.events=patched.events.map(e=>e===retired?{...e,data:{...e.data,turn:1,step:2}}:e);
 assert.throws(()=>restore(patched,KNOWN_SESSION_EVENT_TYPES),/does not match an open turn and step/);
 for(const text of ['NEW_MEMO','']){
  const s=fixture(),original=s.snapshotEvents();
  const message=reconcileMemo(s,'new',text);
  // The plugin is invoked at pre-step, before step/start (or a step may be rejected).
  for(const e of s.snapshotEvents())codec.encodeEvent(e);
  restore(artifact(s),KNOWN_SESSION_EVENT_TYPES);
  s.append('step/start',{turn:1,step:2});if(message)s.append('user/message',message,{surfaceOp:'append'});
  s.append('step/end',{turn:1,step:2,reason:{kind:'completed'}});s.append('turn/end',{turn:1,reason:{kind:'completed'}});
  assert.deepEqual(s.snapshotEvents().slice(0,original.length),original);
  const active=JSON.stringify(s.deriveMessages());assert(!active.includes('OLD_MEMO'));if(text)assert(active.includes(text));
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'memo-format-'));
  try{
   const header=codec.encodeHeader(headerOf(s),0),rows=s.snapshotEvents().flatMap(e=>codec.encodeEvent(e));
   const file=path.join(dir,'session.v4.jsonl');fs.writeFileSync(file,[header,...rows].map(r=>JSON.stringify(r)).join('\n')+'\n');
   const [h,...saved]=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse),decoder=codec.createDecoder(h),events=[];
   const context={emitEvent(e){events.push(e)},emitRun(){throw Error('unexpected stream run')}};
   for(const row of saved)decoder.decodeRow(row,context);
   const restored=restore({header:decoder.header,inheritedEventCount:decoder.finish(context),events},KNOWN_SESSION_EVENT_TYPES);
   const reopened=new Session(s.id,restored.events,restored.header);assert.deepEqual(reopened.deriveMessages(),s.deriveMessages());
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
 }
 console.log(JSON.stringify({passed:true,checks:['original screenshot error reproduced','coordinates-only fix rejected by restoration','pre-step replacement','empty recall clearing','official v4 physical roundtrip','official lifecycle restoration','raw history preserved'],modelRequests:0}));
})().catch(e=>{console.error(e.stack);process.exitCode=1});
