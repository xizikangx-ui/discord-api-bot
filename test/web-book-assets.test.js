"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
test('book branding uses local licensed font shards, bounded initial font and path wordmark',()=>{
 const root=path.resolve(__dirname,'..'),css=fs.readFileSync(path.join(root,'web/src/book-fonts.css'),'utf8'),lines=css.trim().split('\n'),seen=new Set();
 for(const [n,line]of lines.entries()){const name=line.match(/url\("\/fonts\/([^\"]+)"\)/)[1];assert.ok(!seen.has(name));seen.add(name);const b=fs.readFileSync(path.join(root,'web/public/fonts',name));assert.ok(name.includes(crypto.createHash('sha256').update(b).digest('hex').slice(0,12)));assert.ok(line.includes(n?'font-family:BookXiaoWeiExtended;':'font-family:BookXiaoWei;'));if(!n)assert.ok(b.length<=100*1024);assert.ok(line.includes('font-display:swap'))}
 assert.equal(seen.size,108);assert.match(fs.readFileSync(path.join(root,'web/public/fonts/ZCOOLXiaoWei-OFL.txt'),'utf8'),/SIL OPEN FONT LICENSE/);
 const wordmark=fs.readFileSync(path.join(root,'web/public/brand/book-wordmark-v1.svg'),'utf8');assert.match(wordmark,/<title>异常之书<\/title>/);assert.doesNotMatch(wordmark,/<script|(?:href|src)=["']https?:|<image/);assert.ok(wordmark.length>3000);assert.match(fs.readFileSync(path.join(root,'web/index.html'),'utf8'),/<title>异常之书 · 跑团大厅<\/title>/);
});
