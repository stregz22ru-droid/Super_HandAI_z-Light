const fs=require('fs');
const f='C:/Super_HandAI_z/agent/src/features/registry.ts';
let s=fs.readFileSync(f,'utf8');
if(s.includes('deny?:')){console.log('ужу-есть');process.exit(0)};
const anchor='    disableSelf?: boolean;';
const idx=s.indexOf(anchor);
if(idx<0){console.log('ЯКОРЬ-НЕ-НАЙДЕН');process.exit(1)};
const lineEnd=s.indexOf('
', idx);
const nextLine=s.slice(lineEnd+1).split('
')[0];
const insert='    deny?: { reason: string };';
const prefix=s.slice(0, lineEnd+1);
const rest=s.slice(lineEnd+1);
if(nextLine.trim()==='}'){
  s=prefix+insert+'
'+rest;
} else {
  s=prefix+s[lineEnd+1]+'
'+insert+'
'+rest.slice(rest.indexOf('
')+1);
}
fs.writeFileSync(f,s,'utf8');
console.log('deny-добавлен');