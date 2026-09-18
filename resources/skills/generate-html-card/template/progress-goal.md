---
card-type: progress-goal
extends: ../cardspec.md
---

# Progress & Goal Card

"How far along" cards: goal ring with target fraction, or a segmented time/phase bar. (Sales Targets "3.415 / 4.000 · 80%", Time Activity "16 hours 39 minutes".)

## Variant A — goal ring + fraction

`title (+ chevron) → ring + fraction side by side → caption`

- Ring: core §5.5 pattern (round caps OK — single value), center label two lines: `label` (meta) + `80%` (600, `clamp(15px,5.5cqw,20px)`).
- Fraction hero: value in hero-thin at `clamp(28px,13cqw,48px)`, denominator as a §3 suffix span. Data must agree: `80%` ↔ `3.200 / 4.000`. If real numbers don't divide cleanly, round the ring label and let the caption carry the exact values — never show two conflicting truths.
- Caption: `t-body` `--ink-2`, inline `.delta` or percent spans colored (`less than <span class="delta up">20%</span> …`).
- Layout `≥ 260px`: split — ring left (~40%), fraction + caption right. Below that: ring on top, centered. **Re-clamp in the split tier** (the core §3 trap): ring `width:min(40cqw,120px)`, fraction `clamp(24px,10cqw,44px)` — full-card `cqw` overflows a 40% column.

```html
<div class="row">
    <div class="ring" style="--pct:.8; --ring:var(--yellow)">…core §5.5 svg…</div>
    <div>
        <div class="frac">3.200<span class="den"> / 4.000</span></div>
        <p class="cap">Only <span class="delta up">800 deals</span> remain to hit the quarter's target.</p>
    </div>
</div>
```

## Variant B — segmented bar

`title (+ kebab) → value line → segmented bar → legend`

```html
<div class="value-lg">16 hours 39 minutes</div>
<div class="segbar">
    <span style="flex:62; --seg:var(--blue)"></span>
    <span style="flex:28; --seg:var(--green)"></span>
    <span style="flex:10; --seg:var(--red)"></span>
</div>
<div class="legend">
    <span class="legend"><i class="dot" style="background:var(--blue)"></i>Active time</span> …
</div>
```

```css
.value-lg {
    font-weight: 600;
    font-size: clamp(16px, 6cqw, 22px);
    color: var(--ink);
}
.segbar {
    display: flex;
    gap: 3px;
    height: 8px;
}
.segbar span {
    border-radius: var(--r-pill);
    background: var(--seg);
}
.segbar span:first-child:last-child {
    border-radius: var(--r-pill);
}
```

- Segment colors are meaning-bearing (active / paused / extra) — semantic tokens per README ladder rules, each in the legend.
- Small percent label inside a segment only if the segment is ≥15% wide; otherwise legend only.

## Size behavior

- `< 200px`: Variant A keeps ring + percent (drops fraction/caption); Variant B keeps value + bar (drops legend if ≤2 segments, else wraps).
- Standard/wide: full composition.

## Do / Don't

- DO make ring + fraction agree (`80%` ↔ `3.415/4.000`); a mismatch is a data bug, not a style choice.
- DON'T add a second ring per card — multi-metric boards use one card per metric (or `chart-donut.md`).
- DON'T color goal rings by "goodness" unless the requester asks; default to `--tone`.
