---
card-type: quick-transfer
extends: ../cardspec.md
---

# Quick Transfer Card

Send-money flow: contact strip → account/card field → one primary action. Composes existing patterns; nothing new is invented visually.

## Composition

`title row (+ "+ Add" affordance) → contact avatar strip → field → primary button → quiet text link`

```html
<div class="card qt">
    <div class="hd">
        <span>Quick Transfer</span><button type="button" class="plus" aria-label="Add recipient">+</button>
    </div>
    <div class="strip">
        <span class="av on">…avatar…</span><span class="av">…avatar…</span><span class="av">…avatar…</span
        ><span class="pill neutral more">+6</span>
    </div>
    <label class="ctl">
        <span class="fl">Card number</span>
        <span class="digits">0000 0000 0000 0000</span>
        <input inputmode="numeric" autocomplete="cc-number" aria-label="Card number" />
    </label>
    <button class="btn primary">Send Money</button>
    <a class="alink quiet" href="#">Save as Favorite</a>
</div>
```

```css
.strip {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    scrollbar-width: none;
}
.strip::-webkit-scrollbar {
    display: none;
}
.av {
    flex: none;
}
.av.on .avatar circle {
    stroke: var(--tone);
    stroke-width: 2;
} /* active contact */
.plus {
    width: 22px;
    height: 22px;
    border: 0;
    border-radius: 50%;
    display: grid;
    place-content: center;
    margin-left: auto;
    background: color-mix(in oklab, var(--ink) 7%, transparent);
    color: var(--ink-2);
    font: inherit;
    font-size: 14px;
    cursor: pointer;
}
.qt .ctl {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 4px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--card-2);
    padding: 8px 12px;
}
.qt .ctl:focus-within {
    outline: 2px solid color-mix(in oklab, var(--tone) 55%, transparent);
}
.digits {
    font-size: 13px;
    letter-spacing: 0.14em;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
}
.qt .ctl input {
    position: absolute;
    inset: 0;
    opacity: 0;
}
.qt .alink.quiet {
    align-self: center;
} /* colors from README .alink.quiet */
@container (max-width:199px) {
    .qt .strip {
        overflow: hidden;
    }
    .qt .strip .av:nth-of-type(n + 3) {
        display: none;
    }
    .qt .digits {
        letter-spacing: 0.08em;
    }
}
```

- Contact strip: README avatars, 36–40px; active contact gets a 2px tone ring. Horizontal scroll is the one allowed internal scroll — a deliberate carousel, capped at one row. At the compact tier, it becomes two avatars plus a visible `+N` bubble rather than a clipped third avatar.
- Card-number field: reuse the `form-card.md` `.ctl` shell; digits in `tabular-nums` with `.14em` spacing (visual grouping without JS formatting); invisible real `<input>` with `inputmode="numeric"` on top keeps mobile keyboards correct. At the compact tier show masked tail form (`•••• 8129`) instead of ellipsizing an unusable card number.
- The solid `.btn.primary` is full-width; exactly one per card. The text link is tertiary — never a second solid button.

## Size behavior

- Full composition survives all tiers; strip and button never drop. Under ~200px keep two avatars plus a `+N` bubble and use the masked card-number tail.

## Do / Don't

- DON'T add a secondary button; destructive/alternative flows live elsewhere.
- DON'T validate or reformat digits in a static mock; spacing via CSS only.
- DON'T put the field and button on one row below 340px.
