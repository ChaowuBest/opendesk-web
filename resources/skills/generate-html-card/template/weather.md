---
card-type: weather
extends: ../cardspec.md
---

# Weather Card

Two variants: **A — scene** (a colored forecast card, one per mood) and **B — detail widget** (dark nested-panel board). Glyphs in both are inline-SVG **line icons** stroked in the local ink (`stroke:currentColor; fill:none; stroke-width:1.5`) — never emoji, never multicolor clipart; that's what keeps four weather moods looking like one family.

## Variant A — scene

A solid mood surface, like `promo-callout.md` but informational. Set the mood as a local `--tone` mix (no new literals):

| mood       | local tone / surface                                                       | text        |
| ---------- | -------------------------------------------------------------------------- | ----------- |
| sunny      | `color-mix(in oklab, var(--red) 55%, var(--yellow))`                       | `--on-tone` |
| cloudy     | `var(--blue)`                                                              | `--on-tone` |
| hazy       | `color-mix(in oklab, var(--yellow) 70%, var(--red))`                       | `--on-tone` |
| rain/storm | gradient `color-mix(in oklab, var(--blue) 45%, var(--obj))` → `var(--obj)` | `--on-obj`  |

Rule: surface mixing ≥40% `--obj` → `--on-obj` text; otherwise `--on-tone`. Verify ≥4.5:1 in **both** themes before delivering.

```html
<div class="card scene tone-sunny">
    <div class="sc-top">
        <span class="cond"><svg …sun glyph…></svg>Sunny</span>
        <span class="stamp"><b>23:56</b><i>MON 08-23</i></span>
    </div>
    <div class="hero-t">36°</div>
    <div class="sc-mid"><span>42° / 28°</span><span class="city">San Francisco</span></div>
    <div class="strip">
        <span><i>TUE</i><svg …glyph…></svg></span><span>…</span><span>…</span><span>…</span>
    </div>
</div>
```

```css
.scene {
    --pad: 20px; /* pin pad to px: % --pad breaks the strip's negative-margin bleed */
    background: linear-gradient(
        135deg,
        color-mix(in oklab, var(--tone) 92%, var(--card)),
        color-mix(in oklab, var(--tone) 72%, var(--obj))
    );
    color: var(--on-tone);
    border: none;
    gap: 2px;
}
.rain {
    background: linear-gradient(135deg, color-mix(in oklab, var(--blue) 45%, var(--obj)), var(--obj));
    color: var(--on-obj);
}
.sc-top,
.sc-mid,
.strip span {
    color: inherit;
}
.cond {
    display: flex;
    align-items: center;
    gap: 5px;
    font-weight: 600;
    font-size: clamp(12px, 4.6cqw, 14px);
}
.stamp {
    margin-left: auto;
    text-align: right;
    display: flex;
    flex-direction: column;
}
.stamp b {
    font-size: clamp(13px, 5cqw, 16px);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
}
.stamp i {
    font-style: normal;
    font-size: 10px;
    opacity: 0.75;
}
.hero-t {
    font-weight: 250;
    font-size: clamp(44px, 26cqw, 84px);
    line-height: 1;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
}
.sc-mid {
    display: flex;
    justify-content: space-between;
    font-size: 12px;
    opacity: 0.85;
    font-variant-numeric: tabular-nums;
}
.city {
    max-width: 16ch;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.strip {
    display: flex;
    margin: 8px calc(var(--pad) * -1) calc(var(--pad) * -1);
    border-top: 1px solid color-mix(in oklab, currentColor 18%, transparent);
}
.strip span {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    padding: 9px 0;
}
.strip span + span {
    border-left: 1px solid color-mix(in oklab, currentColor 14%, transparent);
}
.strip i {
    font-style: normal;
    font-size: 10px;
    opacity: 0.8;
}
```

- Decorative: ≤2 soft radial-gradient fades of `currentColor` (8–12% at center → transparent), anchored to card corners so they never sit under the hero or strip text.
- `< 180px`: drop hi/lo + city; condition + temp + strip survive. Strip = 4 days max.

## Variant B — detail widget

Standard tokens (no scene surface) — dark parity is automatic. Composition: **header inset panel** (`--card-2`, `--r-lg`): 44px glyph + { day/time meta, `Cloudy 10°C` title (600, `clamp(16px,6cqw,20px)`), city meta } → **sun-times pill** → **metrics row** → **forecast strip**.

```css
.whead {
    background: var(--card-2);
    border-radius: var(--r-lg);
    padding: 14px;
    display: flex;
    align-items: center;
    gap: 12px;
}
.whead .wglyph {
    width: 44px;
    height: 44px;
    color: var(--ink-2);
    flex: none;
}
.whead .m2 {
    font-size: 11px;
    color: var(--ink-3);
}
.whead .t {
    font-weight: 600;
    font-size: clamp(16px, 6cqw, 20px);
    color: var(--ink);
}
.sun {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 14px;
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--ink) 6%, transparent);
}
.sun .t2 {
    font-size: 11.5px;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
}
.sun svg {
    color: var(--ink-3);
}
.sun .dash {
    flex: 1;
    border-top: 1px dashed color-mix(in oklab, var(--ink) 25%, transparent);
}
.wrow {
    display: flex;
    align-items: center;
    gap: 14px;
    flex-wrap: wrap;
}
.wmetric {
    font-size: 12px;
    color: var(--ink-3);
}
.wmetric b {
    color: var(--ink);
    font-weight: 600;
}
.wmetric.on {
    padding: 6px 12px;
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--ink) 8%, transparent);
    color: var(--ink-2);
}
.wmetrics .wdet {
    display: flex;
    gap: 6px;
} /* strip wrapper */
.wtile {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 10px 4px;
    background: var(--card-2);
    border-radius: var(--r-md);
}
.wtile .d {
    font-size: 10.5px;
    color: var(--ink-3);
}
.wtile svg {
    width: 22px;
    height: 22px;
    color: var(--ink-2);
}
.wtile .t2 {
    font-size: 11px;
    color: var(--ink);
    font-variant-numeric: tabular-nums;
}
@container (max-width: 299px) {
    .wtile:nth-child(n + 6) {
        display: none;
    }
}
```

## Do / Don't

- DON'T mix scene and detail in one card; pick per placement.
- DON'T introduce weather colors as literals — every mood derives from the four accents + `--obj`.
- DON'T let decorative blobs reduce text contrast below 4.5:1 (check the hero's lower half).
