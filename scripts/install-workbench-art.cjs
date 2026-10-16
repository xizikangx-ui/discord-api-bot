'use strict';
// Encode generated assets without changing their illustrated content or alpha.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),sharp=require('sharp');
(async()=>{
 const [kind,key,source,promptFile]=process.argv.slice(2);if(!['cards','containers'].includes(kind)||!key||!source)throw Error('Asset arguments missing');
 const root=path.resolve(__dirname,'..'),dir=path.join(root,'web/public/art'),registry=path.join(root,'assets/workbench/manifest.json');
 fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(path.dirname(registry),{recursive:true});
 const manifest=fs.existsSync(registry)?JSON.parse(fs.readFileSync(registry)): {version:1,cards:{},containers:{}};
 if(manifest[kind][key])throw Error('Asset already registered; use a new version explicitly.');
 const meta=await sharp(source).metadata(),stats=await sharp(source).stats();if(!meta.hasAlpha||stats.channels.at(-1).min!==0)throw Error('Generated asset must have transparent pixels.');
 const id=crypto.createHash('sha256').update(kind+':'+key).digest('hex').slice(0,12),result={};
 for(const [size,width,limit]of [['thumb',160,24*1024],['detail',512,96*1024]]){
  let output;for(const quality of [82,72,62,48,36]){output=await sharp(source).resize(width,width,{fit:'inside',withoutEnlargement:true}).webp({quality,alphaQuality:90,effort:6}).toBuffer();if(output.length<=limit)break;}
  if(output.length>limit)throw Error('Asset exceeds size budget');
  const hash=crypto.createHash('sha256').update(output).digest('hex').slice(0,12),name=id+'-'+size+'-'+hash+'.webp';fs.writeFileSync(path.join(dir,name),output);
  result[size]='/art/'+name;result[size+'Bytes']=output.length;
 }
 manifest[kind][key]=result;fs.writeFileSync(registry,JSON.stringify(manifest,null,2)+'\n');
 const promptsPath=path.join(root,'assets/workbench/prompts.json'),prompts=fs.existsSync(promptsPath)?JSON.parse(fs.readFileSync(promptsPath)):[];
 prompts.push({kind,key,tool:'image_gen',prompt:promptFile?fs.readFileSync(promptFile,'utf8'):'Wasteland tactical tabletop transparent collectible card illustration; no words or logos.'});fs.writeFileSync(promptsPath,JSON.stringify(prompts,null,2)+'\n');
 console.log(JSON.stringify({kind,key,...result,registered:Object.keys(manifest.cards).length+Object.keys(manifest.containers).length}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
