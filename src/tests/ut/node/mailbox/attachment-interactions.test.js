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

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHTML } from 'linkedom';
import { bindAttachmentItemInteractions } from '../../../../main/applications/mailbox/renderer/attachment-interactions.js';

function createFixture() {
    const { window, document } = parseHTML(
        '<div id="attachment" tabindex="0"><button class="remove-attachment">remove</button></div>'
    );
    globalThis.Element = window.Element;
    return { window, item: document.querySelector('#attachment'), removeButton: document.querySelector('button') };
}

test('single click, context menu, and keyboard activation request the attachment menu', async () => {
    const { window, item } = createFixture();
    const eventTypes = [];
    bindAttachmentItemInteractions(item, {
        showMenu: (event) => eventTypes.push(event.type),
        open: () => assert.fail('open should only run for a double click')
    });

    item.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 200));
    item.dispatchEvent(new window.Event('contextmenu', { bubbles: true, cancelable: true }));
    const enterEvent = new window.Event('keydown', { bubbles: true, cancelable: true });
    enterEvent.key = 'Enter';
    item.dispatchEvent(enterEvent);

    assert.deepEqual(eventTypes, ['click', 'contextmenu', 'keydown']);
});

test('double click opens the attachment directly without requesting a menu', async () => {
    const { window, item } = createFixture();
    let openCount = 0;
    bindAttachmentItemInteractions(item, {
        showMenu: () => assert.fail('double click handler must not request a menu'),
        open: () => {
            openCount += 1;
        }
    });

    item.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    item.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
    const doubleClickEvent = new window.Event('dblclick', { bubbles: true, cancelable: true });
    item.dispatchEvent(doubleClickEvent);
    await new Promise((resolve) => setTimeout(resolve, 200));

    assert.equal(openCount, 1);
    assert.equal(doubleClickEvent.defaultPrevented, true);
});

test('compose remove control does not trigger attachment actions', () => {
    const { window, item, removeButton } = createFixture();
    let actionCount = 0;
    bindAttachmentItemInteractions(item, {
        showMenu: () => {
            actionCount += 1;
        },
        open: () => {
            actionCount += 1;
        },
        ignoreSelector: '.remove-attachment'
    });

    for (const eventType of ['click', 'contextmenu', 'dblclick']) {
        removeButton.dispatchEvent(new window.Event(eventType, { bubbles: true, cancelable: true }));
    }
    const enterEvent = new window.Event('keydown', { bubbles: true, cancelable: true });
    enterEvent.key = 'Enter';
    removeButton.dispatchEvent(enterEvent);

    assert.equal(actionCount, 0);
});
