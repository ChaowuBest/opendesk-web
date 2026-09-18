---
card-type: promo-callout
extends: ../cardspec.md
---

# Promo / Callout Card

A marketing or announcement card on the **scene surface** (README §Surfaces): solid accent + `--on-tone` text — the same family as the weather mood cards, and like them, one loud card per board. ("Discover a Smarter Way to Support Your Team".)

## Tokens

Add the on-tone pair (README) to the token block — text sits on `var(--tone)`:

```css
--on-tone: #ffffff;
--on-tone: light-dark(#ffffff, #0a0a0b);
```

## Composition

`title → body (optional) → decorative art → action button`

```html
<div class="card promo tone-orange-note" style="--tone:color-mix(in oklab, var(--red) 78%, var(--yellow))">
    <svg class="art" viewBox="0 0 100 100" aria-hidden="true">
        <path d="M50 50 m0 -34 a34 34 0 1 1 -.1 0 M30 70 q20 -18 44 -10" />
    </svg>
    <h3>Discover a Smarter Way to Support Your Team</h3>
    <span class="go" aria-hidden="true">↗</span>
</div>
```

```css
.promo {
    position: relative;
    min-height: clamp(140px, 52cqw, 200px);
    background: var(--tone);
    color: var(--on-tone);
    border: none;
}
.promo h3 {
    margin: 0;
    position: relative;
    z-index: 1; /* paint above the art */
    font-size: clamp(16px, 6.4cqw, 22px);
    line-height: 1.25;
    font-weight: 600;
    max-width: 22ch;
}
.promo .art {
    position: absolute;
    right: -10%;
    bottom: -18%;
    width: 70%;
    opacity: 0.9;
    pointer-events: none;
}
.promo .art path {
    fill: none;
    stroke: var(--on-tone);
    stroke-opacity: 0.14;
    stroke-width: 14;
    stroke-linecap: round;
} /* var() lives in CSS, not the attribute */
.promo .go {
    position: absolute;
    right: var(--pad);
    bottom: var(--pad);
    width: 32px;
    height: 32px;
    display: grid;
    place-content: center;
    border-radius: 10px;
    background: color-mix(in oklab, var(--on-tone) 16%, transparent);
}
```

- **Surface tone**: brand colors outside the 4 semantic accents are allowed _only here_, as a local mix of tokens (`--red`+`--yellow` above) — never a new literal. For calm boards prefer the tint variant instead: `background:color-mix(in oklab, var(--tone) 10%, var(--card))`, `color:var(--ink)`.
- Contrast rule: verify title vs surface ≥4.5:1 in **both** themes (that's what `--on-tone` is for).
- Decorative art: 1–2 oversized stroke/fill shapes at 8–16% on-tone opacity, bleeding off-card (`overflow:hidden` already on `.card`).
- Content is short: a title ≤2 lines, at most one sentence, one action.

## Size behavior

- The composition survives every tier — title + button never drop; art scales and may crop.

## Do / Don't

- DON'T put data (charts, numbers, pills) on a solid tone surface — this pattern carries words and one action only.
- DON'T place two promo cards of different solid hues side by side in one board; one loud card per board, or use the tint variant everywhere.
- DON'T forget `border:none` — the default hairline looks wrong on a colored surface.
