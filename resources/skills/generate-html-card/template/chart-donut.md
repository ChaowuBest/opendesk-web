---
card-type: chart-donut
extends: ../cardspec.md
---

# Donut Breakdown Card

Part-to-whole with 2–4 categories: customer segmentation, storage, traffic sources. Center shows the total; legend carries values + deltas.

## Composition

`title (+ chevron) → donut with center total → legend rows → footer button (optional)`

### Donut — SVG segments, butt caps

```html
<div class="donut" style="--seg-a:.55; --seg-b:.28; --seg-c:.17">
    <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle class="seg" cx="22" cy="22" r="19" style="--from:0;    --frac:var(--seg-a)" />
        <circle class="seg" cx="22" cy="22" r="19" style="--from:.55;  --frac:var(--seg-b)" />
        <circle class="seg" cx="22" cy="22" r="19" style="--from:.83;  --frac:var(--seg-c)" />
    </svg>
    <div class="center"><span class="meta">Total</span><b>2.758</b></div>
</div>
```

```css
.donut {
    position: relative;
    width: min(52cqw, 170px);
    align-self: center;
}
.donut svg {
    display: block;
    width: 100%;
    transform: rotate(-90deg);
}
.seg {
    fill: none;
    stroke-width: 5.5; /* ≈12% of size, butt caps */
    stroke-dasharray: calc(var(--frac) * 119.4) 1000;
    stroke-dashoffset: calc(var(--from) * -119.4);
    stroke: var(--seg-color, var(--tone));
}
.center {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    text-align: center;
}
.center b {
    font-size: clamp(16px, 6cqw, 22px);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--ink);
}
```

Per-segment colors inline: `style="--seg-color:var(--green)"` etc. (semantic tokens or tone ladder, ≤3 hues + optional neutral "Other").

- **Butt caps for multi-segment** (round caps overlap neighbors). Round caps are for the single-ring gauge (`progress-goal.md`, core §5.5).
- Keep `--frac` contiguous and summing to 1. The 2–3% shave is only for same-hue neighbors that must read separately — subtract it from each `--frac` AND advance every later `--from` by the shaved amount, or arcs overlap.

### Legend rows

```css
.lrow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 7px 0;
    min-width: 0;
}
.lrow .chip {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    background: var(--seg-color);
}
.lrow .name {
    color: var(--ink-2);
}
.lrow .val {
    margin-left: auto;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}
```

Value followed by a README `.delta` (`↗ 424` green / `↘ 213` red). When the donut is a pure share (no absolutes), the legend value may be the percent instead (`52%`, tabular) — pick one or the other, never both.

### Footer

Optional full-width quiet button (README `.btn`), width 100%.

## Size behavior

- `< 220px`: donut + center total only; legend drops (total is in the center).
- `220–430px`: stacked — donut, then legend.
- `> 430px`: split — donut left, legend right (`grid-template-columns:minmax(0,5fr) minmax(0,7fr)`).

## Do / Don't

- DON'T exceed 4 segments — merge the tail into a neutral "Other" (`color-mix(in oklab, var(--ink) 15%, transparent)`).
- DON'T use round caps, 3D, explode offsets, or gradients.
- DON'T show a legend without values, or values without the delta when a comparison exists.
- DO keep fractions tabular; center total passes the §3 width budget.
