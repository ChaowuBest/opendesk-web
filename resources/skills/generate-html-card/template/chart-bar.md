---
card-type: chart-bar
extends: ../cardspec.md
---

# Bar Chart Card

Column charts: single series, grouped, or stacked. Sales by month, attendance by weekday, etc.

## Composition

`title (+ select chip / chevron) → plot → x labels → legend → caption box (optional)`

### Plot — HTML bars, not SVG

Bars as divs are easier to round and label than stretched SVG:

```html
<div class="plot">
    <div class="ylabels"><span>$12k</span><span>$6k</span><span>$0</span></div>
    <div class="cols">
        <div class="group">
            <div class="bar" style="height:38%"></div>
            <div class="bar s2" style="height:22%"></div>
        </div>
        …
    </div>
</div>
```

```css
.plot {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    min-height: 0;
    --plot-h: clamp(96px, 42cqw, 190px);
}
.ylabels {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-end;
    height: var(--plot-h);
}
.cols {
    display: flex;
    align-items: flex-end;
    gap: clamp(6px, 4cqw, 18px);
    height: var(--plot-h);
}
.group {
    flex: 1;
    height: 100%; /* definite height → % bars resolve */
    display: flex;
    align-items: flex-end;
    justify-content: center;
    gap: 3px;
    position: relative;
} /* flag anchor, spans full plot height */
.bar {
    width: clamp(10px, 9cqw, 26px);
    border-radius: 5px 5px 2px 2px;
    background: var(--tone);
    min-height: 4px;
}
.bar.s2 {
    background: color-mix(in oklab, var(--tone) 45%, var(--card));
}
```

- **Grouped**: each `.group` holds 2–3 bars. `.group` must chain a definite height (`.cols` → `.group{height:100%}`) or the bars' `height:%` collapse to `min-height` — the classic silent killer in this template.
- **Stacked**: one column per month — `.group > .stack{display:flex; flex-direction:column; justify-content:flex-end; gap:2px; height:100%; width:clamp(10px,9cqw,26px)}` with segments at `height:%` of the stack; only the top segment keeps the top radius, the bottom segment the bottom radius.
- **Colors**: series ladder or ≤3 semantic tokens per README; every series appears in the legend.
- **X labels**: a flex row whose cells are `flex:1; text-align:center`, mirroring `.group{flex:1}` 1:1 so labels sit under their group; current period `--ink / 600`, others `--ink-3`.
- **Target line**: absolute `border-top:1px dashed …25% ink` across `.cols` (anchor `.cols{position:relative}`, `top:calc(100% - <target%> * var(--plot-h))` — or a plain `%` top on an inner wrapper).
- **Flag** (e.g. "+17%"): README inverse chip, `position:absolute` inside the emphasized `.group`, `left:50%; transform:translateX(-50%); bottom:calc(<stack-top%> + 8px)` where `<stack-top%>` is that group's total in the same units as the bars. At compact widths `--plot-h` clamps to 96px and flags can poke above the plot — add `padding-top` ≥ flag height to `.plot`, or drop flags under 200px.

### Caption box (optional)

Dashed-border footnote below the chart: `border:1px dashed …25% ink; border-radius:var(--r-md); padding:8px 12px`, leading 14px icon (`--ink-3`), rich text with `.delta` spans.

## Size behavior

- `< 200px`: drop y-labels, legend and caption; ≤7 bars + x labels survive.
- `200–430px`: full plot + x labels; legend if multi-series.
- `> 430px`: may sit beside a text column (split layout).

## Do / Don't

- DO round bar tops (5–6px) — this is the style's signature.
- DO keep bars flat solid/mix colors by default; a **single-hue fade toward transparent** (top solid `--tone` → bottom 0%, tall columns only) is the allowed exception. No multi-color gradients, no shadows on bars.
- DON'T exceed ~12 groups; aggregate older periods.
- DON'T draw horizontal gridlines beyond ≤3 hairlines if at all — y-labels alone usually read fine.
