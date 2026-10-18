import React,{useState,useMemo,useRef,useEffect} from 'react';
import './rulebook.css';
export function PlayerRulebook({texts=[]}){
  const [query,Q]=useState(''),[selected,Select]=useState(''),[contents,Contents]=useState(false),pageRef=useRef(null);
  const chapters=useMemo(()=>texts.filter(t=>t.key?.startsWith('playerRule/')||t.category==='lore').sort((a,b)=>(a.order||0)-(b.order||0)),[texts]);
  const matches=chapters.filter(c=>(c.label+' '+c.categoryTitle+' '+c.text).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const current=matches.find(c=>c.key===selected)||matches[0],index=matches.indexOf(current);
  const groups=matches.reduce((all,c)=>{let g=all.find(g=>g.id===c.category);if(!g){g={id:c.category,name:c.categoryTitle,description:c.categoryDescription,chapters:[]};all.push(g);}g.chapters.push(c);return all;},[]);
  useEffect(()=>{if(pageRef.current)pageRef.current.scrollTop=0;},[current?.key]);
  function open(key){Select(key);Contents(false);}
  return <section className="panel player-rulebook" aria-label="玩家规则书">
    <div className="rulebook-cover"><span className="rulebook-sigil" aria-hidden="true">✧</span><div><p>异常之书 · 冒险者手册</p><h3>玩家规则书</h3><span>翻开一章，带着答案出发。</span></div></div>
    <div className="rulebook-search"><label>查阅规则<input type="search" placeholder="搜索行动、倒地、兑换券…" value={query} onChange={e=>Q(e.target.value)}/></label><button onClick={()=>Contents(!contents)} aria-expanded={contents} className="rulebook-toc-toggle">{contents?'收起目录':'章节目录'}</button></div>
    <div className="rulebook-layout">
      <nav aria-label="规则书目录" className={contents?'rulebook-toc is-open':'rulebook-toc'}>{groups.map(g=><section key={g.id}><h4>{g.name}</h4><p>{g.description}</p>{g.chapters.map(c=><button key={c.key} aria-current={current?.key===c.key?'page':undefined} onClick={()=>open(c.key)}>{c.label}</button>)}</section>)}</nav>
      {current?<article className="rulebook-page" ref={pageRef} aria-label={'规则正文：'+current.label}>
        <p className="rulebook-volume">{current.categoryTitle}</p><h4>{current.label}</h4><div className="rulebook-divider" aria-hidden="true">✦</div>
        <div className="rulebook-prose">{current.text.split(/\n+/).filter(Boolean).map((p,i)=><p key={i}>{p}</p>)}</div>
        <footer><button disabled={index<=0} onClick={()=>open(matches[index-1].key)}>← 上一章</button><span>{index+1} / {matches.length}</span><button disabled={index>=matches.length-1} onClick={()=>open(matches[index+1].key)}>下一章 →</button></footer>
      </article>:<p role="status">{chapters.length?'没有找到相关章节，试试另一个关键词。':'规则书正在载入，请刷新资料页。'}</p>}
    </div>
  </section>;
}
