---
card-type: form-card
extends: ../cardspec.md
---

# Form Card (inputs & selects)

A card wrapping one control — pickers, quick edits, filters ("Select Client"). One label + one control per card; multi-field forms are `detail-card.md` territory with real inputs.

## Composition

`label → control (+ trailing adornments)`

### Select

```html
<label class="card form">
    <span class="lab">Select Client</span>
    <span class="ctl">
        <svg class="avatar" …initials…></svg>
        <span class="val">John Doe</span>
        <span class="sub">john.doe@company.com</span>
        <svg class="chev" viewBox="0 0 12 12"><path d="M2 4l4 4 4-4" /></svg>
        <select aria-label="Select client">
            <option>John Doe</option>
            <option>…</option>
        </select>
    </span>
</label>
```

```css
.form {
    gap: 6px;
}
.lab {
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-2);
} /* NOT .fl — that belongs to detail-card.md */
.ctl {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 38px;
    padding: 0 10px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--card-2);
}
.ctl .val {
    font-weight: 600;
    font-size: 13px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
}
.ctl .sub {
    font-size: 11px;
    color: var(--ink-3);
    margin-left: auto;
    flex: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.ctl .chev {
    width: 12px;
    flex: none;
    fill: none;
    stroke: var(--ink-3);
    stroke-width: 1.5;
}
.ctl select {
    position: absolute;
    inset: 0;
    opacity: 0;
    width: 100%;
    cursor: pointer;
}
.ctl:focus-within {
    outline: 2px solid color-mix(in oklab, var(--tone) 55%, transparent);
}
```

- The invisible native `<select>` stretched over the styled row keeps keyboard/AT behavior for free; the visible row is plain markup, so avatar + two-line value render exactly like everywhere else.
- Chevron/stepper icons are inline SVG styled in CSS (no `var()` in presentation attributes).

### Text input variant

Same `.ctl` shell; replace the value spans with a real `<input>` styled `background:transparent; border:none; outline:none; color:var(--ink); font:inherit; width:100%`. Placeholder = `--ink-3`. Focus ring via `.ctl:focus-within` (token-derived — do not remove outlines).

## Size behavior

- Full composition survives all tiers; below ~200px hide the `.sub` (email) inside the control, keep label + value + chevron.

## Do / Don't

- DO always show the `<label>`/`.fl` — never placeholder-as-label.
- DO set explicit `background`/`color`/`border` on controls — UA default styling is the one thing that breaks dark parity.
- DON'T put a submit button in the same card as a single picker; pair controls with the actions of the card that owns the workflow.
