---
card-type: event-card
extends: ../cardspec.md
---

# Event Card

A highlighted event with description and priority — and the **event row** reused inside `agenda-card.md`.

## Composition (highlighted variant)

`title row (icon + label) → accent bar + { event title → description → meta }`

```html
<div class="card evc">
    <div class="hd"><svg …calendar glyph 14px, --ink-3…></svg><span class="t">Highlighted Event</span></div>
    <div class="ev">
        <span class="bar" aria-hidden="true"></span>
        <div class="ev-b">
            <span class="evt">Ease Project</span>
            <p class="d">Project planning with design team for Ease.</p>
            <div class="m"><span>10:00 AM</span><i class="dot"></i><span>Priority</span></div>
        </div>
    </div>
</div>
```

```css
.evc .t {
    font-weight: 600;
    font-size: clamp(13px, 4.8cqw, 15px);
    color: var(--ink);
}
.evc .hd {
    justify-content: flex-start; /* leading glyph — override the shell's space-between */
    align-items: center;
    gap: 6px;
}
.ev {
    display: flex;
    gap: 10px;
    min-width: 0;
}
.bar {
    width: 4px;
    border-radius: var(--r-pill);
    background: var(--tone);
    flex: none;
}
.ev-b {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
}
.evt {
    font-weight: 700;
    font-size: clamp(15px, 6cqw, 18px);
    line-height: 1.2;
    color: var(--ink);
}
.d {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink-2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.m {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11.5px;
    color: var(--ink-3);
}
.m .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--red);
}
```

- The **accent bar** is the event's category color: one `--tone` per event (blue = work, red = urgent…); the priority dot is separate (`--red`/`--yellow`) and labeled — color never encodes priority alone.
- Meta values (`10:00 AM`) are tabular.

## Event row (inside `agenda-card.md` and other cards)

Same anatomy, compact: 3px bar, 600 13px title (ellipsis), time pushed right (`margin-left:auto`, meta size). No description, no dot unless prioritized.

## Size behavior

- Highlighted: full composition at every tier; description drops below ~160px.
- Row: full at ≥180px; below, time drops.

## Do / Don't

- DON'T add buttons — reminders/actions belong to `notification-card.md`.
- DON'T reuse the bar color for two different categories in one board; legend via consistency, not a key.
- DO keep bar and priority dot visually distinct (bar = category, dot = urgency).
