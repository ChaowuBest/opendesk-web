---
card-type: line-chart
extends: ../cardspec.md
---

# Line Chart Card

Multi-series trend lines with axes — the full-size sibling of the §5.1 sparkline ("Platform Growth Overview").

## Composition

`title (+ subtitle meta) → period segmented control → plot (y labels + lines) → x labels → crosshair + tooltip (optional)`

```html
<div class="plot" style="--crosshair:38%; --dot-top:38%">
    <div class="ylabels"><span>100</span><span>50</span><span>0</span></div>
    <div class="chart">
        <span class="cross" aria-hidden="true"></span>
        <span class="dotm" aria-hidden="true"></span>
        <span class="tip"><b>March 2026</b><i>$24,591</i></span>
        <svg viewBox="0 0 300 100" preserveAspectRatio="none" aria-hidden="true">
            <path class="ln s2" d="M0,80 C…smooth cubic through data…" />
            <path class="ln" d="M0,62 C…" />
        </svg>
    </div>
    <span></span>
    <div class="xlabels"><span>Jan</span>…<span>Jul</span></div>
</div>
```

```css
.plot {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 8px;
    --plot-h: clamp(110px, 34cqw, 200px);
}
.ylabels {
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: flex-end;
    height: var(--plot-h);
}
.chart {
    position: relative;
    height: var(--plot-h);
    min-width: 0;
}
.chart svg {
    width: 100%;
    height: 100%;
    display: block;
    overflow: visible;
}
.ln {
    fill: none;
    stroke: var(--tone);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
    stroke-linecap: round;
}
.ln.s2 {
    stroke: var(--yellow);
} /* ≤2 semantic series, legend it */
.xlabels {
    display: flex;
    justify-content: space-between;
} /* grid row 2, plot column — stays aligned */
.cross {
    position: absolute;
    top: 0;
    bottom: 0;
    left: var(--crosshair);
    border-left: 1px dashed color-mix(in oklab, var(--ink) 30%, transparent);
}
.dotm {
    position: absolute;
    left: calc(var(--crosshair) - 4px);
    top: calc(var(--dot-top) - 4px);
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tone);
    border: 2px solid var(--card);
}
.tip {
    position: absolute;
    left: calc(var(--crosshair) + 8px);
    top: 18%;
    background: var(--ink);
    color: var(--card);
    border-radius: var(--r-sm);
    border: 1px solid color-mix(in oklab, var(--card) 12%, transparent);
    padding: 5px 9px;
    display: flex;
    flex-direction: column;
    gap: 1px;
}
.tip b {
    font-size: 10.5px;
    font-weight: 500;
    opacity: 0.7;
}
.tip i {
    font-style: normal;
    font-size: 12px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}
```

- Smooth curves via cubic béziers (control points ≈1/3 of the x-gap); `preserveAspectRatio="none"` + `non-scaling-stroke` keeps 2px strokes at every width.
- **Crosshair dot and tooltip are HTML overlays, not SVG elements** — a `<circle>` inside a stretched (`preserveAspectRatio="none"`) SVG renders as an ellipse. Position them with the same `--crosshair` / a `--dot-top` percentage.
- Crosshair position is a plain percentage; the tooltip is the README emphasis-inverse chip extended to two lines (label + value) with the dark-board hairline, sitting right of the line.
- Period control: README segmented control ("30D / 90D / 12M / Custom"), pinned to the title row.

## Size behavior

- `< 220px`: drop y-labels and crosshair/tooltip; 2–3 x-labels remain (flex space-between). For two series, retain a compact two-item legend (`8px` dots plus short names) above or below the plot; do not leave two indistinguishable lines. If that legend cannot fit, render one series and identify the compact state in its title.
- `< 160px`: this template is the wrong tool — switch to a `kpi-stat.md` sparkline.

## Do / Don't

- DO cap at 2 series (3 with a legend and only if hues are semantic).
- DON'T put area fills under multiple overlapping series; at most one low-opacity fade.
- DON'T mark every data point with dots — the only marker is the crosshair's.
