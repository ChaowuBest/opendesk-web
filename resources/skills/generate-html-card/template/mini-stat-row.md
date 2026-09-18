---
card-type: mini-stat-row
extends: ../cardspec.md
---

# Mini Stat Row (selector tiles)

A segmented row of 2–4 mini stats inside one card, where one tile is selected ("Balance / Income / Expenses"). It is a picker as much as a display.

## Composition

`tile ×N — each: icon + (chevron) → label → period meta → value`

```html
<div class="card msr">
    <div class="tiles" role="radiogroup" aria-label="Expense view">
        <label class="tile sel">
            <input type="radio" name="msr" checked />
            <!-- input FIRST: CSS can only style following siblings -->
            <span class="thd"><svg …icon 14px…></svg><span class="chev">›</span></span>
            <span class="tl">Balance</span>
            <span class="tm">April 2022</span>
            <span class="tv">$20,129</span>
        </label>
        <label class="tile">
            <input type="radio" name="msr" />
            <span class="thd"><svg …icon…></svg></span>
            <span class="tl">Income</span><span class="tm">April 2022</span><span class="tv">$20,129</span>
        </label>
        …
    </div>
</div>
```

```css
.msr {
    /* container root — NO @container rules on it (§4 trap) */
}
.tiles {
    display: flex;
    gap: 8px;
}
.tile {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    cursor: pointer;
    position: relative;
}
.tile input {
    position: absolute;
    opacity: 0;
}
.tile:has(input:focus-visible) {
    outline: 2px solid color-mix(in oklab, var(--tone) 55%, transparent);
} /* invisible input still focuses */
.thd {
    display: flex;
    justify-content: space-between;
    align-items: center;
    color: var(--ink-3);
    min-height: 16px;
}
.tl {
    font-size: 12px;
    font-weight: 600;
    color: var(--ink);
}
.tm {
    font-size: 10.5px;
    color: var(--ink-3);
}
.tv {
    font-weight: 600;
    font-size: clamp(15px, 6cqw, 20px);
    color: var(--ink);
    font-variant-numeric: tabular-nums;
}

/* selected state — driven by input:checked or a static .sel class in mocks */
.tile:has(input:checked),
.tile.sel {
    background: var(--ink);
    color: var(--card);
    border-color: color-mix(in oklab, var(--card) 12%, transparent);
}
.tile:has(input:checked) .tl,
.tile.sel .tl {
    color: var(--card);
}
.tile:has(input:checked) .tm,
.tile.sel .tm {
    color: color-mix(in oklab, var(--card) 62%, transparent);
}
.tile:has(input:checked) .tv,
.tile.sel .tv {
    color: var(--card);
}
.tile:has(input:checked) .thd,
.tile.sel .thd {
    color: color-mix(in oklab, var(--card) 65%, transparent);
}
.tile.sel .chev,
.tile:has(input:checked) .chev {
    display: inline;
}
.chev {
    display: none;
}
@container (max-width: 299px) {
    /* content-box tier, on an inner wrapper */
    .tiles {
        flex-direction: column;
    }
}
```

- The selected tile uses the **emphasis inverse** (README `--ink`/`--card`) — it intentionally flips per theme. A `--tone` surface + `--on-tone` text is the alternative when the board needs color.
- Values are `value-lg` weight 600 — equal prominence across tiles; this is not a hero card.
- The chevron appears only on the selected tile.

## Size behavior

- 2 tiles: always a row. 3–4 tiles: row `≥ 300px` content box; below that, stack vertically (the `@container` rule above lives on the inner `.tiles` wrapper — it cannot style the card root).
- Tiles never scroll horizontally.

## Do / Don't

- DO keep every tile's value visible; hiding unselected values defeats the comparison.
- DON'T add sparklines to tiles — that's `kpi-stat.md`; this card's job is switching, not trending.
- DON'T exceed 4 tiles; more means a `form-card.md` select.
