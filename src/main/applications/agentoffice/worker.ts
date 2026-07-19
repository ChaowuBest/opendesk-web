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
import { t } from '../../../locale/index.js';
import { AgentOfficeRepository } from './repository.js';
import type {
    HistoryQuery,
    MessageAttachmentInput,
    StaffDefinition,
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

    async initialize(): Promise<void> {
        this.repository = new AgentOfficeRepository(this.appDataDirectory);
        this.repository.ensurePresetStaffs(presetStaffs());
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

    createStaff(definition: StaffDefinition, defaultAgentsMd?: string) {
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
}
