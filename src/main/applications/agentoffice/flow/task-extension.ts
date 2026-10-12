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

import { z } from 'zod';
import {
    registerTaskExtension,
    type TaskExtension,
    type TaskExtensionCheckpoint,
    type TaskExtensionLifecycleEvent
} from '../../../aikernel/task-extension.js';
import type { TaskState } from '../../../aikernel/states/tasks.js';
import { t } from '../locale/index.js';
import { AgentFlowIdSchema } from './common.js';

const FlowTurnSchema = z.object({
    flowId: AgentFlowIdSchema,
    staffId: AgentFlowIdSchema,
    batchId: AgentFlowIdSchema.optional(),
    generation: z.number().int().positive(),
    model: z.string().min(1),
    outcome: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
    failure: z.string().optional()
});

export class FlowTaskExtension implements TaskExtension {
    readonly key = 'agentoffice.flowReading';
    state?: z.output<typeof FlowTurnSchema>;
    private resolveSettlement?: () => void;
    private settlement = Promise.resolve();
    private reachedFinishHooks = false;

    constructor(private readonly task: TaskState) {}

    configure(input: Omit<z.output<typeof FlowTurnSchema>, 'outcome'>): void {
        if (this.state && this.state.outcome !== 'pending')
            throw new Error(t('agentoffice.flow.error.closedReadingTask'));
        this.state = FlowTurnSchema.parse({ ...input, outcome: 'pending' });
        this.settlement = new Promise((resolve) => {
            this.resolveSettlement = resolve;
        });
        this.task.persistLater();
    }

    waitUntilSettled(): Promise<void> {
        return this.settlement;
    }

    restore(raw: Record<string, unknown>, wasRunningAtShutdown: boolean): void {
        const parsed = FlowTurnSchema.safeParse(raw.agentoffice_flow_turn);
        if (!parsed.success) return;
        this.state = parsed.data;
        if (wasRunningAtShutdown || ['pending', 'running'].includes(this.state.outcome)) {
            this.state.outcome = 'failed';
            this.state.failure = t('agentoffice.flow.error.interruptedReading');
        }
    }

    serialize(): Record<string, unknown> {
        return this.state ? { agentoffice_flow_turn: this.state } : {};
    }

    async handleUserMessage() {
        if (!this.state) return undefined;
        if (this.state.outcome !== 'pending') throw new Error(t('agentoffice.flow.error.closedReadingTask'));
        this.state.outcome = 'running';
        this.reachedFinishHooks = false;
        return undefined;
    }

    async checkpoint(checkpoint: TaskExtensionCheckpoint): Promise<boolean> {
        if (checkpoint === 'after_completion' || checkpoint === 'after_hook_backoff') this.reachedFinishHooks = false;
        if (checkpoint === 'after_finish_hooks') this.reachedFinishHooks = true;
        return false;
    }

    onTurnIterationFailed(reason: string): void {
        if (!this.state || !['pending', 'running'].includes(this.state.outcome)) return;
        this.state.outcome = 'failed';
        this.state.failure = ['turn_iteration_failed', 'hook_reject_safety_cap'].includes(reason)
            ? t('agentoffice.flow.error.readingFailed')
            : reason;
    }

    onTurnSettled(): void {
        if (this.state?.outcome === 'running' && this.task.getTurnGeneration() === this.state.generation) {
            // The standard kernel may settle after catching a completion error. A stopped Task alone is not success.
            const assistant = this.task.chat_context?.messages
                .slice()
                .reverse()
                .find((message) => message.role === 'assistant');
            if (!this.reachedFinishHooks || assistant?.content.some((part) => part.type === 'error')) {
                this.onTurnIterationFailed('turn_iteration_failed');
            } else {
                this.state.outcome = 'completed';
            }
        }
        this.resolveSettlement?.();
    }

    onHistoryMutation(): void {
        if (!this.state || !['pending', 'running'].includes(this.state.outcome)) return;
        this.onTurnIterationFailed(t('agentoffice.flow.error.readingHistoryChanged'));
        this.task.stop('system');
        this.resolveSettlement?.();
    }

    onTaskLifecycle(event: TaskExtensionLifecycleEvent): void {
        if (
            this.state &&
            ['pending', 'running'].includes(this.state.outcome) &&
            (event.type === 'stop' ||
                event.type === 'dispose' ||
                (event.type === 'agent_changed' && this.state.outcome === 'running'))
        ) {
            this.state.outcome = 'cancelled';
            this.resolveSettlement?.();
        }
    }
}

registerTaskExtension('agentoffice.flowReading', (task) => new FlowTaskExtension(task));

export function flowTaskExtension(task: TaskState): FlowTaskExtension {
    return task.extensions.require<FlowTaskExtension>('agentoffice.flowReading');
}
