// Start a fresh WEB_DEMO_WORKSPACE=1 test/helpers/web-demo.cjs first. No production access.
// Playwright is an optional local QA tool, not a website runtime dependency.
const {chromium}=require('playwright');
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const output=process.env.WEB_QA_OUTPUT_DIR||require('node:os').tmpdir();fs.mkdirSync(output,{recursive:true});
const origin='http://127.0.0.1:47840',results={environment:'Windows isolated headless Chrome, loopback, in-memory game and chat',checks:[],errors:[]};
(async()=>{
 const browser=await chromium.launch({headless:true,channel:'chrome'});
 try{
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  await page.route('**/*',r=>new URL(r.request().url()).origin===origin?r.continue():r.abort());
  page.on('pageerror',e=>results.errors.push(e.message));
  const requests=[];page.on('request',r=>requests.push({url:new URL(r.url()).pathname,method:r.method()}));
  const drawer=page.locator('.player-drawer');
  const panel=async name=>{await page.locator('.player-toolbar').getByRole('button',{name,exact:true}).click();await drawer.locator('.loading:visible').waitFor({state:'hidden'});};
  const field=label=>drawer.locator('label').filter({has:page.getByText(label,{exact:true})}).locator('input,textarea,select');
  await page.goto(origin);await page.locator('.composer textarea').waitFor();await page.waitForTimeout(1200);
  await page.locator('.composer textarea').fill('未发送的角色叙述');
  await panel('角色');await field('背景').fill('保留在角色表单的背景');
  for(const name of ['背包','技能','探索','战斗','团务','更多']){await panel(name);assert.equal(await page.locator('.composer textarea').inputValue(),'未发送的角色叙述');assert.equal(await page.locator('.chat-page').isVisible(),true);}
  await panel('角色');assert.equal(await field('背景').inputValue(),'保留在角色表单的背景');
  await page.getByRole('button',{name:'关闭操作面板'}).click();results.checks.push('all seven player toolbar entries render inside chat; chat and form drafts survive panel switches');
  const start=requests.length,times=[];
  for(let n=0;n<20;n++){
   await page.locator('.composer textarea').fill('增量验收 '+n);
   const begin=performance.now(),response=page.waitForResponse(r=>r.request().method()==='POST'&&/\/messages$/.test(new URL(r.url()).pathname));
   await page.locator('.composer button.primary').click();assert.equal((await response).status(),200);times.push(performance.now()-begin);
   await page.waitForFunction(()=>document.querySelector('.composer textarea')?.value==='');
  }
  await page.waitForTimeout(1000);
  const repeated=requests.slice(start).filter(r=>r.method==='GET'&&/\/(game|rooms|members)$/.test(r.url));
  assert.equal(repeated.length,0);times.sort((a,b)=>a-b);results.chat={messages:20,gameDirectoryReads:repeated.length,previousMinimumReads:60,reductionPercent:100,uiConfirmationP95ms:Math.round(times[18])};
  await panel('战斗');await drawer.getByRole('button',{name:'点选移动',exact:true}).click();await field('敌人').selectOption({label:'荒原靶标'});await field('距离').selectOption('5');await drawer.getByRole('button',{name:'靠近 荒原靶标',exact:true}).click();results.checks.push('chat battle movement reachability and point selection render');
  await panel('技能');await drawer.getByRole('button',{name:/星火·苍穹断章/}).click();await field('施放目标').selectOption({label:'荒原靶标 · HP 1/3'});await field('行动 RP（选填）').fill('星火划过营地上空。');
  await drawer.getByRole('button',{name:'释放技能',exact:true}).waitFor({state:'visible'});
  await drawer.getByRole('button',{name:'释放技能',exact:true}).click();
  await page.waitForFunction(async()=>{const g=(await (await fetch('/api/web/v1/groups')).json()).data[0];const v=(await(await fetch('/api/web/v1/groups/'+g.id+'/game?sections=battle')).json()).data;return v.battles.length===0;},null,{timeout:20000});
  await page.locator('.site-sidebar').getByRole('button',{name:/行动记录/}).click();
  await page.getByText('战斗结束 · 灰烬营地 · 技能演练',{exact:false}).first().waitFor();await page.locator('.message-list .battle-loot-card .result-row').filter({hasText:'验收短剑'}).getByRole('button',{name:'拾取',exact:true}).click();
  await page.waitForFunction(async()=>{const g=(await(await fetch('/api/web/v1/groups')).json()).data[0];const v=(await(await fetch('/api/web/v1/groups/'+g.id+'/game')).json()).data;return Object.values(v.player.inventory).filter(i=>i.snapshot.name==='验收短剑').length===2;});results.checks.push('skill and action RP execute once; last NPC death auto-ends battle; summary and loot appear in original system channel; pickup works there');
  await panel('背包');await drawer.getByRole('button',{name:'兑换券',exact:true}).click();await drawer.getByRole('button',{name:'兑换',exact:true}).click();await page.waitForFunction(async()=>{const g=(await(await fetch('/api/web/v1/groups')).json()).data[0];const v=(await(await fetch('/api/web/v1/groups/'+g.id+'/game?sections=core')).json()).data;return Object.values(v.player.couponBalances).every(n=>n===0);});
  await drawer.getByRole('button',{name:'交易与转账',exact:true}).click();await field('交易对象').selectOption({label:'验收队友'});await field('转账金额').fill('10');await drawer.getByRole('button',{name:'转账',exact:true}).click();await drawer.getByRole('button',{name:'确认此版本'}).waitFor();await drawer.getByRole('button',{name:'取消交易'}).click();results.checks.push('voucher redemption and transfer/offer cancellation operate from chat drawer');
  await drawer.getByRole('button',{name:'背包',exact:true}).click();await drawer.getByRole('button',{name:/验收急救药/}).first().click();await field('数量（批量每件消耗一次快速行动）').fill('2');await drawer.getByRole('button',{name:'使用／治疗',exact:true}).click();results.checks.push('bulk healing item executes from chat bag');
  await panel('探索');await drawer.getByRole('button',{name:/B1/}).click();await drawer.getByRole('button',{name:'发起全队移动',exact:true}).click();await drawer.getByText('全队移动 0,0 → 1,0 · 1/2 已同意',{exact:false}).first().waitFor();results.checks.push('exploration proposes shared movement from chat');
  await page.screenshot({path:output+'/workspace-desktop-final.png'});
  await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'关闭操作面板'}).click();await panel('战斗');const box=await drawer.boundingBox();assert.ok(box.width<=390&&box.y>100);assert.equal(await page.locator('.chat-page').isVisible(),true);await page.screenshot({path:output+'/workspace-mobile.png'});results.checks.push('390px mobile uses bottom drawer and keeps chat mounted');
  assert.deepEqual(results.errors,[]);fs.writeFileSync(output+'/workspace-browser.json',JSON.stringify(results,null,2));console.log(JSON.stringify(results));
 }catch(e){results.failure=e.message;fs.writeFileSync(output+'/workspace-browser.json',JSON.stringify(results,null,2));throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
