import React, { useState } from "react";

const TAU = Math.PI * 2;
const RINGS = [1 / 3, 2 / 3, 1];

/**
 * 七轴属性雷达。刻度固定到 max（默认 30），与角色实际数值解耦，
 * 这样一眼能看出「当前值 / 成长空间」。
 */
export function AttributeRadar({
  values = {},
  labels = {},
  max = 30,
  size = 300,
  caption = "属性雷达",
}) {
  const [hover, setHover] = useState(null);
  const keys = Object.keys(values);
  const n = keys.length;
  const ceiling = Number(max) > 0 ? Number(max) : 30;

  if (!n) return null;

  const cx = size / 2;
  const cy = size / 2;
  const r = size * 0.305;
  const angleOf = (i) => -Math.PI / 2 + (i * TAU) / n;
  const at = (i, ratio) => {
    const a = angleOf(i);
    return [cx + Math.cos(a) * r * ratio, cy + Math.sin(a) * r * ratio];
  };
  // 半径按开方映射：面积与数值成正比，低数值时形状也读得出来。
  const ratioOf = (v) =>
    Math.sqrt(Math.max(0, Math.min(1, (Number(v) || 0) / ceiling)));
  const ringPoints = (ratio) =>
    keys.map((_, i) => at(i, Math.sqrt(ratio)).join(",")).join(" ");
  const valuePoints = keys
    .map((k, i) => at(i, ratioOf(values[k])).join(","))
    .join(" ");
  const summary = keys
    .map((k) => `${labels[k] || k} ${values[k]} / ${ceiling}`)
    .join("，");

  const hoverIndex = hover == null ? -1 : keys.indexOf(hover);
  const hoverValue = hoverIndex >= 0 ? values[keys[hoverIndex]] : null;

  return (
    <figure className="attr-radar-figure">
      <svg
        viewBox={`0 0 ${size} ${size}`}
        className="attr-radar"
        role="img"
        aria-label={`${caption}：${summary}`}
      >
        <defs>
          <linearGradient id="radarFill" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#c0b0f7" stopOpacity="0.42" />
            <stop offset="1" stopColor="#7fb2e6" stopOpacity="0.22" />
          </linearGradient>
        </defs>

        <g className="radar-grid">
          {RINGS.map((ratio) => (
            <polygon key={ratio} points={ringPoints(ratio)} />
          ))}
          {keys.map((k, i) => {
            const [x, y] = at(i, 1);
            return <line key={k} x1={cx} y1={cy} x2={x} y2={y} />;
          })}
        </g>

        <polygon className="radar-shape" points={valuePoints} />

        {keys.map((k, i) => {
          const [x, y] = at(i, ratioOf(values[k]));
          return (
            <circle
              key={k}
              className={"radar-dot" + (hover === k ? " is-active" : "")}
              cx={x}
              cy={y}
              r={hover === k ? 5 : 3.2}
              onMouseEnter={() => setHover(k)}
              onMouseLeave={() => setHover(null)}
            >
              <title>{`${labels[k] || k} ${values[k]} / ${ceiling}`}</title>
            </circle>
          );
        })}

        {keys.map((k, i) => {
          const [x, y] = at(i, 1.2);
          const active = hover === k;
          return (
            <g
              key={k}
              className={"radar-axis" + (active ? " is-active" : "")}
              onMouseEnter={() => setHover(k)}
              onMouseLeave={() => setHover(null)}
            >
              <text
                className="radar-label"
                x={x}
                y={y - 6}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {labels[k] || k}
              </text>
              <text
                className="radar-value"
                x={x}
                y={y + 9}
                textAnchor="middle"
                dominantBaseline="middle"
              >
                {values[k]}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="attr-radar-caption" aria-live="polite">
        {hoverIndex >= 0 ? (
          <>
            <b>{labels[keys[hoverIndex]] || keys[hoverIndex]}</b>
            <span>
              {hoverValue} / {ceiling}
            </span>
          </>
        ) : (
          <span>
            {caption} · 满值 {ceiling} · 环 10 / 20 / {ceiling}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
