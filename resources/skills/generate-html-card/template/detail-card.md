---
card-type: detail-card
extends: ../cardspec.md
---

# Detail Card (key–value record)

A record's fields: contact/lead/order/settings blocks. Two layouts — **stacked** (narrow) and **field grid** (wide) — plus optional notes box and footer actions.

## Composition

`title row (+ trailing link or ×) → field groups → inset notes box (optional) → footer button pair (optional)`

### Field group (label over value)

```html
<div class="field">
    <span class="fl">Contact</span>
    <span class="fv"><a href="#">john.doe@example.com</a></span>
</div>
```

```css
.field {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
}
.fl {
    font-size: 11px;
    color: var(--ink-3);
}
.fv {
    font-size: clamp(12px, 4cqw, 13.5px);
    font-weight: 600;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.fv a {
    color: var(--tone);
    text-decoration: none;
}
.fv a:hover {
    text-decoration: underline;
}
```

- Value variants: plain text, `--tone` link, or empty → `--` in `--ink-3` plus a trailing inline action ("Add Email"): the _field row_ becomes `label … link` (`.fl{display:flex; justify-content:space-between}`), never a fake disabled input.
- Long values (emails, URLs) ellipsize; keep them real text so they stay copyable.

### Layouts

- **Stacked** (default, `< 340px`): fields in one column, `gap:14px`.
- **Grid** (`≥ 340px`): `display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:16px 24px` — field pairs read left-to-right; a `min-width:0` on every field keeps ellipsis alive.

### Inset notes box

```css
.inset {
    background: var(--card-2);
    border-radius: var(--r-md);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
}
.inset ul {
    margin: 0;
    padding: 0;
} /* kill UA ul margins */
.inset li {
    list-style: none;
    font-size: 12px;
    color: var(--ink-2);
    display: flex;
    gap: 6px;
}
.inset li::before {
    content: '•';
    color: var(--ink-3);
}
```

Section heading ("Lead Notes") uses `.fl` sizing; an inline action ("Add Note") sits right-aligned on the heading row as a README `.alink`; the title-row "Edit" is the same `.alink`, and a close affordance is a 14px `--ink-3` × glyph button.

### Footer button pair

Right-aligned or full-width pair: secondary **tint** + primary **solid** (README "Buttons — three weights"). Wrap tier, in content-box terms (§2):

```css
@container (max-width: 259px) {
    .pair {
        flex-direction: column;
    }
    .pair .btn {
        width: 100%;
    }
}
```

## Size behavior

Grid collapses to the stacked column below a **340px content box** (`@container (min-width:340px)` builds the grid); title row, fields and notes survive every tier. Only the footer pair may wrap.

## Do / Don't

- DO group fields with section headings past ~7 fields; a wall of labels is unreadable.
- DON'T set values in `--ink-3` — labels are the quiet tier, values must be readable.
- DON'T fake links with color alone in the value + underline on hover only; and never render a link row without an `href`/`role`.
- DON'T mix this card with charts — one record, one card.
