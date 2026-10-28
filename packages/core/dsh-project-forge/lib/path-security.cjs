'use strict';
const fs=require('node:fs'),path=require('node:path');
function physical(input) {
  let p=path.resolve(input),tail=[];
  while(!fs.existsSync(p)){const parent=path.dirname(p);if(parent===p)break;tail.unshift(path.basename(p));p=parent;}
  return path.resolve(fs.realpathSync.native(p),...tail);
}
function inside(file,root){const r=path.relative(physical(root),physical(file));return r===''||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));}
function assertInside(file,roots){if(!roots.some(root=>inside(file,root)))throw Object.assign(new Error('路径不在当前授权工作区：'+file),{code:'OUTSIDE_WORKSPACE'});return physical(file);}
module.exports={physical,inside,assertInside};
