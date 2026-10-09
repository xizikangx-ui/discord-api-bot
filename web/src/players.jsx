import {gridCells} from '../../gm-web/src/ui-state';
import React, { useState, useEffect, useRef } from "react";
import { api, id, mediaUrl } from "./api";
import { Result } from "../../gm-web/src/main";
const attrs = {
    strength: "力量",
    constitution: "体质",
    mind: "心智",
    appearance: "外貌",
    intelligence: "智力",
    agility: "敏捷",
    knowledge: "学识",
  },
  actions = {
    attack: "攻击／技能",
    move: "点选移动",
    reload: "装填",
    ammo: "弹夹操作",
    switch: "切换武器",
    item: "治疗／道具",
    cast: "确认吟唱",
    pass: "放弃行动",
    finish: "结束机会",
    flee: "撤退",
  };
function Select({ label, value, onChange, items, empty = "请选择" }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value || ""} onChange={(e) => onChange(e.target.value)}>
        <option value="">{empty}</option>
        {items.map((x) => (
          <option key={x.id || x.value} value={x.id || x.value}>
            {x.name || x.label}
          </option>
        ))}
      </select>
    </label>
  );
}
const Items = ({ label, value, onChange, player, filter = () => true }) => (
  <Select
    {...{ label, value, onChange }}
    items={Object.values(player?.inventory || {})
      .filter(filter)
      .map((i) => ({ id: i.id, name: i.snapshot.name + " ×" + i.quantity }))}
  />
);
function NumberField({ label, value, onChange, min = 0, max = 1000000 }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value ?? min}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </label>
  );
}
export function PlayerPanel({
  tab,
  game,
  groupId,
  userId,
  prepare,
  run,
  refresh,
}) {
  const p = game.player,
    [name, Name] = useState(""),
    [selected, Selected] = useState(""),
    [form, F] = useState({
      quantity: 1,
      attribute: "strength",
      amount: 1,
      hand: "auto",
    }),
    [profile, P] = useState({}),
    [q, Q] = useState(""),
    [sub, Sub] = useState("inventory"),
    [showPage, ShowPage] = useState(0),
    [offers, Offers] = useState({});
  useEffect(() => {
    if (p)
      P({
        name: p.name,
        gender: p.gender || "male",
        age: p.age || 18,
        ...p.profile,
      });
  }, [p?.id]);
  const item = p?.inventory[selected],
    set = (k, v) => F({ ...form, [k]: v });
  if (!p)
    return (
      <section className="panel character-creation">
        <span className="eyebrow">NEW OPERATIVE</span>
        <h2>建立本团角色档案</h2>
        <p>属性在正式提交时生成一次。角色只属于当前跑团。</p>
        <label className="field">
          <span>角色名字</span>
          <input
            value={name}
            onChange={(e) => Name(e.target.value)}
            maxLength={80}
          />
        </label>
        <button
          className="primary"
          onClick={() => prepare("character.roll", { name })}
        >
          生成待确认角色
        </button>
        {game.draft && (
          <>
            <h3>{game.draft.name}</h3>
            <Select
              label="角色性别"
              value={form.gender || "male"}
              onChange={(v) => set("gender", v)}
              items={[
                { id: "male", name: "男性" },
                { id: "female", name: "女性" },
              ]}
            />
            <div className="attribute-grid">
              {Object.entries(game.draft.attributes).map(([k, v]) => (
                <div key={k}>
                  <span>{attrs[k]}</span>
                  <b>{v}</b>
                </div>
              ))}
            </div>
            <div className="toolbar">
              <button
                className="primary"
                onClick={() =>
                  prepare("character.confirm", {
                    draftId: game.draft.id,
                    gender: form.gender || "male",
                  })
                }
              >
                确认角色
              </button>
              <button
                onClick={() =>
                  prepare("character.roll", {
                    name: game.draft.name,
                    reroll: true,
                  })
                }
              >
                重掷（已用 {game.draft.rerolls}/3）
              </button>
            </div>
          </>
        )}
      </section>
    );
  if (tab === "character")
    return (
      <>
        <section className="panel">
          <span className="eyebrow">OPERATIVE DOSSIER</span>
          <h2>
            {p.name} <span className="badge">等级 {p.level}</span>
          </h2>
          {p.portraits?.avatar?.webMediaId && (
            <img
              className="portrait"
              src={mediaUrl(p.portraits.avatar.webMediaId)}
              alt="角色头像"
            />
          )}
          <div className="attribute-grid">
            {Object.entries(p.attributes).map(([k, v]) => (
              <div key={k}>
                <span>{attrs[k]}</span>
                <b>{v}</b>
              </div>
            ))}
          </div>
          <div className="form-grid">
            <Select
              label="分配属性"
              value={form.attribute}
              onChange={(v) => set("attribute", v)}
              items={Object.entries(attrs).map(([id, name]) => ({ id, name }))}
            />
            <NumberField
              label={"自由点（剩余 " + p.points + "）"}
              value={form.amount}
              min={1}
              max={Math.max(1, p.points)}
              onChange={(v) => set("amount", v)}
            />
          </div>
          <button
            onClick={() =>
              prepare("character.allocate", {
                attribute: form.attribute,
                amount: form.amount,
              })
            }
          >
            预览分配
          </button>
        </section>
        <section className="panel">
          <h3>角色叙述</h3>
          <div className="form-grid">
            {[
              ["name", "名字"],
              ["age", "年龄"],
            ].map(([k, l]) => (
              <label className="field" key={k}>
                <span>{l}</span>
                <input
                  type={k === "age" ? "number" : "text"}
                  value={profile[k] || ""}
                  onChange={(e) =>
                    P({
                      ...profile,
                      [k]:
                        k === "age" ? Number(e.target.value) : e.target.value,
                    })
                  }
                />
              </label>
            ))}
            <Select
              label="性别"
              value={profile.gender}
              onChange={(v) => P({ ...profile, gender: v })}
              items={[
                { id: "male", name: "男性" },
                { id: "female", name: "女性" },
              ]}
            />
            {[
              ["background", "背景"],
              ["appearance", "外貌"],
              ["belief", "信念"],
            ].map(([k, l]) => (
              <label className="field full" key={k}>
                <span>{l}</span>
                <textarea
                  rows={3}
                  maxLength={2000}
                  value={profile[k] || ""}
                  onChange={(e) => P({ ...profile, [k]: e.target.value })}
                />
              </label>
            ))}
          </div>
          <button
            onClick={() =>
              prepare("character.profile", {
                characterId: p.id,
                data: {
                  name: profile.name,
                  age: profile.age,
                  gender: profile.gender,
                  profile: {
                    background: profile.background || "",
                    appearance: profile.appearance || "",
                    belief: profile.belief || "",
                  },
                },
              })
            }
          >
            预览保存资料
          </button>
          <div className="toolbar">
            <Select
              label="势力"
              value={form.faction}
              onChange={(v) => set("faction", v)}
              items={[
                { id: "explorer", name: "自由探险家" },
                { id: "apocalypse", name: "天启重工" },
                { id: "scavenger", name: "拾荒者联盟" },
              ]}
            />
            {form.faction === "apocalypse" && (
              <Select
                label="部门"
                value={form.department}
                onChange={(v) => set("department", v)}
                items={["war", "death", "plague", "famine"].map((id, i) => ({
                  id,
                  name: ["战争部", "死亡部", "瘟疫部", "饥荒部"][i],
                }))}
              />
            )}
            <button
              onClick={() =>
                prepare("character.faction", {
                  characterId: p.id,
                  faction: form.faction,
                  department: form.department,
                })
              }
            >
              选择势力
            </button>
          </div>
          <label className="upload-button">
            上传角色头像
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files[0];
                if (file)
                  run(async () => {
                    const data = await fileData(file);
                    return api("/groups/" + groupId + "/media", {
                      uploadId: id(),
                      data,
                    });
                  })
                    .then(
                      (f) =>
                        f &&
                        prepare("character.portrait", {
                          slot: "avatar",
                          mediaId: f.id,
                        }),
                    )
                    .catch(() => {});
              }}
            />
          </label>
        </section>
        <section className="panel">
          <h3>技能与状态</h3>
          {Object.values(p.learnedSkills || {}).map((s) => (
            <article key={s.id}>
              <h4>{s.snapshot.name}</h4>
              <p>{s.snapshot.description}</p>
            </article>
          ))}
          {p.conditions.map((c) => (
            <span className="badge" key={c.id}>
              {c.template.name} · {c.severity}
            </span>
          ))}
          <details>
            <summary>鉴定技能与详细状态</summary>
            <Result
              value={{
                checkSkills: p.checkSkills,
                temporaryEffects: p.temporaryEffects,
              }}
            />
          </details>
        </section>
      </>
    );
  return (
    <>
      <div className="tabs">
        {[
          ["inventory", "背包"],
          ["trade", "交易与转账"],
          ["coupon", "兑换券"],
          ["showcase", "收藏柜"],
        ].map(([k, l]) => (
          <button
            key={k}
            onClick={() => Sub(k)}
            className={sub === k ? "active" : ""}
          >
            {l}
          </button>
        ))}
      </div>
      {sub === "inventory" && (
        <div className="inventory-layout">
          <section className="panel">
            <div className="section-title">
              <h3>随身资产</h3>
              <small>
                {p.stats.overloaded ? "超重" : "负重正常"} · {p.balance} 游戏币
              </small>
            </div>
            <input
              placeholder="搜索物品名称／分类"
              value={q}
              onChange={(e) => Q(e.target.value)}
            />
            <div className="inventory-grid">
              {Object.values(p.inventory)
                .filter((i) => (i.snapshot.name + i.snapshot.kind).includes(q))
                .map((i) => (
                  <button
                    key={i.id}
                    className={
                      "item-tile " +
                      i.snapshot.rarity +
                      (selected === i.id ? " selected" : "")
                    }
                    onClick={() => Selected(i.id)}
                  >
                    {["red", "gold"].includes(i.snapshot.rarity) && (
                      <img
                        alt=""
                        src={
                          "/api/web/v1/groups/" +
                          groupId +
                          "/icons/" +
                          i.templateId
                        }
                        onError={(e) =>
                          (e.currentTarget.style.display = "none")
                        }
                      />
                    )}
                    <b>{i.snapshot.name}</b>
                    <small>
                      {i.snapshot.kind} · ×{i.quantity}
                    </small>
                  </button>
                ))}
            </div>
            <div className="toolbar">
              <button onClick={() => prepare("loot.open", { box: "card" })}>
                抽卡（{p.tickets.card}次）
              </button>
              <Select
                label="容器抽取"
                value={form.box}
                onChange={(v) => set("box", v)}
                items={Object.entries(p.tickets.boxes).map(([id, n]) => ({
                  id,
                  name: id + " · " + n + "次",
                }))}
              />
              <button
                disabled={!form.box}
                onClick={() => prepare("loot.open", { box: form.box })}
              >
                开箱
              </button>
            </div>
          </section>
          <section className="panel item-details">
            {item ? (
              <>
                <span className={"rarity-label " + item.snapshot.rarity}>
                  {item.snapshot.kind}
                </span>
                <h3>{item.snapshot.name}</h3>
                <p>{item.snapshot.description}</p>
                {item.snapshot.kind === "修复道具" && (
                  <>
                    <Items
                      label="修复目标"
                      player={p}
                      value={form.repairTarget}
                      onChange={(v) => set("repairTarget", v)}
                    />
                    <button
                      onClick={() =>
                        prepare("inventory.repair", {
                          itemId: selected,
                          targetId: form.repairTarget,
                        })
                      }
                    >
                      预览修复
                    </button>
                  </>
                )}
                <small>
                  持有 {item.quantity} · 标价 {item.snapshot.value}
                </small>
                <NumberField
                  label="数量（批量每件消耗一次快速行动）"
                  value={form.quantity}
                  min={1}
                  max={100}
                  onChange={(v) => set("quantity", v)}
                />
                <Select
                  label="治疗目标"
                  value={form.targetUid || userId}
                  onChange={(v) => set("targetUid", v)}
                  items={game.roster.map((r) => ({
                    id: r.userId,
                    name: r.name,
                  }))}
                />
                <div className="toolbar">
                  {["食物", "药品", "消耗品"].includes(item.snapshot.kind) && (
                    <button
                      className="primary"
                      onClick={() =>
                        prepare("inventory.use", {
                          itemId: selected,
                          quantity: form.quantity,
                          targetUid: form.targetUid || userId,
                        })
                      }
                    >
                      预览使用／治疗
                    </button>
                  )}
                  <button
                    onClick={() =>
                      prepare("inventory.equip", {
                        itemId: selected,
                        hand: form.hand,
                      })
                    }
                  >
                    装备
                  </button>
                  <button
                    onClick={() =>
                      prepare("inventory.equip", {
                        itemId: selected,
                        remove: true,
                      })
                    }
                  >
                    卸下
                  </button>
                  <button
                    onClick={() =>
                      prepare("inventory.drop", {
                        itemId: selected,
                        quantity: form.quantity,
                      })
                    }
                  >
                    丢弃
                  </button>
                </div>
                {["配件", "弹药", "弹夹", "特殊物品", "修复道具"].includes(
                  item.snapshot.kind,
                ) && (
                  <AdvancedInventory
                    {...{ item, selected, p, form, set, prepare }}
                  />
                )}
                <details>
                  <summary>装备数值、载弹与效果</summary>
                  <Result value={item} />
                </details>
              </>
            ) : (
              <div className="empty-note">
                <h3>选择一件物品</h3>
                <p>在左侧查看详情并执行操作。</p>
              </div>
            )}
          </section>
        </div>
      )}
      {sub === "trade" && (
        <section className="panel">
          <h3>交易与转账</h3>
          <Select
            label="交易对象"
            value={form.targetUid}
            onChange={(v) => set("targetUid", v)}
            items={game.roster
              .filter((r) => r.userId !== userId)
              .map((r) => ({ id: r.userId, name: r.name }))}
          />
          <NumberField
            label="转账金额"
            value={form.coins || 0}
            onChange={(v) => set("coins", v)}
          />
          <div className="toolbar">
            <button
              onClick={() =>
                prepare("trade.create", { targetUid: form.targetUid })
              }
            >
              发起交换
            </button>
            <button
              onClick={() =>
                prepare("trade.create", {
                  targetUid: form.targetUid,
                  type: "transfer",
                  amount: form.coins,
                })
              }
            >
              预览转账
            </button>
          </div>
          {game.offers.map((o) => (
            <article className="trade-card" key={o.id}>
              <h4>
                {o.type === "transfer"
                  ? "转账"
                  : o.type === "buyback"
                    ? "GM收购"
                    : "玩家交换"}{" "}
                · {o.status}
              </h4>
              <Result value={o.sides} />
              {o.type === "trade" &&
                ["editing", "ready"].includes(o.status) && (
                  <>
                    <Items
                      label="报价物品（可添加多行）"
                      player={p}
                      value={form.offerItem}
                      onChange={(v) => set("offerItem", v)}
                    />
                    <NumberField
                      label="物品数量"
                      value={form.quantity}
                      min={1}
                      onChange={(v) => set("quantity", v)}
                    />
                    <button
                      onClick={() =>
                        Offers({
                          ...offers,
                          [o.id]: [
                            ...(offers[o.id] || []),
                            { id: form.offerItem, quantity: form.quantity },
                          ],
                        })
                      }
                      disabled={
                        !form.offerItem || (offers[o.id]?.length || 0) >= 10
                      }
                    >
                      添加物品到报价
                    </button>
                    {(offers[o.id] || []).map((row, n) => (
                      <div className="result-row" key={n}>
                        <span>
                          {p.inventory[row.id]?.snapshot.name || row.id} ×
                          {row.quantity}
                        </span>
                        <button
                          onClick={() =>
                            Offers({
                              ...offers,
                              [o.id]: offers[o.id].filter((_, i) => i !== n),
                            })
                          }
                        >
                          移除此行
                        </button>
                      </div>
                    ))}
                    <button
                      onClick={() =>
                        prepare("trade.update", {
                          offerId: o.id,
                          coins: form.coins || 0,
                          items:
                            offers[o.id] ||
                            (form.offerItem
                              ? [
                                  {
                                    id: form.offerItem,
                                    quantity: form.quantity,
                                  },
                                ]
                              : []),
                        })
                      }
                    >
                      预览提交报价
                    </button>
                  </>
                )}
              <div className="toolbar">
                <button
                  disabled={o.status !== "ready"}
                  onClick={() =>
                    prepare("trade.confirm", {
                      offerId: o.id,
                      revision: o.revision,
                    })
                  }
                >
                  确认此版本
                </button>
                <button
                  disabled={!["ready", "editing"].includes(o.status)}
                  onClick={() => prepare("trade.cancel", { offerId: o.id })}
                >
                  取消交易
                </button>
              </div>
            </article>
          ))}
        </section>
      )}
      {sub === "coupon" && (
        <section className="panel">
          <h3>兑换券</h3>
          {game.coupons.map((c) => (
            <article key={c.id}>
              <h4>
                {c.name} · 剩余 {c.balance}
              </h4>
              <p>{c.description}</p>
              {c.mode === "choice" && (
                <Select
                  label="选择奖励"
                  value={form.couponItem}
                  onChange={(v) => set("couponItem", v)}
                  items={c.entries.map((e) => ({
                    id: e.ref,
                    name: e.name || e.ref + " ×" + e.quantity,
                  }))}
                />
              )}
              <button
                onClick={() =>
                  prepare("coupon.redeem", {
                    poolId: c.id,
                    selected: form.couponItem,
                  })
                }
              >
                预览兑换
              </button>
            </article>
          ))}
        </section>
      )}
      {sub === "showcase" && (
        <section className="panel">
          <h3>收藏柜</h3>
          <p>只展示你勾选且实际持有的金色、红色物品。</p>
          <div className="toolbar">
            <button disabled={!showPage} onClick={() => ShowPage(showPage - 1)}>
              上一页
            </button>
            <span>第 {showPage + 1} 页</span>
            <button
              disabled={
                Object.values(p.inventory).filter((i) =>
                  ["red", "gold"].includes(i.snapshot.rarity),
                ).length <=
                (showPage + 1) * 20
              }
              onClick={() => ShowPage(showPage + 1)}
            >
              下一页
            </button>
          </div>
          {Object.values(p.inventory)
            .filter((i) => ["red", "gold"].includes(i.snapshot.rarity))
            .slice(showPage * 20, showPage * 20 + 20)
            .map((i) => (
              <label className="showcase-choice" key={i.id}>
                <input
                  type="checkbox"
                  checked={(form.showcase || p.showcase || []).includes(i.id)}
                  onChange={(e) =>
                    set(
                      "showcase",
                      e.target.checked
                        ? [...(form.showcase || p.showcase || []), i.id]
                        : (form.showcase || p.showcase || []).filter(
                            (id) => id !== i.id,
                          ),
                    )
                  }
                />
                {i.snapshot.name} ×{i.quantity}
              </label>
            ))}
          <button
            onClick={() =>
              prepare("showcase.select", {
                characterId: p.id,
                page: showPage,
                refs: (form.showcase || p.showcase || []).filter((id) =>
                  Object.values(p.inventory)
                    .filter((i) => ["red", "gold"].includes(i.snapshot.rarity))
                    .slice(showPage * 20, showPage * 20 + 20)
                    .some((i) => i.id === id),
                ),
              })
            }
          >
            预览展示
          </button>
        </section>
      )}
    </>
  );
}
function AdvancedInventory({ item, selected, p, form, set, prepare }) {
  return (
    <details>
      <summary>配件／弹药／特殊道具</summary>
      <Items
        label="关联武器／装备"
        player={p}
        value={form.weaponId}
        onChange={(v) => set("weaponId", v)}
      />
      <Items
        label="弹夹"
        player={p}
        value={form.magazineId}
        onChange={(v) => set("magazineId", v)}
        filter={(i) => i.snapshot.kind === "弹夹"}
      />
      <Select
        label="饰品特殊槽位"
        value={form.slot}
        onChange={(v) => set("slot", v)}
        items={["head", "body", "ring"].map((id, n) => ({
          id,
          name: ["头部", "身体", "戒指"][n],
        }))}
      />
      <div className="toolbar">
        <button
          onClick={() =>
            prepare("inventory.attach", {
              itemId: form.weaponId,
              attachmentId: selected,
            })
          }
        >
          装配配件
        </button>
        <button
          onClick={() =>
            prepare("inventory.attach", {
              itemId: form.weaponId,
              attachmentId: selected,
              remove: true,
            })
          }
        >
          拆下配件
        </button>
        <button
          onClick={() =>
            prepare("inventory.ammo", {
              operation: {
                type: "fill",
                magazineId: form.magazineId,
                ammoId: selected,
                quantity: form.quantity,
              },
            })
          }
        >
          填装弹夹
        </button>
        <button
          onClick={() =>
            prepare("inventory.ammo", {
              operation: {
                type: "swap",
                weaponId: form.weaponId,
                magazineId: form.magazineId,
              },
            })
          }
        >
          更换弹夹
        </button>
        <button
          onClick={() =>
            prepare("inventory.ammo", {
              operation: { type: "extract", weaponId: form.weaponId },
            })
          }
        >
          抽出弹夹
        </button>
        <button
          onClick={() =>
            prepare("inventory.special", { itemId: selected, slot: form.slot })
          }
        >
          预览特殊道具
        </button>
      </div>
    </details>
  );
}
export function ExplorePanel({ game, groupId, prepare, run, refresh }) {
  const [mid, Map] = useState(""),
    [cell, Cell] = useState(""),
    [key, Key] = useState(""),
    [image, Image] = useState(""),
    [merchant, Merchant] = useState(null),
    [choice, Choice] = useState({ quantity: 1 });
  const mapRef=useRef(null);
  const m = game.maps.find((m) => m.id === mid) || game.maps[0],
    part = m?.participants[game.player?.userId],
    room = m?.cells[part?.cell]?.room;
  mapRef.current=m?.id;
  useEffect(()=>{Cell("");Image("");Merchant(null);},[m?.id]);
  useEffect(()=>{if(image&&m)Image("/api/web/v1/groups/"+groupId+"/map-image/"+m.id+"?v="+game.revision);},[game.revision,m?.id]);
  return (
    <>
      <section className="panel">
        <span className="eyebrow">EXPLORE / SHARED FOG</span>
        <h3>探索地图</h3>
        <Select
          label="地图"
          value={m?.id}
          onChange={(v) => {
            Map(v);
            Image("");
          }}
          items={game.maps}
        />
        {m && (
          <>
            <div className="toolbar">
              <button onClick={() => prepare("map.join", { mapId: m.id })}>
                加入探索
              </button>
              {part && (
                <button onClick={() => prepare("map.leave", { mapId: m.id })}>
                  退出探索
                </button>
              )}
              <button
                onClick={() =>
                  Image(
                    "/api/web/v1/groups/" +
                      groupId +
                      "/map-image/" +
                      m.id +
                      "?v=" +
                      game.revision,
                  )
                }
              >
                静态大图
              </button>
              {part && <span className="badge">当前位置 {part.cell}</span>}
            </div>
            {image && (
              <img
                className="map-image"
                src={image}
                alt="当前已揭示的探索地图"
              />
            )}
            <div
              className="exploration-grid"
              style={{
                gridTemplateColumns: "repeat(" + m.width + ",minmax(65px,1fr))",
              }}
            >
              {gridCells(m.width,m.rows,m.cells).map(({ref,cell:raw}) => {const c=raw||{type:"empty",passable:false};return (
                <button
                  key={ref}
                  className={
                    (c.hidden ? "fog " : "") +
                    (cell === ref ? "selected " : "") +
                    (ref === part?.cell ? "current-cell" : "")
                  }
                  disabled={!raw}
                  onClick={() => Cell(ref)}
                >
                  <small>
                    {String.fromCharCode(65 + Number(ref.split(",")[0]))}
                    {Number(ref.split(",")[1]) + 1}
                  </small>
                  <b>
                    {c.hidden
                      ? "未知区域"
                      : c.room?.merchant?.name ||
                        c.room?.name ||
                        c.name ||
                        ({ entrance: "入口", exit: "出口", corridor: "通道", road: "道路", stairs: "楼梯", room: "房间", forest: "森林", water: "水域", building: "建筑", empty: "空地", wall: "墙体" }[c.type] || "区域")}
                  </b>
                  {ref === part?.cell && <span>◆ 队伍</span>}
                </button>
              );})}
            </div>
            {cell && (
              <div className="toolbar">
                <span>已选 {cell}</span>
                <Items
                  label="开门钥匙（可选）"
                  value={key}
                  onChange={Key}
                  player={game.player}
                  filter={(i) => i.snapshot.kind === "钥匙"}
                />
                <button
                  className="primary"
                  disabled={m.rpWaiting}
                  onClick={() =>
                    prepare("map.move", { mapId: m.id, cell, keyId: key })
                  }
                >
                  发起全队移动
                </button>
              </div>
            )}
            {m.rpWaiting && (
              <div className="banner">等待 GM 完成环境描述。</div>
            )}
            {Object.values(m.moves || {})
              .filter((r) => r.status === "pending")
              .map((r) => (
                <div className="move-request" key={r.id}>
                  <p>
                    全队移动 {r.from} → {r.to} · {r.yes.length}/
                    {r.members.length} 已同意
                  </p>
                  <div className="toolbar">
                    <button
                      onClick={() =>
                        prepare("map.vote", {
                          mapId: m.id,
                          requestId: r.id,
                          yes: true,
                        })
                      }
                    >
                      同意
                    </button>
                    <button
                      onClick={() =>
                        prepare("map.vote", {
                          mapId: m.id,
                          requestId: r.id,
                          yes: false,
                        })
                      }
                    >
                      拒绝
                    </button>
                  </div>
                </div>
              ))}
            <div className="toolbar">
              <button
                onClick={() =>
                  prepare("map.link", { mapId: m.id, kind: "enter" })
                }
              >
                进入建筑
              </button>
              <button
                onClick={() =>
                  prepare("map.link", { mapId: m.id, kind: "exit" })
                }
              >
                返回区域
              </button>
            </div>
          </>
        )}
      </section>
      {room && (
        <section className="panel">
          <h3>{room.name}</h3>
          <p>遭遇：{room.encounter}</p>
          {room.containers?.map((c) => (
            <article key={c.id}>
              <h4>
                {c.name || c.box || "容器"} · {c.status}
              </h4>
              <button
                onClick={() => prepare("map.open", { mapId: m.id, ref: c.id })}
              >
                开启／领取
              </button>
            </article>
          ))}
          {room.supplies?.map((i) => (
            <article key={i.id}>
              <h4>{i.snapshot?.name || i.name || i.templateId}</h4>
              <button
                onClick={() => prepare("map.take", { mapId: m.id, ref: i.id })}
              >
                领取物资
              </button>
            </article>
          ))}
          {room.merchant && (
            <>
              <h3>行商 · {room.merchant.name}</h3>
              <NumberField
                label="交易数量"
                value={choice.quantity}
                min={1}
                max={100}
                onChange={(v) => Choice({ ...choice, quantity: v })}
              />
              {room.merchant.stock.map((i) => (
                <div className="result-row" key={i.id}>
                  <b>{i.template.name}</b>
                  <span>
                    库存 {i.remaining} · 标价 {i.template.value}
                  </span>
                  <button
                    onClick={() =>
                      run(async () =>
                        ((quote)=>{if(mapRef.current===m.id)Merchant(quote);})(
                          await api("/groups/" + groupId + "/merchant/quote", {
                            mapId: m.id,
                            cell: part.cell,
                            mode: "purchase",
                            itemId: i.id,
                            quantity: choice.quantity,
                            clientId: id(),
                          }),
                        ),
                      ).catch(() => {})
                    }
                  >
                    购买预览
                  </button>
                </div>
              ))}
              <Items
                label="出售本人背包物品"
                player={game.player}
                value={choice.itemId}
                onChange={(v) => Choice({ ...choice, itemId: v })}
              />
              <button
                onClick={() =>
                  run(async () =>
                    Merchant(
                      await api("/groups/" + groupId + "/merchant/quote", {
                        mapId: m.id,
                        cell: part.cell,
                        mode: "sell",
                        itemId: choice.itemId,
                        quantity: choice.quantity,
                        clientId: id(),
                      }),
                    ),
                  ).catch(() => {})
                }
              >
                按标价110%出售预览
              </button>
            </>
          )}
        </section>
      )}
      {merchant && (
        <div className="modal">
          <section className="panel">
            <h3>核对行商交易</h3>
            <Result value={merchant} />
            <button
              className="primary"
              onClick={() =>
                run(async () => {
                  const quote=merchant;
                  try{await api("/groups/"+groupId+"/merchant/commit",{id:quote.id});}
                  catch(e){const receipt=await api("/groups/"+groupId+"/merchant/receipt/"+quote.id).catch(()=>null);if(receipt?.status!=="committed")throw e;}
                  if(mapRef.current!==m.id)return;
                  Merchant(null);
                  await refresh();
                }).catch(() => {})
              }
            >
              确认交易
            </button>
            <button onClick={() => Merchant(null)}>返回</button>
          </section>
        </div>
      )}
    </>
  );
}
export function BattlePanel({ game, groupId, userId, prepare, run, refresh }) {
  const [bid, Battle] = useState(""),
    [action, Action] = useState("attack"),
    [x, X] = useState({
      firing: { mode: "semi", count: 1 },
      quantity: 1,
      hand: "auto",
      type: "quick",
      distance: "5",
    }),
    [rp, RP] = useState(""),
    [cells, Cells] = useState([]),
    [cell, Cell] = useState(null),
    [image, Image] = useState(false);
  const b = game.battles.find((b) => b.id === bid) || game.battles[0],
    actor = b?.actors.find((a) => a.userId === userId),
    myTurn = b?.current?.actorId === actor?.id,
    p = game.player;
  const set = (k, v) => X((old) => ({ ...old, [k]: v }));
  const moveRef=useRef(null);moveRef.current=b?.movementFingerprint;
  useEffect(()=>{let alive=true;Cells([]);Cell(null);if(action==='move'&&myTurn&&b){api('/groups/'+groupId+'/game/movement?battleId='+b.id).then(r=>{if(alive&&r.fingerprint===moveRef.current)Cells(r.cells);}).catch(()=>{});}return()=>{alive=false;};},[b?.id,b?.movementFingerprint,action,myTurn,groupId]);
  function execute(params = x) {
    prepare("battle.action", {
      battleId: b.id,
      turnId: b.current?.id,
      action,
      params,
      rp,
    });
  }
  async function loadMove() {
    if (!b) return;
    await run(async () => {
      const r = await api(
        "/groups/" + groupId + "/game/movement?battleId=" + b.id,
      );
      Cells(r.cells);
    }).catch(() => {});
  }
  return (
    <>
      <section className="panel">
        <span className="eyebrow">TACTICAL BATTLEFIELD</span>
        <h3>战斗面板</h3>
        <Select
          label="战斗"
          value={b?.id}
          onChange={(v) => {
            Battle(v);
            Image(false);
          }}
          items={game.battles}
        />
        {b && (
          <>
            <div className="toolbar">
              <span className="badge">{b.status}</span>
              <span>行动轮 {b.actionRound?.number}</span>
              <button onClick={() => Image(!image)}>
                {image ? "收起大图" : "静态战场大图"}
              </button>
              {!actor && (
                <button
                  onClick={() => prepare("battle.join", { battleId: b.id })}
                >
                  加入招募
                </button>
              )}
              {actor && b.status === "recruiting" && (
                <button
                  onClick={() => prepare("battle.withdraw", { battleId: b.id })}
                >
                  退出招募
                </button>
              )}
            </div>
            {image && (
              <img
                className="map-image"
                src={
                  "/api/web/v1/groups/" +
                  groupId +
                  "/battle-image/" +
                  b.id +
                  "?v=" +
                  game.revision
                }
                alt="当前战场"
              />
            )}
            <div
              className="battle-grid"
              style={{
                gridTemplateColumns: "repeat(" + b.width + ",minmax(70px,1fr))",
              }}
            >
              {Array.from({ length: b.height }, (_, y) =>
                Array.from({ length: b.width }, (_, x) => {
                  const occupants = b.actors.filter(
                      (a) =>
                        Math.floor(a.x / 50) === x &&
                        Math.floor(a.y / 50) === y,
                    ),
                    legal = cells.find((c) => c.x === x && c.y === y);
                  return (
                    <button
                      key={x + "," + y}
                      className={
                        (b.terrain[x + "," + y] === "blocked"
                          ? "blocked "
                          : "") +
                        (legal ? "reachable " : "") +
                        (cell?.x === x && cell?.y === y ? "selected" : "")
                      }
                      disabled={action === "move" && !legal}
                      onClick={() => {
                        if (legal) Cell(legal);
                        else if (action === "attack")
                          set("center", { x: x * 50 + 25, y: y * 50 + 25 });
                      }}
                    >
                      <small>
                        {String.fromCharCode(65 + x)}
                        {y + 1}
                      </small>
                      {occupants.map((a) => (
                        <span
                          key={a.id}
                          className={
                            "token " +
                            a.team +
                            (a.id === b.current?.actorId ? " active" : "")
                          }
                        >
                          {a.team === "enemy" ? "▲" : "●"} {a.name}
                          <small>
                            {a.health.hp}/{a.health.maxHP}
                            {a.health.downed ? " 倒地" : ""}
                          </small>
                        </span>
                      ))}
                    </button>
                  );
                }),
              )}
            </div>
            <div className="roster">
              {b.actors.map((a, n) => (
                <article key={a.id}>
                  <b>
                    {n + 1}. {a.name}
                  </b>
                  <span>
                    HP {a.health.hp}/{a.health.maxHP}
                    {a.health.downed ? " · 倒地" : ""} · AP {a.ap}
                  </span>
                  <small>
                    本轮 {b.actionRound?.counts?.[a.id] || 0} 次 · 下次{" "}
                    {a.nextCost} AP
                  </small>
                </article>
              ))}
            </div>
          </>
        )}
      </section>
      {b?.pending.map((h) => (
        <section className="panel defense-card" key={h.id}>
          <h3>受到攻击：请选择防守</h3>
          <p>
            截止 {new Date(h.expiresAt).toLocaleTimeString()}，填写 RP
            不延长期限。
          </p>
          <label className="field">
            <span>防守 RP（选填）</span>
            <textarea
              maxLength={1000}
              value={rp}
              onChange={(e) => RP(e.target.value)}
            />
          </label>
          <div className="toolbar">
            {[
              ["defend", "纯防御"],
              ["dodge", "闪避"],
              ["both", "同时防守"],
              ["none", "放弃防守"],
            ].map(([choice, label]) => (
              <button
                key={choice}
                onClick={() =>
                  prepare("battle.action", {
                    battleId: b.id,
                    action: "defend",
                    params: { hitId: h.id, choice },
                    rp,
                  })
                }
              >
                {label}
              </button>
            ))}
          </div>
        </section>
      ))}
      {b && actor && (
        <section className="panel">
          <h3>{myTurn ? "轮到你行动" : "等待行动机会"}</h3>
          {myTurn && (
            <>
              <div className="opportunity">
                <b>本机会已扣 {b.current.free ? 0 : b.current.apCost} AP</b>
                <span>
                  快速 {b.current.quick} · 正式 {b.current.formal} · 移动{" "}
                  {b.current.move}米
                </span>
              </div>
              <div className="tabs">
                {Object.entries(actions).map(([key, label]) => (
                  <button
                    key={key}
                    className={action === key ? "active" : ""}
                    onClick={() => {
                      Action(key);

                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {action === "attack" && (
                <>
                  <Select
                    label="武器／技能"
                    value={x.abilityKey}
                    onChange={(v) => set("abilityKey", v)}
                    items={b.abilities.map((a) => ({
                      id: a.key,
                      name: a.attack.name,
                    }))}
                  />
                  <Select
                    label="目标"
                    value={x.targetId}
                    onChange={(v) => set("targetId", v)}
                    items={b.actors.filter(
                      (a) => a.id !== actor.id && !a.deathId && !a.retreated,
                    )}
                  />
                  <Select
                    label="消耗行动"
                    value={x.action || "formal"}
                    onChange={(v) => set("action", v)}
                    items={[
                      { id: "quick", name: "快速行动" },
                      { id: "formal", name: "正式行动" },
                    ]}
                  />
                  <Select
                    label="射击模式"
                    value={x.firing.mode}
                    onChange={(v) => set("firing", { ...x.firing, mode: v })}
                    items={[
                      { id: "semi", name: "单发" },
                      { id: "auto", name: "连射" },
                    ]}
                  />
                  <NumberField
                    label="连射发数"
                    value={x.firing.count}
                    min={1}
                    max={100}
                    onChange={(v) => set("firing", { ...x.firing, count: v })}
                  />
                  {b.abilities.find((a) => a.key === x.abilityKey)?.attack.aoe
                    ?.mode !== "single" &&
                    b.abilities.find((a) => a.key === x.abilityKey)?.attack
                      .aoe && (
                      <>
                        <p>
                          选择范围中心：使用目标所在位置，按服务器规则筛选范围。
                        </p>
                        <button
                          onClick={() => {
                            const target = b.actors.find(
                              (a) => a.id === x.targetId,
                            );
                            if (target)
                              set("center", { x: target.x, y: target.y });
                          }}
                        >
                          以所选目标为中心
                        </button>
                        <div className="toolbar">
                          {b.actors
                            .filter((a) => !a.deathId && !a.retreated)
                            .map((a) => (
                              <label key={a.id}>
                                <input
                                  type="checkbox"
                                  checked={(x.targets || []).includes(a.id)}
                                  onChange={(e) =>
                                    set(
                                      "targets",
                                      e.target.checked
                                        ? [...(x.targets || []), a.id]
                                        : (x.targets || []).filter(
                                            (id) => id !== a.id,
                                          ),
                                    )
                                  }
                                />
                                {a.name}
                              </label>
                            ))}
                        </div>
                      </>
                    )}
                </>
              )}
              {action === "move" && (
                <>
                  <p>绿色格子内存在合法终点。选择格子，再点九宫格位置。</p>
                  {cell && (
                    <div className="point-grid">
                      {cell.points.map((p) => (
                        <button
                          key={p.key}
                          disabled={!p.cost}
                          onClick={() =>
                            execute({
                              cellX: cell.x,
                              cellY: cell.y,
                              pointKey: p.key,
                            })
                          }
                        >
                          {p.label}
                          <small>
                            {p.cost
                              ? "距离 " +
                                p.distance +
                                "米 · 计费 " +
                                p.cost +
                                "米"
                              : "不可达"}
                          </small>
                        </button>
                      ))}
                    </div>
                  )}
                  <Select
                    label="敌人"
                    value={x.targetId}
                    onChange={(v) => set("targetId", v)}
                    items={b.actors.filter(
                      (a) =>
                        a.team !== actor.team && !a.deathId && !a.retreated,
                    )}
                  />
                  <Select
                    label="距离"
                    value={x.distance}
                    onChange={(v) => set("distance", v)}
                    items={[
                      { id: "5", name: "5米" },
                      { id: "10", name: "10米" },
                      { id: "20", name: "20米" },
                      { id: "remaining", name: "剩余预算" },
                    ]}
                  />
                  <div className="toolbar">
                    <button
                      onClick={() =>
                        execute({
                          relative: "toward",
                          targetId: x.targetId,
                          distance: x.distance,
                        })
                      }
                    >
                      靠近{" "}
                      {b.actors.find((a) => a.id === x.targetId)?.name ||
                        "敌人"}
                    </button>
                    <button
                      onClick={() =>
                        execute({
                          relative: "away",
                          targetId: x.targetId,
                          distance: x.distance,
                        })
                      }
                    >
                      远离{" "}
                      {b.actors.find((a) => a.id === x.targetId)?.name ||
                        "敌人"}
                    </button>
                  </div>
                </>
              )}
              {["item", "reload", "switch", "ammo"].includes(action) && (
                <>
                  <Items
                    label={action === "item" ? "使用道具" : "武器"}
                    player={p}
                    value={x[action === "item" ? "itemId" : "weaponId"]}
                    onChange={(v) =>
                      set(action === "item" ? "itemId" : "weaponId", v)
                    }
                  />
                  {action === "item" && (
                    <>
                      <NumberField
                        label="数量：每件一次快速行动"
                        value={x.quantity}
                        min={1}
                        max={100}
                        onChange={(v) => set("quantity", v)}
                      />
                      <Select
                        label="同格受疗者"
                        value={x.recipientId || actor.id}
                        onChange={(v) => set("recipientId", v)}
                        items={b.actors.filter(
                          (a) => a.team === actor.team && !a.deathId,
                        )}
                      />
                    </>
                  )}
                  {["reload", "ammo"].includes(action) && (
                    <>
                      <Items
                        label="弹药"
                        player={p}
                        value={x.ammoId}
                        onChange={(v) => set("ammoId", v)}
                        filter={(i) => i.snapshot.kind === "弹药"}
                      />
                      <Items
                        label="弹夹"
                        player={p}
                        value={x.magazineId}
                        onChange={(v) => set("magazineId", v)}
                        filter={(i) => i.snapshot.kind === "弹夹"}
                      />
                      {action === "ammo" && (
                        <Select
                          label="弹夹操作"
                          value={x.ammoType || "fill"}
                          onChange={(v) => set("ammoType", v)}
                          items={[
                            { id: "fill", name: "填装" },
                            { id: "extract", name: "抽出" },
                            { id: "swap", name: "换夹" },
                          ]}
                        />
                      )}
                    </>
                  )}
                </>
              )}
              {action === "pass" && (
                <Select
                  label="放弃哪种行动"
                  value={x.type}
                  onChange={(v) => set("type", v)}
                  items={[
                    { id: "quick", name: "快速行动" },
                    { id: "formal", name: "正式行动" },
                  ]}
                />
              )}
              <label className="field">
                <span>行动 RP（选填，随操作记录发布）</span>
                <textarea
                  maxLength={1000}
                  value={rp}
                  onChange={(e) => RP(e.target.value)}
                  placeholder="角色会如何行动？"
                />
              </label>
              {action !== "move" && (
                <button
                  className="primary"
                  onClick={() =>
                    execute(
                      action === "ammo"
                        ? {
                            ammoVersion: p.ammoVersion || 0,
                            operation: {
                              type: x.ammoType || "fill",
                              weaponId: x.weaponId,
                              magazineId: x.magazineId,
                              ammoId: x.ammoId,
                              quantity: x.quantity,
                            },
                          }
                        : x,
                    )
                  }
                >
                  {rp ? "RP 并行动 · 预览" : "直接执行 · 预览"}
                </button>
              )}
            </>
          )}
        </section>
      )}
      {game.corpses
        .filter((c) => c.battleId === b?.id)
        .map((c) => (
          <section className="panel" key={c.id}>
            <h3>共享战利品</h3>
            {c.items
              .filter((i) => !c.claims[i.id])
              .map((i) => (
                <div className="result-row" key={i.id}>
                  <b>{i.snapshot?.name || i.name}</b>
                  <button
                    onClick={() =>
                      prepare("corpse.claim", { corpseId: c.id, itemId: i.id })
                    }
                  >
                    领取
                  </button>
                </div>
              ))}
          </section>
        ))}
    </>
  );
}
export function ActivitiesPanel({ game, prepare }) {
  const [q, Q] = useState("");
  return (
    <>
      <section className="panel">
        <h3>开团与鉴定</h3>
        {game.sessions.map((s) => (
          <article key={s.id}>
            <h4>{s.name}</h4>
            <p>
              {s.description} · {new Date(s.startsAt).toLocaleString()}
            </p>
            <div className="toolbar">
              <button
                onClick={() => prepare("session.join", { sessionId: s.id })}
              >
                报名
              </button>
              <button
                onClick={() =>
                  prepare("session.join", { sessionId: s.id, withdraw: true })
                }
              >
                退出报名
              </button>
            </div>
          </article>
        ))}
        {game.checks.map((c) => (
          <article key={c.id}>
            <h4>{c.name}</h4>
            <p>{c.description}</p>
            <button onClick={() => prepare("check.roll", { checkId: c.id })}>
              进行鉴定
            </button>
          </article>
        ))}
      </section>
      <section className="panel">
        <h3>名词与规则</h3>
        <input
          placeholder="搜索名称、解释或章节"
          value={q}
          onChange={(e) => Q(e.target.value)}
        />
        {[...game.glossary, ...game.texts]
          .filter((t) =>
            (
              (t.name || t.label || "") + (t.description || t.text || "")
            ).includes(q),
          )
          .map((t) => (
            <details key={t.id || t.key}>
              <summary>{t.name || t.label}</summary>
              <p className="prose">{t.description || t.text}</p>
            </details>
          ))}
      </section>
      <section className="panel">
        <h3>我的操作记录</h3>
        <p>仅本人可见的最近 50 次结果；完整审计由 GM 在工作台查询。</p>
        {game.actionHistory?.map((f) => (
          <details key={f.id}>
            <summary>
              {f.command} · {new Date(f.at).toLocaleString()}
            </summary>
            <Result value={f.result} />
          </details>
        ))}
      </section>
    </>
  );
}
function fileData(file) {
  return new Promise((resolve, reject) => {
    if (file.size > 4 * 1024 * 1024) return reject(Error("图片最多4MiB。"));
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}
