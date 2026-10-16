import React from 'react';
import art from '../../assets/workbench/manifest.json';
export const workbenchArt=art;
export const rarityNames={red:'红',gold:'金',purple:'紫',blue:'蓝',green:'绿',white:'白'};
export function Art({kind,name,rarity,size='thumb',...props}){const item=kind==='container'?art.containers[name]:art.cards[rarity];return item?<img loading="lazy" decoding="async" src={item[size]} alt={kind==='container'?name:rarityNames[rarity]+'色卡牌'} {...props}/>:<span className="art-placeholder" aria-hidden="true">{kind==='container'?'▣':'◇'}</span>;}
export function ItemArt({item,groupId,...props}){const t=item.snapshot||item;if(t.kind==='卡牌')return <Art rarity={t.rarity} {...props}/>;if(['red','gold'].includes(t.rarity))return <img loading="lazy" decoding="async" src={'/api/web/v1/groups/'+groupId+'/icons/'+(item.templateId||t.id)} alt="" {...props} onError={e=>{e.currentTarget.hidden=true;}}/>;return <span className={'equipment-glyph '+t.rarity} aria-hidden="true">{{武器:'⚔',防具:'⬡',饰品:'◈',弹药:'▥',弹夹:'▤',配件:'⚙',药品:'✚'}[t.kind]||'◇'}</span>;}
