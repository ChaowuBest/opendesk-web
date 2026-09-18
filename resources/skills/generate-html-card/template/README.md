# Card Template Library

One file per concrete card type. Templates give **composition, data shape, and size behavior** for a known type; the root [cardspec.md](../cardspec.md) always governs tokens, theming, container adaptivity, and the hard rules. If the requested card type has no template here, cardspec.md's generic patterns (§4–§5) are the spec — do not invent a new visual language.

## Reading order

1. Read `cardspec.md` first (tokens, hard rules, patterns).
2. If a template below matches the request, read that one file and follow its composition.
3. No match → build from cardspec.md §4–§5 directly.

## Current templates

**Data & charts**

| file                                 | card type                                       |
| ------------------------------------ | ----------------------------------------------- |
| [kpi-stat.md](kpi-stat.md)           | hero metric + delta + caption / micro-chart KPI |
| [icon-tile.md](icon-tile.md)         | tiny icon + label + number tile                 |
| [chart-bar.md](chart-bar.md)         | column / grouped / stacked bar charts           |
| [chart-donut.md](chart-donut.md)     | donut breakdown with legend                     |
| [line-chart.md](line-chart.md)       | multi-series trend lines with axes & tooltip    |
| [progress-goal.md](progress-goal.md) | goal rings, target fractions, segmented bars    |
| [heatmap.md](heatmap.md)             | calendar heatmap (attendance, activity)         |

**Time & planning**

| file                             | card type                                     |
| -------------------------------- | --------------------------------------------- |
| [calendar.md](calendar.md)       | month picker + week schedule grid             |
| [agenda-card.md](agenda-card.md) | today composite: date panel + to-dos + events |
| [todo-card.md](todo-card.md)     | task list with circle checkboxes              |
| [event-card.md](event-card.md)   | highlighted event + event row                 |
| [scale-input.md](scale-input.md) | emoji / likert rating scale                   |

**Records & people**

| file                                         | card type                                          |
| -------------------------------------------- | -------------------------------------------------- |
| [detail-card.md](detail-card.md)             | key–value record card (fields, notes, actions)     |
| [entity-row.md](entity-row.md)               | person/record row (avatar, name, status chip)      |
| [data-table.md](data-table.md)               | columnar records with status chips                 |
| [notification-card.md](notification-card.md) | reminder/notification with actions & snoozed state |
| [form-card.md](form-card.md)                 | card-wrapped select / input                        |

**Finance**

| file                                       | card type                                |
| ------------------------------------------ | ---------------------------------------- |
| [transaction-list.md](transaction-list.md) | ledger rows with signed amounts          |
| [bank-card.md](bank-card.md)               | payment card visual (object surface)     |
| [mini-stat-row.md](mini-stat-row.md)       | selector tiles (Balance/Income/Expenses) |
| [quick-transfer.md](quick-transfer.md)     | send-money flow (contacts, field, CTA)   |

**Ambient & utility**

| file                                 | card type                             |
| ------------------------------------ | ------------------------------------- |
| [weather.md](weather.md)             | weather scene card + detail widget    |
| [empty-state.md](empty-state.md)     | zero-data card                        |
| [promo-callout.md](promo-callout.md) | solid-accent callout / marketing card |

## Template file contract

Every template must define, and only within the root token system:

1. **Composition** — the card's slots mapped to the hierarchy `title → hero → supporting → meta`.
2. **Size behavior** — what survives at ~160 / 240 / 400+ px content width, using `@container` tiers.
3. **Theme parity** — one composition for both themes; every color via tokens/`color-mix`. The template must retain the root `html[data-theme]` rules so an OpenDesk iframe follows its host rather than the operating system.
4. **Do / Don't** — the 2–5 mistakes that actually happen for this type.
5. **Embed behavior** — templates describe the content inside the OpenDesk-owned frame. They must not add preview page padding, fixed root width, a theme control, or a second outer card treatment.

A template may NOT: introduce literal colors, redefine tokens, require external assets, or use viewport media queries. It MAY add new _local_ custom properties (e.g. `--pct`, per-series ladders) built from tokens.

## Surfaces

One model, four levels — defined once here, referenced everywhere. If a design reaches for a full-bleed color that isn't one of these, it's a surface violation, not a new idea.

| surface          | tokens                 | flips with theme?                           | use                                                                                           |
| ---------------- | ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| quiet card       | `--card` / `--ink`     | yes                                         | the default — ~95% of cards                                                                   |
| emphasis inverse | `--ink` / `--card`     | yes — _inverts_: light surface in dark mode | chart flags & tooltips (`line-chart.md`, `chart-bar.md`), selected tiles (`mini-stat-row.md`) |
| object           | `--obj` / `--on-obj`   | never — always dark                         | physical objects: the payment card (`bank-card.md`)                                           |
| scene            | `--tone` / `--on-tone` | accent value flips                          | weather mood cards (`weather.md`), promo callout, `.btn.primary`                              |

Rules:

- Emphasis-inverse and object surfaces sit on dark cards in dark mode — keep the hairline: `border:1px solid color-mix(in oklab, var(--card) 12%, transparent)`.
- Quiet content on any of them: `color-mix(in oklab, <on-ink> 60-65%, transparent)`.
- Light accents are dark, dark accents are bright — so `--on-tone` (white in light, near-black in dark) always passes. Never hardcode white; never build an object surface from `--ink`/`--card` (it would flip).
- Solid `--tone` backgrounds are allowed for exactly one primary button, one scene card, or one promo per board. Pills (tiny chips) stay tint-only — solid fills with white text fail contrast at their size.
- The flag/tooltip chip on the emphasis surface:

```css
.flag {
    background: var(--ink);
    color: var(--card);
    border-radius: var(--r-pill);
    padding: 3px 8px;
    font-size: 10.5px;
    font-weight: 600;
}
```

## Conventions

- **Type roles** (cardspec §3): meta/labels sit at 10–11.5px in `--ink-3`; field labels are 11px — read-only `--ink-3` (`.fl` in detail-card) vs control labels 600 `--ink-2` (`.lab` in form-card); pills are 10.5px/600. The weight-250 stat hero is reserved for §3 heroes; entity/date/event titles use 600–700 at body-adjacent sizes on purpose.
- **Class names**: `.hd` (title row), `.meta`, `.pill`, `.btn`, `.alink` are shared vocabulary; per-template classes are local — the same name must not carry different styles in two templates on one page (that's why form-card uses `.lab`, not detail-card's `.fl`).
- **Container tiers**: suggested content-box ladder 160 / 200 / 260 / 340 / 430px; templates deviate per family, but adjacent max-/min-widths must never overlap (the 429/430 pairs).
- **Leading-glyph headers** (icon before the title): set `justify-content:flex-start; gap:6px` on `.hd` or the shell's space-between pushes the title away (cardspec §4).

## Shared patterns (referenced by all templates)

### Delta indicator

Trend change next to a value or inline in captions. Semantics beat sign: "down" is green when down is good (churn, latency).

```html
<span class="delta up">↗ 424</span>
<!-- or inline in a caption sentence -->
```

```css
.delta {
    font-weight: 600;
    font-size: 0.9em;
}
.delta.up {
    color: var(--green);
}
.delta.down {
    color: var(--red);
}
```

### Series color ladder (multi-series charts, stacked segments)

One hue family per card stays the default: series A `var(--tone)`, series B `color-mix(in oklab, var(--tone) 45%, var(--card))`, series C `… 22%`. Distinct _meanings_ (e.g. active vs paused time) may use distinct semantic tokens (`--blue` + `--green` + `--orange→--yellow`) — every series color must appear in the legend, and hue count stays ≤3.

### Legend row / legend chip

```css
.legend {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
    color: var(--ink-2);
}
.legend .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
}
.legend .chip {
    width: 10px;
    height: 10px;
    border-radius: 3px;
} /* donut categories */
```

### Buttons — three weights ("More details", "Snooze/Done", "Send Message")

```css
.btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 9px 14px;
    border: 1px solid var(--border);
    border-radius: var(--r-md);
    background: var(--card);
    color: var(--ink);
    font-weight: 600;
    font-size: 13px;
}
.btn:hover {
    background: var(--card-2);
}
.btn.tint {
    background: color-mix(in oklab, var(--tone) 8%, transparent);
    color: var(--tone);
    border-color: transparent;
}
.btn.primary {
    background: var(--tone);
    color: var(--on-tone);
    border-color: transparent;
}
.btn.tint:hover {
    background: color-mix(in oklab, var(--tone) 19%, transparent);
}
.btn.primary:hover {
    background: color-mix(in oklab, var(--tone) 86%, var(--card));
}
```

Declare the variant hovers _after_ the variants — a later rule of equal specificity wins, and the plain `.btn:hover` alone would never reach tint/primary buttons.
The solid primary is a **scene-level surface** (§Surfaces): always with `--on-tone`, exactly one per card. Pills (tiny chips) stay tint-only — solid fills with white text fail contrast at their size.

Use `.btn.tint` on the quiet `--card` surface only. Inside a `--card-2` field/panel, use the ordinary `.btn` or the single `.btn.primary`: tint-on-tint can bring the dark-theme blue label below the 4.5:1 text threshold.

### Inline action link ("See all", "Edit", "Add Email", "Save as Favorite")

```css
.alink {
    font-size: 12px;
    font-weight: 600;
    color: var(--tone);
    text-decoration: none;
}
.alink:hover {
    text-decoration: underline;
}
.alink.quiet {
    color: var(--ink-2);
}
.alink.quiet:hover {
    color: var(--tone);
    text-decoration: none;
}
```

Placement stays local: `.hd .alink { margin-left:auto }` for trailing links, `align-self:center` for footer links. Value links inside `detail-card.md` fields are plain `a` elements styled by the field rule, not `.alink`.

### Segmented control / filter chips ("30D 90D 12M", "All Billing Products")

```css
.segs {
    display: inline-flex;
    gap: 4px;
    padding: 3px;
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--ink) 6%, transparent);
}
.seg {
    padding: 4px 10px;
    border: 0;
    border-radius: var(--r-pill);
    background: transparent;
    font: inherit;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-2);
    cursor: pointer;
    white-space: nowrap;
}
.seg.on {
    background: var(--tone);
    color: var(--on-tone);
}
```

Quiet variant: `.seg.on { background:var(--card); color:var(--ink); box-shadow:var(--shadow); }`.

### Avatar without images

Inline SVG initials circle; bg from the tone ladder, text `--on-tone`. **Never put `var()`/`color-mix()` in SVG presentation attributes** (`fill="…"`/`stroke="…"`) — they don't resolve reliably there; style SVG through CSS:

```html
<svg viewBox="0 0 24 24" class="avatar" aria-label="Wesley Alexis">
    <circle cx="12" cy="12" r="12" />
    <text x="12" y="16" text-anchor="middle">W</text>
</svg>
```

```css
.avatar {
    width: 24px;
    height: 24px;
    border-radius: 50%;
}
.avatar circle {
    fill: color-mix(in oklab, var(--tone) 75%, var(--card));
}
.avatar text {
    fill: var(--on-tone);
    font-size: 11px;
    font-weight: 600;
    font-family: var(--font);
}
```

Overlapping stacks: negative margin −8px, 2px `var(--card)` ring via `stroke`; trailing "+N" bubble uses `.pill.neutral`. Keep the ladder's tone share ≥40% (`color-mix(in oklab, var(--tone) 40-90%, var(--card))`) — paler ends fail initials contrast in one of the two themes.

### Select-style chip ("Monthly ▾", "Today ⇅")

```css
.chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 10px;
    border-radius: var(--r-pill);
    background: color-mix(in oklab, var(--ink) 8%, transparent);
    color: var(--ink-2);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
}
```

Trailing glyph (`▾`, `⇅`) signals the menu. For a static mock a `<span class="chip">` is fine; only wire a real `<select>` when the demo must be interactive. Unlike a chip, a filter segment, plus affordance, or action that changes visible state is always a real `<button type="button">`.

### Dashed guide line

Target lines and connectors: `border-top:1px dashed color-mix(in oklab, var(--ink) 25%, transparent)`, absolutely positioned at the target's % height. Dashed caption boxes use the same color as `border` (solid `--border` also acceptable).
