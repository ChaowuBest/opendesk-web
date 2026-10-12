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

export const FLOW_READING_TIME_ZONE = 'Asia/Shanghai';
export const FLOW_READING_INTERVAL_MINUTES = 10;
export const FLOW_USER_DEBOUNCE_MS = 500;

// Temporary debugging default requested by the user; retain aligned mode for restoring normal scheduling.
export function isFlowImmediateReadingEnabled(
    environment: Readonly<Record<string, string | undefined>> = process.env
): boolean {
    return environment.OPENDESK_AGENT_FLOW_READING_MODE !== 'aligned';
}

const localClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: FLOW_READING_TIME_ZONE,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
});

export function flowReadingSlot(now: number, intervalMinutes = FLOW_READING_INTERVAL_MINUTES): string {
    const parts = Object.fromEntries(localClock.formatToParts(now).map((part) => [part.type, part.value]));
    const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
    const elapsed = (localMinutes % intervalMinutes) * 60_000 + Number(parts.second) * 1000 + (now % 1000);
    return new Date(now - elapsed).toISOString();
}

export interface FlowReadingTarget {
    flowId: string;
    staffId: string;
    userEventId?: string;
    messageEventId?: string;
    timerDue: boolean;
}

interface FlowReadingSchedulerHost {
    now(): number;
    targets(now: string): Promise<FlowReadingTarget[]>;
    start(target: FlowReadingTarget, trigger: 'user' | 'message' | 'timer'): Promise<string>;
    error(target: FlowReadingTarget | undefined, error: unknown): void;
}

export class FlowReadingScheduler {
    private polling = false;
    private stopped = false;
    private readonly flowDeadlines = new Map<string, number>();
    private readonly pending = new Map<string, { event: string; deadline: number }>();
    private readonly attempted = new Map<string, string>();

    constructor(private readonly host: FlowReadingSchedulerHost) {}

    notifyUser(flowId: string): void {
        if (!this.stopped && !this.flowDeadlines.has(flowId))
            this.flowDeadlines.set(flowId, this.host.now() + FLOW_USER_DEBOUNCE_MS);
    }

    stop(): void {
        this.stopped = true;
        this.pending.clear();
        this.flowDeadlines.clear();
        this.attempted.clear();
    }

    async tick(): Promise<void> {
        if (this.polling || this.stopped) return;
        this.polling = true;
        try {
            const now = this.host.now();
            const targets = await this.host.targets(new Date(now).toISOString());
            targets.sort((left, right) => Number(Boolean(right.userEventId)) - Number(Boolean(left.userEventId)));
            const active = new Set(targets.map((target) => `${target.flowId}:${target.staffId}`));
            for (const key of this.pending.keys()) if (!active.has(key)) this.pending.delete(key);
            for (const key of this.attempted.keys()) if (!active.has(key)) this.attempted.delete(key);
            await Promise.all(
                targets.map(async (target) => {
                    if (this.stopped) return;
                    const key = `${target.flowId}:${target.staffId}`;
                    let trigger: 'user' | 'message' | 'timer';
                    const eventId = target.userEventId ?? target.messageEventId;
                    if (eventId && this.attempted.get(key) !== eventId) {
                        let pending = this.pending.get(key);
                        if (!pending) {
                            pending = {
                                event: eventId,
                                deadline: this.flowDeadlines.get(target.flowId) ?? now + FLOW_USER_DEBOUNCE_MS
                            };
                            this.pending.set(key, pending);
                        }
                        pending.event = eventId;
                        if (now < pending.deadline) return;
                        trigger = target.userEventId ? 'user' : 'message';
                    } else if (target.timerDue) {
                        trigger = 'timer';
                    } else return;
                    try {
                        const status = await this.host.start(target, trigger);
                        if (trigger !== 'timer' && status !== 'busy') {
                            this.attempted.set(key, eventId!);
                            this.pending.delete(key);
                        }
                    } catch (error) {
                        if (trigger !== 'timer') {
                            this.attempted.set(key, eventId!);
                            this.pending.delete(key);
                        }
                        this.host.error(target, error);
                    }
                })
            );
            for (const [flowId, deadline] of this.flowDeadlines) if (deadline <= now) this.flowDeadlines.delete(flowId);
        } catch (error) {
            this.host.error(undefined, error);
        } finally {
            this.polling = false;
        }
    }
}
