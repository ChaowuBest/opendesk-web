/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import type { CDPSession } from './session';

export interface SnapshotElement {
    ref: string;
    tag: string;
    role?: string;
    type?: string;
    text: string;
    ariaLabel?: string;
    placeholder?: string;
    href?: string;
    name?: string;
    value?: string;
    checked?: boolean;
    disabled?: boolean;
    readonly?: boolean;
    rect: { x: number; y: number; w: number; h: number };
}

export interface PageSnapshot {
    url: string;
    title: string;
    viewport: { width: number; height: number };
    scroll: { x: number; y: number };
    elements: SnapshotElement[];
}

/**
 * JS to inject into the page via Runtime.evaluate.
 * Collects all interactive elements, assigns refs (e0, e1, …),
 * tags them with data-od-ref for subsequent click/type operations.
 *
 * Design aligned with Playwright's browser_snapshot concept:
 * returns a structured list of interactive elements with stable refs.
 */
const SNAPSHOT_INJECTION = `(() => {
    // Remove stale refs from previous snapshots
    var oldRefs = document.querySelectorAll('[data-od-ref]');
    for (var i = 0; i < oldRefs.length; i++) oldRefs[i].removeAttribute('data-od-ref');

    var SEL = 'a[href], button, input:not([type=hidden]), select, textarea, '
        + '[role="button"], [role="link"], [role="tab"], [role="menuitem"], '
        + '[role="option"], [role="checkbox"], [role="radio"], [role="switch"], '
        + '[role="textbox"], [role="combobox"], [role="searchbox"], '
        + '[onclick], [tabindex]:not([tabindex="-1"]), summary, details';

    var allEls = document.querySelectorAll(SEL);
    var elements = [];
    var refIdx = 0;

    for (var k = 0; k < allEls.length; k++) {
        var el = allEls[k];
        var rect = el.getBoundingClientRect();
        var style = getComputedStyle(el);

        // Visibility / interactability checks
        if (rect.width === 0 && rect.height === 0) continue;
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        if (parseFloat(style.opacity) < 0.05) continue;

        var ref = 'e' + refIdx;
        el.setAttribute('data-od-ref', ref);

        var tag = el.tagName.toLowerCase();
        var role = el.getAttribute('role') || undefined;
        var text = (el.innerText || el.textContent || '').trim().slice(0, 120);
        var ariaLabel = el.getAttribute('aria-label') || undefined;
        var typeAttr = el.getAttribute('type') || undefined;
        var placeholder = el.getAttribute('placeholder') || undefined;
        var href = el.getAttribute('href') || undefined;
        var nameAttr = el.getAttribute('name') || undefined;
        var value = undefined;
        var readonlyAttr = false;
        if (/^(INPUT|TEXTAREA|SELECT)$/i.test(el.tagName) && 'value' in el) {
            value = String(el.value).slice(0, 120);
            readonlyAttr = !!el.readOnly;
        }
        var checked = (el.type === 'checkbox' || el.type === 'radio') ? !!el.checked : undefined;
        var disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';

        var info = {
            ref: ref,
            tag: tag,
            role: role,
            type: typeAttr,
            text: text,
            ariaLabel: ariaLabel,
            placeholder: placeholder,
            href: href,
            name: nameAttr,
            value: value,
            checked: checked,
            disabled: disabled,
            readonly: readonlyAttr || undefined,
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
        };

        // Remove falsy/empty fields to keep output compact
        var keys = Object.keys(info);
        for (var j = 0; j < keys.length; j++) {
            var v = info[keys[j]];
            if (v === undefined || v === '' || v === false) delete info[keys[j]];
        }

        elements.push(info);
        refIdx++;
    }

    return JSON.stringify({
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        elements: elements
    });
})()`;

/**
 * Capture a page snapshot via CDP Runtime.evaluate.
 * Returns structured interactive element data with refs for targeting.
 */
export async function captureSnapshot(session: CDPSession): Promise<PageSnapshot> {
    const result = await session.send('Runtime.evaluate', {
        expression: SNAPSHOT_INJECTION,
        returnByValue: true
    });

    if (result.exceptionDetails) {
        const msg =
            result.exceptionDetails.text ||
            result.exceptionDetails.exception?.description ||
            'Snapshot evaluation failed';
        throw new Error(`Snapshot failed: ${msg}`);
    }

    return JSON.parse(result.result.value) as PageSnapshot;
}

/**
 * Resolve an element ref (e.g. "e5") to its center coordinates via CDP.
 * First scrolls the element into view, then returns viewport-relative coords.
 */
export async function resolveRefCoords(
    session: CDPSession,
    ref: string
): Promise<{ x: number; y: number; tag: string; text: string }> {
    const result = await session.send('Runtime.evaluate', {
        expression: `(() => {
            var el = document.querySelector('[data-od-ref="${ref}"]');
            if (!el) return JSON.stringify({ error: 'Element ref "${ref}" not found. Page may have changed — call browserSnapshot to refresh.' });
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            var rect = el.getBoundingClientRect();
            return JSON.stringify({
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || '').trim().slice(0, 80)
            });
        })()`,
        returnByValue: true
    });

    if (result.exceptionDetails) {
        throw new Error(`Failed to resolve ref ${ref}: ${result.exceptionDetails.text || 'unknown error'}`);
    }

    const info = JSON.parse(result.result.value);
    if (info.error) throw new Error(info.error);
    return info;
}

/**
 * Resolve a CSS selector to center coordinates via CDP.
 */
export async function resolveSelectorCoords(
    session: CDPSession,
    selector: string
): Promise<{ x: number; y: number; tag: string; text: string }> {
    const selectorEscaped = JSON.stringify(selector);
    const result = await session.send('Runtime.evaluate', {
        expression: `(() => {
            var el = document.querySelector(${selectorEscaped});
            if (!el) return JSON.stringify({ error: 'Selector ' + ${selectorEscaped} + ' did not match any element' });
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            var rect = el.getBoundingClientRect();
            return JSON.stringify({
                x: Math.round(rect.left + rect.width / 2),
                y: Math.round(rect.top + rect.height / 2),
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || '').trim().slice(0, 80)
            });
        })()`,
        returnByValue: true
    });

    if (result.exceptionDetails) {
        throw new Error(`Failed to resolve selector: ${result.exceptionDetails.text || 'unknown error'}`);
    }

    const info = JSON.parse(result.result.value);
    if (info.error) throw new Error(info.error);
    return info;
}

/**
 * Resolve a target (either a ref like "e5" or a CSS selector) to coordinates.
 * Refs take priority — they're assigned by browserSnapshot and more reliable.
 */
export async function resolveTargetCoords(
    session: CDPSession,
    target: string
): Promise<{ x: number; y: number; tag: string; text: string }> {
    // If target looks like an element ref (e0, e1, e12, etc.)
    if (/^e\d+$/.test(target)) {
        return resolveRefCoords(session, target);
    }
    // Otherwise treat as CSS selector
    return resolveSelectorCoords(session, target);
}
