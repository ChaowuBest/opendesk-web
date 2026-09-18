---
card-type: notification-card
extends: ../cardspec.md
---

# Notification / Reminder Card

A timed message with actions: meeting reminders, alerts, follow-ups. Has an **active** and a **snoozed/muted** state.

## Composition (active state)

`title row (title + time meta) → body → action pair`

```html
<div class="card note">
    <div class="hd"><span>Remind client for meeting</span><span class="meta">Now</span></div>
    <p class="body">
        The client requested to email their office first and ask for their schedule before setting up a date.
    </p>
    <div class="pair">
        <button class="btn tint">Snooze</button>
        <button class="btn primary">Done</button>
    </div>
</div>
```

```css
.note .hd span:first-child {
    font-weight: 600;
    font-size: clamp(13px, 4.6cqw, 14px);
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
}
.note .body {
    margin: 0;
    font-size: 12.5px;
    line-height: 1.45;
    color: var(--ink-2);
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
}
.pair {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
} /* right-sized by default */
@container (max-width: 239px) {
    /* compact: two full-width rows */
    .pair {
        flex-direction: column;
    }
    .pair .btn {
        width: 100%;
    }
}
```

- Time meta ("Now", "Tomorrow", "14:30") is `--ink-3`, never a relative- adjective pileup ("in about 24 hours") — pick one form.
- Action pair: tinted secondary + solid primary (README buttons); the _primary_ is the one that advances the workflow. Right-sized by default; below a 240px content box the pair stacks into two full-width rows (CSS above).

## Snoozed / muted state

```html
<div class="hd"><span>Remind client for meeting</span><span class="meta">Tomorrow</span></div>
<div class="state">
    <svg …bell-off, 14px, --ink-3…></svg>
    <span class="meta">Snoozed for 24 hr</span>
    <span class="pill neutral">✓ 24 hrs</span>
</div>
```

- Body drops (nothing to read while muted); the state row replaces it, quiet ink-3 + a neutral pill for the duration. Card keeps full opacity — fading the whole card kills contrast; mute via content, not transparency.
- Carousel dots (when the card cycles): `8px` dots `--ink` at 15% mix, active one a `16px`-wide pill in `var(--tone)`, bottom-right.

## Size behavior

The **active** state keeps title + pair at every tier; body clamps to 3 lines and may drop at the compact tier. The **snoozed** state replaces body _and_ pair with the state row — it has no actions by definition. The card is happiest at 220–360px; don't stretch it past ~480px.

## Do / Don't

- DO one primary action per card; "Snooze" and "Done" never both solid.
- DON'T add charts/avatars to a notification — the entity row (`entity-row.md`) is a separate card.
- DON'T auto-dismiss in mocks with animation; show the snoozed state as a static variant instead.
