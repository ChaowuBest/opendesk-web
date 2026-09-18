---
card-type: icon-tile
extends: ../cardspec.md
---

# Icon Tile (micro stat)

The smallest card: a tinted icon square, a label, one number. Used in clusters ("Active employees 146", "New hires 7"). Slot width 120–180px; it _is_ the compact tier — nothing further collapses.

## Composition

`icon → label → hero` — no title row, no supporting tier.

```html
<div class="card tile tone-green">
    <div class="tile-icon">…16px inline-SVG glyph…</div>
    <div class="meta">Active employees</div>
    <div class="tile-num">146</div>
</div>
```

```css
.tile {
    gap: 8px;
    padding: clamp(12px, 8%, 18px);
}
.tile-icon {
    width: clamp(34px, 26cqw, 44px);
    aspect-ratio: 1;
    border-radius: var(--r-md);
    display: grid;
    place-content: center;
    background: color-mix(in oklab, var(--tone) 15%, transparent);
    color: var(--tone);
} /* glyph: stroke:currentColor */
.tile-num {
    font-weight: 250;
    font-size: clamp(26px, 20cqw, 44px);
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
}
```

- Glyphs: simple 24px-viewBox inline SVG strokes (people, calendar, bell) — `fill:none; stroke:currentColor; stroke-width:2`.
- Variant for ~200px slots: icon and label on one row (icon left, label right), number below.

## Do / Don't

- DO one fact per tile; a tile with a chart or caption has become a KPI card (`kpi-stat.md`).
- DO vary `tone-*` per tile in a cluster — this is the one place multiple accent colors on one board are expected; each tile still has exactly one.
- DON'T shrink the icon square below 32px or the number below 24px.
