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

import { BaseWorker } from '../base.js';
import { t } from './locale/index.js';
import { AgentOfficeRepository } from './repository.js';
import { isAgentFlowEnabled } from './flow/feature.js';
import { AgentFlowRepository } from './flow/repository.js';
import type { FlowReadingBatch } from './flow/reading-common.js';
import { isFlowImmediateReadingEnabled } from './flow/scheduler.js';
import type { TaskUsageSummary } from '../../telemetry/local-telemetry.js';
import {
    AgentFlowIdSchema,
    AgentFlowListFilterSchema,
    AgentFlowMemberIdsSchema,
    AgentFlowMessageHistoryQuerySchema,
    AgentFlowRevisionSchema,
    AgentFlowTaskIdSchema,
    CreateAgentFlowInputSchema,
    PrepareAgentFlowUserMessageInputSchema,
    parseAgentFlowInput,
    UpdateAgentFlowPatchSchema,
    type AgentFlowMessageHistoryQuery,
    type AgentFlowListFilter,
    type CreateAgentFlowInput,
    type PrepareAgentFlowUserMessageInput,
    type UpdateAgentFlowPatch
} from './flow/common.js';
import type {
    DueStaffTrigger,
    HistoryQuery,
    MessageAttachmentInput,
    StaffDefinitionInput,
    StaffMessage,
    StaffTaskRecord,
    StaffUpdateInput,
    PresetStaffDefinition
} from './common.js';

function presetStaffs(): PresetStaffDefinition[] {
    return [
        {
            key: 'research-analyst-v1',
            definition: {
                name: t('agentoffice.preset.research.name'),
                vendor_name: 'OpenDesk',
                title: t('agentoffice.preset.research.title'),
                specialties: [
                    t('agentoffice.preset.research.specialty1'),
                    t('agentoffice.preset.research.specialty2'),
                    t('agentoffice.preset.research.specialty3')
                ]
            },
            agents_md: t('agentoffice.preset.research.instructions')
        },
        {
            key: 'project-planner-v1',
            definition: {
                name: t('agentoffice.preset.planner.name'),
                vendor_name: 'OpenDesk',
                title: t('agentoffice.preset.planner.title'),
                specialties: [
                    t('agentoffice.preset.planner.specialty1'),
                    t('agentoffice.preset.planner.specialty2'),
                    t('agentoffice.preset.planner.specialty3')
                ]
            },
            agents_md: t('agentoffice.preset.planner.instructions')
        },
        {
            key: 'content-writer-v1',
            definition: {
                name: t('agentoffice.preset.writer.name'),
                vendor_name: 'OpenDesk',
                title: t('agentoffice.preset.writer.title'),
                specialties: [
                    t('agentoffice.preset.writer.specialty1'),
                    t('agentoffice.preset.writer.specialty2'),
                    t('agentoffice.preset.writer.specialty3')
                ]
            },
            agents_md: t('agentoffice.preset.writer.instructions')
        }
    ];
}

export default class AgentOfficeWorker extends BaseWorker {
    private repository!: AgentOfficeRepository;
    private flowRepository?: AgentFlowRepository;

    async initialize(): Promise<void> {
        this.repository = new AgentOfficeRepository(this.appDataDirectory);
        this.repository.ensurePresetStaffs(presetStaffs());
        if (isAgentFlowEnabled()) {
            this.flowRepository = new AgentFlowRepository(this.appDataDirectory, this.repository);
        }
    }

    async handleMessage(methodName: string, ...args: unknown[]): Promise<unknown> {
        return await this.taskQueue.add(async () => await super.handleMessage(methodName, ...args));
    }

    listStaffs() {
        return this.repository.listStaffs();
    }

    getStaffDetail(staffId: string) {
        return this.repository.getStaffDetail(staffId);
    }

    listFlows(filter: AgentFlowListFilter = {}) {
        return this.requireFlowRepository().listFlows(parseAgentFlowInput(AgentFlowListFilterSchema, filter));
    }

    getFlow(flowId: string) {
        return this.requireFlowRepository().getFlow(parseAgentFlowInput(AgentFlowIdSchema, flowId));
    }

    createFlow(input: CreateAgentFlowInput) {
        const flow = this.requireFlowRepository().createFlow(parseAgentFlowInput(CreateAgentFlowInputSchema, input));
        void this.emitEvent('flowsChanged');
        return flow;
    }

    updateFlow(flowId: string, expectedRevision: number, patch: UpdateAgentFlowPatch) {
        const flow = this.requireFlowRepository().updateFlow(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowRevisionSchema, expectedRevision),
            parseAgentFlowInput(UpdateAgentFlowPatchSchema, patch)
        );
        void this.emitEvent('flowsChanged');
        return flow;
    }

    setFlowMembers(flowId: string, expectedRevision: number, memberIds: string[]) {
        const flow = this.requireFlowRepository().setFlowMembers(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowRevisionSchema, expectedRevision),
            parseAgentFlowInput(AgentFlowMemberIdsSchema, memberIds)
        );
        void this.emitEvent('flowsChanged');
        return flow;
    }

    archiveFlow(flowId: string, expectedRevision: number) {
        const flow = this.requireFlowRepository().archiveFlow(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowRevisionSchema, expectedRevision)
        );
        void this.emitEvent('flowsChanged');
        return flow;
    }

    getFlowMessageHistory(flowId: string, query: AgentFlowMessageHistoryQuery) {
        return this.requireFlowRepository().getMessageHistory(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowMessageHistoryQuerySchema, query)
        );
    }

    getFlowHistorySnapshot(flowId: string) {
        return this.requireFlowRepository().getHistorySnapshot(parseAgentFlowInput(AgentFlowIdSchema, flowId));
    }

    getFlowReadingState(flowId: string) {
        return this.requireFlowRepository().reading.getState(flowId);
    }

    getFlowReadingView(flowId: string) {
        return this.requireFlowRepository().reading.getView(flowId, isFlowImmediateReadingEnabled());
    }

    setFlowReadingInterval(flowId: string, staffId: string, intervalMinutes: number) {
        this.requireFlowRepository().reading.setInterval(flowId, staffId, intervalMinutes);
        void this.emitEvent('flowReadingChanged', flowId);
        return this.getFlowReadingView(flowId);
    }

    listFlowReadingStates() {
        return this.requireFlowRepository().reading.listStates();
    }

    collectFlowReadingTargets(now: string) {
        return this.requireFlowRepository().reading.collectSchedulerTargets(now, isFlowImmediateReadingEnabled());
    }

    claimFlowReading(
        flowId: string,
        staffId: string,
        trigger: FlowReadingBatch['trigger'],
        sourceMessageId?: string,
        retryOfBatchId?: string
    ) {
        const result = this.requireFlowRepository().reading.claim(
            flowId,
            staffId,
            trigger,
            sourceMessageId,
            retryOfBatchId
        );
        if (result.status === 'claimed') void this.emitEvent('flowReadingChanged', flowId);
        return result;
    }

    bindFlowReadingTask(flowId: string, batchId: string, taskId: string) {
        const batch = this.requireFlowRepository().reading.bindTask(flowId, batchId, taskId);
        this.updateReadingTaskRecord(batch);
        void this.emitEvent('flowReadingChanged', flowId);
        return batch;
    }

    invalidateFlowReadingTask(flowId: string, taskId: string) {
        this.requireFlowRepository().reading.invalidateTask(flowId, taskId);
        void this.emitEvent('flowReadingChanged', flowId);
    }

    assertFlowReadingRunning(flowId: string, batchId: string, taskId: string) {
        return this.requireFlowRepository().reading.assertRunning(flowId, batchId, taskId);
    }

    settleFlowReading(
        flowId: string,
        batchId: string,
        taskId: string | undefined,
        status: 'completed' | 'failed' | 'cancelled',
        failure?: string,
        usage?: TaskUsageSummary
    ) {
        const reading = this.requireFlowRepository().reading;
        const state = reading.getState(flowId);
        const current = state.batches.find((batch) => batch.batchId === batchId);
        if (!current || current.taskId !== taskId) throw new Error(t('agentoffice.flow.error.staleReadingBatch'));
        const batch = reading.finish(flowId, batchId, status, failure);
        if (batch) this.updateReadingTaskRecord(batch, usage);
        void this.emitEvent('flowReadingChanged', flowId);
        void this.emitEvent('staffsChanged');
        return batch;
    }

    appendFlowReadingReply(
        flowId: string,
        batchId: string,
        taskId: string,
        text: string | undefined,
        files: string[],
        replyToMessageId?: string
    ) {
        const result = this.requireFlowRepository().reading.appendReply(
            flowId,
            batchId,
            taskId,
            text,
            files,
            replyToMessageId
        );
        const batch = this.requireFlowRepository().reading.assertRunning(flowId, batchId, taskId);
        this.updateReadingTaskRecord(batch);
        void this.emitEvent('flowMessagesChanged', flowId);
        return result;
    }

    private updateReadingTaskRecord(batch: FlowReadingBatch, usage?: TaskUsageSummary): void {
        if (
            !batch.taskId ||
            batch.taskDeletedAt ||
            !this.repository.listStaffs().some((staff) => staff.id === batch.staffId)
        )
            return;
        const existing = this.repository.readTasks(batch.staffId).find((record) => record.task_id === batch.taskId);
        this.repository.upsertTask(batch.staffId, {
            ...existing,
            task_id: batch.taskId,
            source: 'flow',
            flow_id: batch.flowId,
            flow_batch_id: batch.batchId,
            flow_message_id: batch.sourceMessageId,
            message_ids: [
                ...new Set([
                    ...(existing?.message_ids ?? []),
                    ...batch.unreadMessageIds,
                    ...batch.replies.map((reply) => reply.messageId)
                ])
            ],
            status: batch.status === 'completed' ? 'succeeded' : batch.status === 'pending' ? 'waiting' : batch.status,
            created_at: batch.createdAt,
            updated_at: batch.completedAt ?? new Date().toISOString(),
            usage_summary: usage ?? existing?.usage_summary
        });
    }

    rememberFlowTasks(flowId: string, taskIds: string[]) {
        return this.requireFlowRepository().rememberTasks(parseAgentFlowInput(AgentFlowIdSchema, flowId), taskIds);
    }

    prepareFlowDeletion(flowId: string, expectedRevision: number) {
        const repository = this.requireFlowRepository();
        repository.assertDeletable(flowId, expectedRevision);
        const taskIds = [
            ...repository.reading.blockDeletion(flowId),
            ...repository.readMessages(flowId).flatMap((message) => (message.taskId ? [message.taskId] : []))
        ];
        for (const staff of this.repository.listStaffs()) {
            for (const record of this.repository.readTasks(staff.id)) {
                if (record.source === 'flow' && record.flow_id === flowId) taskIds.push(record.task_id);
            }
        }
        return repository.rememberTasks(flowId, taskIds);
    }

    deleteFlow(flowId: string, expectedRevision: number) {
        const repository = this.requireFlowRepository();
        repository.assertDeletable(flowId, expectedRevision);
        for (const staff of this.repository.listStaffs()) {
            for (const record of this.repository.readTasks(staff.id)) {
                if (record.source === 'flow' && record.flow_id === flowId) {
                    this.repository.deleteTaskRecord(staff.id, record.task_id);
                }
            }
        }
        repository.deleteFlow(flowId, expectedRevision);
        void this.emitEvent('flowsChanged');
        void this.emitEvent('staffsChanged');
    }

    getFlowMessage(flowId: string, messageId: string) {
        return this.requireFlowRepository().getMessage(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowIdSchema, messageId)
        );
    }

    deleteFlowMessage(flowId: string, messageId: string) {
        const message = this.requireFlowRepository().deleteMessage(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowIdSchema, messageId)
        );
        void this.emitEvent('flowMessagesChanged', flowId);
        return message;
    }

    prepareFlowUserMessage(flowId: string, input: PrepareAgentFlowUserMessageInput) {
        const prepared = this.requireFlowRepository().prepareUserMessage(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(PrepareAgentFlowUserMessageInputSchema, input)
        );
        void this.emitEvent('flowMessagesChanged', flowId);
        return prepared;
    }

    appendFlowStaffMessage(
        flowId: string,
        staffId: string,
        taskId: string,
        text?: string,
        files: string[] = [],
        kind: 'message' | 'error' = 'message',
        replyToMessageId?: string
    ) {
        const message = this.requireFlowRepository().appendStaffMessage(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowIdSchema, staffId),
            parseAgentFlowInput(AgentFlowTaskIdSchema, taskId),
            text,
            files,
            kind,
            replyToMessageId
        );
        void this.emitEvent('flowMessagesChanged', flowId);
        return message;
    }

    appendFlowSystemMessage(
        flowId: string,
        text: string,
        taskId?: string,
        kind: 'message' | 'error' = 'message',
        retryable = false
    ) {
        const message = this.requireFlowRepository().appendSystemMessage(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            text,
            taskId ? parseAgentFlowInput(AgentFlowTaskIdSchema, taskId) : undefined,
            kind,
            retryable
        );
        void this.emitEvent('flowMessagesChanged', flowId);
        return message;
    }

    createStaff(definition: StaffDefinitionInput, defaultAgentsMd?: string) {
        const detail = this.repository.createStaff(definition, defaultAgentsMd);
        void this.emitEvent('staffsChanged');
        return detail;
    }

    updateStaff(staffId: string, input: StaffUpdateInput) {
        const detail = this.repository.updateStaff(staffId, input);
        void this.emitEvent('staffsChanged');
        return detail;
    }

    ensureWorkspace(staffId: string) {
        return this.repository.ensureWorkspace(staffId);
    }

    prepareUserMessage(
        staffId: string,
        taskId: string,
        text: string | undefined,
        attachments: MessageAttachmentInput[],
        imageDataUris: string[]
    ) {
        return this.repository.prepareUserMessage(staffId, taskId, text, attachments, imageDataUris);
    }

    appendMessage(staffId: string, message: StaffMessage) {
        this.repository.appendMessage(staffId, message);
        void this.emitEvent('messagesChanged', staffId);
    }

    appendAssistantMessage(
        staffId: string,
        taskId: string,
        text?: string,
        files: string[] = [],
        kind: 'message' | 'error' = 'message'
    ) {
        const message = this.repository.appendAssistantMessage(staffId, taskId, text, files, kind);
        void this.emitEvent('messagesChanged', staffId);
        return message;
    }

    deleteMessage(staffId: string, messageId: string) {
        this.repository.deleteMessage(staffId, messageId);
        void this.emitEvent('messagesChanged', staffId);
    }

    deleteMessagePart(staffId: string, messageId: string, partIndex: number) {
        this.repository.deleteMessagePart(staffId, messageId, partIndex);
        void this.emitEvent('messagesChanged', staffId);
    }

    getHistory(staffId: string, query: HistoryQuery) {
        return this.repository.getHistory(staffId, query);
    }

    readTasks(staffId: string) {
        return this.repository.readTasks(staffId);
    }

    upsertTask(staffId: string, task: StaffTaskRecord) {
        this.repository.upsertTask(staffId, task);
        void this.emitEvent('staffTaskChanged', staffId, task.task_id);
    }

    deleteStaffTaskRecord(staffId: string, taskId: string) {
        const parsedTaskId = parseAgentFlowInput(AgentFlowTaskIdSchema, taskId);
        this.repository.deleteTaskRecord(parseAgentFlowInput(AgentFlowIdSchema, staffId), parsedTaskId);
        void this.emitEvent('staffTaskChanged', staffId, parsedTaskId);
    }

    claimDueTriggers(nowIso: string) {
        return this.repository.claimDueTriggers(nowIso);
    }

    releaseTriggerClaim(trigger: DueStaffTrigger) {
        this.repository.releaseTriggerClaim(trigger);
    }

    importStaff(zipPath: string) {
        const detail = this.repository.importStaff(zipPath);
        void this.emitEvent('staffsChanged');
        return detail;
    }

    exportStaff(staffId: string, zipPath: string) {
        return this.repository.exportStaff(staffId, zipPath);
    }

    listSkills(staffId: string) {
        return this.repository.listSkills(staffId);
    }

    scanSkillSources(rootDirectory: string) {
        return this.repository.scanSkillSources(rootDirectory);
    }

    addSkill(staffId: string, sourcePath: string) {
        const skill = this.repository.addSkill(staffId, sourcePath);
        void this.emitEvent('staffsChanged');
        return skill;
    }

    deleteSkill(staffId: string, name: string) {
        this.repository.deleteSkill(staffId, name);
        void this.emitEvent('staffsChanged');
    }

    deleteStaff(staffId: string) {
        const directory = this.repository.deleteStaff(staffId);
        void this.emitEvent('staffsChanged');
        return directory;
    }

    private requireFlowRepository(): AgentFlowRepository {
        if (!this.flowRepository) throw new Error(t('agentoffice.flow.error.featureDisabled'));
        return this.flowRepository;
    }
}
