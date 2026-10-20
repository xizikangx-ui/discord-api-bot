'use strict';
const {test,expect}=require('../../web/node_modules/@playwright/test');
test('chat draft, quick multi-grant and immediate battle dismissal on desktop and phone',async({page},testInfo)=>{
 const errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>{errors.push('unexpected confirmation: '+dialog.type());return dialog.dismiss();});
 await page.goto('/');await expect(page.getByRole('button',{name:'GM',exact:true})).toBeVisible();
 const composer=page.locator('textarea').filter({visible:true}).first();await composer.fill('隔离验收 · 切换后保留此聊天草稿');
 await page.getByRole('button',{name:'GM',exact:true}).click();await page.getByRole('button',{name:'角色与发放',exact:true}).click();
 const grant=page.getByRole('region',{name:'快捷批量发放'});await expect(grant).toBeVisible();await expect(grant.locator('.grant-player-list input[type=checkbox]')).toHaveCount(2);
 for(const checkbox of await grant.locator('.grant-player-list input[type=checkbox]').all())await checkbox.check();
 await grant.getByLabel('发放类型',{exact:true}).selectOption('points');await grant.getByLabel('统一发放数量',{exact:true}).fill('2');await grant.getByRole('button',{name:'＋ 添加属性点 ×2',exact:true}).click();
 await grant.getByRole('button',{name:'立即发放',exact:true}).click();const results=grant.getByRole('region',{name:'逐角色发放结果'});await expect(results.locator('article.success')).toHaveCount(2);await expect(grant.locator('.grant-selected button')).toHaveCount(0);
 await page.screenshot({path:testInfo.outputPath('quick-grant.png'),fullPage:true});
 await page.getByRole('button',{name:'返回聊天',exact:true}).click();await expect(composer).toHaveValue('隔离验收 · 切换后保留此聊天草稿');
 const expand=page.getByRole('button',{name:'展开操作台',exact:true});if(await expand.isVisible())await expand.click();await expect(page.getByLabel('战斗实时反馈',{exact:true}).first()).toBeVisible();await page.getByRole('button',{name:'关闭战斗表现',exact:true}).first().click();await expect(page.getByLabel('战斗实时反馈',{exact:true})).toHaveCount(0);
 await page.screenshot({path:testInfo.outputPath('chat-battle-closed.png'),fullPage:true});
 expect(errors).toEqual([]);
});
