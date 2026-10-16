import React,{useEffect,useRef,useState} from 'react';
import {api,id} from './api';
const modeNames={single:'七天单次码',multi24h:'24小时多人码'},statuses={active:'有效',expired:'已到期',used:'已使用',revoked:'已停用',issuerInactive:'发码者权限失效'};
export function Invitations({groupId,run,error}){
 const [mode,Mode]=useState('single'),[data,Data]=useState(null),[page,Page]=useState(0),[issued,Issued]=useState(null),[working,Working]=useState(false),[copied,Copied]=useState(false);
 const current=useRef(groupId),sequence=useRef(0);current.current=groupId;
 async function load(){const g=groupId,n=++sequence.current;try{const result=await api('/groups/'+g+'/invites?page='+page);if(current.current===g&&n===sequence.current)Data(result);}catch(e){if(current.current===g)error(e.message);}}
 useEffect(()=>{Issued(null);Data(null);Page(0);},[groupId]);
 useEffect(()=>{void load();return()=>{sequence.current++;};},[groupId,page]);
 async function execute(fn){if(working)return;Working(true);try{await run(fn);}catch{}finally{Working(false);}}
 return <section className="invite-manager" aria-label="本团注册码"><h3>邀请同行者</h3><button onClick={()=>load()} disabled={working}>刷新列表</button><p>选择单次邀请，或分享一天内不限人数的本团注册码。</p><div className="toolbar"><label className="field"><span>注册码类型</span><select aria-label="注册码类型" value={mode} onChange={e=>Mode(e.target.value)}><option value="single">七天单次码</option><option value="multi24h">24小时多人码 · 不限人数</option></select></label><button className="primary" disabled={working} onClick={()=>execute(async()=>{const g=groupId,result=await api('/groups/'+g+'/invite',{mode});if(current.current!==g)return;Issued(result);Copied(false);await load();})}>生成注册码</button></div>
 {issued&&<div className="invite-issued" role="status"><strong>{modeNames[issued.mode]}</strong><code>{issued.code}</code><p>有效至 {new Date(issued.expiresAt).toLocaleString('zh-CN')} · {issued.mode==='multi24h'?'不限加入人数':'仅限一次使用'}</p><button onClick={async()=>{try{await navigator.clipboard.writeText(issued.code);Copied(true);}catch{error('未能复制，请选中注册码手动复制。');}}}>{copied?'已复制':'复制注册码'}</button><button onClick={()=>Issued(null)}>收起注册码</button></div>}
 <p className="muted">邀请码只授予玩家身份。被移出的成员须由GM另发单次邀请；多人码不能自行恢复成员资格。邀请码仅在生成时展示，请及时复制。</p>
 <div className="invite-list">{data?.items.map(i=><article key={i.id}><div><strong>{modeNames[i.mode]}</strong><span className={'invite-status '+i.status}>{statuses[i.status]}</span></div><p>有效至 {new Date(i.expiresAt).toLocaleString('zh-CN')} · 成功加入 {i.usedCount} 次</p><button disabled={working||['revoked','expired','used'].includes(i.status)} onClick={()=>execute(async()=>{const g=groupId;await api('/groups/'+g+'/invites/'+i.id+'/revoke',{operationId:id()});if(current.current===g){if(issued?.id===i.id)Issued(null);await load();}})}>立即停用</button></article>)}</div>
 {!data?.items.length&&<p className="muted">尚未生成邀请。</p>}<div className="pager"><button disabled={!page||working} onClick={()=>Page(page-1)}>上一页</button><span>第 {page+1} 页 · {data?.total||0} 个邀请</span><button disabled={working||(page+1)*50>=(data?.total||0)} onClick={()=>Page(page+1)}>下一页</button></div></section>;
}
