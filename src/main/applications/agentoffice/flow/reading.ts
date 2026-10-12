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

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { t } from '../locale/index.js';
import { flowReadingSlot, type FlowReadingTarget } from './scheduler.js';
import type { AgentFlowRepository } from './repository.js';
import type { AgentFlowMessage } from './common.js';
import { AgentFlowIdSchema, AgentFlowTaskIdSchema, parseAgentFlowInput } from './common.js';
import {
    FlowReadingStateSchema,
    FlowReadingIntervalSchema,
    type FlowReadingBatch,
    type FlowReadingState,
    type FlowReadingClaim
} from './reading-common.js';
import type { FlowReadingView, FlowReadingReceipt } from './reading-view.js';

export class FlowReadingRepository {
    constructor(private readonly repository: AgentFlowRepository) {}

    private filePath(flowId: string): string {
        this.repository.getFlow(flowId);
        return path.join(this.repository.flowDirectory(flowId), 'reading.json');
    }

    private read(flowId: string): FlowReadingState {
        const filePath = this.filePath(flowId);
        if (!fs.existsSync(filePath)) return { schemaVersion: 1, flowId, deleting: false, members: {}, batches: [] };
        try {
            const state = FlowReadingStateSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
            if (state.flowId !== flowId) throw new Error('flow mismatch');
            return state;
        } catch {
            throw new Error(t('agentoffice.flow.error.invalidReadingState'));
        }
    }

    private write(state: FlowReadingState): void {
        const filePath = this.filePath(state.flowId);
        const temporary = filePath + '.' + crypto.randomUUID() + '.tmp';
        fs.writeFileSync(temporary, JSON.stringify(FlowReadingStateSchema.parse(state), null, 4) + '\n', 'utf8');
        fs.renameSync(temporary, filePath);
    }

    assertWritable(flowId: string): void {
        if (this.read(flowId).deleting) throw new Error(t('agentoffice.flow.error.readingUnavailable'));
    }

    invalidateTask(flowId: string, taskId: string): void {
        const state = this.read(flowId);
        if (state.deleting) return;
        for (const batch of state.batches) {
            if (batch.taskId !== taskId) continue;
            batch.taskDeletedAt = new Date().toISOString();
            if (['pending', 'running'].includes(batch.status)) {
                batch.status = 'cancelled';
                batch.completedAt = batch.taskDeletedAt;
            }
        }
        this.write(state);
    }

    private synchronize(state: FlowReadingState, messages: AgentFlowMessage[]): void {
        const flow = this.repository.getFlow(state.flowId);
        for (const staffId of flow.memberIds) {
            state.members[staffId] ??= {
                readMessageIds: [],
                pendingUserMessageIds: [],
                failureCount: 0,
                intervalMinutes: 10,
                userEventBaselineIds: messages
                    .filter((message) => message.sender.type === 'user')
                    .map((message) => message.id)
            };
            const member = flow.members.find((entry) => entry.staffId === staffId);
            if (member?.name) state.members[staffId].name = member.name;
        }
        for (const [staffId, member] of Object.entries(state.members)) {
            const read = new Set(member.readMessageIds);
            for (const message of messages) {
                if (message.sender.type === 'staff' && message.sender.id === staffId) read.add(message.id);
            }
            member.readMessageIds = [...read];
            member.pendingUserMessageIds = messages
                .filter((message) => message.sender.type === 'user' && !read.has(message.id))
                .map((message) => message.id);
        }
        // Recover the reply receipt if the process stopped after message commit but before state commit.
        for (const message of messages) {
            const batch = state.batches.find((candidate) => candidate.batchId === message.readingBatchId);
            if (batch && message.replyKey && !batch.replies.some((reply) => reply.key === message.replyKey)) {
                batch.replies.push({ key: message.replyKey, messageId: message.id });
            }
        }
    }

    getState(flowId: string): FlowReadingState {
        const state = this.read(flowId);
        if (!state.deleting) {
            const before = JSON.stringify(state);
            this.synchronize(state, this.repository.readMessages(flowId));
            if (before !== JSON.stringify(state)) this.write(state);
        }
        return state;
    }

    listStates(): FlowReadingState[] {
        return this.repository
            .listFlows({ status: 'all' })
            .filter((flow) => fs.existsSync(path.join(this.repository.flowDirectory(flow.id), 'reading.json')))
            .map((flow) => this.read(flow.id));
    }

    setInterval(flowId: string, staffId: string, intervalMinutes: number, now = new Date().toISOString()): void {
        const interval = parseAgentFlowInput(FlowReadingIntervalSchema, intervalMinutes);
        const flow = this.repository.getFlow(flowId);
        const state = this.getState(flowId);
        if (state.deleting || flow.status !== 'active' || !flow.memberIds.includes(staffId))
            throw new Error(t('agentoffice.flow.error.readingUnavailable'));
        const progress = state.members[staffId];
        if (progress.intervalMinutes === interval) return;
        progress.intervalMinutes = interval;
        // A changed period starts at its next boundary, never backfills the current slot.
        progress.lastTimerSlot = flowReadingSlot(Date.parse(now), interval);
        this.write(state);
    }

    getView(flowId: string, immediate: boolean, now = new Date().toISOString()): FlowReadingView {
        const flow = this.repository.getFlow(flowId);
        const state = this.getState(flowId);
        const members: FlowReadingView['members'] = Object.entries(state.members).map(([staffId, progress]) => {
            const current = flow.members.find((entry) => entry.staffId === staffId);
            const availability = !current
                ? 'left'
                : current.missing
                  ? 'missing'
                  : !current.enabled
                    ? 'disabled'
                    : 'active';
            const latest = state.batches.filter((batch) => batch.staffId === staffId).at(-1);
            const available = !state.deleting && flow.status === 'active' && availability === 'active';
            return {
                staffId,
                name: current?.name ?? progress.name,
                availability,
                intervalMinutes: progress.intervalMinutes,
                nextTriggerAt:
                    available && !immediate
                        ? new Date(
                              Date.parse(flowReadingSlot(Date.parse(now), progress.intervalMinutes)) +
                                  progress.intervalMinutes * 60_000
                          ).toISOString()
                        : undefined,
                retryBatchId:
                    available && latest && !latest.taskDeletedAt && ['failed', 'cancelled'].includes(latest.status)
                        ? latest.batchId
                        : undefined
            };
        });
        const receipts: Record<string, FlowReadingReceipt> = {};
        const readSets = new Map(
            Object.entries(state.members).map(([id, progress]) => [id, new Set(progress.readMessageIds)])
        );
        const messageBatches = new Map<string, Map<string, FlowReadingBatch>>();
        for (const batch of state.batches) {
            let byMessage = messageBatches.get(batch.staffId);
            if (!byMessage) messageBatches.set(batch.staffId, (byMessage = new Map()));
            for (const messageId of batch.unreadMessageIds) byMessage.set(messageId, batch);
        }
        for (const message of this.repository.readMessages(flowId)) {
            const details = members.map((member) => {
                const batch = messageBatches.get(member.staffId)?.get(message.id);
                const status = readSets.get(member.staffId)?.has(message.id)
                    ? 'read'
                    : batch && ['pending', 'running'].includes(batch.status)
                      ? 'reading'
                      : batch && ['failed', 'cancelled'].includes(batch.status)
                        ? 'failed'
                        : 'unread';
                return { staffId: member.staffId, status } as FlowReadingReceipt['members'][number];
            });
            receipts[message.id] = {
                read: details.filter((member) => flow.memberIds.includes(member.staffId) && member.status === 'read')
                    .length,
                total: flow.memberIds.length,
                members: details
            };
        }
        return { flowId, mode: immediate ? 'immediate' : 'aligned', deleting: state.deleting, members, receipts };
    }

    collectSchedulerTargets(now: string, immediate = false): FlowReadingTarget[] {
        const targets: FlowReadingTarget[] = [];
        for (const flow of this.repository.listFlows({ status: 'active' })) {
            const state = this.getState(flow.id);
            if (state.deleting) continue;
            const before = JSON.stringify(state);
            const messages = this.repository.readMessages(flow.id);
            const detail = this.repository.getFlow(flow.id);
            for (const member of detail.members) {
                if (member.missing || !member.enabled) continue;
                const progress = state.members[member.staffId];
                const slot = flowReadingSlot(Date.parse(now), progress.intervalMinutes);
                const read = new Set(progress.readMessageIds);
                const unread = messages.filter((message) => !read.has(message.id));
                const latest = state.batches
                    .slice()
                    .reverse()
                    .find((batch) => batch.staffId === member.staffId);
                const attempted = new Set([...(latest?.snapshotMessageIds ?? []), ...progress.userEventBaselineIds]);
                const userEvent = unread
                    .filter((message) => message.sender.type === 'user' && !attempted.has(message.id))
                    .at(-1);
                const staffEvent = immediate
                    ? unread
                          .filter(
                              (message) =>
                                  message.sender.type === 'staff' &&
                                  message.kind === 'message' &&
                                  !attempted.has(message.id)
                          )
                          .at(-1)
                    : undefined;
                const newSlot = progress.lastTimerSlot
                    ? progress.lastTimerSlot < slot
                    : Date.parse(now) - Date.parse(slot) < 1000;
                // Consume each wall-clock slot even when busy or empty; never queue missed timer work.
                const failedUnchanged =
                    latest &&
                    ['failed', 'cancelled'].includes(latest.status) &&
                    unread.every((message) => attempted.has(message.id));
                targets.push({
                    flowId: flow.id,
                    staffId: member.staffId,
                    userEventId: userEvent?.id,
                    ...(staffEvent ? { messageEventId: staffEvent.id } : {}),
                    timerDue: Boolean(!immediate && newSlot && unread.length && !failedUnchanged)
                });
            }
            for (const progress of Object.values(state.members)) {
                const slot = flowReadingSlot(Date.parse(now), progress.intervalMinutes);
                if (!immediate && (!progress.lastTimerSlot || progress.lastTimerSlot < slot))
                    progress.lastTimerSlot = slot;
            }
            if (before !== JSON.stringify(state)) this.write(state);
        }
        return targets;
    }

    claim(
        flowId: string,
        staffId: string,
        trigger: FlowReadingBatch['trigger'],
        sourceMessageId?: string,
        retryOfBatchId?: string
    ): FlowReadingClaim {
        parseAgentFlowInput(AgentFlowIdSchema, staffId);
        if (sourceMessageId) parseAgentFlowInput(AgentFlowIdSchema, sourceMessageId);
        if (retryOfBatchId) parseAgentFlowInput(AgentFlowIdSchema, retryOfBatchId);
        if (!['manual', 'mention', 'user', 'message', 'timer'].includes(trigger))
            throw new Error(t('agentoffice.flow.error.invalidInput'));
        const snapshot = this.repository.getHistorySnapshot(flowId);
        const member = snapshot.flow.members.find((candidate) => candidate.staffId === staffId);
        const state = this.getState(flowId);
        if (state.deleting || snapshot.flow.status !== 'active' || !member || member.missing || !member.enabled) {
            throw new Error(t('agentoffice.flow.error.readingUnavailable'));
        }
        if (sourceMessageId) {
            const existing = state.batches.find(
                (batch) => batch.staffId === staffId && batch.sourceMessageId === sourceMessageId
            );
            if (existing) return { status: 'existing', batch: existing };
        }
        const occupied = this.listStates()
            .flatMap((entry) => entry.batches)
            .find((batch) => batch.staffId === staffId && ['pending', 'running'].includes(batch.status));
        if (occupied) return { status: 'busy', batch: occupied };
        const previous = retryOfBatchId ? state.batches.find((batch) => batch.batchId === retryOfBatchId) : undefined;
        const latest = state.batches
            .slice()
            .reverse()
            .find((entry) => entry.staffId === staffId && !entry.taskDeletedAt);
        if (trigger === 'manual' && !retryOfBatchId && latest && ['failed', 'cancelled'].includes(latest.status)) {
            throw new Error(t('agentoffice.flow.error.readingRetryRequired'));
        }
        if (
            retryOfBatchId &&
            (!previous ||
                previous !== latest ||
                previous.taskDeletedAt ||
                previous.staffId !== staffId ||
                !['failed', 'cancelled'].includes(previous.status))
        ) {
            throw new Error(t('agentoffice.flow.error.invalidReadingRetry'));
        }
        const read = new Set(state.members[staffId].readMessageIds);
        const unread = snapshot.messages.filter((message) => !read.has(message.id));
        if (!unread.length) return { status: 'empty' };
        if (
            trigger === 'message' &&
            !unread.some(
                (message) =>
                    message.sender.type === 'staff' &&
                    message.kind === 'message' &&
                    !latest?.snapshotMessageIds.includes(message.id)
            )
        )
            return { status: 'empty' };
        if (
            trigger === 'user' &&
            !unread.some(
                (message) =>
                    message.sender.type === 'user' &&
                    !latest?.snapshotMessageIds.includes(message.id) &&
                    !state.members[staffId].userEventBaselineIds.includes(message.id)
            )
        )
            return { status: 'empty' };
        if (
            trigger === 'timer' &&
            latest &&
            ['failed', 'cancelled'].includes(latest.status) &&
            unread.every((message) => latest.snapshotMessageIds.includes(message.id))
        )
            return { status: 'empty' };
        const batch: FlowReadingBatch = {
            batchId: crypto.randomUUID(),
            flowId,
            staffId,
            trigger,
            sourceMessageId,
            retryOfBatchId,
            unreadMessageIds: unread.map((message) => message.id),
            snapshotMessageIds: snapshot.messages.map((message) => message.id),
            snapshotHighWater: snapshot.messages.reduce(
                (maximum, message) => Math.max(maximum, message.sequence ?? 0),
                0
            ),
            status: 'pending',
            createdAt: new Date().toISOString(),
            failureCount: state.members[staffId].failureCount,
            replies: []
        };
        state.batches.push(batch);
        this.write(state);
        return { status: 'claimed', batch, snapshot };
    }

    bindTask(flowId: string, batchId: string, taskId: string): FlowReadingBatch {
        parseAgentFlowInput(AgentFlowTaskIdSchema, taskId);
        const state = this.read(flowId);
        const batch = state.batches.find((entry) => entry.batchId === batchId);
        if (state.deleting || !batch || batch.status !== 'pending')
            throw new Error(t('agentoffice.flow.error.staleReadingBatch'));
        // Ownership is durable before the batch can execute; cleanup also scans batch taskIds.
        this.repository.rememberTasks(flowId, [taskId]);
        batch.taskId = taskId;
        batch.status = 'running';
        batch.startedAt = new Date().toISOString();
        this.write(state);
        return batch;
    }

    assertRunning(flowId: string, batchId: string, taskId: string): FlowReadingBatch {
        const state = this.read(flowId);
        const batch = state.batches.find((entry) => entry.batchId === batchId);
        const flow = this.repository.getFlow(flowId);
        const member = flow.members.find((entry) => entry.staffId === batch?.staffId);
        if (
            state.deleting ||
            flow.status !== 'active' ||
            !batch ||
            batch.status !== 'running' ||
            batch.taskId !== taskId ||
            !member?.enabled ||
            member.missing
        ) {
            throw new Error(t('agentoffice.flow.error.staleReadingBatch'));
        }
        return batch;
    }

    finish(
        flowId: string,
        batchId: string,
        status: 'completed' | 'failed' | 'cancelled',
        failure?: string
    ): FlowReadingBatch | undefined {
        if (!['completed', 'failed', 'cancelled'].includes(status))
            throw new Error(t('agentoffice.flow.error.invalidInput'));
        const state = this.read(flowId);
        if (state.deleting) return undefined;
        const batch = state.batches.find((entry) => entry.batchId === batchId);
        if (!batch) throw new Error(t('agentoffice.flow.error.staleReadingBatch'));
        if (batch.taskDeletedAt) return undefined;
        if (!['pending', 'running'].includes(batch.status)) return batch;
        const member = this.repository.getFlow(flowId).members.find((entry) => entry.staffId === batch.staffId);
        if (!member?.enabled || member.missing) status = 'cancelled';
        if (status === 'completed' && (!batch.taskId || batch.status !== 'running'))
            throw new Error(t('agentoffice.flow.error.staleReadingBatch'));
        this.synchronize(state, this.repository.readMessages(flowId));
        if (status === 'completed') {
            state.members[batch.staffId].readMessageIds = [
                ...new Set([...state.members[batch.staffId].readMessageIds, ...batch.unreadMessageIds])
            ];
            state.members[batch.staffId].failureCount = 0;
        } else if (status === 'failed') {
            batch.failureCount = ++state.members[batch.staffId].failureCount;
        }
        batch.status = status;
        batch.failure = failure;
        batch.completedAt = new Date().toISOString();
        this.synchronize(state, this.repository.readMessages(flowId));
        // Read receipts and release of the pending/running claim are one atomic state replacement.
        this.write(state);
        return batch;
    }

    appendReply(
        flowId: string,
        batchId: string,
        taskId: string,
        text: string | undefined,
        files: string[],
        replyToMessageId?: string
    ): { messageId: string; created: boolean } {
        const batch = this.assertRunning(flowId, batchId, taskId);
        if (
            replyToMessageId &&
            (!batch.snapshotMessageIds.includes(replyToMessageId) ||
                !this.repository.getMessage(flowId, replyToMessageId))
        ) {
            throw new Error(t('agentoffice.flow.error.invalidReplyReference'));
        }
        const key = crypto
            .createHash('sha256')
            .update(
                JSON.stringify({
                    text: text?.trim() ?? '',
                    replyToMessageId,
                    files: files.map((file) => ({
                        name: path.basename(file),
                        hash: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
                    }))
                })
            )
            .digest('hex');
        const state = this.getState(flowId);
        let current = state.batches.find((entry) => entry.batchId === batchId);
        const visited = new Set<string>();
        while (current) {
            if (visited.has(current.batchId)) throw new Error(t('agentoffice.flow.error.invalidReadingState'));
            visited.add(current.batchId);
            const existing = current.replies.find((reply) => reply.key === key);
            if (existing) return { messageId: existing.messageId, created: false };
            current = current.retryOfBatchId
                ? state.batches.find((entry) => entry.batchId === current!.retryOfBatchId)
                : undefined;
        }
        const message = this.repository.appendStaffMessage(
            flowId,
            batch.staffId,
            taskId,
            text,
            files,
            'message',
            replyToMessageId,
            { readingBatchId: batchId, replyKey: key }
        );
        this.getState(flowId);
        return { messageId: message.id, created: true };
    }

    blockDeletion(flowId: string): string[] {
        const state = this.read(flowId);
        state.deleting = true;
        for (const batch of state.batches) {
            if (['pending', 'running'].includes(batch.status)) {
                batch.status = 'cancelled';
                batch.completedAt = new Date().toISOString();
            }
        }
        this.write(state);
        return state.batches.flatMap((batch) => (batch.taskId ? [batch.taskId] : []));
    }
}
