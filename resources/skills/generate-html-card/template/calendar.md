---
card-type: calendar
extends: ../cardspec.md
---

# Calendar Cards

Two variants: **mini month** (date picker look) and **week schedule grid** (people or rooms × days with event chips). For a day-summary composite (date panel + to-dos + events) use `agenda-card.md` instead — this file owns the month picker and the multi-day schedule.

## Variant A — mini month

`title row (month + ‹ ›) → weekday header → 6-week day grid`

```html
<div class="cal">
    <div class="cal-hd"><b>February</b><span class="nav">‹&nbsp;&nbsp;›</span></div>
    <div class="cal-grid">
        <span class="dow">M</span>…<span class="dow">S</span> <span class="day out">27</span>…<span class="day"
            >20</span
        >
        <span class="day sel">21</span>…
    </div>
</div>
```

```css
.cal {
    inline-size: min(100%, 280px);
}
.cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px 0;
}
.dow {
    text-align: center;
    font-size: 10px;
    font-weight: 600;
    color: var(--ink-3);
    padding: 4px 0;
}
.day {
    aspect-ratio: 1;
    display: grid;
    place-content: center;
    font-size: 11px;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
    border-radius: 50%;
}
.day.out {
    color: color-mix(in oklab, var(--ink) 25%, transparent);
}
.day.today {
    font-weight: 700;
}
.day.sel {
    background: var(--tone);
    color: var(--on-tone);
    font-weight: 600;
}
```

Selected day: tone circle + `--on-tone` text (README on-tone pair). One selected day per card; "today" may coexist (outline: `box-shadow:inset 0 0 0 1px var(--border)`).

## Variant B — week schedule grid

`title row (+ .btn chip "Check Requests" + range chip "Feb 3 – 6 ‹›") → column header (day/month) → rows`

- **Row grid**: `grid-template-columns: minmax(88px, 2fr) repeat(N, minmax(0, 5fr))`; name column holds README avatar + name (`12px`, 600).
- **Day columns**: 1px `--border` left borders; a "now" line may cross them (dashed guide, README).
- **Event chip**: absolutely positioned in its day span (or a nested relative row):
  `display:flex; gap:6px; padding:6px 8px; border-radius:var(--r-sm); background:color-mix(in oklab, var(--tone) 13%, var(--card)); color:var(--tone); font-size:11px; font-weight:600` with a 16px tone-square icon (`--on-tone` glyph) and a `10px` meta time line. Chip tone = event category (Vacation `--green`, Sick `--red`, Unpaid `--yellow`) — this is meaning-bearing color, legend it once in the header or keep names self-evident.
- **Connector**: dashed guide line from the row start to the chip when the event is mid-week.

## Size behavior

- Mini month: cap the calendar itself at `280px` so a wide OpenDesk card does not turn it into an empty giant grid. Cells must stay ≥24px touch size in real UIs. Below a content width of about `168px`, switch to an agenda/list summary rather than rendering a month grid whose seven columns can no longer meet that floor.
- Agenda `< 320px`: collapse to a single-day list (name column hidden, chips become full-width rows); `≥ 560px`: 4–5 day columns.

## Do / Don't

- DO keep dates `tabular-nums`; weekday header single letters at compact sizes.
- DON'T render a 31-day grid below ~180px width — switch to the agenda-list variant instead.
- DON'T stack more than 2 chips per day-cell; overflow gets a `+2` pill (neutral).
