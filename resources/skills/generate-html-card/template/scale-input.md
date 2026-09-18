---
card-type: scale-input
extends: ../cardspec.md
---

# Rating Scale Card

Emoji / likert scale ("Mood Tracking"): a question, a horizontal scale, labeled stops. Works as a static mock or a real radio group.

## Composition

`title → description → scale track → emoji stops + labels`

```html
<div class="scale" role="radiogroup" aria-label="How are you feeling today?">
    <div class="track"><span class="fill" style="width:62%"></span></div>
    <div class="stops">
        <label class="stop"><input type="radio" name="mood" /><em>😞</em><span>Terrible</span></label>
        … Bad / Okay / Good / Great …
    </div>
</div>
```

```css
.track {
    position: absolute;
    top: 9px;
    left: 8%;
    right: 8%;
    height: 4px;
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--ink) 10%, transparent);
}
.fill {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--tone);
}
.scale {
    position: relative;
    padding-top: 11px;
}
.stops {
    display: flex;
}
.stop {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    cursor: pointer;
}
.stop input {
    position: absolute;
    opacity: 0;
}
.stop em {
    font-style: normal;
    font-size: 18px;
    line-height: 1;
    filter: grayscale(1);
    opacity: 0.55;
    transition: 0.15s;
}
.stop input:checked + em,
.stop:hover em {
    filter: none;
    opacity: 1;
    transform: scale(1.2);
}
.stop span {
    font-size: 10px;
    color: var(--ink-3);
}
.stop input:checked ~ span {
    color: var(--ink);
    font-weight: 600;
}
```

- Emoji are system-font glyphs (self-contained); 5 stops is the norm, 3–7 acceptable.
- Fill width ≈ position of the selected stop; tone color via `--tone` on the card.
- Static mock: mark the selected stop checked and skip the inputs.

## Size behavior

- Labels ("Terrible"…) drop below ~200px; emoji + track survive — emoji alone must still carry the meaning.
- 5 stops need ≥150px content width; at the compact tier show 3 stops rather than cramming.

## Do / Don't

- DO keep real radio inputs (visually hidden) when interaction is expected — free keyboard/AT support.
- DON'T use red/green semantics on the track unless the scale is valenced (pain, mood) — then `--tone` may still be neutral; the emoji carry valence.
- DON'T put the question in tiny meta text; it is the title.
