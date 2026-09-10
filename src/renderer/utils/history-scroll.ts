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

/** Whether a nested scroller consumes this wheel gesture before the chat history. */
export function nestedScrollerConsumesWheel(history: HTMLElement, event: WheelEvent): boolean {
    // target is retargeted to the preview host across Shadow DOM boundaries.
    // The composed path retains inner scrollers and slot/host ancestors in order.
    for (const target of event.composedPath()) {
        if (target === history) break;
        const node = target as Element;
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const maxScrollTop = node.scrollHeight - node.clientHeight;
        if (maxScrollTop > 0) {
            const style = history.ownerDocument.defaultView!.getComputedStyle(node);
            if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
                if (event.deltaY < 0 ? node.scrollTop > 0 : node.scrollTop < maxScrollTop) return true;
                if (style.overscrollBehaviorY === 'contain' || style.overscrollBehaviorY === 'none') return true;
            }
        }
    }
    return false;
}
