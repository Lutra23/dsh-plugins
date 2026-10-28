'use strict';
// ProjectForge 移植版 server：以子进程形态承载 VCPChat 原版引擎（vendor/ 内逐字保留），
// 对上层（DSH host 插件）暴露 JSON-lines 协议，不依赖 VCP / VChat 常驻。
//
// 两种模式：
//   1) 常驻：node server.cjs                        —— stdin 逐行 {"id":N,"args":{...}}，stdout 逐行 {"id":N,"ok":true,"result":{...}}
//   2) 单发：node server.cjs '{"command":"ListWorkspaces"}'  —— 打印一次结果，用于调试与单测
//
// 环境变量：
//   PF_DATA_DIR         数据目录（默认 <root>/data）：workspaces.json / projectforge.db
//   PF_DB_PATH          SQLite 路径覆盖
//   PF_WORKSPACES_FILE  工作区注册表覆盖
//   PF_EXTRA_WORKSPACES 追加工作区 JSON 数组，如 [{"alias":"work","path":"C:\\..."}]
//   PF_AST_ENABLED      '0' 关闭 AST 符号索引（退回正则定位）

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const ENGINE = path.join(ROOT, 'vendor', 'VCPDistributedServer', 'Plugin', 'ProjectForge', 'ProjectForgeService.js');
const DATA_DIR = process.env.PF_DATA_DIR ? path.resolve(process.env.PF_DATA_DIR) : path.join(ROOT, 'data');
const WORKSPACES_FILE = process.env.PF_WORKSPACES_FILE
    ? path.resolve(process.env.PF_WORKSPACES_FILE)
    : path.join(DATA_DIR, 'workspaces.json');
const DB_PATH = process.env.PF_DB_PATH ? path.resolve(process.env.PF_DB_PATH) : path.join(DATA_DIR, 'projectforge.db');

const service = require(ENGINE);

/** 日志一律走 stderr：stdout 必须只有协议 JSON。 */
const logger = {
    log: (...a) => process.stderr.write(a.map(String).join(' ') + '\n'),
    warn: (...a) => process.stderr.write(a.map(String).join(' ') + '\n'),
    error: (...a) => process.stderr.write(a.map(String).join(' ') + '\n'),
    info: (...a) => process.stderr.write(a.map(String).join(' ') + '\n'),
};

function readJson(file, fallback) {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_e) {
        return fallback;
    }
}

function slugId(p) {
    let h = 0;
    const s = String(p).toLowerCase();
    for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return 'ws_' + h.toString(16).padStart(8, '0');
}

/** 宿主注入的工作区条目规范化：始终启用，id/别名缺省时自行推导。 */
function normalizeInjected(arr) {
    return (Array.isArray(arr) ? arr : [])
        .filter(w => w && typeof w.path === 'string' && w.path.trim())
        .map(w => ({
            id: w.id || slugId(w.path),
            alias: String(w.alias || path.basename(w.path)),
            path: path.resolve(w.path),
            enabled: w.enabled !== false,
            status: 'ready',
            injected: true,
        }));
}

/**
 * 宿主按次推送的工作区（DSH 插件在握手与每次调用时随请求带上）。
 * 常驻进程的 env 在 spawn 时即固定，反映不了运行中新建的工作区，
 * 因此这条通道才是"DSH 工作区即白名单"的实时来源。
 */
let pushedWorkspaces = null;

function setPushedWorkspaces(list) {
    if (!Array.isArray(list)) return;
    pushedWorkspaces = list;
}

/**
 * 额外（宿主注入）的工作区：优先取按次推送的实时值，否则回落环境变量种子。
 * 别名冲突时**以注入方为准**——合并规则见 makeWorkspaceService。
 */
function extraWorkspaces() {
    if(process.env.PF_DESKTOP_WORKSPACES_FILE){
        const saved=readJson(process.env.PF_DESKTOP_WORKSPACES_FILE,null);
        if(!saved?.tables?.workspaces||!Array.isArray(saved?.global?.workspaceIds))return [];
        return normalizeInjected(saved.global.workspaceIds.map(id=>({id,...saved.tables.workspaces[id]})).filter(w=>w.path).map(w=>({...w,alias:w.title||w.alias})));
    }
    if (pushedWorkspaces) return normalizeInjected(pushedWorkspaces);
    const raw = process.env.PF_EXTRA_WORKSPACES;
    if (!raw) return [];
    try {
        return normalizeInjected(JSON.parse(raw));
    } catch (e) {
        logger.warn('[pf-server] PF_EXTRA_WORKSPACES 解析失败：' + e.message);
        return [];
    }
}

/**
 * 工作区门面：每次调用实时读两个来源——宿主注入的（DSH 工作区注册表，按次推送）
 * 与注册表文件 workspaces.json（补充 DSH 不认识的目录）。改任一方即时生效。
 *
 * 合并规则：**注入方为准**。别名冲突时文件条目让位——DSH 里登记过的工作区即写白名单，
 * 因此"停用某工作区"要在 DSH 侧做，而不是在 workspaces.json 里写 enabled:false。
 * 文件里非冲突的条目照常附加，扮演上游 extraAllowed（ALLOWED_DIRECTORIES）的角色。
 */
function makeWorkspaceService() {
    const list = () => {
        const injected = extraWorkspaces();
        const taken = new Set(injected.map(w => String(w.alias).toLowerCase()));
        const reg = readJson(WORKSPACES_FILE, null) || {};
        const rows = Array.isArray(reg.workspaces) ? reg.workspaces : [];
        const fromFile = rows
            .filter(w => w && typeof w.path === 'string' && w.path.trim())
            .filter(w => !taken.has(String(w.alias || path.basename(w.path)).toLowerCase()))
            .map(w => ({
                id: w.id || slugId(w.path),
                alias: String(w.alias || path.basename(w.path)),
                path: path.resolve(w.path),
                enabled: w.enabled !== false,
                status: 'ready',
            }));
        return [...injected, ...fromFile];
    };
    return {
        list,
        getActiveWorkspaceId() {
            // 只认启用中的工作区；文件里记的 activeWorkspaceId 若已失效则回落首个，避免下游拿到死 id。
            const enabled = list().filter(w => w.enabled);
            const wanted = (readJson(WORKSPACES_FILE, null) || {}).activeWorkspaceId;
            if (wanted) {
                const key = String(wanted).toLowerCase();
                const hit = enabled.find(w => w.id === wanted || String(w.alias).toLowerCase() === key);
                if (hit) return hit.id;
                logger.warn(`[pf-server] activeWorkspaceId「${wanted}」不在当前启用工作区内，改用首个工作区。`);
            }
            return enabled.length ? enabled[0].id : null;
        },
    };
}

/**
 * 回收站实现（替代 npm trash 模块）：走 Windows Shell 的 Recycle Bin，绝不硬删。
 * trash(paths) 语义与 trash 包一致：接受字符串或数组。
 */
function recycleBin(targets) {
    const list = (Array.isArray(targets) ? targets : [targets]).filter(Boolean).map(p => path.resolve(p));
    if (!list.length) return Promise.resolve();
    if (process.platform !== 'win32' || process.env.PF_TEST_MODE === '1') {
        // 非 Windows 无 Shell 回收站：退回同目录 .trash 软删除，仍可恢复。
        return Promise.resolve().then(() => {
            const dir = path.join(DATA_DIR, 'trash');
            fs.mkdirSync(dir, { recursive: true });
            for (const p of list) {
                if (!fs.existsSync(p)) continue;
                const dest = path.join(dir, `${Date.now()}-${path.basename(p)}`);
                fs.renameSync(p, dest);
            }
        });
    }
    const script = list.map(p => {
        const lit = "'" + p.replace(/'/g, "''") + "'";
        return [
            `$p = ${lit}`,
            `if (Test-Path -LiteralPath $p) {`,
            `  if ((Get-Item -LiteralPath $p -Force).PSIsContainer) {`,
            `    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')`,
            `  } else {`,
            `    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')`,
            `  }`,
            `}`,
        ].join('\n');
    }).join('\n');
    const full = `$ErrorActionPreference='Stop'\nAdd-Type -AssemblyName Microsoft.VisualBasic\n${script}\n`;
    // 用 -EncodedCommand 传脚本，规避引号 / 中文路径的转义问题。
    const encoded = Buffer.from(full, 'utf16le').toString('base64');
    return new Promise((resolve, reject) => {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let err = '';
        child.stderr.on('data', d => { err += d.toString(); });
        child.once('error', e => reject(new Error(`无法启动 powershell: ${e.message}`)));
        child.once('exit', code => {
            if (code === 0) resolve();
            else reject(new Error(`powershell 退出码 ${code}${err ? '：' + err.trim() : ''}`));
        });
    });
}

let ready = null;
function ensureBase() {
    if (ready) return ready;
    ready = Promise.resolve().then(() => {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        acquireOwnerLock();
        const config = {
            ALLOWED_DIRECTORIES: process.env.PF_ALLOWED_DIRS || '',
            PROJECTFORGE_DB_PATH: DB_PATH,
            AST_INDEX_ENABLED: process.env.PF_AST_ENABLED === '0' ? 'false' : 'true',
        };
        service.initialize({
            config,
            logger,
            services: { workspaceService: makeWorkspaceService() },
            trash: recycleBin,
        });
        return {
            db: DB_PATH,
            workspacesFile: WORKSPACES_FILE,
            workspaces: makeWorkspaceService().list().map(w => ({ alias: w.alias, path: w.path, enabled: w.enabled })),
        };
    });
    return ready;
}

const crypto = require('node:crypto');
const { createRuntimeApi } = require('./runtime-api.cjs');
const { startHttp } = require('./panel-http.cjs');
const LOCK = DB_PATH + '.engine-lock';
const ownerToken = crypto.randomUUID();
let owned = false, bootstrapPromise, api, httpService, closing = false;
function acquireOwnerLock() {
    fs.mkdirSync(path.dirname(DB_PATH), {recursive:true});
    try { const fd=fs.openSync(LOCK,'wx'); fs.writeFileSync(fd,JSON.stringify({pid:process.pid,token:ownerToken}));fs.closeSync(fd);owned=true; }
    catch(e) {
        if(e.code!=='EEXIST')throw e;
        let old;try{old=JSON.parse(fs.readFileSync(LOCK,'utf8'));}catch{throw new Error('工程锁无效，请先检查持有进程：'+LOCK);}
        try{process.kill(old.pid,0);throw new Error('工程数据库已有活动引擎 PID '+old.pid);}catch(probe){if(probe.code!=='ESRCH')throw probe;}
        fs.unlinkSync(LOCK);acquireOwnerLock();
    }
}
function releaseOwnerLock(){if(!owned)return;try{const v=JSON.parse(fs.readFileSync(LOCK,'utf8'));if(v.token===ownerToken)fs.unlinkSync(LOCK);}catch{}owned=false;}
process.on('exit',releaseOwnerLock);
async function bootstrap(){
    if(bootstrapPromise)return bootstrapPromise;
    bootstrapPromise=(async()=>{
        const info=await ensureBase();
        const {VcpJevPool}=require('./vcp-jev-pool.cjs'),{GoalJevRuntime}=require('./goal-jev-runtime.cjs');
        const goalJev=new GoalJevRuntime({pool:new VcpJevPool({sourceFile:path.join(DATA_DIR,'jev-source.json'),disabled:process.env.PF_TEST_MODE==='1'})});
        api=createRuntimeApi({service,workspaces:()=>makeWorkspaceService().list(),setWorkspaces:setPushedWorkspaces,root:ROOT,goalJev});
        const key=crypto.randomBytes(32).toString('hex');
        httpService=await startHttp({api,root:ROOT,key,onShutdown:()=>shutdown().then(()=>process.exit(0))});
        const manifest={origin:httpService.origin,key,pid:process.pid,protocolVersion:2,pluginVersion:require('../package.json').version,engineInstanceId:ownerToken};
        const temp=path.join(DATA_DIR,'engine-'+ownerToken+'.json');fs.writeFileSync(temp,JSON.stringify(manifest),{mode:0o600});fs.renameSync(temp,path.join(DATA_DIR,'engine.json'));
        return {...info,ready:true,pid:process.pid,origin:httpService.origin,engineInstanceId:ownerToken,...api.capabilities};
    })();return bootstrapPromise;
}
async function shutdown(){
    if(closing)return;closing=true;
    api?.stopAccepting();
    if(api)await api.journal.drain();
    if(httpService)await new Promise(r=>{httpService.server.close(r);httpService.server.closeIdleConnections?.();});
    await service.cleanup();releaseOwnerLock();
    try{const p=path.join(DATA_DIR,'engine.json');if(JSON.parse(fs.readFileSync(p,'utf8')).engineInstanceId===ownerToken)fs.unlinkSync(p);}catch{}
}
async function handle(msg){
    if(closing)throw new Error('工程服务正在关闭');
    if(Array.isArray(msg.workspaces))setPushedWorkspaces(msg.workspaces);
    const info=await bootstrap();
    if(msg.method==='ready')return info;
    return api.dispatch(msg);
}
const oneShot=process.argv[2];
if(oneShot==='--daemon'){
    bootstrap().catch(e=>{logger.error(e.stack);process.exit(1);});
    for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>shutdown().then(()=>process.exit(0)));
}else if(oneShot){
    (async()=>{try{
        let raw=oneShot;
        if(raw==='-'){raw='';for await(const chunk of process.stdin)raw+=chunk;}
        else if(raw.startsWith('@'))raw=fs.readFileSync(path.resolve(raw.slice(1)),'utf8');
        const result=await handle({args:JSON.parse(raw)});process.stdout.write(JSON.stringify({ok:true,result}));
    }catch(e){process.stdout.write(JSON.stringify({ok:false,error:e.message,receipt:e.receipt}));process.exitCode=1;}
    finally{await shutdown();}})();
}else{
    const rl=require('node:readline').createInterface({input:process.stdin});
    const reply=v=>process.stdout.write(JSON.stringify(v)+'\n');
    rl.on('line',line=>{
        let msg;try{msg=JSON.parse(line);}catch{return reply({ok:false,error:'请求不是合法 JSON'});}
        if(msg.method==='shutdown'){rl.close();shutdown().then(()=>{reply({id:msg.id,ok:true,result:{closed:true}});process.exit(0);});return;}
        handle(msg).then(result=>reply({id:msg.id,ok:true,result})).catch(e=>reply({id:msg.id,ok:false,error:e.message,code:e.code,receipt:e.receipt}));
    });
    rl.on('close',()=>{if(!closing)shutdown().then(()=>process.exit(0));});
}
