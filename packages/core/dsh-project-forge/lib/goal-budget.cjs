'use strict';
const KEYS=['maxSteps','maxCalls','maxMinutes'];
function limits(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('预算必须是对象');
 const out={};
 for(const key of KEYS){
  if(value[key]==null)continue;
  const n=Number(value[key]);
  if(!Number.isFinite(n)||n<=0||((key==='maxSteps'||key==='maxCalls')&&!Number.isInteger(n)))throw new Error(`${key} 必须是正数（步数/调用数须为整数）`);
  out[key]=n;
 }
 return out;
}
function effective(authorized={},requested={}){
 const a=limits(authorized),r=limits(requested),out={...a};
 for(const key of KEYS)if(r[key]!=null){
  if(a[key]!=null&&r[key]>a[key])throw new Error(`运行预算 ${key} 不得超过用户授权上限`);
  out[key]=r[key];
 }
 return out;
}
module.exports={limits,effective};
