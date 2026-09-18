---
card-type: bank-card
extends: ../cardspec.md
---

# Bank Card (payment card visual)

A credit/debit card rendered as an **object** inside a card — wallet views, payment methods, quick transfer. The surface must read as dark plastic in _both_ themes, so it uses the core **object tokens** `--obj` / `--on-obj` (cardspec §2; README §Surfaces) — **not** the `--ink` inverse, which flips to white in dark mode.

## Composition

`brand row (+ chip / brand dots) → number → holder / expiry row`

```html
<div class="bankcard">
    <div class="bc-top">
        <span class="bc-label">Credit Card</span>
        <span class="bc-dots"><i></i><i></i><i></i></span>
    </div>
    <div class="bc-num">0918 8124 0042 8129</div>
    <div class="bc-bot"><span>12/20</span></div>
</div>
```

```css
.bankcard {
    border-radius: var(--r-md);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    background: linear-gradient(135deg, var(--obj), color-mix(in oklab, var(--tone) 22%, var(--obj)));
    color: var(--on-obj); /* object surface — dark in BOTH themes */
    border: 1px solid color-mix(in oklab, var(--on-obj) 12%, transparent);
}
.bc-top {
    display: flex;
    justify-content: space-between;
    align-items: center;
}
.bc-label {
    font-size: 11px;
    color: color-mix(in oklab, var(--on-obj) 65%, transparent);
}
.bc-dots {
    display: flex;
}
.bc-dots i {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: color-mix(in oklab, var(--tone) 70%, var(--on-obj));
}
.bc-dots i + i {
    margin-left: -5px;
} /* overlap — never shift the first dot */
.bc-dots i:nth-child(2) {
    opacity: 0.7;
}
.bc-dots i:nth-child(3) {
    opacity: 0.45;
}
.bc-num {
    font-size: clamp(14px, 5cqw, 18px);
    letter-spacing: 0.08em;
    font-variant-numeric: tabular-nums;
}
.bc-bot {
    font-size: 11px;
    color: color-mix(in oklab, var(--on-obj) 65%, transparent);
}
```

- **Object surface** = `--obj`/`--on-obj` (dark in both themes). Do NOT build it from `--ink`/`--card` — those are the _emphasis_ inverse and flip with the theme (README).
- Number is always real text, `tabular-nums`, in groups of 4. Masked form: `•••• 8129`.
- The tone wash in the gradient is the one allowed flourish; keep ≤25% or it stops looking like plastic.

## Size behavior

Scales at every tier (number drops to one group `•••• 8129` under ~160px). Never rotate/3D-tilt; never place pills, charts or text links on the card surface.

## Do / Don't

- DO keep expiry/holder in the 65% card-mix quiet tone.
- DON'T hardcode near-black/near-white — the inversion must come from `--ink`/`--card` or dark parity breaks.
- DON'T use it as a navigation surface; it displays a payment method, nothing else.
