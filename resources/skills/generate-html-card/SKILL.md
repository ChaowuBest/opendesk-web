---
name: generate-html-card
description: >
    Design and build size-adaptive, self-contained HTML cards/widgets (stat,
    chart, list, media, calendar, monitor, etc.) with automatic macOS-style
    dark/light theming. Prefer OpenDesk embed output for cards placed on its
    immersive desktop; create a standalone preview only when it is requested.
    Use whenever creating card components, dashboard tiles, widget-style UI
    boards, or single-file HTML previews of card layouts — even if the user
    just says "make a card" or "widget".
---

# HTML Card Guideline (macOS widget style)

The target look is a quiet "widget board": elevated near-monochrome surfaces on a canvas, hairline borders, large radii, one huge thin numeral or one dominant element per card, restrained accent color used only for data and pills. Both themes share one composition; only token values change. These rules are token- and pattern-based on purpose — combine them freely, do not turn them into fixed templates.

## 1. Hard rules

1. **Self-contained file.** One HTML file per deliverable. System font stack only; icons/charts as inline SVG; no external CSS/JS/fonts/images/network requests. When the deliverable is an OpenDesk immersive-desktop card (the host usually tells you), the host container owns the outer frame: the root must carry **no border, no outer box-shadow, and no border-radius**, and must fill its iframe edge to edge — a framed card there renders as a double-frame artifact (§4).
2. **Tokens only.** Every color and shadow lives as a CSS custom property in the token block (§2); radii use the token scale except micro radii ≤8px on chart primitives (bar corners, heatmap cells). No literal color anywhere else — decorative art included (derive it from `color-mix` of tokens). Components reference `var(--*)` so themes and per-card accents work by construction.
3. **Theme is one switch.** Use `color-scheme: light dark` + the CSS `light-dark()` function so `prefers-color-scheme` works with a single token block. Map `html[data-theme="light"]` / `html[data-theme="dark"]` to a forced `color-scheme` so themes can be pinned for testing/screenshots. In OpenDesk, `data-theme` is the host-theme contract: the host sets it on the iframe document root, so do not replace it with a card-local toggle or an OS-only test. Never write a second "dark stylesheet".
4. **Cards adapt to themselves, not the viewport.** Every card root sets `container-type: inline-size`. All size-dependent rules are `@container` queries; never viewport media queries for card internals. A card must be correct at any width from ~160px to ~800px regardless of the window size.
5. **Hierarchy invariant.** Every card reads top-to-bottom: `title → hero → supporting → meta`. When width shrinks, drop lower tiers (meta first); the **primary visual (sparkline, artwork, ring) belongs to the hero tier and is never dropped**. Never shrink the hero into illegibility and never restructure per theme.

## 2. Tokens

Copy this block as-is; tune values only when the requester specifies a brand.

```css
:root {
    color-scheme: light dark;
} /* follow the OS …         */
html[data-theme='light'] {
    color-scheme: light;
} /* … unless pinned for test */
html[data-theme='dark'] {
    color-scheme: dark;
}

:root {
    /* Every color token: a plain light literal first (fallback for browsers
     without light-dark()), then the same token via light-dark(). No separate
     dark stylesheet exists — light-dark() tracks the used color-scheme. */
    --page: #f5f5f7;
    --page: light-dark(#f5f5f7, #0a0a0b);
    --card: #ffffff;
    --card: light-dark(#ffffff, #1c1c1e);
    --card-2: #f5f5f7;
    --card-2: light-dark(#f5f5f7, #2a2a2d);
    --ink: rgba(0, 0, 0, 0.87);
    --ink: light-dark(rgba(0, 0, 0, 0.87), rgba(255, 255, 255, 0.92));
    --ink-2: rgba(0, 0, 0, 0.55);
    --ink-2: light-dark(rgba(0, 0, 0, 0.55), rgba(255, 255, 255, 0.55));
    --ink-3: rgba(0, 0, 0, 0.46);
    --ink-3: light-dark(rgba(0, 0, 0, 0.46), rgba(255, 255, 255, 0.34));
    --border: rgba(0, 0, 0, 0.1);
    --border: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.09));
    --hi: rgba(255, 255, 255, 0);
    --hi: light-dark(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.06));
    --shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 12px 32px light-dark(rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.5));

    /* semantic accents (Apple system palette; accessible on light bg) */
    --red: #d70015;
    --red: light-dark(#d70015, #ff453a);
    --green: #1f7a35;
    --green: light-dark(#1f7a35, #32d74b);
    --yellow: #b25000;
    --yellow: light-dark(#b25000, #ffd60a);
    --blue: #0066cc;
    --blue: light-dark(#0066cc, #2997ff);

    /* geometry (theme-independent) */
    --r-lg: 22px;
    --r-md: 13px;
    --r-sm: 9px;
    --r-pill: 999px;
    --pad: clamp(14px, 5%, 24px); /* % resolves against card width */
    --gap: clamp(10px, 4cqw, 18px);
    --font:
        -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, 'PingFang SC', 'Microsoft YaHei',
        sans-serif;

    --tone: var(--blue); /* the card's single accent */

    /* solid-surface pairings (primary buttons, selected tiles, weather scenes,
     the bank-card object — when to use which: template/README.md §Surfaces) */
    --on-tone: #ffffff;
    --on-tone: light-dark(#ffffff, #0a0a0b);
    --obj: #1c1c1e;
    --obj: light-dark(#1c1c1e, #2a2a2d);
    --on-obj: rgba(255, 255, 255, 0.92);
}
```

Why: dark themes cannot rely on shadows for elevation (shadows vanish on dark canvas) — the hairline `--border` plus the `--hi` inset highlight carry separation instead. Accent hues flip to brighter dark-mode variants so tinted pills keep contrast.

Two unit traps, both real-world tested:

- **`cqw` on the card shell itself does NOT resolve against the card.** A container's own styles resolve container units against the nearest _ancestor_ container (or the small viewport if none). The clamp bounds keep `--gap` sane on `.card`, but any token whose scaling matters must only be consumed by _descendants_ of the card. The card shell's own padding uses `%` (`--pad`), which resolves against its containing block — right for full-width slots.
- **Container queries measure the content box** — `--pad` and borders are subtracted. A card in a "200px slot" queries at ~170px. Pick `@container` thresholds in content-box terms and tune them per card family; the §4 example values are a starting point, not law.

Per-card accent: set `--tone` on the card (`.tone-red { --tone: var(--red) }`, `.tone-green { … }`) and use `--tone` for all data ink (charts, deltas, pill text). One tone per card; semantic pills may add a second. Tone choice is semantic on shared boards: red next to green reads as _negative vs positive_ — fine for stocks/threat levels, misleading for a music player. For domains with no natural valence prefer `--blue` (or neutral pills) unless "error" is the message.

**Surfaces beyond the quiet card are a closed set** — emphasis-inverse (`--ink`/`--card`), object (`--obj`/`--on-obj`), scene (`--tone`/`--on-tone`) — documented with their use-cases in template/README.md §Surfaces. If a design reaches for another full-bleed color, that's a surface violation, not a new idea.

## 3. Typography

| role                  | rules                                                                                                                             |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| title                 | `font-weight:600; font-size:clamp(12px, 4.5cqw, 15px); letter-spacing:-.01em`                                                     |
| hero (numbers)        | `font-weight:250; font-size:clamp(44px, 30cqw, 132px); line-height:.95; letter-spacing:-.03em; font-variant-numeric:tabular-nums` |
| hero (long: ≥4 chars) | same but `clamp(36px, 18cqw, 96px)`                                                                                               |
| body                  | `font-size:clamp(11.5px, 3.8cqw, 13.5px); font-weight:500`                                                                        |
| meta                  | `font-size:clamp(10px, 3.2cqw, 11.5px); color:var(--ink-3)`                                                                       |

These are roles, not mandated class names — map them to your own classes (`.t-title`, `.t-hero`, `.t-body`, `.t-meta` are fine conventions); the template files refer to the roles.

- The hero is the one loud element; everything else stays quiet. Units/percent suffixes render as a small span inside the hero: `font-size:.38em; font-weight:400; color:var(--ink-2)`.
- **Fit budget:** a hero must fit its content box. Width per glyph ≈ `0.6 × font-size` for digits/latin (tabular nums), `1.0 × font-size` for CJK. E.g. `1,024` (4–5 glyphs) → 18cqw; `派送中` (3 CJK glyphs) → ≈26cqw; `187.42` (6 glyphs) → ≈19cqw. Check the arithmetic; do not eyeball it.
- CJK has no 250 weight; the hero silently falls back to the lightest weight the system font offers. Acceptable — do not fake thinness with scaling or opacity.
- A non-numeric hero (status word like `派送中`, `Delayed`) is allowed: keep hero size/`--ink`, drop `tabular-nums`, mind the CJK width budget.
- When the hero shares a row/column with content at wide sizes, re-clamp it inside that `@container` rule (a narrower column still sees full-card `cqw` and will overflow).

## 4. Card shell & adaptive layout

### OpenDesk embedded-card mode

OpenDesk puts every generated file in a sized iframe inside the immersive desktop. This is the default delivery mode for a generated OpenDesk card. The iframe document must fill its assigned rectangle and must not recreate a demo page around the card: no `body` padding, fixed card width, page background, standalone theme button, or a second decorative border/shadow around a platform-framed card. The OpenDesk title appears as a host-owned hover overlay, so do not reserve a permanent duplicate title bar inside the content unless the requested visual genuinely needs its own heading.

```css
html,
body {
    inline-size: 100%;
    min-block-size: 100%;
    margin: 0;
}
body {
    background: transparent;
    font-family: var(--font);
    overflow: hidden;
}
.card {
    inline-size: 100%;
    min-block-size: 100%;
    box-sizing: border-box;
    background: transparent;
    border: 0;
    border-radius: 0;
    box-shadow: none;
}
```

The host pins `html[data-theme]` before the card paints. Keep the rules from §2 exactly as written so its light/dark choice wins even when the operating-system preference is the opposite. A standalone canvas, fixed slots, and the three-state theme toggle are **preview-only** (§9).

```css
/* Preview/standalone shell ONLY — for OpenDesk embedded cards, keep the
   frame-less root from the embedded-card mode block and add the layout
   properties below; never ship the border/shadow/radius to the iframe. */
.card {
    container-type: inline-size;
    min-width: 0;
    overflow: hidden; /* enables ellipsis, clips chart bleed */
    display: flex;
    flex-direction: column;
    gap: var(--gap);
    padding: var(--pad);
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: var(--r-lg);
    box-shadow:
        var(--shadow),
        inset 0 1px 0 var(--hi);
}
```

- A container cannot style itself, so structural switches (split layouts) live on an inner wrapper. All `cqw` units and `@container` rules apply to descendants only (see §2 for the unit trap).
- **Frame boundary for OpenDesk embeds (hard rule).** A frame is drawn either by the host `.od-card` container **or** by the card — never both, and never half of each. If the file is consumed by the OpenDesk iframe, the `.card` root must ship with `background:transparent; border:0; border-radius:0; box-shadow:none;` (as the embedded-card mode block above prescribes); to paint an inner panel, wrap the content in a child with `border-radius:var(--r-lg); overflow:hidden` — a child radius cannot stack against the host's rounded clip. The framed `.card` block above is **preview-only**: never copy it into an OpenDesk deliverable, it produces a double frame.
- Header row: flex, `align-items:center; justify-content:space-between` — title left, optional trailing icon (14px, `stroke:var(--ink-3)`, e.g. an expand arrow) right. **Leading-glyph variant** (icon _before_ the title — todo/event/agenda/weather use it): set `justify-content:flex-start; gap:6px` on that header, or the shell's space-between pushes the title to the far edge.
- Content tiers get class names and collapse by tier. Compact keeps the identity of the card: **title + hero + primary visual**; drop axis labels, secondary text, pills, footer:

```css
@container (max-width: 159px) {
    /* content-box threshold — tune per card family */
    .axis,
    .meta,
    .footer {
        display: none;
    }
}
@container (min-width: 430px) {
    /* wide: optional split */
    .layout {
        display: grid;
        grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    }
}
```

- Suggested content-box tier ladder: **160 / 200 / 260 / 340 / 430px**. Families deviate deliberately (templates do), but adjacent tiers' max-/min-width must never overlap — hence the 429/430 pairs.
- Every grid/flex child that holds text needs `min-width:0` (or `minmax(0,…)`) or ellipsis will never trigger.
- Fixed widths only in demo harnesses; in real layouts cards sit in `repeat(auto-fill, minmax(220px, 1fr))` grids and must reflow, not scroll. In an OpenDesk embed, the iframe is the slot: use `inline-size:100%` on the root card and never introduce an internal fixed-width wrapper.

## 5. Recurring patterns

For a **known card type** (KPI, bar/donut charts, goal rings, heatmap, calendar, rating scale, icon tile, empty state, promo), read its file in [template/](template/README.md) — it details composition and size behavior on top of these patterns (see §10). Everything below stays the shared foundation.

### 5.1 Sparkline / area chart

Inline SVG, stretched by layout, stroke kept visually thin:

```html
<svg class="spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
    <linearGradient id="g-apt73" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" class="stop-hi" />
        <stop offset="1" class="stop-lo" />
    </linearGradient>
    <path class="area" fill="url(#g-apt73)" d="M0,30 L8,18 … L100,26 L100,36 L0,36 Z" />
    <path class="line" d="M0,30 L8,18 … L100,26" />
</svg>
```

```css
.spark {
    width: 100%;
    height: clamp(44px, 18cqw, 96px);
    display: block;
}
.stop-hi {
    stop-color: var(--tone);
    stop-opacity: 0.3;
}
.stop-lo {
    stop-color: var(--tone);
    stop-opacity: 0;
}
.line {
    fill: none;
    stroke: var(--tone);
    stroke-width: 1.6;
    vector-effect: non-scaling-stroke;
}
```

- `preserveAspectRatio="none"` + `vector-effect:non-scaling-stroke` is the pairing that keeps strokes hairline at any size. Without it, strokes stretch into ropes. The area path needs no stroke; keep `fill` on the element (or scoped per card) — a CSS rule like `.area{fill:url(#one-id)}` silently overrides _every_ sparkline's inline fill on the page (CSS beats presentation attributes).
- Gradient `id` must be unique per SVG when a page has many.
- Axis labels ("Year ago" / "Today") are an HTML flex row (`.t-meta`, space-between) under the SVG, not SVG text — they must not stretch.
- Data: 20–40 points of plausible shape given the domain; jagged is fine and matches the style.

### 5.2 Tinted pill / badge

```css
.pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: var(--r-pill);
    font-size: 10.5px;
    font-weight: 600;
    white-space: nowrap;
    background: color-mix(in oklab, var(--tone) 16%, transparent);
    color: var(--tone);
}
.pill.neutral {
    background: color-mix(in oklab, var(--ink) 9%, transparent);
    color: var(--ink-2);
}
```

Tint-on-tone reads correctly in both themes because both derive from the same token. Never use a solid accent background with white text at this size. Pills are short badges (`2 TTPs`, `+1.86%`); for a long headline chip use a wrapping variant:

```css
.pill.headline {
    white-space: normal;
    text-align: left;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
}
```

### 5.3 List rows (news, processes, transactions)

```css
.row {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 9px 0;
    min-width: 0;
}
.row + .row {
    border-top: 1px solid color-mix(in oklab, var(--ink) 8%, transparent);
}
.row .t {
    font-weight: 600;
    font-size: clamp(12px, 3.6cqw, 13.5px);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.row .m {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ink-3);
    font-size: 11px;
}
.row .pill {
    margin-left: auto;
}
```

- Title clamps to 2 lines; meta is `time · source` plus 0–2 pills. At narrow widths the meta wraps below the title rather than truncating mid-pill.
- Footer link ("See 14 more"): body-role size, `color:var(--ink-2)`, leading `↳` or trailing `›` glyph, no underline until hover. It is a meta tier — compact layouts drop it.

### 5.4 Media block (artwork, maps, previews)

`aspect-ratio` box with `background:var(--card-2)` (or an inline data-URI image), `border-radius:var(--r-md)`, content overlaid or beside it; progress bars: 4px track `color-mix(in oklab, var(--ink) 12%, transparent)`, fill `var(--tone)`. Decorative art (album covers, gradients) must be built from token mixes, e.g. `color-mix(in oklab, var(--tone) 85%, var(--card))` layered shapes — this keeps hard rule 2 intact and the art theme-aware.

### 5.5 Gauges / rings

SVG circles in a square viewBox (never stretched), value arc via dasharray, center label as an **HTML overlay** (keeps token-driven type; SVG `<text>` would not):

```html
<div class="ring" style="--pct:.64; --ring:var(--green)">
    <svg viewBox="0 0 44 44" aria-hidden="true">
        <circle class="track" cx="22" cy="22" r="19" />
        <circle class="value" cx="22" cy="22" r="19" />
    </svg>
    <div class="ring-label"><b>512</b><span>kcal today</span></div>
</div>
```

```css
.ring {
    position: relative;
    width: min(60cqw, 120px);
    align-self: center;
}
.ring svg {
    display: block;
    width: 100%;
    transform: rotate(-90deg);
}
.ring circle {
    fill: none;
    stroke-width: 4;
    stroke-linecap: round;
} /* ≈10% of size */
.track {
    stroke: color-mix(in oklab, var(--ring) 18%, transparent);
}
.value {
    stroke: var(--ring);
    stroke-dasharray: calc(2 * 3.14159 * 19 * var(--pct)) 1000;
}
.ring-label {
    position: absolute;
    inset: 0;
    display: grid;
    place-content: center;
    text-align: center;
}
```

## 6. Anti-patterns

- Viewport media queries inside card CSS, or any layout that only looks right at one window size.
- Literal colors outside the token block — this is what silently breaks one of the two themes.
- Pure-#fff or gray-#333 surfaces in dark mode; and dark cards with no border (they merge into the canvas).
- Fixed heights that clip; use `min-height` and let content breathe.
- Scaling SVG strokes (missing `vector-effect`), axis labels as stretched SVG text, or a shared CSS fill rule that clobbers per-SVG gradient fills (§5.1).
- Long unbroken tokens (URLs, `CVE-2024-38094`) without `overflow-wrap:anywhere` somewhere in the subtree.
- More than one accent tone per card, or accent used for decoration instead of data.
- `outline:none` on focusable elements; keep visible focus rings.
- Treating a visual control as static text. A clickable segment, plus affordance, filter, or row action is a semantic `<button>` (or an `<a>` for navigation), with keyboard focus; a `<span>` is only for non-interactive mock content.
- Copying the §8 preview `body` or `width:240px` into an OpenDesk iframe. It creates a second card/canvas and leaves the rest of the platform card empty.

## 7. QA checklist (verify before delivering)

1. Wrap the card at ~160 / 240 / 400 / 640px slot widths: no overflow, no clipped labels, hero fits (do the §3 width arithmetic for the longest hero value), tiers drop gracefully while the primary visual survives.
2. Pin `data-theme="light"` and `"dark"`: identical composition; body text ≥4.5:1 and meta ≥3:1 against `--card`; cards clearly separated from `--page`.
3. For OpenDesk output, test `data-theme="light"` while the OS is dark and `data-theme="dark"` while the OS is light. The pinned host theme must win. With no `data-theme`, follow `prefers-color-scheme` (the standalone default).
4. Sparkline strokes stay ~1.6px at every width; gradient fade visible in both themes; each SVG's fill points at its own gradient id.
5. Short pills never wrap mid-text; long headline chips wrap and clamp instead of overflowing.
6. Search the file: zero literal colors outside the token block; zero viewport media queries.
7. Stress content: a 4–6 char hero, a 2-line clamped title, a long URL, CJK text — nothing breaks layout.
8. For OpenDesk output, render the actual iframe root at 160 / 240 / 400 / 640px: the content fills both axes without preview chrome, fixed width, a nested surface, or hidden primary content.

## 8. Starter preview skeleton

Minimal, working **preview** starting point — extend per patterns above. It intentionally includes a canvas and a fixed-width card to make a standalone sample legible. Do not copy its `body` or root `.card` rules into OpenDesk; use embedded-card mode in §4 instead.

```html
<!doctype html>
<html lang="en">
    <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>Cards</title>
        <style>
            :root {
                color-scheme: light dark;
                --font:
                    -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, 'PingFang SC',
                    'Microsoft YaHei', sans-serif;
                --page: #f5f5f7;
                --page: light-dark(#f5f5f7, #0a0a0b);
                --card: #fff;
                --card: light-dark(#fff, #1c1c1e);
                --card-2: #f5f5f7;
                --card-2: light-dark(#f5f5f7, #2a2a2d);
                --ink: rgba(0, 0, 0, 0.87);
                --ink: light-dark(rgba(0, 0, 0, 0.87), rgba(255, 255, 255, 0.92));
                --ink-2: rgba(0, 0, 0, 0.55);
                --ink-2: light-dark(rgba(0, 0, 0, 0.55), rgba(255, 255, 255, 0.55));
                --ink-3: rgba(0, 0, 0, 0.46);
                --ink-3: light-dark(rgba(0, 0, 0, 0.46), rgba(255, 255, 255, 0.34));
                --border: rgba(0, 0, 0, 0.1);
                --border: light-dark(rgba(0, 0, 0, 0.1), rgba(255, 255, 255, 0.09));
                --hi: rgba(255, 255, 255, 0);
                --hi: light-dark(rgba(255, 255, 255, 0), rgba(255, 255, 255, 0.06));
                --shadow:
                    0 1px 2px rgba(0, 0, 0, 0.05), 0 12px 32px light-dark(rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.5));
                --red: #d70015;
                --red: light-dark(#d70015, #ff453a);
                --green: #1f7a35;
                --green: light-dark(#1f7a35, #32d74b);
                --yellow: #b25000;
                --yellow: light-dark(#b25000, #ffd60a);
                --blue: #0066cc;
                --blue: light-dark(#0066cc, #2997ff);
                --r-lg: 22px;
                --r-md: 13px;
                --r-pill: 999px;
                --pad: clamp(14px, 5%, 24px);
                --gap: clamp(10px, 4cqw, 18px);
                --tone: var(--blue);
                --on-tone: #fff;
                --on-tone: light-dark(#fff, #0a0a0b);
                --obj: #1c1c1e;
                --obj: light-dark(#1c1c1e, #2a2a2d);
                --on-obj: rgba(255, 255, 255, 0.92);
            }
            html[data-theme='light'] {
                color-scheme: light;
            }
            html[data-theme='dark'] {
                color-scheme: dark;
            }
            .tone-red {
                --tone: var(--red);
            }
            body {
                margin: 0;
                background: var(--page);
                font-family: var(--font);
                display: flex;
                flex-wrap: wrap;
                gap: 20px;
                padding: 40px;
                align-items: flex-start;
            }
            .card {
                container-type: inline-size;
                min-width: 0;
                overflow: hidden;
                display: flex;
                flex-direction: column;
                gap: var(--gap);
                padding: var(--pad);
                width: 240px /* demo slot only — real layouts let the grid size the card */;
                background: var(--card);
                border: 1px solid var(--border);
                border-radius: var(--r-lg);
                box-shadow:
                    var(--shadow),
                    inset 0 1px 0 var(--hi);
            }
            .hd {
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 8px;
                color: var(--ink);
                font-weight: 600;
                font-size: clamp(12px, 4.5cqw, 15px);
            }
            .hero {
                font-weight: 250;
                font-size: clamp(44px, 30cqw, 132px);
                line-height: 0.95;
                letter-spacing: -0.03em;
                color: var(--ink);
                font-variant-numeric: tabular-nums;
            }
            .meta {
                font-size: clamp(10px, 3.2cqw, 11.5px);
                color: var(--ink-3);
            }
            .axis {
                display: flex;
                justify-content: space-between;
            }
            .spark {
                width: 100%;
                height: clamp(44px, 18cqw, 96px);
                display: block;
            }
            .line {
                fill: none;
                stroke: var(--tone);
                stroke-width: 1.6;
                vector-effect: non-scaling-stroke;
            }
            @container (max-width:159px) {
                .meta {
                    display: none;
                }
            }
        </style>
    </head>
    <body>
        <div class="card tone-red">
            <div class="hd"><span>Usage</span><span class="meta">this week</span></div>
            <div class="hero">21</div>
            <svg class="spark" viewBox="0 0 100 36" preserveAspectRatio="none" aria-hidden="true">
                <path class="line" d="M0,28 L10,16 L20,24 L30,10 L40,20 L50,14 L60,26 L70,12 L80,22 L90,18 L100,24" />
            </svg>
            <div class="meta axis"><span>Mon</span><span>Today</span></div>
        </div>
    </body>
</html>
```

## 9. Demo page format (when samples/preview are requested)

- Page background `var(--page)`, simple wrapping flex/grid; place cards in fixed-width slots (e.g. `style="width:260px"`) sized to the tiers you want to prove. When adaptivity itself is under review, show the _same_ card at 2–3 widths; otherwise one slot per card is enough. Cards must never rely on the slot for internal sizing.
- Include the theme toggle, pinned top-right, cycling auto → light → dark. The toggle itself must be token-styled (an unstyled UA button breaks rule 2 on the demo page):

```html
<button id="themeBtn">Theme: auto</button>
<style>
    #themeBtn {
        position: fixed;
        top: 12px;
        right: 12px;
        z-index: 9;
        padding: 6px 12px;
        background: var(--card);
        color: var(--ink-2);
        border: 1px solid var(--border);
        border-radius: var(--r-pill);
        font: 600 12px var(--font);
        cursor: pointer;
    }
</style>
<script>
    const btn = document.getElementById('themeBtn');
    const modes = ['', 'light', 'dark'];
    let i = 0;
    btn.onclick = () => {
        i = (i + 1) % 3;
        const m = modes[i];
        if (m) document.documentElement.dataset.theme = m;
        else delete document.documentElement.dataset.theme;
        btn.textContent = 'Theme: ' + (m || 'auto');
    };
</script>
```

- No other page chrome. Content language follows the requester's language; the font stack already covers CJK.

## 10. Template library

Concrete card types are specified per-type in [template/](template/README.md): `kpi-stat`, `icon-tile`, `chart-bar`, `chart-donut`, `line-chart`, `progress-goal`, `heatmap`, `scale-input`, `calendar`, `agenda-card`, `todo-card`, `event-card`, `weather`, `detail-card`, `notification-card`, `entity-row`, `form-card`, `transaction-list`, `bank-card`, `mini-stat-row`, `quick-transfer`, `data-table`, `empty-state`, `promo-callout`. Rules of engagement:

1. **Match → template.** If the requested card matches a template, read that file and follow its composition; it reuses this spec's tokens and patterns and adds type-specific detail (shared micro-patterns live in template/README.md: delta, series ladders, legend, buttons, avatars, on-tone pair, dashed guides).
2. **No match → this spec.** Build from §4–§5 directly; do not invent a new visual language. If a new type recurs, propose adding a template file following template/README.md's contract.
3. **Conflict → this spec wins.** Templates may add local custom properties (e.g. `--pct`, `--on-tone`) built from tokens, but may not redefine tokens, add literal colors, or drop theme/size rules.
