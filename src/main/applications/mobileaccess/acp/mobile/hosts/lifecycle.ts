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

export interface MobileHostHandle {
    close(): Promise<void>;
}
export interface MobileHostPlan {
    prepare(signal: AbortSignal): Promise<((signal: AbortSignal) => Promise<MobileHostHandle>) | undefined>;
    waitUntilReady(signal: AbortSignal): Promise<void>;
}
export interface MobileLifecycleOptions {
    diagnose?(event: {
        code: 'start_failed' | 'close_failed' | 'close_timeout';
        phase?: 'prepare' | 'readiness' | 'start';
    }): void;
    setTimeout?: (callback: () => void, ms: number) => unknown;
    clearTimeout?: (timer: unknown) => void;
}

export function createMobileHostLifecycle(options: MobileLifecycleOptions = {}) {
    const lifetime = new AbortController();
    let accepting = true;
    let started: Promise<void> | undefined;
    let handle: MobileHostHandle | undefined;
    let closing: Promise<void> | undefined;
    let handleClosing: Promise<void> | undefined;
    const report = (event: Parameters<NonNullable<MobileLifecycleOptions['diagnose']>>[0]) => {
        try {
            options.diagnose?.(event);
        } catch {}
    };
    const closeHandle = () =>
        (handleClosing ??= (async () => {
            try {
                await handle?.close();
            } catch {
                report({ code: 'close_failed' });
            }
        })());
    return {
        signal: lifetime.signal,
        start(input: MobileHostPlan): void {
            if (!accepting || started) return;
            let phase: 'prepare' | 'readiness' | 'start' = 'prepare';
            started = (async () => {
                const launch = await input.prepare(lifetime.signal);
                if (!accepting || !launch) return;
                phase = 'readiness';
                await input.waitUntilReady(lifetime.signal);
                if (!accepting) return;
                phase = 'start';
                handle = await launch(lifetime.signal);
                if (!accepting) await closeHandle();
            })().catch(() => {
                if (accepting) report({ code: 'start_failed', phase });
            });
        },
        close(): Promise<void> {
            if (closing) return closing;
            // Establish the single budget before abort can synchronously invoke any cleanup.
            let finish!: () => void;
            closing = new Promise<void>((resolve) => {
                finish = resolve;
            });
            const timer = (options.setTimeout ?? setTimeout)(() => {
                report({ code: 'close_timeout' });
                finish();
            }, 3000);
            accepting = false;
            lifetime.abort();
            const cleanup = handle ? closeHandle() : Promise.resolve(started).then(closeHandle);
            void cleanup.finally(() => {
                (options.clearTimeout ?? clearTimeout)(timer as ReturnType<typeof setTimeout>);
                finish();
            });
            return closing;
        }
    };
}
