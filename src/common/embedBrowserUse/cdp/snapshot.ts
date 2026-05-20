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
 * Captures ARIA accessibility snapshots and resolves element refs / CSS
 * selectors to viewport coordinates via CDP Runtime.evaluate.
 */

import type { CDPSession } from './session';
import type { PageSnapshot } from '../protocol';

/**
 * JS to inject into the page via Runtime.evaluate.
 *
 * Full DOM tree walk with:
 * - Implicit ARIA role computation per HTML-AAM spec
 * - Accessible name computation (aria-label, aria-labelledby, alt, text content)
 * - Shadow DOM traversal
 * - Visibility gating (aria-hidden + CSS visibility)
 * - YAML-based output matching Playwright MCP's aria snapshot format
 * - Ref assignment to interactable elements (data-od-ref for click/type targeting)
 */
const SNAPSHOT_INJECTION = `(() => {
    // Clean up old refs
    var oldRefs = document.querySelectorAll('[data-od-ref]');
    for (var i = 0; i < oldRefs.length; i++) oldRefs[i].removeAttribute('data-od-ref');

    var refIdx = 0;

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
            var first = role.trim().split(/\\s+/)[0];
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
        var ids = val.trim().split(/\\s+/);
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
        var visible = rect.width > 0 && rect.height > 0;
        var display = '';
        try { display = getComputedStyle(el).display || ''; } catch(e) {}
        var isInline = display === 'inline';
        var cursor = '';
        try { cursor = getComputedStyle(el).cursor || ''; } catch(e) {}
        return { visible: visible, inline: isInline, cursor: cursor };
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
    // mode: 'ai' => visibility = ariaOrVisible, refs = interactable, includeGenericRole = true

    var visited = new Set();

    function toAriaNode(el) {
        var role = getRole(el);
        if (!role || role === 'presentation' || role === 'none') return null;

        var name = getAccessibleName(el);
        // Trim name to reasonable length
        if (name.length > 900) name = name.slice(0, 900);

        var box = computeBox(el);
        var rpe = receivesPointerEvents(el);

        // Skip lone inline generics with a single text child (noise reduction)
        if (role === 'generic' && box.inline && el.childNodes.length === 1 && el.childNodes[0].nodeType === 3)
            return null;

        var node = { role: role, name: name, children: [], props: {}, box: box, rpe: rpe, el: el };

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
            var ids = el.getAttribute('aria-owns').split(/\\s+/);
            for (var j = 0; j < ids.length; j++) {
                var owned = document.getElementById(ids[j]);
                if (owned) ariaOwned.push(owned);
            }
        }

        var childAriaNode = visible ? toAriaNode(el) : null;

        if (childAriaNode) {
            // Compute ref for interactable elements
            if (childAriaNode.box.visible && childAriaNode.rpe) {
                var ref = 'e' + refIdx;
                childAriaNode.ref = ref;
                el.setAttribute('data-od-ref', ref);
                refIdx++;
            }
            parentAriaNode.children.push(childAriaNode);
        }

        processElement(childAriaNode || parentAriaNode, el, ariaOwned, visible);
    }

    // ---- Normalize string children (merge adjacent text) ----

    function normalizeStrings(ariaNode) {
        var newChildren = [];
        var buf = [];
        for (var i = 0; i < ariaNode.children.length; i++) {
            var child = ariaNode.children[i];
            if (typeof child === 'string') {
                buf.push(child);
            } else {
                if (buf.length) {
                    var merged = buf.join('').replace(/[\\s\\u00A0]+/g, ' ').trim();
                    if (merged) newChildren.push(merged);
                    buf = [];
                }
                normalizeStrings(child);
                newChildren.push(child);
            }
        }
        if (buf.length) {
            var merged = buf.join('').replace(/[\\s\\u00A0]+/g, ' ').trim();
            if (merged) newChildren.push(merged);
        }
        ariaNode.children = newChildren;

        // Remove text child that is same as name
        if (ariaNode.children.length === 1 && ariaNode.children[0] === ariaNode.name)
            ariaNode.children = [];
    }

    // ---- Normalize generic roles (prune wrappers) ----

    function normalizeGenerics(node) {
        var result = [];
        for (var i = 0; i < node.children.length; i++) {
            var child = node.children[i];
            if (typeof child === 'string') {
                result.push(child);
                continue;
            }
            var normalized = normalizeGenerics(child);
            result.push.apply(result, normalized);
        }

        var removeSelf = node.role === 'generic' && !node.name &&
            result.length <= 1 && result.every(function(c) { return typeof c !== 'string' && !!c.ref; });
        if (removeSelf) return result;

        node.children = result;
        return [node];
    }

    // ---- YAML rendering (Playwright-compatible format) ----

    function yamlNeedsQuotes(str) {
        if (!str.length) return true;
        if (/^\\s|\\s$/.test(str)) return true;
        if (/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f-\\x9f]/.test(str)) return true;
        if (/^-/.test(str)) return true;
        if (/[\\n:]( |$)/.test(str)) return true;
        if (/\\s#/.test(str)) return true;
        if (/[\\n\\r]/.test(str)) return true;
        if (/^[&*\\],?!>|@"'#%]/.test(str)) return true;
        if (/[{}\`]/.test(str)) return true;
        if (/^\\[/.test(str)) return true;
        var low = str.toLowerCase();
        if (!isNaN(Number(str)) || ['y','n','yes','no','true','false','on','off','null'].indexOf(low) !== -1) return true;
        return false;
    }

    function yamlEscapeKey(str) {
        if (!yamlNeedsQuotes(str)) return str;
        return "'" + str.replace(/'/g, "''") + "'";
    }

    function yamlEscapeValue(str) {
        if (!yamlNeedsQuotes(str)) return str;
        return JSON.stringify(str);
    }

    function hasPointerCursor(node) {
        return node.box && node.box.cursor === 'pointer';
    }

    function createKey(node) {
        var key = node.role;
        if (node.name && node.name.length <= 900)
            key += ' ' + JSON.stringify(node.name);

        if (node.checked === 'mixed') key += ' [checked=mixed]';
        else if (node.checked === true) key += ' [checked]';
        if (node.disabled) key += ' [disabled]';
        if (node.expanded === true) key += ' [expanded]';
        if (node.level) key += ' [level=' + node.level + ']';
        if (node.pressed === 'mixed') key += ' [pressed=mixed]';
        else if (node.pressed === true) key += ' [pressed]';
        if (node.selected === true) key += ' [selected]';

        if (node.ref) {
            key += ' [ref=' + node.ref + ']';
            if (hasPointerCursor(node)) key += ' [cursor=pointer]';
        }

        return key;
    }

    function indent(d) { var s = ''; for (var i = 0; i < d; i++) s += '  '; return s; }

    function renderYaml(nodes) {
        var lines = [];

        function visitText(text, depth) {
            var escaped = yamlEscapeValue(text);
            if (escaped) lines.push(indent(depth) + '- text: ' + escaped);
        }

        function getSingleTextChild(n) {
            if (n.children.length === 1 && typeof n.children[0] === 'string' && !Object.keys(n.props).length)
                return n.children[0];
            return undefined;
        }

        function visit(node, depth) {
            var escapedKey = indent(depth) + '- ' + yamlEscapeKey(createKey(node));
            var singleText = getSingleTextChild(node);
            var hasNoChildren = !singleText && !node.children.length;

            if (hasNoChildren && !Object.keys(node.props).length) {
                lines.push(escapedKey);
            } else if (singleText !== undefined) {
                lines.push(escapedKey + ': ' + yamlEscapeValue(singleText));
            } else {
                lines.push(escapedKey + ':');
                var propKeys = Object.keys(node.props);
                for (var p = 0; p < propKeys.length; p++)
                    lines.push(indent(depth + 1) + '- /' + propKeys[p] + ': ' + yamlEscapeValue(node.props[propKeys[p]]));
                for (var c = 0; c < node.children.length; c++) {
                    var child = node.children[c];
                    if (typeof child === 'string')
                        visitText(child, depth + 1);
                    else
                        visit(child, depth + 1);
                }
            }
        }

        for (var i = 0; i < nodes.length; i++) {
            var n = nodes[i];
            if (typeof n === 'string')
                visitText(n, 0);
            else
                visit(n, 0);
        }
        return lines.join('\\n');
    }

    // ---- Build the tree ----

    var root = { role: 'fragment', name: '', children: [], props: {}, box: { visible: true, inline: false }, rpe: true };

    if (document.body) {
        visitNode(root, document.body, true);
    }

    normalizeStrings(root);
    normalizeGenerics(root);

    var nodesToRender = root.role === 'fragment' ? root.children : [root];
    var yamlStr = renderYaml(nodesToRender);

    return JSON.stringify({
        url: location.href,
        title: document.title,
        viewport: { width: window.innerWidth, height: window.innerHeight },
        scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
        ariaSnapshot: yamlStr
    });
})()`;

/**
 * Capture a page snapshot via CDP Runtime.evaluate.
 * Returns YAML-based ARIA snapshot with element refs for targeting.
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
 * First scrolls the element into view, waits for layout to stabilize,
 * then returns viewport-relative coords.
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
 * Resolve a target (either a ref like "e5" or a CSS selector) to coordinates.
 * Refs take priority — they're assigned by snapshot and more reliable.
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
