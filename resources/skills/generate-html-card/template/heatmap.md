---
card-type: heatmap
extends: ../cardspec.md
---

# Heatmap Card

Calendar heatmap: attendance, activity, contributions. Weeks as columns, weekdays as rows.

## Composition

`title (+ period chip) → month labels → grid (+ weekday labels)`

```html
<div class="hm-wrap">
    <div class="hm-months"><span>Feb</span><span>Mar</span><span>Apr</span></div>
    <div class="hm-body">
        <div class="hm-days"><span>Mon</span><span>Wed</span><span>Fri</span><span>Sun</span></div>
        <div class="hm"><i style="--lvl:0"></i><i style="--lvl:2"></i><i style="--lvl:4"></i> …</div>
    </div>
</div>
```

```css
.hm {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    width: 100%;
    grid-template-rows: repeat(7, 1fr);
    gap: clamp(2px, 1cqw, 4px);
}
.hm i {
    aspect-ratio: 1;
    border-radius: 3px;
    background: color-mix(in oklab, var(--tone) calc(var(--lvl) * 24%), var(--card-2));
}
```

- **Levels 0–4**: `--lvl` × ~24% tone over `--card-2`; level 0 is plain `--card-2`. Five steps is the max that stays readable.
- **Cell size**: `grid-auto-columns:1fr` + `width:100%` stretches cells to the card width, and `aspect-ratio:1` derives the height — without both, empty `<i>` cells collapse to 0×0 and the heatmap is invisible. Cap the wrapper so cells stay 6–16px: `max-width ≈ weeks × 16px + (weeks−1) × gap` (16 weeks → ≈313px at 4px gap).
- **Weekday labels**: only Mon/Wed/Fri/Sun (every other row) to avoid a crowded edge. Align via one `grid-template-columns:auto 1fr` wrapper holding months/grid/labels; weekday labels are their own 7-row grid with the same gap so they sit on real rows 1/3/5/7; month labels span the grid column only, roughly every 4th week.
- Data shape: ~12–26 weeks; keep plausible rhythms (weekends lighter for work tools).

## Size behavior

- `< 220px`: drop weekday labels; months survive.
- The grid itself is the content — it never drops. If width can't fit ~12 columns at ≥6px, reduce the week range instead of shrinking cells.

## Do / Don't

- DO use one hue ramp (`--tone` over `--card-2`) — theme parity is automatic.
- DON'T add borders per cell, gaps above 4px, or a second hue.
- DON'T fake interactivity beyond `title` attributes on cells.
