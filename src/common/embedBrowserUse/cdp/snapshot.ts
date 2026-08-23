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

/**
 * embedBrowserUse — CDP-based page snapshot and coordinate resolution.
 *
 * Captures ARIA accessibility snapshots (JSON tree format) from all frames
 * (including cross-origin iframes), merges them into a single tree, and
 * renders the output as YAML.  Resolves element refs to viewport coordinates
 * across nested iframe boundaries.
 */

import type { CDPSession } from './session.js';
import type { PageSnapshot } from '../protocol.js';
import {
    type FrameAriaResult,
    type AriaNode,
    mergeFrameTrees,
    renderAriaTreeToYaml,
    resolveNestedRefCoords,
    isNestedRef,
    runAriaPasses,
    collapseNoisySubtrees
} from './aria.js';
import { DEFAULT_ARIA_PASSES, pruneOffscreenPass } from '../passes/index.js';

/** Minimum rendered image area that warrants exposing its source in snapshots. */
export const IMAGE_DETAIL_MIN_RENDERED_AREA = 10_000;

// ---------------------------------------------------------------------------
// JS snapshot injection script
// ---------------------------------------------------------------------------

/**
 * JS to inject into each frame via Runtime.evaluate / WebFrameMain.executeJavaScript.
 *
 * Full DOM tree walk with:
 * - Implicit ARIA role computation per HTML-AAM spec
 * - Accessible name computation (aria-label, aria-labelledby, alt, text content)
 * - Shadow DOM traversal
 * - Visibility gating (aria-hidden + CSS visibility)
 * - Ref assignment to interactable elements (data-od-ref for click/type targeting)
 * - Iframe detection: marks iframe elements with frameIndex/frameSrc, collects iframeUrls
 * - Returns JSON tree directly (NOT YAML)
 */
export const SNAPSHOT_INJECTION = `(() => {
    // Stable ref scheme: we PRESERVE existing data-od-ref attributes across
    // snapshots so the same DOM node keeps the same ref between calls. This
    // enables ref-based diffing and the explore() tool. We only assign a fresh
    // ref to elements that don't already have one, continuing the index from
    // the highest existing value.
    var refIdx = 0;
    var existingRefs = document.querySelectorAll('[data-od-ref]');
    for (var i = 0; i < existingRefs.length; i++) {
        var m = /(?:^|[-])e(\\d+)$/.exec(existingRefs[i].getAttribute('data-od-ref') || '');
        if (m) refIdx = Math.max(refIdx, parseInt(m[1], 10) + 1);
    }

    var iframeIdx = 0;
    var iframeUrls = [];

    // ---- Implicit role mappings (HTML-AAM spec) ----
    // https://www.w3.org/TR/html-aam/#html-element-role-mappings
    var ancestorLandmark = 'article:not([role]),aside:not([role]),main:not([role]),nav:not([role]),section:not([role]),[role=article],[role=complementary],[role=main],[role=navigation],[role=region]';

    function hasExplicitName(el) {
        return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby');
    }

    var inputTypeRoles = {
        button: 'button', checkbox: 'checkbox', image: 'button', radio: 'radio',
        range: 'slider', reset: 'button', submit: 'button', number: 'spinbutton'
    };

    var implicitRoles = {
        A: function(el) { return el.hasAttribute('href') ? 'link' : null; },
        AREA: function(el) { return el.hasAttribute('href') ? 'link' : null; },
        ARTICLE: function() { return 'article'; },
        ASIDE: function() { return 'complementary'; },
        BLOCKQUOTE: function() { return 'blockquote'; },
        BUTTON: function() { return 'button'; },
        DATALIST: function() { return 'listbox'; },
        DD: function() { return 'definition'; },
        DETAILS: function() { return 'group'; },
        DIALOG: function() { return 'dialog'; },
        DT: function() { return 'term'; },
        FIELDSET: function() { return 'group'; },
        FIGURE: function() { return 'figure'; },
        FOOTER: function(el) { return el.closest(ancestorLandmark) ? null : 'contentinfo'; },
        FORM: function(el) { return hasExplicitName(el) ? 'form' : null; },
        H1: function() { return 'heading'; },
        H2: function() { return 'heading'; },
        H3: function() { return 'heading'; },
        H4: function() { return 'heading'; },
        H5: function() { return 'heading'; },
        H6: function() { return 'heading'; },
        HEADER: function(el) { return el.closest(ancestorLandmark) ? null : 'banner'; },
        HR: function() { return 'separator'; },
        IFRAME: function() { return 'iframe'; },
        IMG: function(el) {
            if (el.getAttribute('alt') === '' && !el.getAttribute('title') && !el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby'))
                return 'presentation';
            return 'img';
        },
        INPUT: function(el) {
            var type = (el.type || 'text').toLowerCase();
            if (type === 'hidden') return null;
            if (type === 'search') return el.hasAttribute('list') ? 'combobox' : 'searchbox';
            if (type === 'email' || type === 'tel' || type === 'text' || type === 'url' || type === '') {
                if (el.hasAttribute('list')) {
                    var listEl = document.getElementById(el.getAttribute('list'));
                    if (listEl && listEl.tagName === 'DATALIST') return 'combobox';
                }
                return 'textbox';
            }
            if (type === 'file') return 'button';
            return inputTypeRoles[type] || 'textbox';
        },
        LI: function() { return 'listitem'; },
        MAIN: function() { return 'main'; },
        MATH: function() { return 'math'; },
        MENU: function() { return 'list'; },
        METER: function() { return 'meter'; },
        NAV: function() { return 'navigation'; },
        OL: function() { return 'list'; },
        OPTGROUP: function() { return 'group'; },
        OPTION: function() { return 'option'; },
        OUTPUT: function() { return 'status'; },
        P: function() { return 'paragraph'; },
        PROGRESS: function() { return 'progressbar'; },
        SEARCH: function() { return 'search'; },
        SECTION: function(el) { return hasExplicitName(el) ? 'region' : null; },
        SELECT: function(el) { return el.hasAttribute('multiple') || el.size > 1 ? 'listbox' : 'combobox'; },
        SVG: function() { return 'img'; },
        TABLE: function() { return 'table'; },
        TBODY: function() { return 'rowgroup'; },
        TD: function(el) {
            var table = el.closest('table');
            var tRole = table ? (table.getAttribute('role') || '') : '';
            return (tRole === 'grid' || tRole === 'treegrid') ? 'gridcell' : 'cell';
        },
        TEXTAREA: function() { return 'textbox'; },
        TFOOT: function() { return 'rowgroup'; },
        TH: function() { return 'columnheader'; },
        THEAD: function() { return 'rowgroup'; },
        TR: function() { return 'row'; },
        UL: function() { return 'list'; }
    };

    // Roles that support checked state
    var checkedRoles = ['checkbox', 'menuitemcheckbox', 'option', 'radio', 'switch', 'menuitemradio', 'treeitem'];
    // Roles that support disabled state
    var disabledRoles = ['button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox', 'menuitem',
        'menuitemcheckbox', 'menuitemradio', 'option', 'radio', 'searchbox', 'slider', 'spinbutton',
        'switch', 'tab', 'textbox', 'treeitem'];
    // Roles that support expanded state
    var expandedRoles = ['application', 'button', 'checkbox', 'combobox', 'gridcell', 'link', 'listbox',
        'menuitem', 'row', 'rowheader', 'tab', 'treeitem', 'columnheader'];
    // Roles with level
    var levelRoles = ['heading', 'listitem', 'row', 'treeitem'];
    // Roles with pressed
    var pressedRoles = ['button'];
    // Roles with selected
    var selectedRoles = ['gridcell', 'option', 'row', 'tab', 'columnheader', 'rowheader', 'treeitem'];

    // ---- Role computation ----

    function getExplicitRole(el) {
        var role = el.getAttribute('role');
        if (role) {
            var first = role.trim().split(/\\\\s+/)[0];
            if (first && first !== 'presentation' && first !== 'none') return first;
            if (first === 'presentation' || first === 'none') return null;
        }
        return undefined;
    }

    function getRole(el) {
        var explicit = getExplicitRole(el);
        if (explicit !== undefined) return explicit;

        var fn = implicitRoles[el.tagName];
        if (fn) return fn(el);

        return 'generic';
    }

    // ---- Accessible name computation (simplified) ----

    function getIdRefs(el, attr) {
        var val = el.getAttribute(attr);
        if (!val) return [];
        var ids = val.trim().split(/\\\\s+/);
        var doc = el.getRootNode ? el.getRootNode() : document;
        var results = [];
        for (var i = 0; i < ids.length; i++) {
            var ref = doc.getElementById ? doc.getElementById(ids[i]) : document.getElementById(ids[i]);
            if (ref) results.push(ref);
        }
        return results;
    }

    function textOf(el) {
        return (el.innerText || el.textContent || '').replace(/[\\s\\u00A0]+/g, ' ').trim();
    }

    function getAccessibleName(el) {
        // 1. aria-labelledby
        var labelledBy = getIdRefs(el, 'aria-labelledby');
        if (labelledBy.length) {
            var parts = [];
            for (var i = 0; i < labelledBy.length; i++) parts.push(textOf(labelledBy[i]));
            var joined = parts.join(' ').trim();
            if (joined) return joined;
        }

        // 2. aria-label
        var ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();

        // 3. For <img>: alt
        if (el.tagName === 'IMG') {
            var alt = el.getAttribute('alt');
            if (alt != null) return alt.trim();
        }

        // 4. For <input>: associated <label>
        if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
            if (el.id) {
                var labels = document.querySelectorAll('label[for=' + JSON.stringify(el.id) + ']');
                if (labels.length) return textOf(labels[0]);
            }
            var parentLabel = el.closest('label');
            if (parentLabel) {
                var clone = parentLabel.cloneNode(true);
                var inputs = clone.querySelectorAll('input,select,textarea');
                for (var i = 0; i < inputs.length; i++) inputs[i].remove();
                var lt = (clone.innerText || clone.textContent || '').replace(/[\\s\\u00A0]+/g, ' ').trim();
                if (lt) return lt;
            }
        }

        // 5. For <area>: alt
        if (el.tagName === 'AREA') {
            var alt = el.getAttribute('alt');
            if (alt != null) return alt.trim();
        }

        // 6. For <fieldset>: <legend>
        if (el.tagName === 'FIELDSET') {
            var legend = el.querySelector('legend');
            if (legend) return textOf(legend);
        }

        // 7. For <figure>: <figcaption>
        if (el.tagName === 'FIGURE') {
            var caption = el.querySelector('figcaption');
            if (caption) return textOf(caption);
        }

        // 8. For <table>: <caption>
        if (el.tagName === 'TABLE') {
            var cap = el.querySelector('caption');
            if (cap) return textOf(cap);
        }

        // 9. For <details>: <summary>
        if (el.tagName === 'DETAILS') {
            var summary = el.querySelector(':scope > summary');
            if (summary) return textOf(summary);
        }

        // 10. Text content for common interactive roles
        var role = getRole(el);
        if (['button', 'link', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
             'option', 'treeitem', 'switch', 'heading', 'cell', 'gridcell',
             'columnheader', 'rowheader', 'tooltip', 'listitem'].indexOf(role) !== -1) {
            var txt = textOf(el);
            if (txt) return txt;
        }

        // 11. title attribute as fallback
        var title = el.getAttribute('title');
        if (title && title.trim()) return title.trim();

        // 12. placeholder for textboxes (when no other name)
        if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
            var ph = el.getAttribute('placeholder');
            if (ph && ph.trim()) return ph.trim();
        }

        return '';
    }

    // ---- Visibility ----

    function isHiddenForAria(el) {
        if (el.getAttribute('aria-hidden') === 'true') return true;
        if (el.tagName === 'STYLE' || el.tagName === 'SCRIPT' || el.tagName === 'NOSCRIPT' ||
            el.tagName === 'HEAD' || el.tagName === 'TEMPLATE') return true;

        var style = null;
        try { style = getComputedStyle(el); } catch(e) { return false; }
        if (!style) return false;

        if (style.display === 'none') return true;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return true;
        return false;
    }

    function isElementVisible(el) {
        var rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return false;

        var style = null;
        try { style = getComputedStyle(el); } catch(e) { return false; }
        if (!style) return false;

        if (style.display === 'none') return false;
        if (style.visibility === 'hidden' || style.visibility === 'collapse') return false;
        if (parseFloat(style.opacity) < 0.05) return false;
        return true;
    }

    function receivesPointerEvents(el) {
        try {
            var style = getComputedStyle(el);
            return style.pointerEvents !== 'none';
        } catch(e) { return true; }
    }

    function computeBox(el) {
        var rect = el.getBoundingClientRect();
        var width = Math.round(rect.width);
        var height = Math.round(rect.height);
        var visible = width > 0 && height > 0;
        var display = '';
        try { display = getComputedStyle(el).display || ''; } catch(e) {}
        var isInline = display === 'inline';
        var cursor = '';
        try { cursor = getComputedStyle(el).cursor || ''; } catch(e) {}
        var inViewport = visible && rect.bottom > 0 && rect.top < (window.innerHeight || 0)
            && rect.right > 0 && rect.left < (window.innerWidth || 0);
        return { visible: visible, inline: isInline, cursor: cursor, width: width, height: height, inViewport: inViewport };
    }

    function getImageUrl(el) {
        var candidates = [el.currentSrc || '', el.src || ''];
        for (var i = 0; i < candidates.length; i++) {
            var candidate = candidates[i].trim();
            if (candidate && !/^(?:data|blob):/i.test(candidate)) return candidate;
        }
        return '';
    }

    // ---- Icon-font detection ----
    // <i>/<span> that render a glyph via an icon font (e.g. Font Awesome
    // <i class="fa fa-cog"></i>) carry no text content and no implicit ARIA
    // role, so they are otherwise dropped by the generic-wrapper cleanup
    // passes and never appear in the snapshot. Lift them into named 'img'
    // nodes so the agent can see (and target) the icon.

    function isIconFontElement(el) {
        if (el.tagName !== 'I' && el.tagName !== 'SPAN') return false;
        var cls = el.getAttribute('class');
        if (!cls || !cls.trim()) return false;
        // No real text content (whitespace-only)
        var text = (el.textContent || '').replace(/[\\s\\u00A0]+/g, '');
        if (text) return false;
        // Must actually render a box (icon glyph sized by its font)
        var rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        return true;
    }

    function iconNameFromClass(el) {
        var cls = (el.getAttribute('class') || '').trim();
        if (!cls) return '';
        var tokens = cls.split(/\\s+/);
        // Prefer the icon glyph class (e.g. "fa-cog", "icon-search", "mdi-home");
        // skip generic family/size modifiers (fa, fa-solid, fa-regular, fa-2x).
        var skip = /^(?:fa|fa-solid|fa-regular|fa-brands|fa-[0-9]+x)$/i;
        for (var i = tokens.length - 1; i >= 0; i--) {
            var t = tokens[i];
            if (!t || skip.test(t)) continue;
            return t;
        }
        return cls;
    }

    // ---- State computation ----

    function getChecked(el) {
        var val = el.getAttribute('aria-checked');
        if (val === 'true') return true;
        if (val === 'mixed') return 'mixed';
        if (val === 'false') return false;
        if ('checked' in el) return !!el.checked;
        return undefined;
    }

    function getDisabled(el) {
        if (el.getAttribute('aria-disabled') === 'true') return true;
        if ('disabled' in el && el.disabled) return true;
        return false;
    }

    function getExpanded(el) {
        var val = el.getAttribute('aria-expanded');
        if (val === 'true') return true;
        if (val === 'false') return false;
        if (el.tagName === 'DETAILS') return el.open;
        return undefined;
    }

    function getLevel(el) {
        var val = el.getAttribute('aria-level');
        if (val) return parseInt(val, 10) || undefined;
        var m = el.tagName.match(/^H([1-6])$/);
        if (m) return parseInt(m[1], 10);
        return undefined;
    }

    function getPressed(el) {
        var val = el.getAttribute('aria-pressed');
        if (val === 'true') return true;
        if (val === 'mixed') return 'mixed';
        if (val === 'false') return false;
        return undefined;
    }

    function getSelected(el) {
        var val = el.getAttribute('aria-selected');
        if (val === 'true') return true;
        return undefined;
    }

    // ---- Tree building ----
    // Follows Playwright's approach: full DOM walk, build AriaNode tree.
    // Returns JSON objects (not YAML).

    var visited = new Set();

    function toAriaNode(el) {
        var role = getRole(el);
        if (!role || role === 'presentation' || role === 'none') return null;

        var name = getAccessibleName(el);
        // Icon-font glyphs (<i class="fa fa-cog"> etc.) have no text content and
        // default to 'generic', which the cleanup passes would drop. Name them
        // from their class so they survive the passes. <i> (the idiomatic icon
        // tag) is lifted to an explicit 'icon' role; a decorated <span> stays
        // generic but keeps its class-derived name.
        if (isIconFontElement(el)) {
            if (el.tagName === 'I') role = 'icon';
            name = iconNameFromClass(el);
        }
        // Trim name to reasonable length
        if (name.length > 900) name = name.slice(0, 900);

        var box = computeBox(el);
        var rpe = receivesPointerEvents(el);

        // Skip lone inline generics with a single text child (noise reduction)
        if (role === 'generic' && box.inline && el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
            return null;

        var node = { role: role, name: name, children: [], props: {}, box: box, rpe: rpe, el: el };

        if (role === 'img' && el.tagName === 'IMG' &&
            box.width * box.height >= ${IMAGE_DETAIL_MIN_RENDERED_AREA}) {
            var imageUrl = getImageUrl(el);
            if (imageUrl) {
                node.image = {
                    url: imageUrl,
                    width: box.width,
                    height: box.height
                };
            }
        }

        // States
        if (checkedRoles.indexOf(role) !== -1) {
            var c = getChecked(el);
            if (c !== undefined) node.checked = c;
        }
        if (disabledRoles.indexOf(role) !== -1) {
            if (getDisabled(el)) node.disabled = true;
        }
        if (expandedRoles.indexOf(role) !== -1) {
            var e = getExpanded(el);
            if (e !== undefined) node.expanded = e;
        }
        if (levelRoles.indexOf(role) !== -1) {
            var l = getLevel(el);
            if (l) node.level = l;
        }
        if (pressedRoles.indexOf(role) !== -1) {
            var p = getPressed(el);
            if (p !== undefined) node.pressed = p;
        }
        if (selectedRoles.indexOf(role) !== -1) {
            var s = getSelected(el);
            if (s !== undefined) node.selected = s;
        }

        // Iframe: mark with frameIndex and frameSrc for merging
        if (el.tagName === 'IFRAME') {
            node.frameSrc = el.src || '';
            node.frameIndex = iframeIdx++;
            iframeUrls.push(el.src || '');
        }

        // Input values become text children
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
            if (el.type !== 'checkbox' && el.type !== 'radio' && el.type !== 'file') {
                if (el.value) node.children = [el.value.slice(0, 500)];
            }
        }

        return node;
    }

    function processElement(ariaNode, el, ariaOwned, parentVisible) {
        // Block-level spacing
        var display = '';
        try { display = getComputedStyle(el).display || 'inline'; } catch(e) { display = 'inline'; }
        var isBlock = (display !== 'inline' || el.nodeName === 'BR');
        if (isBlock) ariaNode.children.push(' ');

        // Slot assigned nodes
        var assignedNodes = el.nodeName === 'SLOT' ? el.assignedNodes() : [];
        if (assignedNodes.length) {
            for (var i = 0; i < assignedNodes.length; i++)
                visitNode(ariaNode, assignedNodes[i], parentVisible);
        } else {
            // Regular children
            var child = el.firstChild;
            while (child) {
                if (!child.assignedSlot)
                    visitNode(ariaNode, child, parentVisible);
                child = child.nextSibling;
            }
            // Shadow DOM
            if (el.shadowRoot) {
                var sc = el.shadowRoot.firstChild;
                while (sc) {
                    visitNode(ariaNode, sc, parentVisible);
                    sc = sc.nextSibling;
                }
            }
        }

        // aria-owns targets
        for (var i = 0; i < ariaOwned.length; i++)
            visitNode(ariaNode, ariaOwned[i], parentVisible);

        if (isBlock) ariaNode.children.push(' ');

        // Deduplicate: if sole child text matches name
        if (ariaNode.children.length === 1 && ariaNode.name === ariaNode.children[0])
            ariaNode.children = [];

        // Properties
        if (ariaNode.role === 'link' && el.hasAttribute('href'))
            ariaNode.props.url = el.getAttribute('href');
        if ((ariaNode.role === 'textbox' || ariaNode.role === 'searchbox') &&
            el.hasAttribute('placeholder') && el.getAttribute('placeholder') !== ariaNode.name)
            ariaNode.props.placeholder = el.getAttribute('placeholder');
        if (ariaNode.role === 'option')
            ariaNode.props.value = el.value;
    }

    function visitNode(parentAriaNode, node, parentVisible) {
        if (visited.has(node)) return;
        visited.add(node);

        // Text nodes
        if (node.nodeType === 3) {
            if (!parentVisible) return;
            var text = node.nodeValue;
            if (parentAriaNode.role !== 'textbox' && text)
                parentAriaNode.children.push(text);
            return;
        }

        if (node.nodeType !== 1) return;

        var el = node;

        // Visibility: ariaOrVisible mode (like Playwright AI mode)
        // Once a parent is invisible, the entire subtree is invisible.
        var notHiddenForAria = !isHiddenForAria(el);
        var visible = parentVisible && (notHiddenForAria || isElementVisible(el));

        // Gather aria-owns targets
        var ariaOwned = [];
        if (el.hasAttribute('aria-owns')) {
            var ids = el.getAttribute('aria-owns').split(/\\\\s+/);
            for (var j = 0; j < ids.length; j++) {
                var owned = document.getElementById(ids[j]);
                if (owned) ariaOwned.push(owned);
            }
        }

        var childAriaNode = visible ? toAriaNode(el) : null;

        if (childAriaNode) {
            // Reuse a stable ref if this element already carries one from a
            // previous snapshot; otherwise mint a fresh one. Reusing keeps the
            // same DOM node mapped to the same ref across snapshots.
            var existingRef = el.getAttribute('data-od-ref');
            if (existingRef) {
                childAriaNode.ref = existingRef;
            } else if (childAriaNode.box.visible && childAriaNode.rpe) {
                var ref = 'e' + refIdx;
                childAriaNode.ref = ref;
                el.setAttribute('data-od-ref', ref);
                refIdx++;
            }
            // Iframe elements ALWAYS get a ref, even if not yet visible.
            // The ref is needed for tree merging (prefixing child-frame refs)
            // and for lazy on-demand expansion via explore().
            if (el.tagName === 'IFRAME' && !childAriaNode.ref) {
                var iframeRef = 'e' + refIdx;
                childAriaNode.ref = iframeRef;
                el.setAttribute('data-od-ref', iframeRef);
                refIdx++;
            }
            parentAriaNode.children.push(childAriaNode);
        }

        processElement(childAriaNode || parentAriaNode, el, ariaOwned, visible);
    }

    // Tree normalization/optimization passes now run in TypeScript
    // (see passes/: runAriaPasses / DEFAULT_ARIA_PASSES), so the raw
    // snapshot emitted here preserves the maximum AriaNode information.

    // ---- Serialize to JSON (strip internal fields: box, rpe, el) ----

    function serializeNode(node) {
        var obj = {
            role: node.role,
            name: node.name,
            children: [],
            props: {}
        };

        // Copy props
        var propKeys = Object.keys(node.props);
        for (var i = 0; i < propKeys.length; i++) {
            obj.props[propKeys[i]] = node.props[propKeys[i]];
        }

        // Copy states
        if (node.ref) obj.ref = node.ref;
        if (node.checked !== undefined) obj.checked = node.checked;
        if (node.disabled) obj.disabled = true;
        if (node.expanded !== undefined) obj.expanded = node.expanded;
        if (node.level) obj.level = node.level;
        if (node.pressed !== undefined) obj.pressed = node.pressed;
        if (node.selected !== undefined) obj.selected = node.selected;
        if (node.image !== undefined) obj.image = node.image;

        // Copy layout box (visible / inViewport) so viewport-aware passes can run
        if (node.box !== undefined) obj.box = node.box;

        // Copy iframe metadata
        if (node.frameSrc !== undefined) obj.frameSrc = node.frameSrc;
        if (node.frameIndex !== undefined) obj.frameIndex = node.frameIndex;

        // Serialize children
        for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            if (typeof child === 'string') {
                obj.children.push(child);
            } else {
                obj.children.push(serializeNode(child));
            }
        }

        return obj;
    }

    // ---- Build the tree ----

    var root = { role: 'fragment', name: '', children: [], props: {}, box: { visible: true, inline: false }, rpe: true };

    if (document.body) {
        visitNode(root, document.body, true);
    }

    // Serialize to clean JSON (no internal JS fields)
    var serializedRoot = serializeNode(root);

    return JSON.stringify({
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        root: serializedRoot,
        iframeUrls: iframeUrls
    });
})()`;

// ---------------------------------------------------------------------------
// Snapshot capture
// ---------------------------------------------------------------------------

export interface CapturedSnapshot extends PageSnapshot {
    /** Full ARIA tree (with collapse flags + complete children) for the explore() tool. */
    tree: AriaNode;
}

export interface SnapshotOptions {
    /**
     * Collapse subtrees outside the current viewport that carry no interactable
     * descendant, so the snapshot focuses on what the agent can actually see.
     */
    viewportOnly?: boolean;
}

/**
 * Capture a page snapshot across ALL frames (including cross-origin iframes).
 *
 * Uses executeJavaScriptOnAllFrames to inject the snapshot script into every
 * frame. The main frame's tree is merged with child frame trees: each iframe
 * node's children are replaced with the corresponding child frame's ARIA tree.
 * Refs in child frames are prefixed with the parent iframe's ref
 * (e.g. "e5-e3" means element e3 inside iframe e5).
 *
 * The captured tree is first run through the optimization pass pipeline, then
 * "noisy" subtrees (iframes, large landmark regions, deep decoration chains)
 * are marked collapsed. Collapsed nodes keep their full children in `tree` so
 * the explore() tool can expand them on demand, while the rendered
 * `ariaSnapshot` shows only a compact one-line summary.
 *
 * When `opts.viewportOnly` is true an additional pruneOffscreenPass runs at the
 * tail of the pipeline, folding off-screen non-interactive regions into one
 * line so long pages shrink to the visible part. The rendered snapshot is
 * always prefixed with an interactive-element index (P0): the index sits at the
 * very top so a truncated result still carries the clickable refs the agent
 * needs to continue.
 */
export async function captureSnapshot(session: CDPSession, opts: SnapshotOptions = {}): Promise<CapturedSnapshot> {
    const nestedResult = await session.executeJavaScriptOnAllFrames(SNAPSHOT_INJECTION);

    // Parse main frame result
    let mainResult: FrameAriaResult;
    if (typeof nestedResult.mainResult === 'string') {
        mainResult = JSON.parse(nestedResult.mainResult);
    } else {
        mainResult = nestedResult.mainResult as FrameAriaResult;
    }

    // Merge child frame trees into the main tree
    if (Object.keys(nestedResult.frameResults).length > 0) {
        mergeFrameTrees(mainResult.root, nestedResult.frameResults);
    }

    // Run the optimization pass pipeline, then mark noisy subtrees collapsed.
    // Collapsed nodes retain their full children in `tree` for explore().
    const passes = opts.viewportOnly ? [...DEFAULT_ARIA_PASSES, pruneOffscreenPass] : DEFAULT_ARIA_PASSES;
    const optimizedRoot = runAriaPasses(mainResult.root, passes);
    collapseNoisySubtrees(optimizedRoot);
    const ariaSnapshot = renderAriaTreeToYaml(optimizedRoot, true);

    return {
        url: mainResult.url,
        title: mainResult.title,
        viewport: mainResult.viewport,
        scroll: mainResult.scroll,
        ariaSnapshot,
        tree: optimizedRoot
    };
}

// ---------------------------------------------------------------------------
// Coordinate resolution (single-frame, backward compatible)
// ---------------------------------------------------------------------------

/**
 * Resolve a simple element ref (e.g. "e5") to its center coordinates via CDP.
 * Only works for elements in the main frame — use resolveNestedRefCoords for
 * iframe-nested refs.
 */
export async function resolveRefCoords(
    session: CDPSession,
    ref: string
): Promise<{ x: number; y: number; tag: string; text: string }> {
    const result = await session.send('Runtime.evaluate', {
        expression: `(async () => {
            var el = document.querySelector('[data-od-ref="${ref}"]');
            if (!el) return JSON.stringify({ error: 'Element ref "${ref}" not found. Page may have changed — call snapshot to refresh.' });
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            var rect = el.getBoundingClientRect();
            var cx = Math.round(rect.left + rect.width / 2);
            var cy = Math.round(rect.top + rect.height / 2);
            var hitEl = document.elementFromPoint(cx, cy);
            var obscured = hitEl && hitEl !== el && !el.contains(hitEl) && !hitEl.contains(el);
            return JSON.stringify({
                x: cx,
                y: cy,
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || '').trim().slice(0, 80),
                obscured: !!obscured
            });
        })()`,
        awaitPromise: true,
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
        expression: `(async () => {
            var sel = ${selectorEscaped};
            var el = document.querySelector(sel);
            if (!el) return JSON.stringify({ error: 'Selector ' + sel + ' did not match any element' });
            el.scrollIntoView({ block: 'center', behavior: 'instant' });
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            var rect = el.getBoundingClientRect();
            var cx = Math.round(rect.left + rect.width / 2);
            var cy = Math.round(rect.top + rect.height / 2);
            var hitEl = document.elementFromPoint(cx, cy);
            var obscured = hitEl && hitEl !== el && !el.contains(hitEl) && !hitEl.contains(el);
            return JSON.stringify({
                x: cx,
                y: cy,
                tag: el.tagName.toLowerCase(),
                text: (el.innerText || '').trim().slice(0, 80),
                obscured: !!obscured
            });
        })()`,
        awaitPromise: true,
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
 * Resolve a target (ref like "e5" / "e5-e3-e1" or CSS selector) to coordinates.
 *
 * - Simple refs (e5): resolved via CDP Runtime.evaluate in the main frame
 * - Nested refs (e5-e3-e1): resolved by walking the WebFrameMain tree using
 *   WebFrameMain.executeJavaScript() — works cross-origin
 * - CSS selectors: resolved via CDP Runtime.evaluate
 */
export async function resolveTargetCoords(
    session: CDPSession,
    target: string
): Promise<{ x: number; y: number; tag: string; text: string }> {
    // If target looks like an element ref (e0, e1, e5-e3, etc.)
    if (/^e\d+/.test(target)) {
        if (isNestedRef(target)) {
            // Nested iframe ref: use WebFrameMain tree walking
            return resolveNestedRefCoords(session.webContents.mainFrame, target);
        }
        return resolveRefCoords(session, target);
    }
    // Otherwise treat as CSS selector
    return resolveSelectorCoords(session, target);
}
