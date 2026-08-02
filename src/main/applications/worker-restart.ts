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

export type WorkerRestartDecision = {
    firstFailure: boolean;
    scheduled: boolean;
    exhausted: boolean;
    attempt: number;
    delayMs: number;
};

type ScheduleTimer = (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
type CancelTimer = (timer: ReturnType<typeof setTimeout>) => void;

export class WorkerRestartController {
    private restartCount = 0;
    private restartTimer?: ReturnType<typeof setTimeout>;
    private handledFailures = new WeakSet<object>();

    constructor(
        private readonly maxRestarts: number,
        private readonly scheduleTimer: ScheduleTimer = (callback, delayMs) => setTimeout(callback, delayMs),
        private readonly cancelTimer: CancelTimer = (timer) => clearTimeout(timer)
    ) {}

    reset(): void {
        if (this.restartTimer !== undefined) {
            this.cancelTimer(this.restartTimer);
            this.restartTimer = undefined;
        }
        this.restartCount = 0;
        this.handledFailures = new WeakSet<object>();
    }

    markStable(): void {
        this.restartCount = 0;
    }

    schedule(source: object, restart: () => void): WorkerRestartDecision {
        if (this.handledFailures.has(source)) {
            return {
                firstFailure: false,
                scheduled: false,
                exhausted: false,
                attempt: this.restartCount,
                delayMs: 0
            };
        }
        this.handledFailures.add(source);

        if (this.restartTimer !== undefined) {
            return {
                firstFailure: true,
                scheduled: false,
                exhausted: false,
                attempt: this.restartCount,
                delayMs: 0
            };
        }

        if (this.restartCount >= this.maxRestarts) {
            return {
                firstFailure: true,
                scheduled: false,
                exhausted: true,
                attempt: this.restartCount,
                delayMs: 0
            };
        }

        this.restartCount++;
        const delayMs = Math.min(1000 * Math.pow(2, this.restartCount - 1), 30000);
        this.restartTimer = this.scheduleTimer(() => {
            this.restartTimer = undefined;
            restart();
        }, delayMs);
        return {
            firstFailure: true,
            scheduled: true,
            exhausted: false,
            attempt: this.restartCount,
            delayMs
        };
    }
}
