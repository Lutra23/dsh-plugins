'use strict';
const fs=require('node:fs'),crypto=require('node:crypto');
const OP=require('./operations.cjs');
const textHash=text=>OP.hash(String(text).replace(/\r\n/g,'\n'));
function installDocumentVersions(db){
 db.exec(`CREATE TABLE IF NOT EXISTS pf_blueprint_versions(
 id TEXT PRIMARY KEY,document_id TEXT NOT NULL,body BLOB NOT NULL,before_hash TEXT NOT NULL,
 after_hash TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,state TEXT NOT NULL)`);
 return {
  list(id){return db.prepare('SELECT id,document_id,before_hash,after_hash,reason,created_at,state FROM pf_blueprint_versions WHERE document_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100').all(id)},
  get(id,versionId){const v=db.prepare('SELECT * FROM pf_blueprint_versions WHERE document_id=? AND id=?').get(id,versionId);if(!v)throw Object.assign(Error('文档版本不存在'),{code:'NOT_FOUND'});return {...v,markdown:Buffer.from(v.body).toString('utf8'),body:undefined}},
  async write(id,file,markdown,expectedHash,reason){
   OP.check(file);
   const before=fs.readFileSync(file);
   if(textHash(before.toString('utf8'))!==expectedHash)throw Object.assign(Error('文档已变化，请重新读取后提交'),{code:'REVISION_CONFLICT'});
   if(typeof markdown!=='string'||!markdown.trim()||Buffer.byteLength(markdown)>2*1024*1024)throw Error('正文不能为空或超过 2MB');
   if(typeof reason!=='string'||!reason.trim())throw Error('需要说明修改或回退原因');
   const versionId=crypto.randomUUID(),nextHash=textHash(markdown);
   OP.dbWrite();
   db.prepare('INSERT INTO pf_blueprint_versions VALUES(?,?,?,?,?,?,?,?)').run(versionId,id,before,expectedHash,nextHash,reason,new Date().toISOString(),'prepared');
   // The journal snapshots, fsyncs and atomically renames, checking external edits.
   try { await OP.writeFile(file,Buffer.from(markdown,'utf8'),{expectedHash:OP.hash(before)}); }
   catch(error){db.prepare("UPDATE pf_blueprint_versions SET state=? WHERE id=?").run(OP.scope.getStore()?.fsTouched?'needs-reconciliation':'failed-before-commit',versionId);throw error;}
   db.prepare("UPDATE pf_blueprint_versions SET state='committed' WHERE id=?").run(versionId);
   return {versionId,hash:expectedHash,newHash:nextHash,reason};
  }
 };
}
module.exports={installDocumentVersions,textHash};
