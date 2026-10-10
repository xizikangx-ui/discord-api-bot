import React, { useState } from "react";
import { api, mediaUrl } from "./api";
export function GroupHome({ game, group, members, rooms, Preview, onRoom, onNavigate }) {
  return (
    <>
      <section className="panel">
        <span className="eyebrow">CAMP OVERVIEW</span>
        <h2>{group?.name}</h2>
        <p>{group?.description || "同伴聚集之处，故事继续之地。"}</p>
        <h3>营地公告</h3>
        <p className="prose">{group?.announcement || "GM 尚未发布公告。"}</p>
        <div className="attribute-grid">
          <div>
            <span>有效成员</span>
            <b>{members?.filter((m) => m.active).length || 0}</b>
          </div>
          <button className="overview-action" onClick={() => { const r=rooms?.find(r=>r.unread>0)||rooms?.[0];if(r)onRoom(r.id); }}>
            <span>未读消息</span>
            <b>{rooms?.reduce((n, r) => n + r.unread, 0) || 0}</b>
            <small>点击打开对应频道</small>
          </button>
          <button className="overview-action" onClick={() => onNavigate({battleId:game?.battles[0]?.id})}>
            <span>进行中战斗</span>
            <b>{game?.battles.length || 0}</b>
          </button>
        </div>
      </section>
      {rooms?.some(r=>r.unread>0) && <section className="panel"><h3>未读消息</h3><div className="toolbar">
        {rooms.filter(r=>r.unread>0).map(r=><button key={r.id} onClick={()=>onRoom(r.id)}>{r.name} · {r.unread} 条未读 →</button>)}
      </div></section>}
      {game?.actionDrafts?.length > 0 && (
        <section className="panel">
          <h3>旧版未执行草稿</h3>
          <p>旧版草稿不会自动执行。可打开查看或返回修改。</p>
          {game.actionDrafts.map((f) => (
            <div className="result-row" key={f.id}>
              <span>
                {f.gm?"GM操作草稿":"玩家行动草稿"} · {new Date(f.expiresAt).toLocaleTimeString()}
              </span>
              <button onClick={() => Preview(f)}>继续核对</button>
            </div>
          ))}
        </section>
      )}
      <section className="panel">
        <h3>待办与团务</h3>
        {game?.battles
          .filter((b) => b.pending.length)
          .map((b) => (
            <p key={b.id}><button onClick={()=>onNavigate({battleId:b.id})}>⚑ {b.name} · 前往防守 →</button></p>
          ))}
        {game?.maps
          .filter((m) => m.rpWaiting)
          .map((m) => (
            <p key={m.id}><button onClick={()=>onNavigate({mapId:m.id,kind:'webNotice'})}>◇ {m.name} · 查看环境描述待办 →</button></p>
          ))}
        {game?.sessions
          .filter((s) => s.status === "open")
          .map((s) => (
            <p key={s.id}>
              开团 · {s.name} · {new Date(s.startsAt).toLocaleString()}
              <button onClick={()=>onNavigate({source:'sessions'})}>查看团务 →</button>
            </p>
          ))}
        <p>每个团拥有自己的角色、资产、探索地图、战斗与频道。</p>
      </section>
    </>
  );
}
export function MemberDirectory({ members, game, openDM, me }) {
  return (
    <section className="panel">
      <h3>营地成员与角色</h3>
      {members
        .filter((m) => m.active)
        .map((m) => {
          const p = game?.roster.find((p) => p.userId === m.userId);
          return (
            <article key={m.userId}>
              <div className="result-row">
                <b>
                  {m.name} · {m.role === "gm" ? "GM" : "玩家"}
                </b>
                {m.userId !== me.user.id && (
                  <button onClick={() => openDM(m.userId)}>一对一私聊</button>
                )}
              </div>
              {p && (
                <>
                  <h4>
                    {p.name} · Lv.{p.level}
                  </h4>
                  <p>{p.profile?.background}</p>
                  <div className="toolbar">
                    {p.showcase?.map((i) => (
                      <span className="badge" key={i.id}>
                        {i.snapshot.name} ×{i.quantity}
                      </span>
                    ))}
                  </div>
                </>
              )}
            </article>
          );
        })}
    </section>
  );
}
export function ChannelManager({ groupId, rooms, members, run, refresh }) {
  const [editing, Edit] = useState(null),
    [name, Name] = useState(""),
    [kind, Kind] = useState("chat");
  async function save(p) {
    await run(async () => {
      await api("/groups/" + groupId + "/rooms/update", p);
      Edit(null);
      await refresh();
    }).catch(() => {});
  }
  return (
    <section className="panel">
      <h3>频道管理</h3>
      <div className="toolbar">
        <input
          aria-label="新频道名称"
          placeholder="新频道名称"
          value={name}
          onChange={(e) => Name(e.target.value)}
        />
        <select
          aria-label="新频道类型"
          value={kind}
          onChange={(e) => Kind(e.target.value)}
        >
          <option value="chat">普通聊天</option>
          <option value="rp">剧情 RP</option>
          <option value="gm">GM 隐藏</option>
        </select>
        <button
          disabled={!name.trim()}
          onClick={() =>
            run(async () => {
              await api("/groups/" + groupId + "/rooms", { name, kind });
              Name("");
              await refresh();
            }).catch(() => {})
          }
        >
          新建频道
        </button>
      </div>
      {rooms
        .filter((r) => !["dm", "system"].includes(r.kind))
        .map((r) => (
          <div className="result-row" key={r.id}>
            <b>{r.name}</b>
            <span>
              {r.kind === "gm"
                ? "GM隐藏"
                : r.members?.length
                  ? "指定成员可见"
                  : "本团成员可见"}
            </span>
            <button onClick={() => Edit({ ...r })}>访问范围／名称</button>
          </div>
        ))}
      {editing && (
        <div className="modal">
          <section className="panel">
            <h3>修改频道</h3>
            <label className="field">
              <span>名称</span>
              <input
                value={editing.name}
                onChange={(e) => Edit({ ...editing, name: e.target.value })}
              />
            </label>
            <p>不勾选成员表示全团可见；GM 隐藏频道始终仅 GM 可见。</p>
            {members
              .filter((m) => m.active)
              .map((m) => (
                <label className="showcase-choice" key={m.userId}>
                  <input
                    type="checkbox"
                    checked={(editing.members || []).includes(m.userId)}
                    onChange={(e) =>
                      Edit({
                        ...editing,
                        members: e.target.checked
                          ? [...(editing.members || []), m.userId]
                          : (editing.members || []).filter(
                              (id) => id !== m.userId,
                            ),
                      })
                    }
                  />
                  {m.name}
                </label>
              ))}
            <div className="toolbar">
              <button className="primary" onClick={() => save(editing)}>
                保存
              </button>
              <button
                onClick={() => {

                    save({ ...editing, archived: true });
                }}
              >
                关闭频道
              </button>
              <button onClick={() => Edit(null)}>取消</button>
            </div>
          </section>
        </div>
      )}
    </section>
  );
}
