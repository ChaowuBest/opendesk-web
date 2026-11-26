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
 * Holds a Provider's own queue while a remote answer is still closing its delivery.
 *
 * Clearing the current item is not enough: between the answer returning and the close notification
 * finishing, the remote exit is still occupied. Any advance entry point that activates an item in
 * that window publishes it into a busy endpoint and loses it, and the deferred advance then sees the
 * item already current and will not re-offer it. So every advance entry point must consult the
 * barrier, not just the one call the answer path defers.
 *
 * The matching release runs from `InteractionRemoteSettlement.afterRemoteClose`, which the delivery
 * endpoint guarantees to run exactly once — including on close failure, disconnect and disposal — so
 * the queue can never stay held.
 */
export class RemoteFinishBarrier {
    private holds = 0;

    /** True while a remote delivery is still closing and no item may be activated. */
    get blocked(): boolean {
        return this.holds > 0;
    }

    /** Raises the barrier for one closing delivery; the returned release is idempotent. */
    hold(): () => void {
        this.holds += 1;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            this.holds -= 1;
        };
    }
}
