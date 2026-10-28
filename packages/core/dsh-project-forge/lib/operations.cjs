'use strict';
// Local DSH patch: durable receipts and file intent records, shared by tools and panel.
const fs = require('node:fs');
const fsp = fs.promises;
const path = require('node:path');
const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const scope = new AsyncLocalStorage();
const terminal = new Set(['completed', 'committed', 'cancelled-before-commit', 'failed-before-commit', 'needs-reconciliation']);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
function error(message, code) { return Object.assign(new Error(message), { code }); }
function check(file) {
  const ctx = scope.getStore();
  if (ctx?.signal.aborted) throw error('操作已请求取消。', 'CANCELLED');
  ctx?.validate?.(file);
}
function checkpoint(name) {
  const ctx = scope.getStore();
  if (ctx?.fault === name && process.env.PF_TEST_MODE === '1' && process.env.PF_TEST_ROOT) process.exit(86);
}
function dbWrite() {
  const ctx = scope.getStore();
  if (!ctx) return;
  if (!ctx.fsTouched) check();
  if (!ctx.dbTouched) {
    ctx.journal.db.prepare("UPDATE pf_operations SET db_touched=1, phase='database' WHERE id=?").run(ctx.id);
    ctx.dbTouched = true;
  }
}
async function disk(file) {
  try { const stat = await fsp.lstat(file); if (!stat.isFile() || stat.isSymbolicLink()) throw error('只支持普通文件：' + file, 'FILE_TYPE');
    const bytes = await fsp.readFile(file); return { bytes, hash: hash(bytes), mode: stat.mode, nlink:stat.nlink }; }
  catch(e) { if (e.code === 'ENOENT') return {bytes:null,hash:null}; throw e; }
}
async function prepare(file, bytes, kind = 'write') {
  check(file); const ctx = scope.getStore();
  const before = await disk(file);
  if (!ctx) return {before};
  check();
  if (ctx.blockedFiles.has(path.resolve(file).toLowerCase())) throw error('该文件有未核对操作，请先检查操作记录。', 'RECONCILIATION_REQUIRED');
  const beforeHash = ctx.journal.store.putBlob(before.bytes);
  const afterHash = ctx.journal.store.putBlob(bytes);
  const info = ctx.journal.db.prepare(`INSERT INTO pf_operation_files(operation_id,path,kind,before_hash,after_hash,phase)
    VALUES(?,?,?,?,?,'prepared')`).run(ctx.id,path.resolve(file),kind,beforeHash,afterHash);
  checkpoint('prepared');
  return {before, ctx, row:Number(info.lastInsertRowid)};
}
function phase(p, value) {
  if (!p.ctx) return;
  p.ctx.journal.db.prepare('UPDATE pf_operation_files SET phase=? WHERE id=?').run(value,p.row);
  if (value === 'applying' || value === 'applied') p.ctx.fsTouched = true;
}
async function writeFile(file, bytes, options = {}) {
  const p = await prepare(file, bytes);
  if (Object.hasOwn(options,'expectedHash') && options.expectedHash !== p.before.hash) throw error('文件在读取后发生变化。', 'REVISION_CONFLICT');
  if (!p.ctx) return fsp.writeFile(file, bytes);
  if (p.before.nlink > 1) throw error('文件有多个硬链接，拒绝替换以免改变链接语义。', 'HARDLINK');
  const temp = path.join(path.dirname(file), `.pf-${p.ctx.id}-${p.row}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', p.before.mode || 0o600);
    await handle.writeFile(bytes); await handle.sync(); await handle.close(); handle=null;
    check(file);
    const now = await disk(file);
    if (now.hash !== p.before.hash) throw error('文件在提交前发生变化。', 'FILE_CONFLICT');
    phase(p,'applying'); checkpoint('before-file');
    await fsp.rename(temp, file);
    phase(p,'applied'); checkpoint('after-file');
  } finally { if(handle) await handle.close().catch(()=>{}); await fsp.unlink(temp).catch(e=>{if(e.code!=='ENOENT') throw e;}); }
}
async function removeFile(file, perform) {
  const p = await prepare(file, null, 'remove'); check();
  if ((await disk(file)).hash !== p.before.hash) throw error('文件在删除前发生变化。','FILE_CONFLICT');
  phase(p,'applying'); checkpoint('before-file'); await perform(); phase(p,'applied'); checkpoint('after-file');
}
async function rename(from, to) {
  const source = await disk(from);
  const a = await prepare(from, null, 'move-source');
  const b = await prepare(to, source.bytes, 'move-target');
  check();
  if ((await disk(from)).hash !== source.hash || (await disk(to)).hash !== b.before.hash) throw error('移动前文件已变化。','FILE_CONFLICT');
  phase(a,'applying'); phase(b,'applying'); checkpoint('before-file');
  try { await fsp.rename(from,to); } catch(e) { phase(a,'failed');phase(b,'failed');throw e; }
  phase(a,'applied'); phase(b,'applied'); checkpoint('after-file');
}
async function mkdir(dir, options) {
  check(dir); const ctx = scope.getStore();
  if (!ctx || fs.existsSync(dir)) return fsp.mkdir(dir,options);
  const row=ctx.journal.db.prepare("INSERT INTO pf_operation_files(operation_id,path,kind,phase) VALUES(?,?,'directory','applying')").run(ctx.id,path.resolve(dir));
  ctx.fsTouched=true; await fsp.mkdir(dir,options);
  ctx.journal.db.prepare("UPDATE pf_operation_files SET phase='applied' WHERE id=?").run(row.lastInsertRowid);
}
function recordNode(store, nodeId, node) {
  const ctx=scope.getStore(); if(!ctx) return;
  const project=store.getProject(node.projectId,{includeDeleted:true});
  const abs=path.resolve(ctx.projectRoot?.(node.projectId)||project.root,...node.filePath.split('/'));
  store.db.prepare(`UPDATE pf_operation_files SET phase='ledgered',node_id=? WHERE id=(
    SELECT id FROM pf_operation_files WHERE operation_id=? AND path=? AND after_hash IS ? AND phase='applied' ORDER BY id DESC LIMIT 1)`)
    .run(nodeId,ctx.id,abs,node.afterHash??null);
  checkpoint('ledger-transaction');
}
class OperationJournal {
  constructor(store) {
    this.store=store; this.db=store.db; this.controllers=new Map(); this.tail=Promise.resolve();
    this.db.exec(`CREATE TABLE IF NOT EXISTS pf_operations(
      id TEXT PRIMARY KEY, request_hash TEXT NOT NULL, command TEXT NOT NULL, project_id TEXT,
      status TEXT NOT NULL, phase TEXT NOT NULL, db_touched INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS pf_operation_files(id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL,
      path TEXT NOT NULL, kind TEXT NOT NULL, before_hash TEXT, after_hash TEXT, phase TEXT NOT NULL, node_id INTEGER);
      CREATE INDEX IF NOT EXISTS pf_op_files ON pf_operation_files(operation_id);
      CREATE INDEX IF NOT EXISTS pf_op_project ON pf_operations(project_id,created_at);`);
    this.db.exec('CREATE TABLE IF NOT EXISTS pf_cancel_requests(id TEXT PRIMARY KEY, created_at TEXT NOT NULL)');
    // An interrupted operation is never replayed. Preserve ambiguous disk/database effects.
    this.db.prepare(`UPDATE pf_operations SET status=CASE WHEN db_touched=0 AND NOT EXISTS(
      SELECT 1 FROM pf_operation_files f WHERE f.operation_id=pf_operations.id AND f.phase IN ('applying','applied','ledgered'))
      THEN 'failed-before-commit' ELSE 'needs-reconciliation' END,
      phase='interrupted',updated_at=? WHERE status='running'`).run(new Date().toISOString());
  }
  status(id) {
    const r=this.db.prepare('SELECT * FROM pf_operations WHERE id=?').get(id);
    if(!r) return {operationId:id,status:this.db.prepare('SELECT 1 FROM pf_cancel_requests WHERE id=?').get(id)?'cancelled-before-commit':'unknown',phase:'not-found'};
    return {operationId:r.id,command:r.command,projectId:r.project_id,status:r.status,phase:r.phase,
      createdAt:r.created_at,updatedAt:r.updated_at,error:r.error,
      files:this.db.prepare('SELECT path,kind,before_hash AS beforeHash,after_hash AS afterHash,phase,node_id AS nodeId FROM pf_operation_files WHERE operation_id=? ORDER BY id').all(id)};
  }
  list(projectId,limit=100) {
    return this.db.prepare('SELECT id FROM pf_operations WHERE (? IS NULL OR project_id=?) ORDER BY created_at DESC LIMIT ?')
      .all(projectId||null,projectId||null,Math.min(100,Math.max(1,Number(limit)||100))).map(r=>this.status(r.id));
  }
  cancel(id) {
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id||'')) throw error('无效 operationId','INVALID_ID');
    // Cancellation may arrive before the original HTTP request. Persist its identity.
    this.db.prepare('INSERT OR IGNORE INTO pf_cancel_requests VALUES(?,?)').run(id,new Date().toISOString());
    const c=this.controllers.get(id); if(c) c.abort();
    return {requested:!!c||this.status(id).status==='cancelled-before-commit',...this.status(id)};
  }
  async inspect(id) {
    const s=this.status(id);
    for(const f of s.files||[]) {
      try { const d=f.kind==='directory'?{hash:fs.existsSync(f.path)?'directory':null}:await disk(f.path);
        f.currentHash=d.hash; f.matchesTarget=d.hash===f.afterHash; f.matchesBefore=d.hash===f.beforeHash;
      } catch(e) { f.inspectionError=e.message; }
    }
    return s;
  }
  run({id=crypto.randomUUID(),args,projectId,projectRoot,validate,fault,signal},fn) {
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) return Promise.reject(error('无效 operationId','INVALID_ID'));
    const digest=hash(JSON.stringify(stable(args)));
    const previous=this.db.prepare('SELECT * FROM pf_operations WHERE id=?').get(id);
    if(previous) {
      if(previous.request_hash!==digest) return Promise.reject(error('operationId 已用于不同请求。','ID_CONFLICT'));
      const receipt=this.status(id);
      return Promise.resolve({...(previous.result?JSON.parse(previous.result):{content:[{type:'text',text:'此操作已有记录，请查看回执。'}]}),receipt,replayed:true});
    }
    const now=new Date().toISOString();
    this.db.prepare("INSERT INTO pf_operations(id,request_hash,command,project_id,status,phase,created_at,updated_at) VALUES(?,?,?,?,'running','queued',?,?)")
      .run(id,digest,String(args.command||args.method||''),projectId||null,now,now);
    const controller=new AbortController(); this.controllers.set(id,controller);
    if(this.db.prepare('SELECT 1 FROM pf_cancel_requests WHERE id=?').get(id))controller.abort();
    const abort=()=>controller.abort(); signal?.addEventListener('abort',abort,{once:true}); if(signal?.aborted) abort();
    const job=this.tail.then(async()=>{
      const blockedFiles=new Set(this.db.prepare(`SELECT f.path FROM pf_operation_files f JOIN pf_operations o ON o.id=f.operation_id WHERE o.status='needs-reconciliation'`).all().map(r=>path.resolve(r.path).toLowerCase()));
      const ctx={id,journal:this,projectRoot,signal:controller.signal,validate,fault,dbTouched:false,fsTouched:false,blockedFiles};
      return scope.run(ctx,async()=>{
        try {
          check(); this.db.prepare("UPDATE pf_operations SET phase='executing' WHERE id=?").run(id);
          const result=await fn(); checkpoint('before-receipt');
          const state=ctx.fsTouched||ctx.dbTouched?'committed':(result?.details?.status==='rejected'?'failed-before-commit':'completed');
          const body=JSON.stringify(result??{});
          this.db.prepare('UPDATE pf_operations SET status=?,phase=?,result=?,project_id=COALESCE(project_id,?),updated_at=? WHERE id=?')
            .run(state,'finished',body.length<=1024*1024?body:null,result?.details?.project?.id||result?.details?.projectId||result?.projectId||null,new Date().toISOString(),id);
          return {...result,receipt:this.status(id)};
        } catch(e) {
          const state=ctx.fsTouched||ctx.dbTouched?'needs-reconciliation':(e.code==='CANCELLED'?'cancelled-before-commit':'failed-before-commit');
          this.db.prepare('UPDATE pf_operations SET status=?,phase=?,error=?,updated_at=? WHERE id=?')
            .run(state,'stopped',e.message,new Date().toISOString(),id);
          e.receipt=this.status(id); throw e;
        } finally { this.controllers.delete(id); signal?.removeEventListener('abort',abort); }
      });
    });
    this.tail=job.catch(()=>{}); return job;
  }
  async drain() { await this.tail; }
}
module.exports={OperationJournal,check,dbWrite,writeFile,rename,removeFile,mkdir,recordNode,checkpoint,disk,hash,scope,terminal};
