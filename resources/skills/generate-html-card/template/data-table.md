---
card-type: data-table
extends: ../cardspec.md
---

# Data Table Card

Columnar records with row actions — billing activity, recent orders, user lists.

## Composition

`title (+ subtitle meta) → filter chips → table`

```html
<div class="hd">
    <div><span class="t">Billing Activity</span> <span class="meta">Latest user and billing events</span></div>
    <div class="segs">
        <button type="button" class="seg on">All</button><button type="button" class="seg">Billing</button
        ><button type="button" class="seg">Products</button>
    </div>
</div>
<table class="dt">
    <thead>
        <tr>
            <th class="c-check"><input type="checkbox" aria-label="Select all" /></th>
            <th>Name</th>
            <th class="c-2">Email</th>
            <th class="c-date">Date</th>
            <th class="c-status">Status</th>
        </tr>
    </thead>
    <tbody>
        <tr>
            <td class="c-check"><input type="checkbox" aria-label="Select Faria Tasnim" /></td>
            <td>
                <span class="cellp"><svg class="avatar" …initials…></svg>Faria Tasnim</span>
            </td>
            <td class="c-2">faria@gmail.com</td>
            <td class="c-date num">24 Jan 2026, 22:32</td>
            <td class="c-status"><span class="pill tone-green">Completed</span></td>
        </tr>
        …
    </tbody>
</table>
```

```css
.dt {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    font-size: 12px;
}
.dt th {
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-3);
    padding: 8px;
    border-bottom: 1px solid var(--border);
}
.dt td {
    padding: 9px 8px;
    border-bottom: 1px solid color-mix(in oklab, var(--ink) 7%, transparent);
    vertical-align: middle;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
.dt tr:last-child td {
    border-bottom: none;
}
.dt tbody tr:hover {
    background: var(--card-2);
}
.dt input[type='checkbox'] {
    accent-color: var(--tone);
}
.c-check {
    width: 30px;
} /* fixed layout: budgets, not %, fit a slot */
.cellp {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
}
.cellp .avatar {
    width: 24px;
    flex: none;
}
.c-2 {
    color: var(--ink-2);
}
.num {
    font-variant-numeric: tabular-nums;
}
```

Column budgets for a ~460px slot: check 30px · name flex · email 22% · date 34% · status 74px. Email is the first sacrifice — it ellipsizes, then the whole column drops at the collapse tier.

- **Status chips** are core `.pill` with semantic tones: Completed `tone-green`, Cancelled `tone-red`, Pending `tone-yellow`. Status is the one place a row may carry color.
- **Filter chips / segmented control**: README pattern; active segment `tone` bg + `--on-tone` text (or the tint variant for quiet boards).
- Numeric/date columns: `tabular-nums`, never wrap. Text cells: `max-width` + ellipsis via `.cellp`/`td > span` wrappers (a bare `td` won't ellipsize).
- **Responsive collapse** (content-box queries on the card): below `430px`, hide `.c-2` (email) before the name column becomes meaningless; below `340px`, hide `.c-date` too; below `260px`, abandon the table and render the same data as `entity-row.md` rows with status pills. Do not wait for a table to visibly crush the name column before collapsing it.

```css
@container (max-width:429px) {
    .dt .c-2 {
        display: none;
    }
}
@container (max-width:339px) {
    .dt .c-date {
        display: none;
    }
}
```

## Do / Don't

- DO one hairline between rows only — no zebra stripes, no vertical borders.
- DON'T put buttons inside rows beyond a kebab icon; bulk actions belong to the selection toolbar pattern.
- DON'T let the checkbox column shrink (`width:1%; white-space:nowrap`) or disappear in collapse tiers.
