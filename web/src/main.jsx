const SkillBook=React.lazy(()=>import("./skills").then(m=>({default:m.SkillBook})));
import {BattlePresentationProvider, BattleStage, BattleEventDetails, BattleEffectsSettings, useBattleFeedback} from './battle-presentation';
import {clearSceneMessages,clearSceneGame,readRestartDraft,saveRestartDraft} from './restart-drafts';
import {useRestartDraft} from './use-restart-draft';
import { BattleLoot } from "./battle-loot";
import {workbenchArt} from "./item-art";
window.workbenchArt=workbenchArt;
import { notificationTarget } from "./notification-target";
import { GroupHome, MemberDirectory } from "./community";
import { Avatar, AccountAvatar } from "./avatar";
import { avatarSource, mergeAvatarMembers } from "./avatar-state";
import React, { useState, useEffect, useRef, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { api, id, setCsrf, mediaUrl } from "./api";
import { labels,bindGroupTransport } from "../../gm-web/src/data";
import {GMContextProvider,GMActivity} from "../../gm-web/src/context";
import {canonicalChat,groupUnread,subscribePayload,purgeGroupDrafts,mergeGroupList} from "./group-chat-state";
import {Result} from "../../gm-web/src/result";
import {Field,SearchSelect} from "../../gm-web/src/controls";
const gmComponent=name=>React.lazy(()=>import("../../gm-web/src/main").then(m=>({default:m[name]})));
const Templates=gmComponent('Templates'),Grant=gmComponent('Grant'),World=gmComponent('World'),Commands=gmComponent('Commands'),Audit=gmComponent('Audit');
const Workbench=React.lazy(()=>import('./workbench').then(m=>({default:m.Workbench})));
const WorldExplorer=React.lazy(()=>import('./world-map').then(m=>({default:m.ExplorationHub}))),AtlasManager=React.lazy(()=>import('./world-map').then(m=>({default:m.WorldMap})));
const Market=React.lazy(()=>import('./market').then(m=>({default:m.Market})));
const playerComponent=name=>React.lazy(()=>import("./players").then(m=>({default:m[name]})));
const PlayerPanel=playerComponent('PlayerPanel'),ExplorePanel=playerComponent('ExplorePanel'),BattlePanel=playerComponent('BattlePanel'),ActivitiesPanel=playerComponent('ActivitiesPanel');
import {allSections,visibleSections,mergeGame,refreshQueue,unreadEvent,markRead} from './refresh-state';
import {chatTasks} from './chat-tasks';
import {taskCounts,contextPosition} from './chat-shell';
import {consoleKey,readConsole,saveConsole} from './console-state';
import {Invitations} from './invites';
import {roomMessages,mergeMessages} from "./chat-state";
import {useChatScroll} from "./use-chat-scroll";
import {useMessageSound} from './chat-audio';
import {shouldSend} from './chat-audio-state';
import {GroupMusic} from './music';
import "./style.css";
import "./book-theme.css";
import "./group-chat.css";
import {RareLootProvider,useRareLoot,RareLootToast} from "./rare-loot";
const date = (v) =>
  new Date(v).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
function Auth({ done }) {
  const [mode, M] = useState("login"),
    [p, P] = useState({
      token: location.hash.startsWith("#setup=")
        ? decodeURIComponent(location.hash.slice(7))
        : "",
    }),
    [busy, B] = useState(false),
    [error, E] = useState(""),
    [siteNotice,SiteNotice]=useState(""),
    [recovery, R] = useState("");
  const busyRef=useRef(false);
  useEffect(() => {
    api("/auth/status")
      .then((s) => {
        SiteNotice(s.siteNotice||"");
        if (!s.initialized && p.token) M("bootstrap");
      })
      .catch((e) => E(e.message));
    if (location.hash) history.replaceState(null, "", location.pathname);
  }, []);
  const title = {
    login: "重返书页",
    register: "加入同行",
    bootstrap: "写下第一章",
    recover: "找回账号",
  }[mode];
  async function submit(e) {
    e.preventDefault();
    if (busyRef.current) return;
    busyRef.current=true;
    B(true);
    E("");
    try {
      const r = await api("/auth/" + mode, p);
      if (r.csrf) setCsrf(r.csrf);
      if (r.recovery) {
        R(r.recovery);
      } else done();
    } catch (e) {
      E(e.message);
    } finally {
      busyRef.current=false;
      B(false);
    }
  }
  return (
    <div className="auth-screen">
      <div className="auth-art">
        <span className="eyebrow">翻开书页，记录未知</span>
        <img className="book-emblem" src="/brand/book-icon-v1.svg" alt=""/>
        <h1 className="book-wordmark"><img src="/brand/book-wordmark-v1.svg" alt="异常之书"/></h1>
        <p>
          在未知的书页间，
          <br />
          写下属于你们的故事。
        </p>
        <div className="auth-lines">
          <span>01 / 角色与探索</span>
          <span>02 / 战术与裁决</span>
          <span>03 / 同伴与叙事</span>
        </div>
        <small>独立账号 · 多团存档 · 实时聊天</small>
      </div>
      <section className="auth-form panel">
        {siteNotice&&<p className="domain-notice" role="status">{siteNotice}</p>}
        <span className="eyebrow">新的旅程，从这里开始</span>
        <h2>{title}</h2>
        {recovery ? (
          <>
            <p>请保存恢复码。忘记密码时可使用一次，使用后会换发新码。</p>
            <code className="recovery">{recovery}</code>
            <button
              className="primary"
              onClick={() => {
                R("");
                if (mode === "recover") M("login");
                else done();
              }}
            >
              我已保存，继续
            </button>
          </>
        ) : (
          <>
            <form onSubmit={submit}>
              {[
                ["name", "用户名"],
                ...(mode === "register"
                  ? [
                      ["displayName", "显示昵称"],
                      ["invite", "邀请码"],
                    ]
                  : []),
                ...(mode === "bootstrap"
                  ? [
                      ["displayName", "显示昵称"],
                      ["token", "管理员初始化凭证"],
                    ]
                  : []),
                ...(mode === "recover"
                  ? [
                      ["recoveryCode", "恢复码"],
                      ["resetToken", "管理员重置凭证（与恢复码二选一）"],
                    ]
                  : []),
                ["password", mode === "recover" ? "新密码" : "密码"],
              ].map(([k, l]) => (
                <label className="field" key={k}>
                  <span>{l}</span>
                  <input
                    required={!["resetToken", "recoveryCode"].includes(k)}
                    type={
                      [
                        "password",
                        "token",
                        "recoveryCode",
                        "resetToken",
                      ].includes(k)
                        ? "password"
                        : "text"
                    }
                    autoComplete={
                      k === "password"
                        ? mode === "login"
                          ? "current-password"
                          : "new-password"
                        : k === "name"
                          ? "username"
                          : "off"
                    }
                    value={p[k] || ""}
                    onChange={(e) => P({ ...p, [k]: e.target.value })}
                  />
                </label>
              ))}
              {mode !== "login" && (
                <small>
                  密码12—128字；用户名使用英文、数字、下划线或短横线。
                </small>
              )}
              <button className="primary" disabled={busy}>
                {busy
                  ? "正在连接…"
                  : {
                      login: "登录",
                      register: "使用邀请注册",
                      bootstrap: "创建管理员",
                      recover: "重置密码",
                    }[mode]}
              </button>
            </form>
            <div className="toolbar">
              {["login", "register", "recover"]
                .filter((x) => x !== mode)
                .map((x) => (
                  <button
                    key={x}
                    className="subtle"
                    onClick={() => {
                      M(x);
                      E("");
                    }}
                  >
                    {
                      {
                        login: "已有账号",
                        register: "邀请码注册",
                        recover: "忘记密码",
                      }[x]
                    }
                  </button>
                ))}
            </div>
          </>
        )}
        {error && (
          <div className="banner error" role="alert">
            {error}
          </div>
        )}
        <p>
          <a href="/privacy" target="_blank" rel="noreferrer">
            隐私说明
          </a>
        </p>
      </section>
    </div>
  );
}
class PanelErrorBoundary extends React.Component {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidUpdate(previous) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className="panel panel-load-error" role="alert"><h3>这个面板暂时无法打开</h3><p>网站可能刚刚更新，或网络加载中断。聊天和导航仍可继续使用。</p><p>请先复制并保存未提交的填写和未发送文字，再点击下方按钮手动刷新。刷新不会自动重新执行操作；之前待核对的结果仍需按原记录查询。</p><button type="button" onClick={() => window.location.reload()}>保存填写后刷新页面</button></section>;
  }
}
function Keep({ show, children, resetKey = '' }) {
  const [seen, Seen] = useState(show);
  useEffect(() => {
    if (show) Seen(true);
  }, [show]);
  return seen || show ? <div hidden={!show}><PanelErrorBoundary resetKey={resetKey+':'+show}><Suspense fallback={<div className="loading">正在载入面板…</div>}>{children}</Suspense></PanelErrorBoundary></div> : null;
}
function PendingTasks({game,userId,onNavigate,onOpen,expanded=false}){const all=chatTasks(game,userId),tasks=expanded?all:all.filter(t=>t.system?.hitId);return tasks.length?<div className={'chat-tasks'+(expanded?' expanded':'')} aria-label="待处理事项">{tasks.map(t=><button key={t.key} className={t.system?.hitId?'urgent':''} onClick={()=>t.system?onNavigate(t.system):onOpen(t.tab)}><i className="notification-dot" aria-hidden="true"/>{t.text} →</button>)}</div>:expanded?<div className="chat-tasks" role="status">当前没有待处理事项。</div>:null;}
function ConsoleStatus({data}){const p=data?.player,b=data?.battle;if(!p)return null;return <div className="console-status" aria-label="常驻角色状态"><b>{p.name}</b><span>HP {p.health.hp}/{p.health.maxHP}</span><span className={p.health.downed?'danger':''}>倒地 {p.health.reserveHP}/{p.health.maxHP}</span><span>AP {p.ap}</span>{b&&<><span>轮 {b.actionRound?.number||1} · {b.actionRound?.counts?.[b.actorId]||0} 次</span><span>下次 {b.nextCost} AP</span><span>快 {b.quick} / 正 {b.formal}</span></>}</div>;}
function App() {
  const [me,Me]=useState(null),[booting,Boot]=useState(true),[groups,GroupsValue]=useState([]),[groupId,Group]=useState(''),[visited,Visited]=useState([]),[error,E]=useState('');
  const knownGroups=useRef({user:null,groups:[]}),socketHub=useRef({socket:null,handle:null}),[connected,Conn]=useState(false);
  const current=groups.some(g=>g.id===groupId)?groupId:groups[0]?.id||'';
  function Groups(value){GroupsValue(old=>mergeGroupList(old,typeof value==='function'?value(old):value));}
  async function boot(){try{const value=await api('/auth/me');setCsrf(value.csrf);Me(value);const list=await api('/groups');Groups(list);const saved=readRestartDraft(localStorage,'navigation:'+value.user.id);Group(old=>list.some(g=>g.id===old)?old:list.find(g=>g.id===saved?.groupId)?.id||list[0]?.id||'');E('');}catch(e){if(e.code==='UNAUTHORIZED'||!me)Me(null);else E(e.message);}finally{Boot(false);}}
  useEffect(()=>{void boot();},[]);
  useEffect(()=>{
    if(!me?.user.id)return;let alive=true,retry;
    function open(){const socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');socketHub.current.socket=socket;
      socket.onopen=()=>{Conn(true);socketHub.current.handle?.({type:'socket-open'});};
      socket.onmessage=e=>{let event;try{event=JSON.parse(e.data);}catch{return;}if(event.type==='group-unread')Groups(old=>groupUnread(old,event.data));else if(event.type==='group-state')Groups(old=>old.map(g=>g.id===event.data?.groupId?{...g,pending:event.data.pending??g.pending,hasUpdates:g.hasUpdates||!!event.data.pending||event.data.revision>(g.revision??-1),revision:event.data.revision??g.revision}:g));else if(['group-deleted','access-revoked'].includes(event.type))Groups(old=>old.filter(g=>g.id!==event.data?.groupId));else if(event.type==='permissions')void api('/groups').then(Groups).catch(()=>{});socketHub.current.handle?.(event);};
      socket.onclose=e=>{Conn(false);if(e.code===4001){Me(null);return;}if(e.code===4003)void api('/groups').then(Groups).catch(()=>{});if(alive)retry=setTimeout(open,2500);};socket.onerror=()=>socket.close();}
    open();return()=>{alive=false;clearTimeout(retry);socketHub.current.socket?.close();socketHub.current.socket=null;};
  },[me?.user.id]);
  useEffect(()=>{if(!me?.user.id)return;const prior=knownGroups.current;if(prior.user===me.user.id)for(const before of prior.groups){const after=groups.find(g=>g.id===before.id);if(!after||(['gm','admin'].includes(before.role)&&!['gm','admin'].includes(after.role)))purgeGroupDrafts(localStorage,sessionStorage,me.user.id,before.id,{gmOnly:!!after});}knownGroups.current={user:me.user.id,groups};},[me?.user.id,groups]);
  useEffect(()=>{if(!current)return;Visited(old=>[...new Set([...old,current])].filter(g=>groups.some(row=>row.id===g)));},[current,groups]);
  if(booting)return <div className="loading">◈ 正在翻开书页…</div>;
  if(!me)return <Auth done={boot}/>;
  const sessions=[...new Set([...visited,current])].filter(g=>!g||groups.some(row=>row.id===g));
  return <>{error&&<div className="banner error" role="alert">{error}<button onClick={boot}>重新连接</button></div>}{sessions.map(gid=><div key={me.user.id+':'+gid} hidden={gid!==current} className="group-session"><RareLootProvider><BattlePresentationProvider><GroupSession {...{me,Me,groups,Groups,boot,socketHub,connected}} groupId={gid} Group={Group} selected={gid===current}/></BattlePresentationProvider></RareLootProvider></div>)}</>;
}
function GroupSession({me,Me,groups,Groups,boot,groupId,Group,selected,socketHub,connected}) {
  const battleFeedback=useBattleFeedback(),rareLoot=useRareLoot();
  const [tab, SetTab] = useState("chat"),
    [mobileConsole,MobileConsole]=useState(()=>matchMedia('(max-width:850px)').matches),
    [consolePrefs,ConsolePrefs]=useState({}),
    [rooms, Rooms] = useState([]),
    [roomId, Room] = useState(""),
    [members, Members] = useState([]),
    [game, Game] = useState(null),
    [schema, Schema] = useState(null),
    [gmDirectory,GMDirectory]=useState(null),
    [error, E] = useState(""),
    [notice, N] = useState(""),
    [busy, B] = useState(false),
    [preview, Preview] = useState(null),
    [pendingOperation, PendingOperation] = useState(null),
    [navigation, Navigation] = useState(null),
    [result, R] = useState(null),
    [accountRecovery, AccountRecovery] = useState(""),
    [chatEvent, ChatEvent] = useState(null),
    [drafts, Drafts] = useState(() => {
      try {
        const stored=JSON.parse(sessionStorage.getItem("wasteland-editor-drafts")||"{}");const key=groupId+":"+me.user.id;return {[key]:stored[key]||{}};
      } catch {
        return {};
      }
    }),
    [gmTab, GmTab] = useState("templates");
  const active = useRef({}),
    liveReady=useRef(false),prefsRef=useRef(null),subscription=useRef(0),gmNames=useRef({}),
    refreshTimer = useRef(null),deferredSections=useRef(new Map()),
    busyRef = useRef(false),
    pendingRef = useRef(null),
    gameRef=useRef(null),roomsRef=useRef([]), readQueues=useRef(new Map()),directoryGroup=useRef(null),epoch=useRef(0),sceneClears=useRef({mapIds:[],battleIds:[]}),
    memberRead=useRef(null),memberReadVersion=useRef(0),
    [foreground,Foreground]=useState(document.visibilityState==='visible'),
    [mobileSide, MobileSide] = useState(false);
  const [quickMenu,QuickMenu]=useState(null),[taskList,TaskList]=useState(false),[resultOpen,ResultOpen]=useState(false),[gmUnread,GMUnread]=useState(false);
  const menuRef=useRef(null);
  const group = groups.find((g) => g.id === groupId),
    gm = ["gm", "admin"].includes(group?.role),
    scope = groupId + ":" + me?.user.id;
  useEffect(()=>{if(selected)rareLoot.configure(scope,{groupId,channelId:canonicalChat(group,rooms)?.id||group?.chatRoomId});},[selected,scope,group?.chatRoomId,rooms]);
  const receiveSound=useMessageSound(me?.user.id,me?.user.preferences?.messageSound);
  const tasks=chatTasks(game,me?.user.id),taskBadges=taskCounts(tasks,gm),unread=groups.reduce((sum,g)=>sum+(g.unread||0),0),otherUpdates=groups.some(g=>g.hasUpdates);
  const shortcuts=[["console","操作台"],["character","角色"],["bag","背包"],["skills","技能"],["explore","探索"],["battle","战斗"],["activities","团务"],["more","更多"]];
  function openQuickMenu(e){if(e.type==='contextmenu'&&e.target.closest('input,textarea,select,a,[contenteditable="true"]'))return;e.preventDefault();QuickMenu({...contextPosition(e.clientX||e.currentTarget.getBoundingClientRect().left,e.clientY||e.currentTarget.getBoundingClientRect().bottom,innerWidth,innerHeight),groupId});}
  useEffect(()=>{if(!quickMenu)return;const close=e=>{if(!menuRef.current?.contains(e.target))QuickMenu(null);},escape=e=>{if(e.key==='Escape')QuickMenu(null);};document.addEventListener('pointerdown',close);document.addEventListener('keydown',escape);return()=>{document.removeEventListener('pointerdown',close);document.removeEventListener('keydown',escape);};},[quickMenu]);
  useEffect(()=>{QuickMenu(null);TaskList(false);},[groupId]);
  useEffect(()=>{if(selected&&tab==='gm')SetTab(panelPref.pane==='console'?'chat':panelPref.pane);},[selected]);
  useEffect(()=>{if(selected&&gm&&(group?.pending||group?.gmUnread>0))GMUnread(true);},[selected,gm,group?.pending,group?.gmUnread]);
  useEffect(()=>{if(selected&&me?.user.id&&groupId)saveRestartDraft(localStorage,'navigation:'+me.user.id,{groupId,roomId});},[selected,me?.user.id,groupId,roomId]);
  async function savePreferences(patch){const target=me?.user.id;try{const value=await api('/preferences',patch);Me(old=>old?.user.id===target?{...old,user:{...old.user,preferences:value}}:old);}catch(e){E(e.message);}}
  const panelKey=consoleKey(me?.user.id,groupId,mobileConsole),panelPref=consolePrefs[panelKey]||readConsole(localStorage,panelKey,mobileConsole),panelOpen=panelPref.open;
  function setConsole(change){const next={...panelPref,...change};ConsolePrefs(old=>({...old,[panelKey]:next}));saveConsole(localStorage,panelKey,next);}
  function Tab(next){if(next==='gm'){SetTab(next);return;}if(next==='chat'){SetTab(panelPref.pane==='console'?'chat':panelPref.pane);return;}const pane=next==='console'?'console':next;setConsole({pane,open:true});SetTab(pane==='console'?'chat':pane);}
  useEffect(()=>{const q=matchMedia('(max-width:850px)'),change=()=>MobileConsole(q.matches);q.addEventListener('change',change);return()=>q.removeEventListener('change',change);},[]);
  useEffect(()=>{SetTab(panelPref.pane==='console'?'chat':panelPref.pane);},[panelKey]);
  active.current = { groupId, roomId, scope,tab,panelOpen,selected,roomIds:rooms.map(room=>room.id),watchGroups:groups.map(g=>g.id) };
  pendingRef.current=pendingOperation;gameRef.current=game;roomsRef.current=rooms;
  prefsRef.current=me?.user.preferences;window.webArtStyle=me?.user.preferences?.artStyle||"magic";
  useEffect(()=>{battleFeedback.configure(scope,{mode:me?.user.preferences?.battleEffects||'full',onModeChange:next=>savePreferences({battleEffects:next})});},[scope,me?.user.preferences?.battleEffects]);
  useEffect(()=>{if(!me?.user.id)return;const saved=readRestartDraft(localStorage,'gm-editor:'+me.user.id+':'+groupId,true)||readRestartDraft(localStorage,'gm-editor:'+me.user.id);if(saved?.[scope])Drafts(old=>({...old,[scope]:saved[scope]}));},[me?.user.id,groupId]);
  useEffect(()=>{const persist=event=>{
    if(busyRef.current||pendingRef.current)event.preventDefault();
    try{const stored=JSON.parse(sessionStorage.getItem('wasteland-editor-drafts')||'{}'),mine={[scope]:drafts[scope]||{}};sessionStorage.setItem('wasteland-editor-drafts',JSON.stringify({...stored,...mine}));
      if(me?.user.id){if(!saveRestartDraft(localStorage,'gm-editor:'+me.user.id+':'+groupId,mine))event.preventDefault();if(selected&&!saveRestartDraft(localStorage,'navigation:'+me.user.id,{groupId,roomId:active.current.roomId}))event.preventDefault();}
    }catch{event.preventDefault();}
  };window.addEventListener('book:before-restart',persist);return()=>window.removeEventListener('book:before-restart',persist);},[drafts,me?.user.id,scope,selected]);
  function applyMembers(rows) {
    Members(old => mergeAvatarMembers(old, rows));
    const self = rows.find(m => m.userId === me?.user.id);
    if (self) Me(old => old?.user.id === self.userId && (self.avatarVersion || 0) >= (old.user.avatarVersion || 0) ? { ...old, user: { ...old.user, avatar: self.avatar, avatarVersion: self.avatarVersion || 0 } } : old);
  }
  async function refreshMembers() {
    const target = active.current.groupId, generation = epoch.current;
    if (!target) return;
    const existing = memberRead.current;
    if (existing?.groupId === target && existing.generation === generation) { existing.again = true; return existing.promise; }
    const request = { groupId: target, generation, again: false, version: ++memberReadVersion.current };
    memberRead.current = request;
    request.promise = api('/groups/' + target + '/members').then(rows => {
      if (active.current.groupId === target && epoch.current === generation && memberReadVersion.current === request.version) applyMembers(rows);
    }).finally(() => {
      if (memberRead.current === request) memberRead.current = null;
      if (request.again && active.current.groupId === target && epoch.current === generation) void refreshMembers().catch(() => {});
    });
    return request.promise;
  }
  function avatarSaved(response, target, userId) {
    memberReadVersion.current++;
    Me(old => old?.user.id === userId && (response.user?.avatarVersion || 0) >= (old.user.avatarVersion || 0) ? { ...old, user: { ...old.user, avatar: response.avatar, avatarVersion: response.user.avatarVersion } } : old);
    if (active.current.groupId === target) Members(old => old.map(m => m.userId === userId ? { ...m, avatar: response.avatar, avatarVersion: response.user.avatarVersion } : m));
  }
  async function refresh(options={}) {
    const g=active.current.groupId;if(!g)return;
    const generation=epoch.current;
    if(!readQueues.current.has(g))readQueues.current.set(g,refreshQueue(
      async keys=>api('/groups/'+g+'/game?sections='+keys.join(',')),
      data=>{if(active.current.groupId!==g||epoch.current!==generation)return;if(!battleFeedback.ready()&&Array.isArray(data.feedbackBaseline))battleFeedback.baseline(data.feedbackBaseline);liveReady.current=true;gameRef.current=mergeGame(gameRef.current,clearSceneGame(data,sceneClears.current));Game(gameRef.current);},
      (k,v)=>v<0||(gameRef.current?.sectionVersions?.[k]??-1)<v
    ));
    const jobs=[readQueues.current.get(g)(options.sections||visibleSections(active.current.tab,gameRef.current,active.current.panelOpen),options.expected||{})];
    if(directoryGroup.current!==g||options.directory){directoryGroup.current=g;jobs.push(Promise.all([api('/groups/'+g+'/rooms'),refreshMembers()]).then(([r])=>{if(active.current.groupId===g&&epoch.current===generation)Rooms(r);}).catch(e=>{if(epoch.current===generation)directoryGroup.current=null;throw e;}));}
    await Promise.all(jobs);
  }
  useEffect(()=>{const changed=()=>Foreground(document.visibilityState==='visible');document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
  useEffect(() => {
    liveReady.current=false;sceneClears.current={mapIds:[],battleIds:[]};
    epoch.current++;Game(null);gameRef.current=null;directoryGroup.current=null;readQueues.current.clear();Tab("chat");Navigation(null);
    Rooms([]);
    Members([]);
    Room("");
    Schema(null);GMDirectory(null);gmNames.current={};
    if(!gm)Drafts(old=>{const pending=old[scope]?.pendingOperation;return {[scope]:pending&&!pending.isGM?{pendingOperation:pending}:{}};});
    Preview(null);
    const restored=drafts[scope]?.pendingOperation;PendingOperation(restored&&(!restored.isGM||gm)?restored:null);
    R(null);
    if (!selected||!groupId || !me) return;
    refresh().catch((e) => E(e.message));
    const base = "/groups/" + groupId + "/gm";

    if (gm && active.current.tab==="gm")
      Promise.all([api(base + "/schemas"), api(base + "/directory")])
        .then(([s, d]) => {
          if (active.current.groupId !== groupId) return;
          Schema(s);GMDirectory(d);
          Object.assign(labels, s.attributeLabels);
        })
        .catch((e) => E(e.message));
  }, [groupId, me?.user.id, gm]);
  useEffect(()=>{if(!selected||!groupId||!me)return;void refresh({sections:visibleSections(tab,gameRef.current,panelOpen)}).catch(e=>E(e.message));
    if(gm&&tab==='gm'&&!schema){const base='/groups/'+groupId+'/gm';const target=groupId;Promise.all([api(base+'/schemas'),api(base+'/directory')]).then(([s,d])=>{if(active.current.groupId!==target)return;Schema(s);GMDirectory(d);Object.assign(labels,s.attributeLabels);}).catch(e=>E(e.message));}
  },[selected,tab,groupId,me?.user.id,gm,panelOpen]);
  useEffect(()=>{if(selected&&panelOpen&&tab==='chat'&&(game?.dashboard?.battle||game?.dashboard?.map))void refresh({sections:visibleSections(tab,game,panelOpen)}).catch(()=>{});},[selected,game?.dashboard?.battle?.id,game?.dashboard?.map?.id,panelOpen]);
  useEffect(()=>{if(selected&&panelOpen&&game?.dashboard&&!game.dashboard.player&&game.sectionVersions.core===undefined)void refresh({sections:['core']}).catch(()=>{});},[selected,!!game?.dashboard,game?.dashboard?.player?.id,groupId,panelOpen]);
  useEffect(()=>{
    if(!selected||!groupId||!me||!foreground)return;
    let alive=true,pending=false;
    async function check(){if(pending)return;pending=true;try{const v=await api('/groups/'+groupId+'/version');if(!alive||active.current.groupId!==groupId)return;const keys=visibleSections(active.current.tab,gameRef.current,active.current.panelOpen).filter(k=>v.sectionVersions?.[k]!==gameRef.current?.sectionVersions?.[k]);if(keys.length)await refresh({sections:keys,expected:v.sectionVersions});}catch{}finally{pending=false;}}
    void check();const timer=setInterval(check,5000);return()=>{alive=false;clearInterval(timer);};
  },[selected,groupId,me?.user.id,foreground]);
  useEffect(() => {
    if(!rooms.some(r=>r.id===roomId))Room(canonicalChat(group,rooms)?.id||'');
  }, [rooms,group?.chatRoomId]);
  function sendSubscription(socket=socketHub.current.socket){if(socket?.readyState!==1)return;subscription.current=socketHub.current.requestId=(socketHub.current.requestId||0)+1;socket.send(JSON.stringify(subscribePayload(active.current,subscription.current)));}
  useEffect(() => {
    if(!me||!selected)return;
    function resume(){rareLoot.reconnect();liveReady.current=false;battleFeedback.reconnect();sendSubscription();void refresh({sections:[...new Set([...visibleSections(active.current.tab,gameRef.current,active.current.panelOpen),'battle'])]}).catch(()=>{});ChatEvent({type:'reconnect',at:Date.now()});}
    const receive=event=>{
      if(event.type==='socket-open'){resume();return;}
        if(['subscribed','subscription-ack'].includes(event.type)){if(event.data?.requestId!==subscription.current&&event.requestId!==subscription.current)return;return;}
        if(event.type==='subscription-error'){
          const details=event.data||event;if(details.groupId&&details.groupId!==groupId){void api('/groups').then(Groups).catch(()=>{});return;}if(details.requestId!==undefined&&details.requestId!==subscription.current)return;
          if(details.code==='UNAUTHORIZED'){Me(null);return;}
          E(details.message||'本团访问已变化，请重新选择跑团。');
          if(['FORBIDDEN','NOT_FOUND'].includes(details.code)&&(details.groupId===groupId||!details.groupId)){epoch.current++;Game(null);gameRef.current=null;Rooms([]);Members([]);Schema(null);GMDirectory(null);Preview(null);R(null);readQueues.current.clear();api('/groups').then(Groups).catch(()=>{});}return;
        }
        if(event.type==='group-unread')return;
        if(event.type==='group-state')return;
        if(['group-deleted','access-revoked'].includes(event.type))return;
        if(event.data?.groupId&&event.data.groupId!==groupId&&!['permissions','music'].includes(event.type))return;
        receiveSound(event);
        if(event.type==='rare-loot'){rareLoot.ingest(event.data?.rareLoot,{source:'live'});return;}
        if(event.type==='message'&&active.current.roomIds?.includes(event.data?.roomId)){battleFeedback.ingest(event,{source:'socket'});rareLoot.ingest(event.data.system?.rareLoot,{source:'live'});if(event.data.system?.corpses?.length)void refresh({sections:['battle']}).catch(()=>{});}
        if(event.type==='scenes-cleared'&&event.data?.groupId===active.current.groupId){
          const cleared=event.data;battleFeedback.clear(cleared.battleIds||[]);sceneClears.current={mapIds:[...new Set([...sceneClears.current.mapIds,...(cleared.mapIds||[])])],battleIds:[...new Set([...sceneClears.current.battleIds,...(cleared.battleIds||[])])]};
          Game(old=>{const next=clearSceneGame(old,sceneClears.current);gameRef.current=next;return next;});
          Navigation(old=>old&&[...(cleared.mapIds||[]),...(cleared.battleIds||[])].includes(old.id)?null:old);R(null);ChatEvent(event);N('旧探索场景已清理；角色资产保留，请等待GM建立新地图。');void refresh().catch(()=>{});return;
        }
        if(event.type==='avatar'){refreshMembers().catch(()=>{});}
        else if(event.type==='inbox-unread'){GMUnread(true);ChatEvent({...event,at:Date.now()});return;}
        else if(event.type==='room-unread'){const next=unreadEvent(roomsRef.current,event.data);roomsRef.current=next;Rooms(next);if(event.data.unread!==undefined)Groups(old=>groupUnread(old,event.data));}
        else if(event.type==='state'){
          if(busyRef.current&&pendingRef.current){for(const key of event.data.sections||allSections)deferredSections.current.set(key,event.data.revision);}else if(document.visibilityState==='visible')refresh({sections:(event.data.sections||allSections).filter(k=>visibleSections(active.current.tab,gameRef.current,active.current.panelOpen).includes(k)&&event.data.sectionVersions?.[k]!==gameRef.current?.sectionVersions?.[k]),expected:event.data.sectionVersions}).catch(e=>E(e.message));
        } else if(event.type==='permissions') {
          epoch.current++;directoryGroup.current=null;readQueues.current.clear();refresh({directory:true}).catch(()=>{});
        } else ChatEvent(event);

    };
    Groups(old=>old.map(g=>g.id===groupId?{...g,hasUpdates:false}:g));socketHub.current.handle=receive;if(socketHub.current.socket?.readyState===1)resume();
    return()=>{if(socketHub.current.handle===receive)socketHub.current.handle=null;};
  },[me?.user.id,selected]);
  useEffect(() => {if(selected)sendSubscription();}, [selected,groupId,roomId,groups.map(g=>g.id).join(',')]);
  useEffect(()=>{if(!selected)return;const timer=setTimeout(()=>N(''),5000);return()=>clearTimeout(timer);},[notice,result,selected]);
  async function run(fn) {
    if (busyRef.current) return;
    busyRef.current=true;
    B(true);
    E("");
    try {
      return await fn();
    } catch (e) {
      E(e.message);
      throw e;
    } finally {
      busyRef.current=false;
      B(false);
      const keys=[...deferredSections.current].filter(([k,v])=>visibleSections(active.current.tab,gameRef.current,active.current.panelOpen).includes(k)&&(gameRef.current?.sectionVersions?.[k]??-1)<v).map(([k])=>k);deferredSections.current.clear();if(keys.length)void refresh({sections:keys}).catch(()=>{});
    }
  }
  async function runChat(fn){try{return await fn();}catch(e){E(e.message);throw e;}}
  async function prepare(command, params, isGM = false) {
    if (command === "storage.recover") {
      await run(async () => {
        R(await api("/groups/" + groupId + "/gm/recover", {}));
        await refresh();
      }).catch(() => {});
      return;
    }
    if(pendingOperation){await run(()=>checkDirect()).catch(()=>{});return;}
    const targetGroup=groupId, operationId=id(), request={groupId:targetGroup,operationId,command,params,isGM};
    return await run(async()=>{
      PendingOperation(request);saveLocal('pendingOperation',request);
      try{
        const r=await api('/groups/'+targetGroup+(isGM?'/gm/execute':'/game/execute'),{operationId,command,params,versions:gameRef.current?.versions,includePatch:true,sections:[...new Set([...visibleSections(active.current.tab,gameRef.current,active.current.panelOpen),'dashboard','core','market'])].filter(k=>k!=='management').join(',')});
        if(active.current.groupId!==targetGroup)return;
        if(active.current.selected){rareLoot.ingest(r.rareLoot||[],{source:'http'});battleFeedback.ingest(r.battleFeedback||[],{source:'http'});}if(r.gamePatch){gameRef.current=mergeGame(gameRef.current,clearSceneGame(r.gamePatch,sceneClears.current));Game(gameRef.current);}R(command==='corpse.claim'?null:r.result);PendingOperation(null);saveLocal('pendingOperation',null);N(command==='corpse.claim'?'已拾取，物品已放入背包。':'已保存，通知在后台更新。');if(!r.gamePatch)void refresh().catch(()=>{});return r;
      }catch(e){
        if(active.current.groupId!==targetGroup)throw e;
        if(['CONFLICT','VALIDATION','FORBIDDEN','NOT_FOUND'].includes(e.code)){
          PendingOperation(null);saveLocal('pendingOperation',null);if(e.details)R({conflicts:e.details});await refresh().catch(()=>{});
        }else {
          const recovered=await checkDirect(request).catch(()=>N('连接中断，原操作待核对；不会重复执行。'));
          if(recovered?.status==='committed')return;
        }
        throw e;
      }
    }).catch(()=>{});
  }
  async function checkDirect(request=pendingOperation){
    if(!request)return;
    const r=await api('/groups/'+request.groupId+'/game/operations/'+request.operationId+'?includePatch=1&sections='+visibleSections(active.current.tab,gameRef.current,active.current.panelOpen).concat('core','market').join(','));
    if(active.current.groupId!==request.groupId || pendingRef.current?.operationId!==request.operationId)return;
    if(r.status==='committed'){if(active.current.selected){rareLoot.ingest(r.rareLoot||[],{source:'http'});battleFeedback.ingest(r.battleFeedback||[],{source:'http'});}if(r.gamePatch){gameRef.current=mergeGame(gameRef.current,clearSceneGame(r.gamePatch,sceneClears.current));Game(gameRef.current);}E('');R(request.command==='corpse.claim'?null:r.result);PendingOperation(null);saveLocal('pendingOperation',null);N(request.command==='corpse.claim'?'已核对：战利品已放入背包。':'上一操作已保存，可以继续操作。');if(!r.gamePatch)void refresh().catch(()=>{});}
    else if(r.status==='uncommitted'){PendingOperation(null);saveLocal('pendingOperation',null);N('权威记录确认此操作未保存。填写内容已保留，可重新提交。');}
    else N(r.status==='processing'?'原操作仍在处理中，请稍后查询。':'保存结果尚未明确，修改保持暂停。');
    return r;
  }
  useEffect(()=>{
    if(!selected||!pendingOperation || pendingOperation.groupId!==groupId || !me)return;
    let alive=true,timer;
    const check=async()=>{if(!alive)return;if(!busyRef.current && document.visibilityState==='visible')await checkDirect(pendingOperation).catch(()=>{});if(alive)timer=setTimeout(check,5000);};
    void check();return()=>{alive=false;clearTimeout(timer);};
  },[selected,groupId,me?.user.id,pendingOperation?.operationId]);
  function openRoom(id){Room(id);Tab('chat');MobileSide(false);}
  function navigateNotice(system){
    const target=notificationTarget(system,gm);if(!target)return;
    Navigation({...target,key:id()});Tab(target.tab);if(target.tab==='gm')GmTab(target.gmTab);MobileSide(false);
  }
  async function receipt() {
    if (!preview) return;
    const r = await api("/groups/" + groupId + "/game/receipt/" + preview.id);
    if (r.status === "committed") {
      if(active.current.selected){rareLoot.ingest(r.rareLoot||[],{source:'http'});battleFeedback.ingest(r.battleFeedback||[],{source:'http'});}
      R(r.result);
      Preview(null);
      await refresh();
    } else N("操作状态：" + r.status + "。请保留原编号。");
  }
  async function commit() {
    const f = preview, targetGroup=groupId;
    await run(async () => {
      try {
        const r = await api("/groups/" + targetGroup + "/game/commit", {
          draftId: f.id,
        });
        if(active.current.groupId!==targetGroup)return;
        if(active.current.selected){rareLoot.ingest(r.rareLoot||[],{source:'http'});battleFeedback.ingest(r.battleFeedback||[],{source:'http'});}
        R(r.result);
        Preview(null);
        N("已保存，网站通知在后台更新。");
        await refresh();
      } catch (e) {
        if(active.current.groupId!==targetGroup)throw e;
        if (e.details) Preview((old) => ({ ...old, conflicts: e.details }));
        await receipt().catch(() => N("暂时无法确认结果，请保留原操作编号。"));
        throw e;
      }
    }).catch(() => {});
  }
  async function openDM(userId) {
    if (userId === me.user.id) return;
    await run(async () => {
      const r = await api("/groups/" + groupId + "/dm", { userId });
      await refresh({directory:true});
      Room(r.id);
      Tab("chat");
    }).catch(() => {});
  }
  function saveLocal(key, value) {
    Drafts((old) => {
      const next = { ...old, [scope]: { ...(old[scope] || {}), [key]: value } };
      try {
        const stored=JSON.parse(sessionStorage.getItem("wasteland-editor-drafts")||"{}");sessionStorage.setItem("wasteland-editor-drafts", JSON.stringify({...stored,[scope]:next[scope]}));
      } catch {
        E("浏览器草稿空间不足，请保存服务器草稿。");
      }
      return next;
    });
  }
  const common = {
    schema,
    direct: true,
    session: {
      guildId: groupId,
      userId: me?.user.id,
      canConfig: me?.user.admin,
    },
    prepare: (c, p) => prepare(c, p, true),
    run,
    revision: game?.revision || 0,
    error: E,
    notice: N,
    busy,
    lastResult: result,
    drafts: drafts[scope] || {},
    saveLocal,
  };
  if (accountRecovery)
    return (
      <div className="auth-screen">
        <section className="auth-form panel">
          <h2>密码已更新，旧设备已退出</h2>
          <p>请保存新的恢复码，旧恢复码已失效。</p>
          <code className="recovery">{accountRecovery}</code>
          <button
            className="primary"
            onClick={() => {
              AccountRecovery("");
              boot();
            }}
          >
            我已保存，重新登录
          </button>
        </section>
      </div>
    );
  return (
    <GMContextProvider value={{api:bindGroupTransport(api,groupId),scope,active:selected&&tab==="gm",schema,directory:gmDirectory,boxes:schema?.boxes||[],direct:true,session:{guildId:groupId,userId:me.user.id},mediaBase:"/api/web/v1/groups/"+groupId+"/gm",names:gmNames.current}}><div className="site integrated-site immersive-site book-theme">
      {mobileSide&&<button className="channel-scrim" aria-label="关闭跑团导航" onClick={()=>MobileSide(false)}/>}
      <aside className={"site-sidebar " + (mobileSide ? "shown" : "")}>
        <div className="brand">
          <img className="book-emblem" src="/brand/book-icon-v1.svg" alt=""/>
          <h1>
            <img className="book-wordmark" src="/brand/book-wordmark-v1.svg" alt="异常之书"/><small>与同行者共写故事</small>
          </h1>
        </div>
        <nav className="group-chat-list" aria-label="跑团群聊">
          <small>你的跑团</small>
          {groups.map(g=><button key={g.id} className={g.id===groupId?'chosen':''} onClick={()=>{Group(g.id);if(g.id===groupId){Room(canonicalChat(group,rooms)?.id||'');SetTab(panelPref.pane==='console'?'chat':panelPref.pane);}MobileSide(false);}}><span className="group-seal">{g.name?.slice(0,1)||'团'}</span><span>{g.name}<small>{g.role==='admin'?'管理员':g.role==='gm'?'GM':'玩家'}</small></span>{g.unread>0?<b className="unread">{g.unread>99?'99+':g.unread}</b>:g.hasUpdates?<i className="notification-dot" aria-label="本团有新动态"/>:null}</button>)}
        </nav>
        <nav className="group-management-links"><button onClick={()=>{Tab('settings');MobileSide(false);}}>成员与私聊</button>{gm&&<button onClick={()=>{Tab('gm');MobileSide(false);}}>GM 工作台{gmUnread&&<i className="notification-dot" aria-label="有新的GM待办"/>}</button>}{me.user.admin&&<button onClick={()=>{Tab('settings');MobileSide(false);}}>网站管理</button>}</nav>
        <footer>
          <span className={"connection " + (connected ? "online" : "")}>
            ● {connected ? "实时连接" : "重连中"}
          </span>
          <b>{me.user.displayName}</b>
          <small>
            {group?.role === "admin" ? "网站管理员" : gm ? "本团 GM" : "玩家"} ·
            独立存档
          </small>
        </footer>
      </aside>
      <main className="site-main" onContextMenu={openQuickMenu}>
        <header className="site-header">
          <button
            className="mobile-menu channel-menu-button"
            aria-label="打开导航"
            onClick={() => MobileSide(!mobileSide)}
          >
            ☰{(unread>0||otherUpdates)&&<i className="notification-dot" aria-label={unread?unread+' 条未读消息':'有跑团新动态'}/>}
          </button>
          <div>
            <h2>
              {tab !== "gm"
                ? rooms.find((r) => r.id === roomId)?.kind==="dm"?rooms.find(r=>r.id===roomId)?.name:group?.name || "团群聊"
                : group?.name || "跑团大厅"}
            </h2>
          </div>
          <div className="header-tags">
            <span className={"connection header-connection "+(connected?"online":"")} title={connected?"实时连接":"正在重连"}>●</span>{rooms.find(r=>r.id===roomId)?.kind==="dm"&&<button onClick={()=>Room(canonicalChat(group,rooms)?.id||'')}>返回群聊</button>}<button className="console-toggle" aria-label={panelOpen?"收起操作台":"展开操作台"} onClick={()=>panelOpen?setConsole({open:false}):Tab('console')}>{panelOpen?"收起":"操作台"}</button>
            <button className="notifications-button" aria-label={'待办提醒'+(tasks.length?'，'+tasks.length+' 项':'')} aria-expanded={taskList} onClick={()=>TaskList(!taskList)}>提醒{tasks.length>0&&<b className="red-count">{tasks.length}</b>}</button>
            <details className="chat-settings-menu"><summary aria-label="聊天设置与音乐">设置</summary><div className="chat-settings-body">{groupId&&<GroupMusic key={scope} active={selected} groupId={groupId} userId={me.user.id} gm={gm} event={chatEvent} preferences={me.user.preferences||{}} onPreferences={savePreferences}/>}<ConsoleStatus data={game?.dashboard}/><label><input type="checkbox" checked={!!me.user.preferences?.messageSound} onChange={e=>savePreferences({messageSound:e.target.checked})}/>新消息提示音</label>{result&&<button onClick={()=>ResultOpen(true)}>查看最近操作结果</button>}</div></details>
            <button className="quick-menu-button" aria-haspopup="menu" aria-expanded={!!quickMenu} onClick={openQuickMenu}>功能 ⋮</button>
            {gm&&<button className="gm-quick-button" onClick={()=>{if(gmUnread)GmTab('inbox');Tab(tab==='gm'?'chat':'gm');}}>{tab==='gm'?'返回聊天':'GM'}{gmUnread&&<i className="notification-dot" aria-label="有新的GM待办"/>}</button>}
          </div>
        </header>
        {me.siteNotice&&<div className="banner domain-notice" role="status">{me.siteNotice}</div>}
        {error && (
          <div className="banner error" role="alert">
            {error}
            <button onClick={() => E("")}>×</button>
          </div>
        )}
        {notice && (
          <div className="banner success-toast" role="status">
            {notice}{result&&<button onClick={()=>ResultOpen(true)}>查看结果</button>}
            <button onClick={() => N("")}>×</button>
          </div>
        )}
        {pendingOperation && <div className="banner" role="status"><span>上一操作待核对；仍可查看消息和面板。</span><button disabled={busy} onClick={()=>run(()=>checkDirect()).catch(()=>{})}>查询保存结果</button></div>}
        {(game?.dashboard?game.dashboard.battle?.pending?.length:game?.battles.some((b) => b.pending.length)) && (
          <div className="banner defense-card" role="status">
            你有待结算的受击，请及时防守。
            <button onClick={() => Tab("battle")}>打开防守面板</button>
          </div>
        )}
        {!groupId ? (
          <section className="panel empty">
            <h2>建立你的第一处营地</h2>
            <p>
              {me.user.admin
                ? "创建跑团后，邀请你的 GM 和玩家。"
                : "使用GM的邀请码加入跑团。"}
            </p>
            <Settings
              {...{
                me,
                group,
                groupId,
                members,
                groups,
                Groups,
                refresh,
                run,
                error: E,
                notice: N,
                boot,
                game,
                openDM,
                AccountRecovery,
                onAvatarSaved: avatarSaved,
                rooms,
              }}
            />
          </section>
        ) : (
          <>
            <div className={"chat-workspace "+(panelOpen||tab==="gm"?"with-panel":"console-collapsed")+(tab==="gm"?" gm-workspace":"")}><div hidden={tab==="gm"} className="chat-page">
              <PendingTasks game={game} userId={me.user.id} onNavigate={system=>{navigateNotice(system);TaskList(false);}} onOpen={target=>{Tab(target);TaskList(false);}} expanded={taskList}/>
              {!(panelOpen&&(tab==='battle'||(['chat','console'].includes(tab)&&game?.dashboard?.battle)))&&<BattleStage battle={game?.battles?.find(b=>b.id===game?.dashboard?.battle?.id)} userId={me.user.id} compact/>}
              {result&&resultOpen&&<section className="chat-result-popover" aria-label="个人操作结果"><button className="result-close" onClick={()=>ResultOpen(false)}>关闭结果 ×</button><Result value={result}/></section>}
              <Chat
                key={scope}
                {...{
                  groupId,
                  roomId,
                  me,
                  chatEvent,
                  members,
                  rooms,
                  run:runChat,
                  busy:false,
                  game,
                  prepare,
                  navigateNotice,
                  gm,
                  onPreferences:savePreferences,
                }}
                error={E}
                notice={N}
                visible={selected&&tab !== "gm"}
                onRead={(room,sequence,summary)=>{const next=markRead(roomsRef.current,room,sequence);roomsRef.current=next;Rooms(next);if(summary?.groupId&&summary.unread!==undefined)Groups(old=>groupUnread(old,summary));}}
              />
            </div>
            <div id="player-operation-panel" hidden={!panelOpen&&tab!=="gm"} className={"page-content "+(tab!=="gm"?"player-drawer":"")} key={groupId}>
              <header className="drawer-header"><div><b>{({console:"玩家一体操作台",chat:"玩家一体操作台",character:"我的角色",bag:"背包与交易",skills:"技能卡册",explore:"探索地图",battle:"战术战斗",activities:"团务与资料",more:"营地服务",settings:"成员与账号",library:"公共模板库",home:"营地总览",gm:"GM工作台"})[tab]}</b></div>{tab!=="gm"&&<button onClick={()=>setConsole({open:false})} aria-label="收起操作台">⌄</button>}</header>{tab==='gm'&&result&&<details className="chat-private-result"><summary>本次操作已保存 · 查看结果</summary><Result value={result}/><button onClick={()=>R(null)}>收起结果</button></details>}<PanelErrorBoundary resetKey={groupId+':'+tab+':'+gmTab}><Suspense fallback={<div className="loading" role="status">正在载入面板…</div>}>
              <Keep show={panelOpen&&(tab==="chat"||tab==="console")}>{game&&<Workbench {...{game,groupId,prepare,run,refresh,busy}} userId={me.user.id} active={selected&&panelOpen&&(tab==="chat"||tab==="console")} error={E} onOpen={(target,detail)=>{if(detail)Navigation({...detail,key:id()});Tab(target);}}/>}</Keep>
              <Keep show={panelOpen&&tab==="more"}><section className="panel service-menu"><h3>营地服务</h3>{[["home","公告与未读"],["library","公共模板库"],["settings","成员、私聊与账号"],["bag","收藏柜与兑换券"],["activities","规则与名词"]].map(([k,name])=><button key={k} onClick={()=>Tab(k)}>{name}</button>)}</section></Keep>
              <Keep show={panelOpen&&tab === "home"}>
                <GroupHome {...{ game, group, members, Preview }} rooms={rooms.filter(r=>r.id===canonicalChat(group,rooms)?.id)} onRoom={openRoom} onNavigate={navigateNotice} />
              </Keep>
              <Keep show={panelOpen&&["character", "bag"].includes(tab)}>
                {game && (
                  <PlayerPanel
                    tab={tab}
                    navigation={navigation}
                    game={game}
                    groupId={groupId}
                    userId={me.user.id}
                    prepare={prepare}
                    run={run}
                    refresh={refresh}
                  />
                )}
              </Keep>
              <Keep show={panelOpen&&tab === "explore"}>
                {game && (
                  <WorldExplorer {...{ game, groupId, prepare, run, refresh,gm }} admin={me.user.admin} userId={me.user.id} navigation={navigation} active={selected&&panelOpen&&tab==="explore"} openMap={mapId=>Navigation({type:'map',id:mapId,key:id()})} />
                )}
              </Keep>
              <Keep show={panelOpen&&tab === "battle"}>
                {game && (
                  <BattlePanel
                    {...{ game, groupId, prepare, run, refresh }}
                    active={selected&&panelOpen&&tab==="battle"}
                    navigation={navigation}
                    userId={me.user.id}
                  />
                )}
              </Keep>
              <Keep show={panelOpen&&tab === "skills"}>{game&&<SkillBook {...{game,groupId,prepare}} userId={me.user.id} active={selected&&panelOpen&&tab==="skills"} artStyle={me.user.preferences?.artStyle||"magic"}/>}</Keep>
              <Keep show={panelOpen&&tab === "activities"}>
                {game && <ActivitiesPanel key={groupId} {...{ game, prepare }} />}
              </Keep>
              <Keep show={tab === "gm"}>
                {gm && schema && (
                  <>
                    <div className="toolbar gm-refresh"><button disabled={busy} onClick={()=>run(async()=>{await refresh({directory:true,sections:allSections});N('已读取本团最新数据，填写内容保留。');}).catch(()=>{})}>刷新本团数据</button><small>只读取当前团，不重新执行操作。</small></div><div className="tabs">
                      {[
                        ["inbox", "GM 待办"],
                        ["templates", "内容录入"],
                        ["grant", "角色与发放"],
                        ["maps", "地图管理"],
                        ["world", "世界图册"],
                        ["battles", "战斗管理"],
                        ["content", "内容与公示"],
                        ["markets", "营地市场"],
                        ["audit", "记录与审计"],
                      ].map(([k, v]) => (
                        <button
                          key={k}
                          className={gmTab === k ? "active" : ""}
                          onClick={() => GmTab(k)}
                        >
                          {v}
                        </button>
                      ))}
                    </div>
                    <Keep show={gmTab === "inbox"}><GMInbox groupId={groupId} active={selected&&foreground&&tab==='gm'&&gmTab==='inbox'} event={chatEvent} onRead={summary=>{GMUnread(!!summary?.gmUnread);Groups(old=>{const next=summary?.unreadVersion?groupUnread(old,summary):old;return next.map(g=>g.id===groupId?{...g,pending:!!summary?.gmUnread,gmUnread:summary?.gmUnread||0}:g);});}} onNavigate={navigateNotice} error={E}/></Keep>
                    <Keep show={gmTab === "templates"}>
                      <Templates {...common} />
                    </Keep>
                    <Keep show={gmTab === "grant"}>
                      <Grant {...common} />
                    </Keep>
                    <Keep show={gmTab === "maps"}>
                      <World {...common} kind="maps" navigation={navigation} openTemplates={() => GmTab("templates")} />
                    </Keep>
                    <Keep show={gmTab==='world'}><AtlasManager {...{game,groupId,prepare,run,refresh}} gm={true} admin={me.user.admin} userId={me.user.id} active={selected&&tab==='gm'&&gmTab==='world'} onMap={mapId=>{Navigation({type:'map',id:mapId,key:id()});Tab('explore');}}/></Keep>
                    <Keep show={gmTab === "battles"}>
                      <World {...common} kind="battles" navigation={navigation} />
                    </Keep>
                    <Keep show={gmTab === "markets"}><Market {...{groupId}} active={selected&&tab==="gm"&&gmTab==="markets"} type="weapon" gm prepare={(c,p)=>prepare(c,p,true)} revision={game?.sectionVersions?.market} onError={E}/><Market {...{groupId}} active={selected&&tab==="gm"&&gmTab==="markets"} type="armor" gm prepare={(c,p)=>prepare(c,p,true)} revision={game?.sectionVersions?.market} onError={E}/></Keep>
                    <Keep show={gmTab === "content"}>
                      <Commands
                        {...common}
                        groups={["content", "public", "character"]}
                      />
                    </Keep>
                    <Keep show={gmTab === "audit"}>
                      <Audit {...common} />
                    </Keep>
                  </>
                )}
              </Keep>
              <Keep show={panelOpen&&tab === "library"}><GMActivity active={selected&&gm&&panelOpen&&tab==='library'}>
                <Library
                  {...{ me, groupId, gm, run }}
                  error={E}
                  notice={N}
                  refresh={refresh}
                />
              </GMActivity></Keep>
              <Keep show={panelOpen&&tab === "settings"}>
                <Settings
                  {...{
                    me,
                    group,
                    groupId,
                    members,
                    groups,
                    Groups,
                    refresh,
                    run,
                    error: E,
                    notice: N,
                    boot,
                    game,
                    openDM,
                    rooms,
                    AccountRecovery,
                    onAvatarSaved: avatarSaved,
                  }}
                />
              </Keep>
            </Suspense></PanelErrorBoundary></div></div>
          </>
        )}
      </main>
      {quickMenu?.groupId===groupId&&<div ref={menuRef} className="chat-context-menu" role="menu" aria-label="快捷功能" style={{left:quickMenu.left,top:quickMenu.top}}><small>快捷功能 · 也可右键打开</small>{shortcuts.map(([key,label])=><button role="menuitem" key={key} onClick={()=>{Tab(key);QuickMenu(null);}}>{label}{taskBadges[key]>0&&<b className="red-count">{taskBadges[key]}</b>}</button>)}<button role="menuitem" onClick={()=>{Tab('settings');QuickMenu(null);}}>账号与成员</button><button role="menuitem" onClick={()=>{MobileSide(true);QuickMenu(null);}}>切换跑团{unread>0&&<b className="red-count">{unread}</b>}</button>{gm&&<button role="menuitem" onClick={()=>{Tab('gm');QuickMenu(null);}}>GM 工作台</button>}</div>}
      {selected&&<RareLootToast defensePending={!!(game?.dashboard?.battle?.pending?.length||game?.battles?.some(b=>b.pending?.length))} onOpen={cue=>{if(cue.battleId)navigateNotice({battleId:cue.battleId});else if(cue.mapId)navigateNotice({mapId:cue.mapId,cell:cue.cell});else if(cue.journeyId)navigateNotice({worldJourneyId:cue.journeyId});else {ResultOpen(true);Tab('bag');}}}/>}
      <aside className="character-sidebar" hidden>
        <span className="eyebrow">你的角色</span>
        {game?.player ? (
          <>
            <h3>{game.player.name}</h3>
            <p className="muted">
              等级 {game.player.level} ·{" "}
              {game.player.health.downed ? "倒地，等待救援" : "行动就绪"}
            </p>
            <Bar
              name="正常生命"
              value={game.player.hp}
              max={game.player.stats.maxHP}
            />
            <Bar
              name="倒地生命"
              value={game.player.health.reserveHP}
              max={game.player.stats.maxHP}
              reserve
            />
            <div className="stat-pair">
              <span>AP</span>
              <b>{game.player.ap}</b>
            </div>
            <div className="stat-pair">
              <span>游戏币</span>
              <b>{game.player.balance.toLocaleString()}</b>
            </div>
            <div className="stat-pair">
              <span>自由点</span>
              <b>{game.player.points}</b>
            </div>
            {game.battles.find((b) =>
              b.actors.some((a) => a.userId === me.user.id),
            ) && (
              <button className="primary" onClick={() => Tab("battle")}>
                打开战斗面板
              </button>
            )}
          </>
        ) : (
          <div className="empty-note">
            <div>◇</div>
            <h3>档案尚未建立</h3>
            <p>每个团拥有独立角色。</p>
            <button onClick={() => Tab("character")}>前往建卡</button>
          </div>
        )}
        <hr />
        <div className="section-title">
          <h4>营地成员</h4>
          <small>{members.filter((m) => m.active).length}人</small>
        </div>
        {members
          .filter((m) => m.active)
          .map((m) => (
            <button
              className="member"
              key={m.userId}
              onClick={() => {
                if (m.userId !== me.user.id)
                  run(async () => {
                    const r = await api("/groups/" + groupId + "/dm", {
                      userId: m.userId,
                    });
                    await refresh({directory:true});
                    Room(r.id);
                    Tab("chat");
                  }).catch(() => {});
              }}
            >
              <Avatar avatar={m.avatar || m.characterAvatar} groupId={groupId} name={m.name}/>
              <span>
                {m.name}
                <small>{m.role === "gm" ? "GM" : "玩家"}</small>
              </span>
              {m.userId !== me.user.id && <span className="muted">↗</span>}
            </button>
          ))}
      </aside>
      {preview && (
        <div className="legacy-draft">
          <section className="panel">
            <span className="eyebrow">尚未写完的篇章</span>
            <h3>上个版本留下的草稿</h3>
            <p>
              有效至 {new Date(preview.expiresAt).toLocaleTimeString()} ·{" "}

            </p>
            {error&&<div className="banner error" role="alert">{error}</div>}
            <Result value={preview.preview} />
            {preview.conflicts && <Result value={preview.conflicts} />}
            <div className="toolbar">
              <button
                className="primary"
                disabled={
                  busy ||
                  preview.canCommit === false ||
                  !!preview.conflicts ||
                  Date.now() > preview.expiresAt
                }
                onClick={commit}
              >
                {busy ? "正在保存…" : "执行此草稿"}
              </button>
              <button
                disabled={busy}
                onClick={() => run(receipt).catch(() => {})}
              >
                查询已保存结果
              </button>
              <button disabled={busy} onClick={() => {Preview(null);refresh().catch(()=>{});}}>
                返回修改
              </button>
            </div>
          </section>
        </div>
      )}
    </div></GMContextProvider>
  );
}
export function Bar({ name, value = 0, max = 1, reserve = false }) {
  return (
    <div className={"life-bar " + (reserve ? "reserve" : "")}>
      <div>
        <span>{name}</span>
        <b>
          {value} <small>/ {max}</small>
        </b>
      </div>
      <div className="track">
        <i
          style={{
            width: Math.max(0, Math.min(100, (value / max) * 100)) + "%",
          }}
        />
      </div>
    </div>
  );
}
function Chat({
  groupId,
  roomId,
  me,
  chatEvent,
  members,
  rooms,
  run,
  busy,
  game,
  prepare,
  navigateNotice,
  gm,
  error,
  notice,
  onRead,
  visible,
  onPreferences,
}) {
  const rareLoot=useRareLoot();
  const [storedMessages, Messages] = useState([]),
    [drafts, Drafts] = useState({}),
    [composers, Composers] = useState({}),
    [online, Online] = useState([]),
    [personas,Personas]=useState([]),
    [sending, Sending] = useState(false),
    [inView, InView] = useState(false),
    [foreground, Foreground] = useState(document.visibilityState==='visible');
  const messages=roomMessages(storedMessages,roomId);
  const scroll=useChatScroll(roomId,messages,visible);
  const composer=composers[roomId]||{},attachments=composer.attachments||[],reply=composer.reply||null,kind=composer.kind||'text',mode=composer.mode||'normal';
  const change=(key,v)=>Composers(old=>{const c=old[roomId]||{},value=typeof v==='function'?v(c[key]||[]):v;return {...old,[roomId]:{...c,[key]:value}};});
  const Attachments=v=>change('attachments',v),Reply=v=>change('reply',v),Kind=v=>change('kind',v),Mode=v=>change('mode',v);
  useEffect(()=>{if(!visible||!gm){if(!gm)Personas([]);return;}let alive=true;api('/groups/'+groupId+'/chat/personas').then(rows=>{if(alive)Personas(rows);}).catch(()=>{});return()=>{alive=false;};},[visible,groupId,gm,kind==='rp']);
  const sendingRooms=useRef(new Set());
  const bottom = useRef(null),
    active = useRef(roomId),
    client = useRef({}),
    cursor = useRef(0),sceneClears=useRef({mapIds:[],battleIds:[]});
  const protectMessages=incoming=>clearSceneMessages(incoming,sceneClears.current);
  useRestartDraft('chat:'+me.user.id+':'+groupId,{drafts,composers,client:client.current},saved=>{Drafts(saved.drafts||{});Composers(saved.composers||{});client.current=saved.client||{};},()=>sendingRooms.current.size>0);
  active.current = roomId;
  const room = rooms.find((r) => r.id === roomId),
    readOnly = !!room?.archived || room?.kind === "system";
  async function load(before) {
    if (!roomId) return;
    const r = await api(
      "/rooms/" +
        encodeURIComponent(roomId) +
        "/messages" +
        (before ? "?before=" + before : ""),
    );
    if (active.current === roomId) {
      rareLoot.baseline(r.flatMap(m=>m.system?.rareLoot||[]));
      if(before)scroll.preserveHistory();
      Messages((old) =>
        mergeMessages(old,protectMessages(r)),
      );
    }
  }
  async function catchUp() {
    if (!roomId) return;
    if (!cursor.current) return load();
    let after = cursor.current;
    while (active.current === roomId) {
      const batch = await api(
        "/rooms/" + encodeURIComponent(roomId) + "/messages?after=" + after,
      );
      if (active.current !== roomId) return;
      Messages((old) =>
        mergeMessages(old,protectMessages(batch)),
      );
      if (!batch.length) break;
      after = batch.at(-1).sequence;
      cursor.current = Math.max(cursor.current, after);
      if (batch.length < 50) break;
    }
    const fresh = await api(
      "/rooms/" + encodeURIComponent(roomId) + "/messages",
    );
    if (active.current === roomId)
      Messages((old) =>
        mergeMessages(old,protectMessages(fresh)),
      );
  }
  useEffect(() => {
    if(!visible)return;
    cursor.current = messages.at(-1)?.sequence||0;
    catchUp().catch((e) => error(e.message));
    Sending(sendingRooms.current.has(roomId));
  }, [roomId,visible]);
  useEffect(() => {
    if(!visible)return;
    if(chatEvent?.type==='scenes-cleared'&&chatEvent.data?.groupId===groupId){sceneClears.current={mapIds:[...new Set([...sceneClears.current.mapIds,...(chatEvent.data.mapIds||[])])],battleIds:[...new Set([...sceneClears.current.battleIds,...(chatEvent.data.battleIds||[])])]};Messages(old=>protectMessages(old));return;}
    if (chatEvent?.type === "reconnect") {
      catchUp().catch(() => {});
      return;
    }
    if (chatEvent?.type === "presence") {
      Online(chatEvent.data);
      return;
    }
    if (chatEvent?.data?.roomId !== roomId) return;
    if (["message", "deleted"].includes(chatEvent.type))
      Messages((old) =>
        mergeMessages(old,protectMessages([chatEvent.data])),
      );
  }, [chatEvent, roomId,visible]);
  useEffect(()=>{const handler=()=>Foreground(document.visibilityState==='visible');document.addEventListener('visibilitychange',handler);return()=>document.removeEventListener('visibilitychange',handler);},[]);
  useEffect(()=>{const observer=new IntersectionObserver(([entry])=>InView(entry.isIntersecting),{root:scroll.list.current});if(bottom.current)observer.observe(bottom.current);return()=>observer.disconnect();},[roomId]);
  useEffect(()=>{if(messages.length)cursor.current=Math.max(cursor.current,messages.at(-1).sequence);},[messages.at(-1)?.sequence]);
  useEffect(()=>{if(visible&&foreground&&inView&&roomId&&messages.length)api('/rooms/'+encodeURIComponent(roomId)+'/read',{sequence:messages.at(-1).sequence}).then(summary=>onRead(roomId,messages.at(-1).sequence,summary)).catch(()=>{});},[visible,foreground,inView,roomId,messages.at(-1)?.sequence]);
  async function send(e) {
    e.preventDefault();
    if (sendingRooms.current.has(roomId) || !roomId) return;
    sendingRooms.current.add(roomId);
    Sending(true);
    error("");
    const text = drafts[roomId] || "",
      data = {
        text,
        kind,
        ...(kind==='rp'&&gm&&composer.npcId?{npcId:composer.npcId}:{}),
        mode,
        attachments: attachments.map((a) => a.id),
        replyTo: reply?.id,
      },
      signature = JSON.stringify(data),
      payload =
        client.current[roomId]?.signature === signature
          ? client.current[roomId]
          : { clientId: id(), ...data, signature };
    client.current[roomId] = payload;
    try {
      const m = await api(
        "/rooms/" + encodeURIComponent(roomId) + "/messages",
        payload,
      );
      if(active.current===roomId){scroll.followLatest();Messages((old) => mergeMessages(old,[m]));}
      Drafts((old) => ({ ...old, [roomId]: old[roomId]===text?"":old[roomId] }));
      Attachments([]);
      Reply(null);
      delete client.current[roomId];
      onRead(roomId,m.sequence);
    } catch (e) {
      if(active.current===roomId)error(e.message + "；保留同一消息编号，再次发送不会重复创建。");
    } finally {
      sendingRooms.current.delete(roomId);
      if(active.current===roomId)Sending(false);
    }
  }
  async function upload(files) {
    if (files.length + attachments.length > 3) {
      error("每条最多3张图片。");
      return;
    }
    for (const f of files) {
      if (f.size > 4 * 1024 * 1024) {
        error("每张图片最多4 MiB。");
        continue;
      }
      await run(async () => {
        const data = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result.split(",")[1]);
          reader.onerror = reject;
          reader.readAsDataURL(f);
        });
        const r = await api("/groups/" + groupId + "/media", {
          roomId,
          uploadId: id(),
          data,
        });
        Attachments((old) => [...old, { id: r.id, name: f.name }]);
      }).catch(() => {});
    }
  }
  return (
    <>
      <div className="chat-context">
        <span>
          ◌{" "}
          {room?.kind === "dm"
            ? "仅对话双方可见"
            : room?.kind === "gm"
              ? "仅本团 GM 可见"
              : "本团成员可见"}
        </span>
        <small>{online.length} 人在线 · 消息仅保存在网站</small>
      </div>
      <div className="message-list" ref={scroll.list} onScroll={scroll.onScroll} tabIndex={0} aria-label="聊天记录">
        <div ref={scroll.content}>
        {messages.length >= 50 && (
          <button
            className="subtle older"
            onClick={() =>
              load(messages[0].sequence).catch((e) => error(e.message))
            }
          >
            加载更早消息
          </button>
        )}
        {!messages.length && (
          <div className="chat-empty">
            <span>◈</span>
            <h3>故事从这里开始</h3>
            <p>
              {roomId
                ? "写下一段话，与你的同伴建立联系。"
                : "选择一个跑团，开始新的故事。"}
            </p>
          </div>
        )}
        {messages
          .filter((m) => !m.superseded)
          .map((m) => (
            <article
              key={m.id}
              data-message-id={m.id}
              className={
                "message " +
                (m.kind === "system"
                  ? "system-card "
                  : m.kind === "rp"
                    ? "rp-message "
                    : "") +
                (m.deleted ? "deleted" : "")
              }
            >
              <Avatar avatar={m.kind === 'system' ? null : m.speaker ? {...m.speaker.avatar,messageId:m.id} : avatarSource(m, members.find(member => member.userId === m.authorId))} groupId={groupId} name={m.characterName || m.authorName || ''} symbol={m.kind === 'system' ? '⚑' : undefined}/>
              <div className="message-content">
                <div className={"message-title art-"+(window.webArtStyle||"magic")}>
                  <b className={m.kind==="rp"?"art-title":""}>{m.characterName || m.authorName}</b>
                  {m.kind === "rp" && <span className="badge">{m.speaker?'NPC RP · GM '+m.authorName:'角色 RP'}</span>}
                  {m.system?.npcId && (
                    <span className="badge">NPC · 固定操作卡</span>
                  )}
                  <time>{date(m.at)}</time>
                  <div className="message-actions">
                    <button onClick={() => Reply(m)} title="回复">
                      ↩
                    </button>
                    {["text", "rp"].includes(m.kind) && !m.deleted && (
                      <button
                        onClick={() =>
                          run(() =>
                            api("/messages/delete", { id: m.id }),
                          ).catch(() => {})
                        }
                        title="删除"
                      >
                        ×
                      </button>
                    )}
                  </div>
                </div>
                {m.replySummary && (
                  <blockquote>
                    {m.replySummary.author}：{m.replySummary.text}
                  </blockquote>
                )}
                {m.kind==='system'&&m.text?.length>240?<details className="system-text-details"><summary>{m.text.split('\n')[0]} · 展开详情</summary><p>{m.deleted?"消息已删除":m.text}</p></details>:<p>{m.deleted ? "消息已删除" : m.text}</p>}
                {m.dice && (
                  <div className="dice-result">
                    <span>⬡</span>
                    <b>{m.dice.total}</b>
                    <small>
                      {m.dice.expression} · 骰点{" "}
                      {m.dice.rolls.map((r) => r.dice.join("/")).join("、")}
                    </small>
                  </div>
                )}
                {m.attachments?.length > 0 && (
                  <div className="chat-images">
                    {m.attachments.map((a) => (
                      <a
                        key={a}
                        href={mediaUrl(a)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        <img src={mediaUrl(a)} alt="聊天图片" />
                      </a>
                    ))}
                  </div>
                )}
                {m.system?.event && <EventDetails event={m.system.event} />}
                {m.system?.cleared&&<span className="badge">场景已清理 · 历史记录保留</span>}
                {m.system?.corpses?.map(c => <BattleLoot key={c.id}
                  corpse={game?.corpses?.find(live => live.id === c.id) || { ...c, canClaim: false, blockedReason: "仅本场参战角色可拾取；若刚结束战斗，请稍候刷新。" }}
                  prepare={prepare} busy={busy} />)}
                {notificationTarget(m.system,gm) && <button onClick={()=>navigateNotice(m.system)}>
                  {m.system?.corpses ? '查看战利品与战斗' : m.system?.kind==='webDefense' ? '前往防守' : m.system?.kind==='webNotice' ? '前往处理' : m.system?.battleId ? '打开战斗面板' : m.system?.mapId ? '打开对应地图' : '查看团务'} →
                </button>}
              </div>
            </article>
          ))}
        <div ref={bottom} className="chat-bottom" />
        </div>
      </div>
      {scroll.unseen>0&&<button type="button" className="chat-new-messages" onClick={scroll.followLatest}>{scroll.unseen} 条新消息 · 回到最新 ↓</button>}
      <form className="composer" onSubmit={send}>
        {reply && (
          <div className="reply-banner">
            回复 {reply.authorName}：{reply.text.slice(0, 100)}
            <button type="button" onClick={() => Reply(null)}>
              ×
            </button>
          </div>
        )}
        {attachments.length > 0 && (
          <div className="toolbar">
            {attachments.map((a) => (
              <span className="badge" key={a.id}>
                <img
                  className="image-preview"
                  src={mediaUrl(a.id)}
                  alt={a.name}
                />
                {a.name}
                <button
                  type="button"
                  onClick={() =>
                    Attachments((old) => old.filter((x) => x.id !== a.id))
                  }
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          aria-label="聊天消息"
          disabled={!roomId || readOnly}
          placeholder={
            readOnly
              ? "系统记录自动发布，普通聊天请选择其他频道。"
              : "发送消息，或用角色 RP 记录你的故事…"
          }
          maxLength={kind === "rp" ? 1000 : 4000}
          value={drafts[roomId] || ""}
          onChange={(e) => {
            Drafts((old) => ({ ...old, [roomId]: e.target.value }));
            delete client.current[roomId];
          }}
          onKeyDown={(e) => {
            if (shouldSend(e,me.user.preferences?.sendShortcut||'ctrlEnter')) { e.preventDefault(); void send(e); }
          }}
        />
        <div className="composer-tools">
          <div className="toolbar">
            <select
              aria-label="消息类型"
              disabled={readOnly}
              value={kind}
              onChange={(e) => {
                Kind(e.target.value);
                delete client.current[roomId];
              }}
            >
              <option value="text">普通聊天</option>
              <option value="rp">角色 RP</option>
              <option value="dice">掷骰（如 2d20+3）</option>
            </select>
            {kind==='rp'&&gm&&<select aria-label="RP 发言身份" value={composer.npcId||''} onChange={e=>{change('npcId',e.target.value);delete client.current[roomId];}}><option value="">我的玩家角色</option>{personas.map(n=><option key={n.id} value={n.id}>{n.name} · {n.source}</option>)}</select>}
            {kind === "dice" && (
              <select
                aria-label="掷骰模式"
                value={mode}
                onChange={(e) => Mode(e.target.value)}
              >
                <option value="normal">普通</option>
                <option value="advantage">优势</option>
                <option value="disadvantage">劣势</option>
              </select>
            )}
            <label className="upload-button">
              ＋ 图片
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple
                disabled={busy || readOnly}
                onChange={(e) => upload([...e.target.files])}
              />
            </label>
          </div>
          <button className="primary" disabled={sending || readOnly || !roomId}>
            {sending ? "保存中…" : "发送 ↗"}
          </button>
        </div>
        <details className="composer-settings"><summary>{(me.user.preferences?.sendShortcut||'ctrlEnter')==='enter'?'Enter 发送 · Shift + Enter 换行':'Ctrl / ⌘ + Enter 发送'} · 发送设置</summary><small className="muted">
          <select aria-label="发送快捷键" value={me.user.preferences?.sendShortcut||'ctrlEnter'} onChange={e=>onPreferences({sendShortcut:e.target.value})}><option value="ctrlEnter">Ctrl / ⌘ + Enter 发送</option><option value="enter">Enter 发送 · Shift + Enter 换行</option></select> ·{" "}
          {kind === "rp" ? "RP 不改变规则判定" : "断线后保留输入与原消息编号"}
        </small></details>
      </form>
    </>
  );
}
function GMInbox({groupId,active,event,onNavigate,error,onRead}){
  const [items,Items]=useState([]),[loaded,Loaded]=useState(false);const request=useRef(0);
  useEffect(()=>{if(!active)return;const version=++request.current;api('/groups/'+groupId+'/inbox').then(r=>{if(version===request.current){Items(r.items||[]);Loaded(true);if(r.roomId&&r.items?.length)void api('/rooms/'+encodeURIComponent(r.roomId)+'/read',{sequence:Math.max(...r.items.map(i=>i.sequence||0))}).then(summary=>{if(version===request.current)onRead?.(summary);}).catch(()=>{});else if(!r.unread)onRead?.();}}).catch(e=>{if(version===request.current)error(e.message);});return()=>{request.current++;};},[active,groupId,event?.type==='state'?event.data?.revision:null,event?.type==='inbox-unread'?event.at:null]);
  return <section className="panel gm-inbox"><h3>GM 待办与隐藏通知</h3><p className="muted">仅本团 GM 可见。处理后以最新状态为准。</p>{!loaded?<p>正在读取…</p>:!items.length?<p>当前没有 GM 待办。</p>:items.map(item=><article key={item.id}><h4>{item.title||item.name||'待处理事项'}</h4><p>{item.text||item.description}</p>{notificationTarget(item.system,true)&&<button onClick={()=>onNavigate(item.system)}>前往处理 →</button>}</article>)}</section>;
}
function EventDetails({ event }) {
  return <BattleEventDetails event={event}/>;
}
function Library({ me, groupId, gm, run, error, notice, refresh }) {
  const [entries, Entries] = useState([]),
    [proposals, Proposals] = useState([]),
    [q, Q] = useState(""),
    [sync, Sync] = useState(null),
    [resolutions, Resolutions] = useState({}),
    [rejectReasons, RejectReasons] = useState({}),
    [p, P] = useState({ collection: "catalog", templateId: "" });
  async function load() {
    Entries(await api("/library"));
    if (me.user.admin) Proposals(await api("/library/proposals"));
  }
  useEffect(() => {
    load().catch((e) => error(e.message));
  }, []);
  return (
    <>
      <section className="panel">
        <span className="eyebrow">共同记录的知识</span>
        <h3>公共模板库</h3>
        <p>
          管理员审核后发布，各团保存自己的版本。已发物品和活动遭遇保持快照。
        </p>
        <input
          placeholder="搜索模板名称"
          value={q}
          onChange={(e) => Q(e.target.value)}
        />
        {gm && (
          <div className="toolbar">
            <button
              className="primary"
              onClick={() =>
                run(async () =>
                  Sync(await api("/groups/" + groupId + "/library/sync", {})),
                ).catch(() => {})
              }
            >
              检查同步差异
            </button>
            <select
              value={p.collection}
              onChange={(e) => P({ collection: e.target.value, templateId: "" })}
            >
              {[
                ["catalog", "物品"],
                ["skillTemplates", "技能"],
                ["npcTemplates", "NPC"],
                ["roomTemplates", "房间"],
                ["traits", "词条"],
                ["conditionTemplates", "异常"],
                ["couponPools", "兑换池"],
                ["bossPools", "BOSS池"],
                ["merchantTemplates", "行商"],
                ["glossaryTerms", "名词"],
                ["checkSkillTemplates", "鉴定技能"],
                ["mapCategories", "地图分类"],
              ].map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
            <label className="field"><span>本团模板</span><SearchSelect source={p.collection} value={p.templateId} onChange={templateId=>P({...p,templateId})}/></label>
            <button
              onClick={() =>
                run(() =>
                  api("/groups/" + groupId + "/library/propose", p).then(() =>
                    notice("入库申请已提交，等待管理员审核。"),
                  ),
                ).catch(() => {})
              }
            >
              申请入库
            </button>
          </div>
        )}
        <div className="library-cards">
          {entries
            .filter((e) =>
              (e.template.name || e.template.title || "").includes(q),
            )
            .map((e) => (
              <article key={e.id}>
                <span className="badge">
                  {labels[e.collection]||"模板"} · 公共 v{e.version}
                </span>
                <h4>{e.template.name || e.template.title}</h4>
                <p>{e.template.description || "已发布的共用模板"}</p>

              </article>
            ))}
        </div>
      </section>
      {sync && (
        <section className="panel">
          <h3>同步预览</h3>
          <Result value={sync.changes} />
          {sync.conflicts.length > 0 && (
            <>
              <h4>保留本地内容的冲突</h4>
              <Result value={sync.conflicts} />
              {sync.conflicts.map((c) => (
                <label className="field" key={c.id}>
                  <span>
                    {c.name || '相关模板'}：{c.reason}
                  </span>
                  <input
                    type="checkbox"
                    disabled={!!c.missing?.length}
                    checked={resolutions[c.id] === "replace"}
                    onChange={(e) =>
                      Resolutions({
                        ...resolutions,
                        [c.id]: e.target.checked ? "replace" : "keep",
                      })
                    }
                  />
                  明确使用公共版本覆盖
                </label>
              ))}
            </>
          )}
          <button
            className="primary"
            onClick={() =>
              run(async () => {
                const r = await api("/groups/" + groupId + "/library/sync", {
                  commit: true,
                  preview: sync,
                  resolutions,
                  operationId: id(),
                });
                notice(
                  "已同步 " +
                    r.updated +
                    " 项，保留 " +
                    r.conflicts.length +
                    " 项冲突。",
                );
                Sync(null);
                await refresh();
              }).catch(() => {})
            }
          >
            同步可更新项
          </button>
          <button onClick={() => Sync(null)}>取消</button>
        </section>
      )}
      {me.user.admin && (
        <section className="panel">
          <h3>待审核申请</h3>
          {proposals
            .filter((f) => f.status === "pending")
            .map((f) => (
              <article key={f.id}>
                <h4>
                  {f.template.name} · {labels[f.collection]||"模板"}
                </h4>
                <Result value={f.template} />
                <button
                  onClick={() =>
                    run(async () => {
                      const current = entries.find(
                        (e) =>
                          e.collection === f.collection &&
                          e.templateId === f.templateId,
                      );
                      await api("/library/review", {
                        id: f.id,
                        baseVersion: current?.version || 0,
                        operationId: id(),
                      });
                      await load();
                    }).catch(() => {})
                  }
                >
                  审核并发布
                </button>
                <label className="field"><span>驳回理由</span><input maxLength={1000} value={rejectReasons[f.id]||""} onChange={e=>RejectReasons({...rejectReasons,[f.id]:e.target.value})}/></label>
                <button disabled={!rejectReasons[f.id]?.trim()} onClick={()=>run(()=>api("/library/review",{id:f.id,reject:true,reason:rejectReasons[f.id],operationId:id()}).then(load)).catch(()=>{})}>驳回</button>
              </article>
            ))}
        </section>
      )}
    </>
  );
}
function Settings({
  me,
  group,
  groupId,
  members,
  Groups,
  refresh,
  run,
  error,
  notice,
  boot,
  game,
  openDM,
  rooms,
  AccountRecovery,
  onAvatarSaved,
}) {
  const [devices, Devices] = useState([]),
    [users, Users] = useState([]),
    [secret, Secret] = useState(""),
    [p, P] = useState({}),
    [invite, Invite] = useState(""),[deletion,Deletion]=useState(null),[preferences,Preferences]=useState(me.user.preferences||{artStyle:"magic",killEffects:true});
  useEffect(()=>{if(!deletion||deletion.status==="deleted")return;const t=setInterval(()=>api("/admin/groups/"+deletion.groupId+"/deletion").then(Deletion).catch(()=>{}),2500);return()=>clearInterval(t);},[deletion?.groupId,deletion?.status]);
  useEffect(() => {
    api("/auth/devices")
      .then(Devices)
      .catch(() => {});
    if (me.user.admin)
      api("/admin/users")
        .then(Users)
        .catch(() => {});
  }, []);
  return (
    <>
      {group && <AccountAvatar {...{ me, groupId }} member={members.find(m => m.userId === me.user.id)} onSaved={onAvatarSaved}/>}
      {group && <MemberDirectory {...{ members, game, openDM, me, groupId }} />}
      <section className="panel">
        <h3>营地与成员</h3>
        {me.user.admin && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api("/groups", {
                  name: p.groupName,
                  description: "",
                  operationId: id(),
                });
                Groups(await api("/groups"));
                notice("跑团已建立。");
              }).catch(() => {});
            }}
          >
            <label className="field">
              <span>新团名称</span>
              <input
                required
                value={p.groupName || ""}
                onChange={(e) => P({ ...p, groupName: e.target.value })}
              />
            </label>
            <button>建立跑团</button>
          </form>
        )}
        <form
          className="toolbar"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api("/groups/join", { code: invite });
              Groups(await api("/groups"));
              Invite("");
            }).catch(() => {});
          }}
        >
          <input
            required
            placeholder="输入GM提供的邀请码"
            value={invite}
            onChange={(e) => Invite(e.target.value)}
          />
          <button>加入跑团</button>
        </form>
        {group && ["admin", "gm"].includes(group.role) && (
          <>
            <label className="field">
              <span>营地公告</span>
              <textarea
                maxLength={4000}
                value={p.announcement ?? group.announcement ?? ""}
                onChange={(e) => P({ ...p, announcement: e.target.value })}
              />
            </label>
            <button
              onClick={() =>
                run(() =>
                  api("/groups/" + groupId + "/settings", {
                    version: group.version,
                    autoSync: group.autoSync,
                    announcement: p.announcement ?? group.announcement ?? "",
                  })
                    .then(() => api("/groups"))
                    .then(Groups),
                ).catch(() => {})
              }
            >
              保存公告
            </button>
            <Invitations {...{groupId,run,error}}/>
            <label className="field">
              <span>每24小时自动同步公共库</span>
              <input
                type="checkbox"
                checked={group.autoSync !== false}
                onChange={(e) =>
                  run(async () => {
                    await api("/groups/" + groupId + "/settings", {
                      version: group.version,
                      autoSync: e.target.checked,
                    });
                    Groups(await api("/groups"));
                  }).catch(() => {})
                }
              />
            </label>
            {members.map((m) => (
              <div className="result-row" key={m.userId}>
                <b>{m.name}</b>
                <span>
                  {m.role === "gm" ? "GM" : "玩家"} · {m.active ? "有效" : "已移除"}
                </span>
                {me.user.admin && (
                  <button
                    onClick={() =>
                      run(() =>
                        api("/groups/" + groupId + "/members", {
                          userId: m.userId,
                          role: m.role === "gm" ? "player" : "gm",
                          version: m.version,
                        }).then(refresh),
                      ).catch(() => {})
                    }
                  >
                    {m.role === "gm" ? "改为玩家" : "任命GM"}
                  </button>
                )}
                <button
                  onClick={() => {
                      run(() =>
                        api("/groups/" + groupId + "/members", {
                          userId: m.userId,
                          role: m.role,
                          active: false,
                          version: m.version,
                        }).then(refresh),
                      ).catch(() => {});
                  }}
                >
                  移出本团
                </button>
              </div>
            ))}
            {me.user.admin && (
              <div className="toolbar">
                <select
                  value={p.userId || ""}
                  onChange={(e) => P({ ...p, userId: e.target.value })}
                >
                  <option value="">选择网站账号</option>
                  {users.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.displayName}（{u.name}）
                    </option>
                  ))}
                </select>
                <button
                  disabled={!p.userId}
                  onClick={() =>
                    run(() =>
                      api("/groups/" + groupId + "/members", {
                        userId: p.userId,
                        role: "gm",
                      }).then(refresh),
                    ).catch(() => {})
                  }
                >
                  任命新GM到此团
                </button>
              </div>
            )}
          </>
        )}
      </section>
      <section className="panel">
        <h3>展示偏好</h3><label className="field"><span>技能及 RP 标题风格</span><select value={preferences.artStyle} onChange={e=>Preferences({...preferences,artStyle:e.target.value})}><option value="tactical">战术 · 钢铁铭文</option><option value="magic">魔法 · 星火符文</option><option value="psychic">精神 · 幻象回响</option></select></label><BattleEffectsSettings/><button onClick={()=>run(async()=>{await api('/preferences',{artStyle:preferences.artStyle});await boot();notice('展示偏好已保存。');}).catch(()=>{})}>保存标题风格</button>
        <h3>账号安全</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api("/auth/password", {
                currentPassword: p.currentPassword,
                password: p.password,
              });
              AccountRecovery(r.recovery);
              notice("密码已修改，旧设备已退出。");
            }).catch(() => {});
          }}
        >
          {[
            ["currentPassword", "当前密码"],
            ["password", "新密码"],
          ].map(([k, l]) => (
            <label className="field" key={k}>
              <span>{l}</span>
              <input
                required
                type="password"
                autoComplete={
                  k === "password" ? "new-password" : "current-password"
                }
                value={p[k] || ""}
                onChange={(e) => P({ ...p, [k]: e.target.value })}
              />
            </label>
          ))}
          <button>修改密码并退出旧设备</button>
        </form>
        <div className="toolbar">
          <button
            onClick={() =>
              api("/auth/logout", {})
                .then(boot)
                .catch((e) => error(e.message))
            }
          >
            退出登录
          </button>
        </div>
        {devices.map((d) => (
          <div className="result-row" key={d.id}>
            <b>
              {d.name}
              {d.current ? " · 当前设备" : ""}
            </b>
            <span>
              {d.revokedAt
                ? "已退出"
                : new Date(d.expiresAt).toLocaleDateString() + " 到期"}
            </span>
            <button
              disabled={!!d.revokedAt}
              onClick={() =>
                run(async () => {
                  await api("/auth/devices/revoke", { id: d.id });
                  Devices(await api("/auth/devices"));
                }).catch(() => {})
              }
            >
              退出设备
            </button>
          </div>
        ))}
      </section>
      {me.user.admin && (
        <section className="panel">
          <h3>管理员团管理</h3>
          {group&&<article className="delete-group"><h4>{group.name}</h4><p>永久删除此团的成员关系、邀请码、频道与私聊、消息、图片、角色资产、模板、地图、战斗及草稿。网站账号、其他团与已发布公共库保留。点击即执行，无法从网站恢复。</p><button className="danger" disabled={!!deletion&&deletion.status!=='deleted'} onClick={()=>run(async()=>{const r=await api('/admin/groups/'+group.id+'/delete',{operationId:id(),baseVersion:group.version});Deletion(r);Groups(await api('/groups'));notice('删除已开始，图片清理将在后台完成。');}).catch(()=>{})}>永久删除团</button></article>}
          {deletion&&<p role="status">删除进度：{{deleting:'正在删除',deleted:'已删除',cleanup_error:'清理异常，后台将继续重试'}[deletion.status]}</p>}
          <h3>管理员账号管理</h3>
          {users.map((u) => (
            <div className="result-row" key={u.id}>
              <b>{u.displayName}</b>
              <small>{u.name}</small>
              <button
                onClick={() =>
                  run(async () => {
                    const r = await api("/admin/reset", { userId: u.id });
                    Secret("15分钟密码重置凭证：" + r.token);
                  }).catch(() => {})
                }
              >
                生成密码重置凭证
              </button>
              <button
                disabled={u.id === me.user.id}
                onClick={() => {
                    run(() =>
                      api("/admin/user", {
                        userId: u.id,
                        disabled: !u.disabled,
                      })
                        .then(() => api("/admin/users"))
                        .then(Users),
                    ).catch(() => {});
                }}
              >
                {u.disabled ? "恢复账号" : "停用账号"}
              </button>
            </div>
          ))}
        </section>
      )}
      {secret && (
        <div className="modal">
          <section className="panel">
            <h3>请私密保存或交给指定成员</h3>
            <code className="recovery">{secret}</code>
            <button onClick={() => Secret("")}>完成</button>
          </section>
        </div>
      )}
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
