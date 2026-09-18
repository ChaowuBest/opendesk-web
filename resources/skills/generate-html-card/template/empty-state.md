---
card-type: empty-state
extends: ../cardspec.md
---

# Empty State Card

Zero-data card ("No tasks assigned to you yet"). Keeps the card's title row honest and fills the body with one calm illustration + one sentence.

## Composition

`title row (+ filter chip / kebab) → centered illustration → primary line → secondary line → action (optional)`

```html
<div class="card">
    <div class="hd"><span>Assigned Tasks</span><span class="chip">Today ⇅</span></div>
    <div class="empty">
        <svg class="art" viewBox="0 0 96 64" aria-hidden="true">
            <rect x="8" y="6" width="80" height="52" rx="8" fill="var(--card-2)" />
            <rect x="58" y="14" width="22" height="22" rx="6" fill="var(--tone)" opacity=".85" />
            <rect
                x="18"
                y="18"
                width="28"
                height="5"
                rx="2.5"
                fill="color-mix(in oklab, var(--ink) 12%, transparent)"
            />
            <rect x="18" y="30" width="40" height="5" rx="2.5" fill="color-mix(in oklab, var(--ink) 8%, transparent)" />
        </svg>
        <p class="t1">No tasks assigned to you yet</p>
        <p class="t2">Tasks assigned to you will be displayed here.</p>
    </div>
</div>
```

```css
.empty {
    min-height: clamp(120px, 44cqw, 220px);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 6px;
    text-align: center;
}
.art {
    width: clamp(88px, 34cqw, 128px);
    margin-bottom: 8px;
}
.t1 {
    font-weight: 600;
    font-size: clamp(13px, 4.4cqw, 15px);
    color: var(--ink);
}
.t2 {
    font-size: 12px;
    color: var(--ink-3);
    max-width: 34ch;
}
```

- Illustration: 2–4 flat shapes from `--card-2` / ink mixes plus one small `--tone` accent. No photos, no complex scenes, no text inside the SVG.
- Action: a single README `.btn` ("Create task") when an escape hatch exists — never more than one.

## Size behavior

- All tiers keep the full composition; only the illustration scales. At `< 200px` cap `t2` to one line (it wraps naturally via `max-width`).

## Do / Don't

- DON'T show zeros/stripped charts as the empty state — say the fact in words.
- DON'T blame the user; keep copy neutral ("No tasks yet", not "You haven't…").
- DO keep the title row identical to the populated state — the card shouldn't change shape when data arrives.
