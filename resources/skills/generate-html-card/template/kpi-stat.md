---
card-type: kpi-stat
extends: ../cardspec.md
---

# KPI / Stat Card

One headline number with its context. Covers: revenue-style KPIs ("$5.832, decreased by $421"), rate KPIs ("92% ↗ 12%"), and stat-with-micro-chart variants.

## Composition

`title → hero → supporting (caption sentence or micro-chart) → meta (period labels / avatars)`

- **Title row**: label left (`t-title`), optional trailing `›` chevron or kebab. Icon variant: a 28–32px circle, `color-mix(in oklab, var(--tone) 13%, transparent)` bg + tone glyph, sits _before_ the title (finance dashboards); the kebab may coexist with it at wide widths.
- **Hero**: number + small unit spans — prefix/suffix per §3 (`.38em; font-weight:400; color:var(--ink-2)`; `$5.832`, `92%`). Inline delta may sit beside the hero (see below).
- **Caption sentence** (optional): 1–2 lines, `t-body` in `--ink-2`; only the delta words are colored: `…decreased this month by about <span class="delta down">$421</span>`.
- **Micro-chart** (optional): 4–7 mini columns or a core §5.1 sparkline. Mini columns: flex, each bar `flex:1; max-width:14px; border-radius:4px 4px 2px 2px`, periods as `color-mix(in oklab, var(--ink) 9%, transparent)`, the current one `var(--tone)`; period letters beneath (`t-meta`), current emphasized `color:var(--ink); font-weight:600`. Past ~7 bars, or once axes/legends/tooltips are needed, step up to `chart-bar.md`.
- **Trailing meta** (optional): avatar stack (README pattern) with `+N` pill.

## Delta next to hero

```html
<div class="hero">92<span class="u">%</span></div>
<span class="delta up" style="font-size:clamp(13px,5cqw,17px)">↗ 12%</span>
```

Hero and delta on one baseline row (`display:flex; align-items:baseline; gap:8px`).

## Size behavior

- `< 180px` content: title + hero + delta + micro-chart survive. Drop the caption, axis labels, and avatars first; the micro-chart is part of the primary visual and is never dropped. Put the delta below the hero when they cannot share one row, and use the long-hero scale from cardspec §3 for five or more glyphs.
- `180–430px`: full stack.
- `> 430px`: may split — hero left, caption right (`grid-template-columns: minmax(0,4fr) minmax(0,6fr)`). The split hero must be re-clamped against its smaller column, for example `font-size:clamp(32px,8cqw,56px)`, and the delta must be allowed to wrap below it rather than overlap.

## Do / Don't

- DO keep numerals `tabular-nums`; the hero must pass the §3 width budget.
- DO color only the delta words in a caption — never the whole sentence.
- DON'T stack a chart _and_ a caption _and_ avatars at 200px — pick two supports max.
- DON'T use red/green decoratively: green means "changed favorably", red "unfavorably", regardless of sign.
