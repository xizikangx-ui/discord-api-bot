import React from "react";

export function BattleLoot({ corpse, prepare, busy = false }) {
  const items = corpse.items || [], remaining = items.filter(i => !corpse.claims?.[i.id]).length;
  return <div className="battle-loot-card">
    <div className="toolbar"><b>{corpse.name || "共享战利品"}</b><span className="badge">剩余 {remaining} / {items.length} 项</span></div>
    {!corpse.canClaim && remaining > 0 && <p className="muted">{corpse.blockedReason}</p>}
    {items.map(i => <div className="result-row" key={i.id}>
      <span>{i.name || i.snapshot?.name || "物品"}{i.quantity > 1 ? " ×" + i.quantity : ""}</span>
      {corpse.claims?.[i.id] ? <span className="badge">{corpse.claims[i.id].name || "队友"}已领取</span> :
        <button disabled={busy || !corpse.canClaim} onClick={() => prepare("corpse.claim", { corpseId: corpse.id, itemId: i.id })}>拾取</button>}
    </div>)}
    {!items.length && <p className="muted">没有可拾取的物品。</p>}
  </div>;
}
