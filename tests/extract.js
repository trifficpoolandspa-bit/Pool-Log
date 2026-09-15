// Pulls real functions out of a file so they can be exercised directly
const fs = require('fs');
function grabFn(src, name){
  let s = src.indexOf('function ' + name + '(');
  if(s === -1) return '';
  let i = src.indexOf('{', s), d = 0;
  for(let j = i; j < src.length; j++){
    if(src[j] === '{') d++;
    else if(src[j] === '}'){ d--; if(d === 0) return src.slice(s, j+1); }
  }
  return '';
}
function grabBlock(src, startsWith, endsWith){
  const a = src.indexOf(startsWith);
  if(a === -1) return '';
  const b = src.indexOf(endsWith, a) + endsWith.length;
  return src.slice(a, b);
}
module.exports = {grabFn, grabBlock};
