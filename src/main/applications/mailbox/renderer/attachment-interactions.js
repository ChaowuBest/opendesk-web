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

function shouldIgnoreEvent(event, ignoreSelector) {
    if (!ignoreSelector || !(event.target instanceof Element)) return false;
    return Boolean(event.target.closest(ignoreSelector));
}

export function bindAttachmentItemInteractions(item, { showMenu, open, ignoreSelector }) {
    let singleClickTimer = null;

    const cancelPendingSingleClick = () => {
        if (singleClickTimer !== null) {
            clearTimeout(singleClickTimer);
            singleClickTimer = null;
        }
    };

    item.addEventListener('click', (event) => {
        if (shouldIgnoreEvent(event, ignoreSelector)) return;
        cancelPendingSingleClick();
        singleClickTimer = setTimeout(() => {
            singleClickTimer = null;
            showMenu(event);
        }, 180);
    });
    item.addEventListener('contextmenu', (event) => {
        if (shouldIgnoreEvent(event, ignoreSelector)) return;
        cancelPendingSingleClick();
        showMenu(event);
    });
    item.addEventListener('dblclick', (event) => {
        if (shouldIgnoreEvent(event, ignoreSelector)) return;
        cancelPendingSingleClick();
        event.preventDefault();
        event.stopPropagation();
        open();
    });
    item.addEventListener('keydown', (event) => {
        if (shouldIgnoreEvent(event, ignoreSelector)) return;
        if (event.key !== 'Enter' && event.key !== ' ') return;
        cancelPendingSingleClick();
        showMenu(event);
    });
}
