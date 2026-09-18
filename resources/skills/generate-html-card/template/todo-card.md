---
card-type: todo-card
extends: ../cardspec.md
---

# To-do Card

Task lists: pinned to-dos, checklists, today's tasks. Also supplies the **task row** reused by `agenda-card.md`.

## Composition

`title row (icon + title, optional count meta) → task rows → "N others" meta (optional)`

```html
<div class="card todo">
    <div class="hd"><span class="t">📌 Pinned To-dos</span></div>
    <label class="task">
        <input type="checkbox" />
        <span class="box" aria-hidden="true"></span>
        <span class="tx"><b>Ease widget design</b><i>9:30 AM</i></span>
    </label>
    <label class="task">…Daily interface desi… 3:00 PM…</label>
    <span class="meta more">6 others</span>
</div>
```

```css
.todo .hd {
    justify-content: flex-start;
    gap: 6px;
    align-items: center;
}
.hd .t {
    font-weight: 600;
    font-size: clamp(13px, 4.8cqw, 15px);
    color: var(--ink);
}
.task {
    position: relative; /* anchor for the hidden checkbox input */
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 11px 0;
    min-width: 0;
    cursor: pointer;
}
.task + .task {
    border-top: 1px dashed color-mix(in oklab, var(--ink) 22%, transparent);
}
.task input {
    position: absolute;
    opacity: 0;
}
.task:has(input:focus-visible) {
    outline: 2px solid color-mix(in oklab, var(--tone) 55%, transparent);
    outline-offset: 2px;
}
.box {
    width: 18px;
    height: 18px;
    flex: none;
    border-radius: 50%;
    border: 1.5px solid color-mix(in oklab, var(--ink) 30%, transparent);
    display: grid;
    place-content: center;
}
.box::after {
    content: '';
    width: 9px;
    height: 5px;
    border-left: 2px solid var(--on-tone);
    border-bottom: 2px solid var(--on-tone);
    transform: rotate(-45deg) translate(0, -1px);
    opacity: 0;
}
.task input:checked ~ .box {
    background: var(--tone);
    border-color: var(--tone);
}
.task input:checked ~ .box::after {
    opacity: 1;
}
.tx {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
}
.tx b {
    font-weight: 600;
    font-size: clamp(12.5px, 4.4cqw, 13.5px);
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.tx i {
    font-style: normal;
    font-size: 11px;
    color: var(--ink-3);
}
.task input:checked ~ .tx b {
    color: var(--ink-3);
    text-decoration: line-through;
}
.more {
    display: block;
    padding: 6px 0 0;
}
```

- The pin/clip/list icon in the title row is a 14px `--ink-3` inline-SVG glyph (the 📌 above stands in for it — use SVG, not emoji).
- Rows are real checkboxes (keyboard + AT free); `:has()` drives both the box fill and the done style.

## Size behavior

- `< 180px`: drop the time line; title + box survive. Show ≤3 rows + "N others" at every tier — a to-do card never scrolls.

## Do / Don't

- DO one list per card; "Pinned", "Today", "Overdue" are separate cards or sections of `agenda-card.md`.
- DON'T add pills/tags to tasks — priority belongs to events (`event-card.md`).
- DON'T fake the checkbox with a bordered span alone; keep the input for focus & AT.
