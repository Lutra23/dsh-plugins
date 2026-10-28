'use strict';
function workItems(markdown){
 const found=new Map();let active=false;
 for(const line of String(markdown||'').split(/\r?\n/)){
  if(!line.startsWith('|')){active=false;continue;}
  if(/^\|\s*(ID|工作包)\s*\|\s*(工作包|内容)\s*\|/i.test(line)){active=true;continue;}
  const m=active&&/^\|\s*([A-Z]+\d+)\s*\|\s*([^|]+)\|/.exec(line);
  if(m)found.set(m[1],m[2].trim());
 }
 return found;
}
module.exports={workItems};
