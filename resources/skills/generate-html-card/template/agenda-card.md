---
card-type: agenda-card
extends: ../cardspec.md
---

# Agenda / Today Card

A day summary that composes the date, counts, to-dos and events in one wide card. Reuses `todo-card.md` and `event-card.md` rows as-is. The month picker and the multi-day week schedule grid live in `calendar.md`.

## Composition (wide)

`split: date panel | content`

```html
<div class="card agd">
    <div class="panel">
        <span class="dnum">Jan 9</span>
        <span class="dwd">Friday</span>
        <span class="dsep" aria-hidden="true"></span>
        <span class="cnt"><svg …event glyph…></svg>1 Event</span>
        <span class="cnt"><svg …check glyph…></svg>8 To-dos</span>
    </div>
    <div class="col">
        <div class="hd"><span class="t">Today</span><span class="cnt-pill">9</span><span class="kebab">⋯</span></div>
        <span class="sec">To-dos</span>
        …2 × todo-card.md task rows…
        <span class="meta more">6 others</span>
        <span class="sec">Events</span>
        <div class="erow">
            <span class="bar" aria-hidden="true"></span>
            <span class="et">Ease Project Planning</span>
            <span class="et-time">10:00</span>
        </div>
    </div>
</div>
```

```css
.agd {
    flex-direction: row;
    gap: var(--gap);
}
@container (min-width:430px) {
    .agd {
        display: grid;
        grid-template-columns: minmax(0, 4fr) minmax(0, 7fr);
    }
}
.panel {
    background: var(--card-2);
    border-radius: var(--r-md);
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 6px;
}
.dnum {
    font-weight: 700;
    font-size: clamp(22px, 9cqw, 32px);
    line-height: 1;
    letter-spacing: -0.02em;
    color: var(--ink);
}
.dwd {
    font-size: 13px;
    color: var(--ink-2);
}
.dsep {
    border-top: 1px dashed color-mix(in oklab, var(--ink) 22%, transparent);
    margin: 8px 0;
}
.cnt {
    display: flex;
    align-items: center;
    gap: 7px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ink);
}
.cnt svg {
    color: var(--ink-3);
}
.col {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.col .hd {
    justify-content: flex-start;
    gap: 6px;
} /* leading title, not space-between */
.t {
    font-weight: 700;
    font-size: clamp(14px, 5cqw, 16px);
    color: var(--ink);
}
.cnt-pill {
    font-size: 11px;
    color: var(--ink-3);
}
.kebab {
    margin-left: auto;
    color: var(--ink-3);
    font-size: 14px;
}
.sec {
    font-size: 11px;
    color: var(--ink-3);
    padding: 8px 0 2px;
}
.erow {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0;
    min-width: 0;
}
.erow .bar {
    width: 3px;
    height: 16px;
    border-radius: var(--r-pill);
    background: var(--tone);
    flex: none;
}
.et {
    font-weight: 600;
    font-size: 12.5px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.et-time {
    margin-left: auto;
    font-size: 11px;
    color: var(--ink-3);
    font-variant-numeric: tabular-nums;
}
```

- The date panel is a **card-2 inset** (`detail-card.md` inset pattern, larger); counts must match the lists ("6 others" + 2 shown = 8).
- To-do rows: `todo-card.md` `.task` markup verbatim. Event rows: `event-card.md` row variant.

## Size behavior

- `≥ 430px` content box: split (panel left, sections right).
- `< 430px`: panel collapses to a header strip — the tier is explicit, not implied:

```css
@container (max-width: 429px) {
    .agd {
        display: flex;
        flex-direction: column;
    }
    .panel {
        flex-direction: row;
        align-items: center;
        gap: 12px;
    }
    .dnum {
        font-size: 16px;
    }
    .dwd,
    .cnt {
        font-size: 12.5px;
    }
    .dsep {
        display: none;
    }
}
```

- To-do rows: `todo-card.md` `.task` markup verbatim. Event rows: `event-card.md` row variant.

## Do / Don't

- DO reuse the row patterns untouched — a second checkbox design on one board is the classic drift.
- DON'T show more than 2–3 rows per section; overflow is the "N others" meta's job.
- DON'T restyle the date as a hero numeral with tabular figures — "Jan 9" is a word + number set in 700, not the stat hero.
