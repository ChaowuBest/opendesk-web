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
 * 订阅 API 是异步的（要等 IPC 往返），句柄返回之前元素可能已被移出文档或重连：
 * - 断开：disconnectedCallback 只能退订已保存的句柄，pending 的那份没人管；
 * - 重连：新的订阅会覆盖元素上保存的字段，上一份句柄就此丢失。
 * 两种情形都会留下无人退订的回调（表现为重复 toast、重复刷新）。
 *
 * 这里给 owner 维护一个“代”（epoch）：订阅完成时若代已变化或元素已断开，
 * 就立刻退订自己，只有最后一次订阅会交给 onReady 保存。
 */
const epochs = new WeakMap<object, number>();

interface DeferredSubscriptionOwner {
    readonly isConnected: boolean;
}

export function adoptDeferredSubscription(
    owner: DeferredSubscriptionOwner,
    subscription: unknown,
    onReady: (unsubscribe: () => void) => void,
    onError?: (error: unknown) => void
): void {
    const epoch = (epochs.get(owner) ?? 0) + 1;
    epochs.set(owner, epoch);
    // API 缺失时调用方会传 undefined（甚至是同步的 undefined 返回值），直接跳过
    if (subscription === undefined || subscription === null) return;

    const report = (error: unknown, fallbackMessage: string) => {
        if (onError !== undefined) {
            onError(error);
            return;
        }
        console.warn(fallbackMessage, error);
    };

    void Promise.resolve(subscription)
        .then((value) => {
            if (typeof value !== 'function') return;
            const unsubscribe = value as () => void;
            if (epochs.get(owner) !== epoch || !owner.isConnected) {
                // 过期订阅自己退订；退订本身抛错也不能变成未捕获 rejection
                try {
                    unsubscribe();
                } catch (error) {
                    report(error, 'releasing expired subscription failed');
                }
                return;
            }
            try {
                onReady(unsubscribe);
            } catch (error) {
                // 保存句柄失败不应被误当成订阅失败，单独上报
                report(error, 'storing subscription handle failed');
            }
        })
        .catch((error: unknown) => report(error, 'deferred subscription failed'));
}
