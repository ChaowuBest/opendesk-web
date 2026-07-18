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
 * Lightweight DOM morph utilities.
 *
 * Updates the children of a container element to match new HTML,
 * preserving element identity (and thus CSS animations/transitions/hover state)
 * where the structure is compatible. Falls back to replacement when tags or
 * class lists differ.
 */

/**
 * Updates the children of containerEl to match newHtml.
 * Preserves element identity where structure is compatible.
 */
export function morphDomChildren(containerEl, newHtml) {
    if (!containerEl) return;
    const tpl = document.createElement('template');
    tpl.innerHTML = String(newHtml).trim();
    const newChildren = [...tpl.content.childNodes];
    const oldChildren = [...containerEl.childNodes];

    const maxLen = Math.max(oldChildren.length, newChildren.length);
    for (let i = 0; i < maxLen; i++) {
        if (i < oldChildren.length && i < newChildren.length) {
            morphNode(oldChildren[i], newChildren[i]);
        } else if (i < newChildren.length) {
            containerEl.appendChild(newChildren[i].cloneNode(true));
        } else if (oldChildren[i]) {
            oldChildren[i].remove();
        }
    }
}

function morphNode(oldNode, newNode) {
    if (oldNode.nodeType !== newNode.nodeType) {
        oldNode.replaceWith(newNode.cloneNode(true));
        return;
    }
    if (oldNode.nodeType === Node.TEXT_NODE) {
        if (oldNode.textContent !== newNode.textContent) {
            oldNode.textContent = newNode.textContent;
        }
        return;
    }
    if (oldNode.nodeType !== Node.ELEMENT_NODE) {
        oldNode.replaceWith(newNode.cloneNode(true));
        return;
    }

    if (oldNode.tagName !== newNode.tagName || !sameClassList(oldNode, newNode)) {
        oldNode.replaceWith(newNode.cloneNode(true));
        return;
    }

    morphAttributes(oldNode, newNode);

    const oldChildren = [...oldNode.childNodes];
    const newChildren = [...newNode.childNodes];
    const maxLen = Math.max(oldChildren.length, newChildren.length);
    for (let i = 0; i < maxLen; i++) {
        if (i < oldChildren.length && i < newChildren.length) {
            morphNode(oldChildren[i], newChildren[i]);
        } else if (i < newChildren.length) {
            oldNode.appendChild(newChildren[i].cloneNode(true));
        } else if (oldChildren[i]) {
            oldChildren[i].remove();
        }
    }
}

function sameClassList(a, b) {
    if (a.classList.length !== b.classList.length) return false;
    for (const cls of a.classList) {
        if (!b.classList.contains(cls)) return false;
    }
    return true;
}

function morphAttributes(oldEl, newEl) {
    for (const attr of [...oldEl.attributes]) {
        if (attr.name === 'class') continue;
        if (!newEl.hasAttribute(attr.name)) {
            oldEl.removeAttribute(attr.name);
        }
    }
    for (const attr of newEl.attributes) {
        if (attr.name === 'class') continue;
        if (oldEl.getAttribute(attr.name) !== attr.value) {
            oldEl.setAttribute(attr.name, attr.value);
        }
    }
}
