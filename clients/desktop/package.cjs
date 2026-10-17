'use strict';
const path=require('node:path');
(async()=>{const {packager}=await import('@electron/packager');const output=await packager({dir:__dirname,name:'YichangBook',executableName:'YichangBook',platform:'win32',arch:'x64',out:path.join(__dirname,'release'),overwrite:true,asar:true,ignore:[/^\/release($|\/)/,/^\/package.cjs$/,/^\/test.cjs$/],appCopyright:'异常之书',win32metadata:{CompanyName:'异常之书',FileDescription:'异常之书 · 玩家与 GM 客户端',ProductName:'异常之书'}});console.log(output.join('\n'));})().catch(e=>{console.error(e);process.exitCode=1;});
