const zlib=require("zlib"),fs=require("fs");
const files=process.argv.slice(2);
function scanZstdFrames(buf){const frames=[];let offset=0;while(offset<buf.length){const start=offset;if(buf.length-offset<4)return{frames};if(buf.readUInt32LE(offset)!==4247762216)throw new Error("bad magic");offset+=4;if(offset===buf.length)return{frames};const d=buf.readUInt8(offset);offset+=1;const cs=d>>>6,ss=(d&32)!==0,ck=(d&4)!==0,df=d&3,db=df===3?4:df,cb=cs===0?(ss?1:0):1<<cs;offset+=(ss?0:1)+db+cb;for(;;){if(buf.length-offset<3)return{frames};const h=buf.readUIntLE(offset,3);offset+=3;const lb=(h&1)!==0,bt=(h>>>1)&3,bs=h>>>3;offset+=bt===1?1:bs;if(lb)break;}if(ck)offset+=4;frames.push({start,end:offset});}return{frames};}
const MESSAGE_TYPES=new Set(["user/message","assistant/message"]),MAX=24;
const isApp=(e)=>MESSAGE_TYPES.has(e.type)&&e.surfaceOp==="append";
function paginate(all,beforeSeq,throughSeq){const end=Math.min(throughSeq+1,beforeSeq??throughSeq+1);let count=0,cut=0;for(let index=end-1;index>=0;index--){const event=all[index];if(!isApp(event))continue;count++;const sources=event.sourceEventSeqs;let gs=event.seq;if(sources!==undefined)for(const s of sources)if(s<gs)gs=s;if(count>=MAX){cut=gs;break;}}return{events:all.slice(cut,end),hasMore:cut>0};}
function textOfContent(c){if(typeof c==="string")return c;if(Array.isArray(c))return c.filter(b=>b&&b.type==="text").map(b=>b.text).join("\n");return"";}
function userText(e){const m=e?.data?.message??e?.data;return textOfContent(m?.content??m);}
function planOf(events,tailSeq){
  let ts=null;for(const e of events){if(e.seq>tailSeq)break;if(e.type==="turn/start")ts=e;}
  if(ts===null)return null;
  let ut="";for(const e of events){if(e.seq<=ts.seq)continue;if(e.seq>tailSeq)break;if(e.type==="user/message"&&e.surfaceOp==="append"){ut=userText(e);break;}}
  let pe=null,fs=null;
  for(const e of events){if(e.seq>=ts.seq)break;if(e.type==="turn/end")pe=e;if(e.type==="agent/inbox/spliced"&&e.seq>(pe?pe.seq:-1)){if(fs===null)fs=e;}}
  let b,wc;
  if(pe!==null){b=pe.seq;wc=true;}
  else if(fs!==null){b=fs.seq-1;wc=true;}
  else {b=ts.seq-1;wc=false;}
  return{boundarySeq:b,userText:ut,turn:ts.data?.turn,windowComplete:wc,prevTurnEnd:pe?pe.seq:null};
}
for(const file of files){
  const buffer=fs.readFileSync(file);const{frames}=scanZstdFrames(buffer);
  let text="";for(const f of frames)text+=zlib.zstdDecompressSync(buffer.subarray(f.start,f.end)).toString("utf8");
  const events=text.split("\n").filter(Boolean).map(l=>JSON.parse(l));
  console.log("=== "+file.split("\\").pop().slice(8,15)+" events="+events.length);
  const turns=[];let lastTail=null;
  for(const e of events){
    if(e.type==="turn/start")turns.push({turn:e.data.turn,tail:null,end:null});
    else if(e.type==="turn/end"){const t=turns.find(x=>x.turn===e.data.turn);if(t){t.end=e.seq;t.tail=lastTail;}}
    else if(e.type==="assistant/message"&&e.surfaceOp==="append")lastTail=e.seq;
  }
  for(const t of turns){
    const tail=t.tail??t.end;
    let beforeSeq,lastFirst,acc=[],plan=null,pages=0,exhausted=false;
    for(let i=0;i<8;i++){
      const page=paginate(events,beforeSeq,tail);pages++;
      if(page.events.length===0){exhausted=true;break;}
      acc=page.events.concat(acc);
      plan=planOf(acc,tail);
      if(plan!==null&&(plan.windowComplete||page.hasMore!==true))break;
      if(page.hasMore!==true){exhausted=true;break;}
      const fs2=page.events[0].seq;
      if(!Number.isInteger(fs2)||fs2===lastFirst){exhausted=true;break;}
      lastFirst=fs2;beforeSeq=fs2;
    }
    if(plan===null){console.log(` turn ${t.turn} -> NULL after ${pages}p`);continue;}
    // key assertion: no inherited queue splice may survive above the boundary
    const leak=events.filter(e=>e.type==="agent/inbox/spliced"&&e.seq>plan.boundarySeq&&e.seq<(events.find(x=>x.type==="turn/start"&&x.data.turn===t.turn)?.seq??1e9)&&e.data?.inserted?.length>0);
    console.log(` turn ${t.turn} boundary=${plan.boundarySeq} (prevTurnEnd=${plan.prevTurnEnd}) queueLeak=${leak.length?"LEAK seq"+leak.map(x=>x.seq):"none"} userText=${JSON.stringify((plan.userText||"").slice(0,20))} pages=${pages}${plan.windowComplete?"":" INCOMPLETE-WINDOW"}`);
  }
}
