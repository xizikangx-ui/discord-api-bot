import React,{createContext,useContext,useEffect,useMemo,useRef,useState}from'react';
import{createRareLootTracker}from'./rare-loot-state';
import{ItemArt}from'./item-art';
import'./rare-loot.css';
const noop=()=>{},fallback={configure:noop,reconnect:noop,baseline:noop,ingest:noop,clear:noop},Context=createContext({controller:fallback,current:null,dismiss:noop});
export function RareLootProvider({children}){
 const tracker=useRef(createRareLootTracker()),scope=useRef(''),[queue,Queue]=useState([]);
 const controller=useMemo(()=>({
  configure(next,options={}){if(scope.current===next)return;scope.current=next;tracker.current.configure(next,options);Queue([]);},
  reconnect(){tracker.current.reconnect();Queue([]);},
  baseline(values){tracker.current.baseline(values||[]);},
  ingest(values,options){const fresh=tracker.current.ingest(values||[],options);if(fresh.length)Queue(old=>[...old,...fresh].slice(-5));},
  clear(){Queue([]);},
 }),[]);
 const current=queue[0]||null,dismiss=()=>Queue(old=>old.slice(1));
 useEffect(()=>{if(!current)return;const t=setTimeout(()=>Queue(old=>old[0]?.id===current.id?old.slice(1):old),4000);return()=>clearTimeout(t);},[current?.id]);
 return <Context.Provider value={{controller,current,dismiss}}>{children}</Context.Provider>;
}
export const useRareLoot=()=>useContext(Context).controller;
export function RareLootToast({defensePending=false,onOpen}){
 const {current:c,dismiss}=useContext(Context);if(!c||defensePending)return null;
 return <RareLootNotice cue={c} dismiss={dismiss} onOpen={onOpen}/>;
}
export function RareLootNotice({cue:c,dismiss=noop,onOpen}){
 return <aside className={'rare-loot-toast '+(c.red?'red':'gold')} role="status" aria-live="polite" aria-label="稀有物资发现"><div className="rare-loot-glow" aria-hidden="true"/><button className="rare-loot-close" aria-label="关闭稀有物资提示" onClick={dismiss}>×</button><header><span aria-hidden="true">✦</span><div><small>{c.red?'红色珍藏现世':'金色珍藏发现'}</small><h3>{c.title||'稀有物资'}</h3></div></header><ul>{c.items.slice(0,4).map(i=><li key={i.id}><ItemArt item={i} groupId={c.groupId}/><b className={i.rarity}>{i.name}</b><span>×{i.quantity}</span></li>)}</ul>{c.items.length>4&&<small>另有 {c.items.length-4} 项稀有物资</small>}<footer><span>{c.pending?'已确定 · 待领取':'结果已保存'}</span>{onOpen&&<button onClick={()=>{onOpen(c);dismiss();}}>查看原结果 →</button>}</footer></aside>;
}
