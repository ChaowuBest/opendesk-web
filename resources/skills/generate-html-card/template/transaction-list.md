---
card-type: transaction-list
extends: ../cardspec.md
---

# Transaction List Card

Ledger rows with signed amounts: transactions, invoices, payments. Core §5.3 list rows + money conventions.

## Composition

`title row (+ trailing "See all" link) → date group header → rows …`

```html
<div class="hd"><span>Transaction History</span><a class="alink" href="#">See all</a></div>
<div class="dgroup">
    <span class="dhead">13 April 2022</span>
    <div class="row trow">
        <div class="tmain"><span class="t">Cash Withdrawal</span><span class="m">13 Apr, 2022</span></div>
        <span class="amt neg">−$20.129</span>
    </div>
    <div class="row trow">
        <div class="tmain"><span class="t">Deposit</span><span class="m">13 Apr, 2022 at 3:30 PM</span></div>
        <span class="amt pos">+$20.129</span>
    </div>
</div>
```

```css
.hd .alink {
    margin-left: auto;
} /* README .alink pattern — placement only */
.dhead {
    font-size: 11px;
    font-weight: 600;
    color: var(--ink-3);
    padding: 10px 0 4px;
}
.trow {
    flex-direction: row;
    align-items: center;
    gap: 10px;
}
.tmain {
    display: flex;
    flex-direction: column;
    gap: 1px;
    min-width: 0;
}
.tmain .t {
    font-weight: 600;
    font-size: 13px;
    color: var(--ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}
.tmain .m {
    font-size: 11px;
    color: var(--ink-3);
}
.amt {
    margin-left: auto;
    flex: none;
    font-weight: 600;
    font-size: 13px;
    font-variant-numeric: tabular-nums;
}
.amt.neg {
    color: var(--red);
}
.amt.pos {
    color: var(--green);
}
@container (max-width:179px) {
    .trow {
        flex-wrap: wrap;
        gap: 4px;
    }
    .trow .tmain {
        flex-basis: 100%;
    }
    .trow .amt {
        margin-left: 0;
    }
}
```

- **Money semantics here are sign-based, not sentiment-based**: a withdrawal is red even when it's a perfectly good purchase. This is the ledger exception to the delta rule — do not "fix" it per row sentiment.
- One decimal convention per card (all `$20.129` or all `$20.13`, never mixed); amounts right-aligned via `margin-left:auto` + `tabular-nums`.
- Group rows by day with `.dhead`; separators from core `.row + .row`.

## Size behavior

- `< 180px`: drop the `.m` datetime line and place the amount on its own second line. A one-line title and a tabular amount cannot both fit in the remaining width; never let the amount steal the title down to a few visible characters.
- `< 150px`: also drop group headers.
- "See all" stays (it is the escape hatch), unless the card _is_ the detail view.

## Do / Don't

- DO keep signed amounts with a real `−`/`+` (or locale-appropriate parentheses) — color alone is not enough.
- DON'T right-align titles or left-align amounts; the money column is always the right edge.
- DON'T add pills/charts to rows; a transaction needing status chips becomes a `data-table.md`.
