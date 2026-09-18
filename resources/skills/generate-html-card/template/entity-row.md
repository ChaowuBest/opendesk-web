---
card-type: entity-row
extends: ../cardspec.md
---

# Entity Row Card

One record as a row: person, company, file, conversation. Works standalone (micro card) and as rows inside other cards (agenda, inbox, pickers).

## Composition

`avatar → name + subtitle (≤2 lines) → trailing chip → chevron`

```html
<div class="card erow tone-blue">
    <svg class="avatar" viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="12" />
        <text x="12" y="16" text-anchor="middle">JD</text>
    </svg>
    <div class="who">
        <span class="nm">John Doe</span>
        <span class="sub">Chief technical Officer</span>
        <span class="sub">Tech Innovators Inc.</span>
    </div>
    <span class="pill">New Lead</span>
    <span class="chev" aria-hidden="true">›</span>
</div>
```

```css
.erow {
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 12px var(--pad);
}
.avatar {
    width: clamp(30px, 11cqw, 40px);
    height: auto;
    flex: none;
}
.who {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
    flex: 1;
}
.nm {
    font-weight: 600;
    font-size: clamp(13px, 4.6cqw, 14px);
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.sub {
    font-size: 11px;
    color: var(--ink-3);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.chev {
    color: var(--ink-3);
    font-size: 16px;
    flex: none;
}
```

- Avatar: README initials pattern (solid `var(--tone)` circle + `--on-tone` text is fine for entity rows).
- Trailing chip: status ("New Lead") as a tone-tinted pill, or neutral pill for weak states; optional secondary meta ("New Lead ›" as one link) when the chevron is the affordance.
- Standalone card: one row per card. As rows in a card: reuse `.who/.nm/.sub` inside `.row` (core §5.3) with hairline separators.

## Size behavior

- `≥ 180px`: full row. `< 180px`: drop the second subtitle and the chip; keep avatar + name + chevron.
- Never let the name wrap — ellipsis + `title` attribute carry the full value.

## Do / Don't

- DO keep initials ≤2 characters; they stay legible at 30px.
- DON'T use external photos — data-URI or initials only (self-contained rule).
- DON'T stack more than 2 meta lines; move detail to the detail card (`detail-card.md`).
