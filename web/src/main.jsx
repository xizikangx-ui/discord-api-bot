const SkillBook=React.lazy(()=>import("./skills").then(m=>({default:m.SkillBook})));
import {freshKills} from "./kill-effects";
import { BattleLoot } from "./battle-loot";
import { notificationTarget } from "./notification-target";
import { GroupHome, MemberDirectory, ChannelManager } from "./community";
import React, { useState, useEffect, useRef, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { api, id, setCsrf, mediaUrl } from "./api";
import { setTransport, labels } from "../../gm-web/src/data";
import {Result} from "../../gm-web/src/result";
import {Field,SearchSelect} from "../../gm-web/src/controls";
const gmComponent=name=>React.lazy(()=>import("../../gm-web/src/main").then(m=>({default:m[name]})));
const Templates=gmComponent('Templates'),Grant=gmComponent('Grant'),World=gmComponent('World'),Commands=gmComponent('Commands'),Audit=gmComponent('Audit');
const playerComponent=name=>React.lazy(()=>import("./players").then(m=>({default:m[name]})));
const PlayerPanel=playerComponent('PlayerPanel'),ExplorePanel=playerComponent('ExplorePanel'),BattlePanel=playerComponent('BattlePanel'),ActivitiesPanel=playerComponent('ActivitiesPanel');
import {allSections,mergeGame,refreshQueue,unreadEvent,markRead} from './refresh-state';
import {chatTasks} from './chat-tasks';
import {roomMessages,mergeMessages} from "./chat-state";
import "./style.css";
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
    [recovery, R] = useState("");
  const busyRef=useRef(false);
  useEffect(() => {
    api("/auth/status")
      .then((s) => {
        if (!s.initialized && p.token) M("bootstrap");
      })
      .catch((e) => E(e.message));
    if (location.hash) history.replaceState(null, "", location.pathname);
  }, []);
  const title = {
    login: "返回营地",
    register: "加入荒原",
    bootstrap: "建立你的指挥站",
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
        <span className="eyebrow">WASTELAND ARCHIVES / ONLINE</span>
        <div className="hero-mark">◈</div>
        <h1>荒原档案</h1>
        <p>
          在失序的世界里，
          <br />
          留下属于你们的故事。
        </p>
        <div className="auth-lines">
          <span>01 / 角色与探索</span>
          <span>02 / 战术与裁决</span>
          <span>03 / 同伴与叙事</span>
        </div>
        <small>独立账号 · 多团存档 · 实时聊天</small>
      </div>
      <section className="auth-form panel">
        <span className="eyebrow">ESTABLISH CONTACT</span>
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
function Keep({ show, children }) {
  const [seen, Seen] = useState(show);
  useEffect(() => {
    if (show) Seen(true);
  }, [show]);
  return seen || show ? <div hidden={!show}><Suspense fallback={<div className="loading">正在载入面板…</div>}>{children}</Suspense></div> : null;
}
function PendingTasks({game,userId,onNavigate,onOpen}){const tasks=chatTasks(game,userId);return tasks.length?<div className="chat-tasks" aria-label="待处理事项">{tasks.map(t=><button key={t.key} className={t.system?.hitId?'urgent':''} onClick={()=>t.system?onNavigate(t.system):onOpen(t.tab)}>{t.text}</button>)}</div>:null;}
function App() {
  const [me, Me] = useState(null),
    [booting, Boot] = useState(true),
    [groups, Groups] = useState([]),
    [groupId, Group] = useState(""),
    [tab, Tab] = useState("chat"),
    [rooms, Rooms] = useState([]),
    [roomId, Room] = useState(""),
    [members, Members] = useState([]),
    [game, Game] = useState(null),
    [schema, Schema] = useState(null),
    [error, E] = useState(""),
    [notice, N] = useState(""),
    [busy, B] = useState(false),
    [preview, Preview] = useState(null),
    [pendingOperation, PendingOperation] = useState(null),
    [navigation, Navigation] = useState(null),
    [result, R] = useState(null),
    [killEffect,KillEffect]=useState(null),
    [accountRecovery, AccountRecovery] = useState(""),
    [connected, Conn] = useState(false),
    [chatEvent, ChatEvent] = useState(null),
    [drafts, Drafts] = useState(() => {
      try {
        return JSON.parse(
          sessionStorage.getItem("wasteland-editor-drafts") || "{}",
        );
      } catch {
        return {};
      }
    }),
    [gmTab, GmTab] = useState("templates");
  const ws = useRef(null),
    active = useRef({}),
    seenDeaths=useRef(new Set()),liveReady=useRef(false),prefsRef=useRef(null),
    refreshTimer = useRef(null),
    busyRef = useRef(false),
    pendingRef = useRef(null),
    gameRef=useRef(null), readQueues=useRef(new Map()),directoryGroup=useRef(null),epoch=useRef(0),
    [foreground,Foreground]=useState(document.visibilityState==='visible'),
    [mobileSide, MobileSide] = useState(false);
  const group = groups.find((g) => g.id === groupId),
    gm = ["gm", "admin"].includes(group?.role),
    scope = groupId + ":" + me?.user.id;
  active.current = { groupId, roomId, scope };
  pendingRef.current=pendingOperation;gameRef.current=game;
  prefsRef.current=me?.user.preferences;window.webArtStyle=me?.user.preferences?.artStyle||"tactical";
  useEffect(()=>{if(!killEffect)return;const t=setTimeout(()=>KillEffect(null),2100);return()=>clearTimeout(t);},[killEffect]);
  async function boot() {
    try {
      const a = await api("/auth/me");
      setCsrf(a.csrf);
      Me(a);
      Groups(await api("/groups"));
    } catch {
      Me(null);
    } finally {
      Boot(false);
    }
  }
  useEffect(() => {
    boot();
  }, []);
  async function refresh(options={}) {
    const g=active.current.groupId;if(!g)return;
    const generation=epoch.current;
    if(!readQueues.current.has(g))readQueues.current.set(g,refreshQueue(
      async keys=>api('/groups/'+g+'/game'+(gameRef.current?'?sections='+keys.join(','):'')),
      data=>{if(active.current.groupId!==g||epoch.current!==generation)return;if(!liveReady.current){for(const id of data.historicalDeathIds||[])seenDeaths.current.add(id);liveReady.current=true;}gameRef.current=mergeGame(gameRef.current,data);Game(gameRef.current);}
    ));
    const jobs=[readQueues.current.get(g)(options.sections||allSections)];
    if(directoryGroup.current!==g||options.directory){directoryGroup.current=g;jobs.push(Promise.all([api('/groups/'+g+'/rooms'),api('/groups/'+g+'/members')]).then(([r,m])=>{if(active.current.groupId===g&&epoch.current===generation){Rooms(r);Members(m);}}).catch(e=>{if(epoch.current===generation)directoryGroup.current=null;throw e;}));}
    await Promise.all(jobs);
  }
  useEffect(()=>{const changed=()=>Foreground(document.visibilityState==='visible');document.addEventListener('visibilitychange',changed);return()=>document.removeEventListener('visibilitychange',changed);},[]);
  useEffect(() => {
    if (!me) return;
    const gid = groups.some((g) => g.id === groupId)
      ? groupId
      : groups[0]?.id || "";
    if (gid !== groupId) Group(gid);
  }, [groups, me]);
  useEffect(() => {
    liveReady.current=false;KillEffect(null);
    epoch.current++;Game(null);gameRef.current=null;directoryGroup.current=null;readQueues.current.clear();Tab("chat");Navigation(null);
    Rooms([]);
    Room("");
    Schema(null);
    Preview(null);
    PendingOperation(drafts[groupId+":"+me?.user.id]?.pendingOperation||null);
    R(null);
    if (!groupId || !me) return;
    refresh().catch((e) => E(e.message));
    const base = "/groups/" + groupId + "/gm";
    setTransport((path, body) => api(base + path, body));
    window.gmMediaBase = "/api/web/v1" + base;
    window.gmDirect=true;
    window.gmSession = { guildId: groupId, userId: me.user.id };
    if (gm)
      Promise.all([api(base + "/schemas"), api(base + "/directory")])
        .then(([s, d]) => {
          if (active.current.groupId !== groupId) return;
          Schema(s);
          window.gmSchema = s;
          window.gmDirectory = d;
          window.gmBoxes = s.boxes;
          Object.assign(labels, s.attributeLabels);
        })
        .catch((e) => E(e.message));
  }, [groupId, me?.user.id, gm]);
  useEffect(()=>{
    if(!groupId||!me||!foreground)return;
    let alive=true,pending=false;
    async function check(){if(pending)return;pending=true;try{const v=await api('/groups/'+groupId+'/version');if(!alive||active.current.groupId!==groupId)return;const keys=allSections.filter(k=>v.sectionVersions?.[k]!==gameRef.current?.sectionVersions?.[k]);if(keys.length)await refresh({sections:keys});}catch{}finally{pending=false;}}
    void check();const timer=setInterval(check,5000);return()=>{alive=false;clearInterval(timer);};
  },[groupId,me?.user.id,foreground]);
  useEffect(() => {
    if (!rooms.some((r) => r.id === roomId))
      Room(rooms.find((r) => r.kind === "chat")?.id || rooms[0]?.id || "");
  }, [rooms]);
  useEffect(() => {
    if (!me) return;
    let alive = true,
      retry;
    function open() {
      const socket = new WebSocket(
        (location.protocol === "https:" ? "wss://" : "ws://") +
          location.host +
          "/ws",
      );
      ws.current = socket;
      socket.onopen = () => {
        Conn(true);liveReady.current=false;
        socket.send(
          JSON.stringify({
            type: "subscribe",
            groupId: active.current.groupId || undefined,
            roomId: active.current.roomId || undefined,
          }),
        );
        refresh().catch(() => {});
        ChatEvent({ type: "reconnect", at: Date.now() });
      };
      socket.onmessage = (e) => {
        const event = JSON.parse(e.data);
        const kills=freshKills(event,seenDeaths.current,liveReady.current);if(kills.length&&prefsRef.current?.killEffects!==false)KillEffect({id:kills.join(":"),count:kills.length});
        if(event.type==='room-unread'){Rooms(old=>unreadEvent(old,event.data));}
        else if(event.type==='state'){
          if(document.visibilityState==='visible')refresh({sections:event.data.sections||allSections}).catch(e=>E(e.message));
        } else if(event.type==='permissions') {
          epoch.current++;directoryGroup.current=null;readQueues.current.clear();refresh({directory:true}).catch(()=>{});
        } else ChatEvent(event);
      };
      socket.onclose = (e) => {
        Conn(false);
        if ([4001, 4003].includes(e.code)) {
          boot();
          E("登录或访问权限已变化，请重新核对。");
        }
        if (alive) retry = setTimeout(open, 2500);
      };
      socket.onerror = () => socket.close();
    }
    open();
    return () => {
      alive = false;
      clearTimeout(retry);
      ws.current?.close();
    };
  }, [me?.user.id]);
  useEffect(() => {
    if (ws.current?.readyState === 1)
      ws.current.send(
        JSON.stringify({
          type: "subscribe",
          groupId: groupId || undefined,
          roomId: roomId || undefined,
        }),
      );
  }, [groupId, roomId]);
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
    }
  }
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
    await run(async()=>{
      PendingOperation(request);saveLocal('pendingOperation',request);
      try{
        const r=await api('/groups/'+targetGroup+(isGM?'/gm/execute':'/game/execute'),{operationId,command,params,versions:game?.versions});
        if(active.current.groupId!==targetGroup)return;
        R(command==='corpse.claim'?null:r.result);PendingOperation(null);saveLocal('pendingOperation',null);N(command==='corpse.claim'?'已拾取，物品已放入背包。':'已保存，通知在后台更新。');await refresh();
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
    const r=await api('/groups/'+request.groupId+'/game/operations/'+request.operationId);
    if(active.current.groupId!==request.groupId || pendingRef.current?.operationId!==request.operationId)return;
    if(r.status==='committed'){E('');R(request.command==='corpse.claim'?null:r.result);PendingOperation(null);saveLocal('pendingOperation',null);N(request.command==='corpse.claim'?'已核对：战利品已放入背包。':'上一操作已保存，可以继续操作。');await refresh();}
    else if(r.status==='uncommitted'){PendingOperation(null);saveLocal('pendingOperation',null);N('权威记录确认此操作未保存。填写内容已保留，可重新提交。');}
    else N(r.status==='processing'?'原操作仍在处理中，请稍后查询。':'保存结果尚未明确，修改保持暂停。');
    return r;
  }
  useEffect(()=>{
    if(!pendingOperation || pendingOperation.groupId!==groupId || !me)return;
    let alive=true,timer;
    const check=async()=>{if(!alive)return;if(!busyRef.current && document.visibilityState==='visible')await checkDirect(pendingOperation).catch(()=>{});if(alive)timer=setTimeout(check,5000);};
    void check();return()=>{alive=false;clearTimeout(timer);};
  },[groupId,me?.user.id,pendingOperation?.operationId]);
  function openRoom(id){Room(id);Tab('chat');MobileSide(false);}
  function navigateNotice(system){
    const target=notificationTarget(system,gm);if(!target)return;
    Navigation({...target,key:id()});Tab(target.tab);if(target.tab==='gm')GmTab(target.gmTab);MobileSide(false);
  }
  async function receipt() {
    if (!preview) return;
    const r = await api("/groups/" + groupId + "/game/receipt/" + preview.id);
    if (r.status === "committed") {
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
        sessionStorage.setItem("wasteland-editor-drafts", JSON.stringify(next));
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
  if (booting) return <div className="loading">◈ 正在连接指挥站…</div>;
  if (!me) return <Auth done={boot} />;
  return (
    <div className="site integrated-site">
      <aside className={"site-sidebar " + (mobileSide ? "shown" : "")}>
        <div className="brand">
          <span className="sigil">◈</span>
          <h1>
            荒原档案<small>TABLETOP / ONLINE</small>
          </h1>
        </div>
        <label className="group-picker">
          <small>当前跑团</small>
          <select
            aria-label="切换跑团"
            value={groupId}
            onChange={(e) => Group(e.target.value)}
          >
            <option value="">选择跑团</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
        <nav>
          {[

            ["chat", "◌", "营地通讯"],






            ...(gm ? [["gm", "⌘", "GM 工作台"]] : []),

            ...(me.user.admin ? [["settings", "⚙", "网站管理"]] : []),
          ].map(([k, icon, name]) => (
            <button
              key={k}
              className={tab === k ? "active" : ""}
              onClick={() => {
                Tab(k);
                MobileSide(false);
              }}
            >
              <span>{icon}</span>
              {name}
            </button>
          ))}
        </nav>
        <div className="channel-list">
          <div className="section-title">
            <small>本团频道</small>
            {gm && (
              <button
                title="新建频道"
                onClick={() => {
                  Tab("settings");
                }}
              >
                ＋
              </button>
            )}
          </div>
          {rooms.map((r) => (
            <button
              key={r.id}
              className={roomId === r.id ? "chosen" : ""}
              onClick={() => {
                Room(r.id);
                Tab("chat");
                MobileSide(false);
              }}
            >
              <span>
                {r.kind === "gm" ? "▰" : r.kind === "dm" ? "↗" : "#"}
              </span>
              {r.name}
              {r.unread > 0 && <b className="unread">{r.unread}</b>}
            </button>
          ))}
        </div>
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
      <main className="site-main">
        <header className="site-header">
          <button
            className="mobile-menu"
            aria-label="打开导航"
            onClick={() => MobileSide(!mobileSide)}
          >
            ☰
          </button>
          <div>
            <span className="eyebrow">
              {tab === "chat"
                ? "CAMP COMMUNICATIONS"
                : "TACTICAL FIELD TERMINAL"}
            </span>
            <h2>
              {tab !== "gm"
                ? rooms.find((r) => r.id === roomId)?.name || "营地通讯"
                : group?.name || "跑团大厅"}
            </h2>
          </div>
          <div className="header-tags">
            <span className="badge">{group?.name || "尚未入团"}</span>
            <small>存档 v{game?.revision || 0}</small>
          </div>
        </header>
        {error && (
          <div className="banner error" role="alert">
            {error}
            <button onClick={() => E("")}>×</button>
          </div>
        )}
        {notice && (
          <div className="banner" role="status">
            {notice}
            <button onClick={() => N("")}>×</button>
          </div>
        )}
        {pendingOperation && <div className="banner" role="status"><span>上一操作待核对；仍可查看消息和面板。</span><button disabled={busy} onClick={()=>run(()=>checkDirect()).catch(()=>{})}>查询保存结果</button></div>}
        {game?.battles.some((b) => b.pending.length) && (
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
                rooms,
              }}
            />
          </section>
        ) : (
          <>
            <div className={"chat-workspace "+(tab!=="chat"?"with-panel":"")+(tab==="gm"?" gm-workspace":"")}><div hidden={tab==="gm"} className="chat-page">
              <div className="player-toolbar" aria-label="玩家工具栏">{[["character","角色"],["bag","背包"],["skills","技能"],["explore","探索"],["battle","战斗"],["activities","团务"],["more","更多"]].map(([k,name])=><button key={k} className={tab===k?"active":""} onClick={()=>Tab(tab===k?"chat":k)}>{name}</button>)}</div>
              {game?.player&&<div className="chat-character" aria-label="当前角色状态"><strong>{game.player.name}</strong><span>HP {game.player.hp}/{game.player.stats.maxHP}</span>{game.player.health.downed&&<span className="urgent">倒地生命 {game.player.health.reserveHP}/{game.player.stats.maxHP}</span>}<span>AP {game.player.ap}</span>{game.player.conditions.length>0&&<span>异常 {game.player.conditions.length} 项</span>}</div>}
              <PendingTasks game={game} userId={me.user.id} onNavigate={navigateNotice} onOpen={Tab}/>
              {result&&<details className="chat-private-result"><summary>本次操作已保存 · 查看个人结果</summary><Result value={result}/><button onClick={()=>R(null)}>收起结果</button></details>}
              <Chat
                {...{
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
                }}
                error={E}
                notice={N}
                visible={tab !== "gm"}
                onRead={(id,sequence)=>Rooms(old=>markRead(old,id,sequence))}
              />
            </div>
            <div className={"page-content "+(tab!=="gm"?"player-drawer":"")} key={groupId} hidden={tab === "chat"}>
              <header className="drawer-header"><b>{({character:"我的角色",bag:"背包与交易",skills:"技能卡册",explore:"探索地图",battle:"战术战斗",activities:"团务与资料",more:"营地服务",settings:"成员与账号",library:"公共模板库",home:"营地总览",gm:"GM工作台"})[tab]}</b><button onClick={()=>Tab("chat")} aria-label="关闭操作面板">×</button></header>{tab==='gm'&&result&&<details className="chat-private-result"><summary>本次操作已保存 · 查看结果</summary><Result value={result}/><button onClick={()=>R(null)}>收起结果</button></details>}<Suspense fallback={<div className="loading" role="status">正在载入面板…</div>}>
              <Keep show={tab==="more"}><section className="panel service-menu"><h3>营地服务</h3>{[["home","公告与未读"],["library","公共模板库"],["settings","成员、私聊与账号"],["bag","收藏柜与兑换券"],["activities","规则与名词"]].map(([k,name])=><button key={k} onClick={()=>Tab(k)}>{name}</button>)}</section></Keep>
              <Keep show={tab === "home"}>
                <GroupHome {...{ game, group, members, rooms, Preview }} onRoom={openRoom} onNavigate={navigateNotice} />
              </Keep>
              <Keep show={["character", "bag"].includes(tab)}>
                {game && (
                  <PlayerPanel
                    tab={tab}
                    game={game}
                    groupId={groupId}
                    userId={me.user.id}
                    prepare={prepare}
                    run={run}
                    refresh={refresh}
                  />
                )}
              </Keep>
              <Keep show={tab === "explore"}>
                {game && (
                  <ExplorePanel {...{ game, groupId, prepare, run, refresh }} navigation={navigation} />
                )}
              </Keep>
              <Keep show={tab === "battle"}>
                {game && (
                  <BattlePanel
                    {...{ game, groupId, prepare, run, refresh }}
                    navigation={navigation}
                    userId={me.user.id}
                  />
                )}
              </Keep>
              <Keep show={tab === "skills"}>{game&&<SkillBook {...{game,groupId,prepare}} userId={me.user.id} artStyle={me.user.preferences?.artStyle||"tactical"}/>}</Keep>
              <Keep show={tab === "activities"}>
                {game && <ActivitiesPanel {...{ game, prepare }} />}
              </Keep>
              <Keep show={tab === "gm"}>
                {gm && schema && (
                  <>
                    <div className="tabs">
                      {[
                        ["templates", "内容录入"],
                        ["grant", "角色与发放"],
                        ["maps", "地图管理"],
                        ["battles", "战斗管理"],
                        ["content", "内容与公示"],
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
                    <Keep show={gmTab === "templates"}>
                      <Templates {...common} />
                    </Keep>
                    <Keep show={gmTab === "grant"}>
                      <Grant {...common} />
                    </Keep>
                    <Keep show={gmTab === "maps"}>
                      <World {...common} kind="maps" navigation={navigation} openTemplates={() => GmTab("templates")} />
                    </Keep>
                    <Keep show={gmTab === "battles"}>
                      <World {...common} kind="battles" navigation={navigation} />
                    </Keep>
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
              <Keep show={tab === "library"}>
                <Library
                  {...{ me, groupId, gm, run }}
                  error={E}
                  notice={N}
                  refresh={refresh}
                />
              </Keep>
              <Keep show={tab === "settings"}>
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
                  }}
                />
              </Keep>
            </Suspense></div></div>
          </>
        )}
      </main>
      <aside className="character-sidebar" hidden>
        <span className="eyebrow">YOUR OPERATIVE</span>
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
              <span className="avatar">{m.name?.slice(0, 1)}</span>
              <span>
                {m.name}
                <small>{m.role === "gm" ? "GM" : "玩家"}</small>
              </span>
              {m.userId !== me.user.id && <span className="muted">↗</span>}
            </button>
          ))}
      </aside>
      {killEffect&&<div className={"kill-overlay art-"+(me.user.preferences?.artStyle||"tactical")} role="status" key={killEffect.id}><img src="/effects/kill-v1.gif" alt=""/><div><small>CONFIRMED ELIMINATION</small><h2 className="art-title">敌人已击杀</h2>{killEffect.count>1&&<p>本次击杀 {killEffect.count} 名敌人</p>}</div><button onClick={()=>KillEffect(null)}>关闭特效</button></div>}
      {preview && (
        <div className="legacy-draft">
          <section className="panel">
            <span className="eyebrow">SAVED DRAFT</span>
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
    </div>
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
}) {
  const [storedMessages, Messages] = useState([]),
    [drafts, Drafts] = useState({}),
    [composers, Composers] = useState({}),
    [online, Online] = useState([]),
    [sending, Sending] = useState(false),
    [inView, InView] = useState(false),
    [foreground, Foreground] = useState(document.visibilityState==='visible');
  const messages=roomMessages(storedMessages,roomId);
  const composer=composers[roomId]||{},attachments=composer.attachments||[],reply=composer.reply||null,kind=composer.kind||'text',mode=composer.mode||'normal';
  const change=(key,v)=>Composers(old=>{const c=old[roomId]||{},value=typeof v==='function'?v(c[key]||[]):v;return {...old,[roomId]:{...c,[key]:value}};});
  const Attachments=v=>change('attachments',v),Reply=v=>change('reply',v),Kind=v=>change('kind',v),Mode=v=>change('mode',v);
  const sendingRooms=useRef(new Set());
  const bottom = useRef(null),
    active = useRef(roomId),
    client = useRef({}),
    cursor = useRef(0);
  active.current = roomId;
  const room = rooms.find((r) => r.id === roomId),
    readOnly = room?.kind === "system";
  async function load(before) {
    if (!roomId) return;
    const r = await api(
      "/rooms/" +
        encodeURIComponent(roomId) +
        "/messages" +
        (before ? "?before=" + before : ""),
    );
    if (active.current === roomId)
      Messages((old) =>
        mergeMessages(old,r),
      );
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
        mergeMessages(old,batch),
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
        mergeMessages(old,fresh),
      );
  }
  useEffect(() => {
    Messages([]);
    cursor.current = 0;
    load().catch((e) => error(e.message));
    Sending(sendingRooms.current.has(roomId));
  }, [roomId]);
  useEffect(() => {
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
        mergeMessages(old,[chatEvent.data]),
      );
  }, [chatEvent, roomId]);
  useEffect(()=>{const handler=()=>Foreground(document.visibilityState==='visible');document.addEventListener('visibilitychange',handler);return()=>document.removeEventListener('visibilitychange',handler);},[]);
  useEffect(()=>{const observer=new IntersectionObserver(([entry])=>InView(entry.isIntersecting));if(bottom.current)observer.observe(bottom.current);return()=>observer.disconnect();},[roomId]);
  useEffect(()=>{if(messages.length)cursor.current=Math.max(cursor.current,messages.at(-1).sequence);},[messages.at(-1)?.sequence]);
  useEffect(()=>{if(visible&&foreground&&inView&&roomId&&messages.length)api('/rooms/'+encodeURIComponent(roomId)+'/read',{sequence:messages.at(-1).sequence}).then(()=>onRead(roomId,messages.at(-1).sequence)).catch(()=>{});},[visible,foreground,inView,roomId,messages.at(-1)?.sequence]);
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
      if(active.current===roomId)Messages((old) =>
        mergeMessages(old,[m]),
      );
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
      <div className="message-list">
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
                : "选择左侧频道，或先加入一个团。"}
            </p>
          </div>
        )}
        {messages
          .filter((m) => !m.superseded)
          .map((m) => (
            <article
              key={m.id}
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
              <div className="avatar">
                {m.kind === "system"
                  ? "⚑"
                  : (m.characterName || m.authorName).slice(0, 1)}
              </div>
              <div className="message-content">
                <div className={"message-title art-"+(window.webArtStyle||"tactical")}>
                  <b className={m.kind==="rp"?"art-title":""}>{m.characterName || m.authorName}</b>
                  {m.kind === "rp" && <span className="badge">角色 RP</span>}
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
                <p>{m.deleted ? "消息已删除" : m.text}</p>
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
                {m.system?.corpses?.map(c => <BattleLoot key={c.id}
                  corpse={game?.corpses?.find(live => live.id === c.id) || { ...c, canClaim: false, blockedReason: "仅本场参战角色可拾取；若刚结束战斗，请稍候刷新。" }}
                  prepare={prepare} busy={busy} />)}
                {notificationTarget(m.system,gm) && <button onClick={()=>navigateNotice(m.system)}>
                  {m.system?.corpses ? '查看战利品与战斗' : m.system?.kind==='webDefense' ? '前往防守' : m.system?.kind==='webNotice' ? '前往处理' : m.system?.battleId ? '打开战斗面板' : m.system?.mapId ? '打开对应地图' : '查看团务'} →
                </button>}
              </div>
            </article>
          ))}
        <div ref={bottom} />
      </div>
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
            if (e.ctrlKey && e.key === "Enter") send(e);
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
        <small className="muted">
          Ctrl + Enter 发送 ·{" "}
          {kind === "rp" ? "RP 不改变规则判定" : "断线后保留输入与原消息编号"}
        </small>
      </form>
    </>
  );
}
function EventDetails({ event }) {
  const [page, Page] = useState(0),
    d = event.details || {},
    parts = d.children || [],
    current = parts[page],
    result =
      current?.result ||
      (!d.children ? d.results?.[0] : null) ||
      (["result", "death"].includes(event.type) ? d : null),
    kills = result?.killed && result?.deathId ? [result.deathId] : [],
    max =
      !!result &&
      !result.dodge?.success &&
      result.perShot?.some((s) => s.maxRoll);
  return (
    <div className="event-details">
      {kills.length > 0 && <strong className="kill-callout">击杀确认</strong>}
      {max && <strong className="max-callout">满伤害命中</strong>}
      {d.healthAfter && (
        <p>
          正常 HP {d.healthBefore?.hp} → {d.healthAfter.hp}　倒地 HP{" "}
          {d.healthBefore?.reserveHP} → {d.healthAfter.reserveHP}
        </p>
      )}
      {event.rpEntries?.map((r, n) => (
        <blockquote key={r.operationId || n}>{r.text}</blockquote>
      ))}
      {parts.length > 0 && (
        <div className="toolbar">
          <button disabled={!page} onClick={() => Page(page - 1)}>
            上一目标／组
          </button>
          <span>
            {current?.name || current?.targetName || ""} {page + 1}/
            {parts.length}
          </span>
          <button
            disabled={page >= parts.length - 1}
            onClick={() => Page(page + 1)}
          >
            下一目标／组
          </button>
        </div>
      )}
      <details>
        <summary>骰点、伤害与结算详情</summary>
        <Result value={current || d} />
      </details>
    </div>
  );
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
        <span className="eyebrow">SHARED KNOWLEDGE / VERSIONED</span>
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
}) {
  const [devices, Devices] = useState([]),
    [users, Users] = useState([]),
    [secret, Secret] = useState(""),
    [p, P] = useState({}),
    [invite, Invite] = useState(""),[deletion,Deletion]=useState(null),[preferences,Preferences]=useState(me.user.preferences||{artStyle:"tactical",killEffects:true});
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
      {group && <MemberDirectory {...{ members, game, openDM, me }} />}
      {group && ["admin", "gm"].includes(group.role) && (
        <ChannelManager {...{ groupId, rooms, members, run, refresh }} />
      )}
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
            <button
              onClick={() =>
                run(async () => {
                  const r = await api("/groups/" + groupId + "/invite", {});
                  Secret("单次邀请码（7天有效）：" + r.code);
                }).catch(() => {})
              }
            >
              生成玩家注册／入团邀请
            </button>
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
        <h3>展示偏好</h3><label className="field"><span>技能及 RP 标题风格</span><select value={preferences.artStyle} onChange={e=>Preferences({...preferences,artStyle:e.target.value})}><option value="tactical">战术 · 钢铁铭文</option><option value="magic">魔法 · 星火符文</option><option value="psychic">精神 · 幻象回响</option></select></label><label><input type="checkbox" checked={preferences.killEffects} onChange={e=>Preferences({...preferences,killEffects:e.target.checked})}/>播放击杀特效</label><button onClick={()=>run(async()=>{await api('/preferences',preferences);await boot();notice('展示偏好已保存。');}).catch(()=>{})}>保存展示偏好</button>
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
