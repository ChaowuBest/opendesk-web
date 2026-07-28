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

import fs from 'fs';
import path from 'path';
import { BaseApplication, type EventDecl, type ProtocolHandlerConfig } from '../base.js';
import { GlobalState } from '../../aikernel/states/global.js';
import type { TaskManagerState, TaskState } from '../../aikernel/states/tasks.js';
import { getPlatform } from '../../../platforms/base.js';
import { getLocale, t } from '../../../locale/index.js';
import { logger } from '../../utils/logger.js';
import { getOpendeskDirectory, getTaskArtifactDirectory, Setting } from '../../utils/setting.js';
import { getTempDir } from '../../utils/temp.js';
import { createAgentOfficeTaskToolset } from './tools.js';
import { createStaffPermissionEnforcer } from './permission.js';
import { SkillRegistry } from '../skillmgr/utils.js';
import AgentOfficeWorker from './worker.js';
import { unwrapAgentOfficeCallResult } from './common.js';
import { CustomAgent } from './custom-agent.js';
import type { AgentMcpRegistration, McpMgrApplication } from '../mcpmgr/app.js';
import type { AgentDecl, ModeDecl } from '../../aikernel/agents/common.js';
import type {
    DueStaffTrigger,
    HistoryQuery,
    InstalledSkillSummary,
    PreparedMessage,
    SendStaffMessageInput,
    StaffDefinitionInput,
    StaffDetail,
    StaffListItem,
    StaffMessage,
    StaffPermission,
    StaffSkillBatchImportResult,
    StaffSkillImportCandidate,
    StaffTaskSource,
    StaffTaskRecord,
    StaffUpdateInput
} from './common.js';

const AGENTOFFICE_SCHEME = 'agentoffice';
const PORTRAIT_DATA_URI_MAX_LENGTH = 8 * 1024 * 1024;
const SKILL_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;
const STAFF_TRIGGER_POLL_INTERVAL_MS = 30 * 1000;

export function interpolateAgentOfficePrompt(template: string, values: Record<string, string>): string {
    let prompt = template;
    for (const [key, value] of Object.entries(values)) {
        prompt = prompt.split(`\${${key}}`).join(value);
    }
    return prompt;
}

function mimeTypeFor(filePath: string): string {
    const extension = path.extname(filePath).toLowerCase();
    const known: Record<string, string> = {
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg',
        '.wav': 'audio/wav',
        '.m4a': 'audio/mp4',
        '.ogg': 'audio/ogg',
        '.pdf': 'application/pdf',
        '.txt': 'text/plain; charset=utf-8',
        '.md': 'text/markdown; charset=utf-8'
    };
    return known[extension] ?? 'application/octet-stream';
}

function buildTaskPrompt(
    current: StaffMessage,
    recent: StaffMessage[],
    resourcesDirectory: string,
    scheduledTaskInProgress: boolean
): string {
    return interpolateAgentOfficePrompt(t('agentoffice.task.prompt'), {
        resourcesDirectory,
        recent: JSON.stringify(recent, null, 2),
        current: JSON.stringify(current, null, 2),
        scheduledTaskNotice: scheduledTaskInProgress ? t('agentoffice.task.scheduledInProgress') : ''
    });
}

function buildScheduledTaskPrompt(recent: StaffMessage[], memoryPath: string): string {
    return interpolateAgentOfficePrompt(t('agentoffice.task.scheduledPrompt'), {
        recent: JSON.stringify(recent, null, 2),
        memoryPath
    });
}

function taskNameFor(input: SendStaffMessageInput): string {
    const text = input.text?.trim();
    const fallback = input.attachments
        ?.map((attachment) => attachment.name || path.basename(attachment.path))
        .join(', ');
    return `${t('agentoffice.taskPrefix')} ${text || fallback || t('agentoffice.attachmentMessage')}`;
}

export function acquireStaffTaskForMessage(
    records: readonly StaffTaskRecord[],
    taskManager: Pick<TaskManagerState, 'getTask' | 'createTask'>,
    taskName: string,
    onInterrupt: (task: TaskState, turnKey: string) => void
): { task: TaskState; reused: boolean; interruptedTurnKey?: string } {
    const activeTask = findRunningStaffTaskBySource(records, taskManager, 'user');
    if (!activeTask) {
        return { task: taskManager.createTask(undefined, { taskName, internal: true }), reused: false };
    }

    activeTask.markAsInternal();
    const interruptedTurnKey = `${activeTask.task_id}:${activeTask.getTurnGeneration()}`;
    onInterrupt(activeTask, interruptedTurnKey);
    activeTask.stop('user');
    return { task: activeTask, reused: true, interruptedTurnKey };
}

export function findRunningStaffTaskBySource(
    records: readonly StaffTaskRecord[],
    taskManager: Pick<TaskManagerState, 'getTask'>,
    source: StaffTaskSource
): TaskState | undefined {
    return records
        .slice()
        .reverse()
        .filter((record) => (record.source ?? 'user') === source)
        .map((record) => taskManager.getTask(record.task_id))
        .find((candidate): candidate is TaskState => candidate?.task_status === 'running');
}

export function mergeStaffTaskRecord(
    existing: StaffTaskRecord | undefined,
    task: TaskState,
    messageId: string,
    timestamp: string
): StaffTaskRecord {
    return {
        task_id: task.task_id,
        message_ids: existing ? [...existing.message_ids, messageId] : [messageId],
        status: 'running',
        source: 'user',
        created_at: existing?.created_at ?? timestamp,
        updated_at: timestamp,
        usage_summary: task.usage_summary
    };
}

export function applyStaffModelToTask(
    task: Pick<TaskState, 'model' | 'ensureValidModelOrFallback'>,
    model: string | undefined
): void {
    task.model = model?.trim() || undefined;
    task.ensureValidModelOrFallback();
}

export function assignStaffAgentToTask(
    task: Pick<TaskState, 'agentId' | 'activeModeId' | 'allowedTools' | 'disabledTools'>,
    agent: AgentDecl,
    mode: ModeDecl
): void {
    task.agentId = agent.agentId;
    task.activeModeId = mode.id;
    task.allowedTools = mode.allowedTools;
    task.disabledTools = mode.disabledTools;
}

export async function applyStaffPermissionToTask(
    task: Pick<TaskState, 'harnessContext'>,
    options: {
        workspace: string;
        resourcesDirectory: string;
        protectedDirectory: string;
        permission: StaffPermission;
    }
): Promise<void> {
    task.harnessContext.permission = await createStaffPermissionEnforcer(options);
}

export class AgentOfficeApplication extends BaseApplication {
    private readonly staffLocks = new Map<string, Promise<void>>();
    private readonly repliedTurns = new Set<string>();
    private readonly monitoredTurns = new Set<string>();
    private readonly suppressedTurns = new Set<string>();
    private readonly invalidatedTurns = new Set<string>();
    private readonly staffAgents = new Map<string, CustomAgent>();
    private readonly staffMcpRegistrations = new Map<string, AgentMcpRegistration>();
    private readonly scheduledTaskQueues = new Map<string, Promise<void>>();
    private readonly scheduledTaskIds = new Set<string>();
    private customMcpRegistrations: AgentMcpRegistration[] = [];
    private triggerPollTimer?: ReturnType<typeof setInterval>;
    private triggerPollRunning = false;
    private schedulerRecovered = false;
    private schedulerStopping = false;

    constructor() {
        super('agentoffice', t('agentoffice.name'));
    }

    isExperimental(): boolean {
        return true;
    }

    static getWorkerClass() {
        return AgentOfficeWorker;
    }

    setRegistry(registry: any): void {
        super.setRegistry(registry);
        if (this.triggerPollTimer) return;
        this.schedulerStopping = false;
        this.schedulerRecovered = false;
        this.triggerPollTimer = setInterval(() => void this.pollScheduledTriggers(), STAFF_TRIGGER_POLL_INTERVAL_MS);
        this.triggerPollTimer.unref?.();
    }

    /**
     * 加载可派发的 Custom Agent，同时加载不进入 AgentRegistry 的 Staff Agent。
     * 两类 Agent 的 MCP 都由 MCPMgr 统一管理。
     */
    async getAgents(): Promise<AgentDecl[]> {
        await this.disposeStaffAgents();
        const agentsDirectory = path.join(getOpendeskDirectory(), 'agents');
        const agents: CustomAgent[] = [];

        if (fs.existsSync(agentsDirectory)) {
            const entries = fs.readdirSync(agentsDirectory, { withFileTypes: true });
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const agentDirectory = path.join(agentsDirectory, entry.name);
                try {
                    agents.push(await CustomAgent.loadFromPath(agentDirectory));
                } catch (error) {
                    logger.warn(`AgentOffice: failed to load custom agent from ${agentDirectory}: ${error}`);
                }
            }
        } else {
            logger.info(`AgentOffice: custom agents directory not found: ${agentsDirectory}`);
        }

        this.customMcpRegistrations = agents.map((agent) => ({
            agentId: agent.agentId,
            config: agent.mcpConfig
        }));
        await this.loadStaffAgents();
        await this.syncAgentMcpServers();
        return agents;
    }

    private async loadStaffAgents(): Promise<void> {
        let staffs: StaffListItem[];
        try {
            staffs = await this.callAgentOfficeWorker<StaffListItem[]>('listStaffs');
        } catch (error) {
            logger.warn(`AgentOffice: failed to list staff agents: ${error}`);
            return;
        }

        for (const staff of staffs) {
            if (!staff.enabled) continue;
            try {
                const agent = await this.createStaffAgent(staff.id, staff);
                this.staffAgents.set(staff.id, agent);
                this.staffMcpRegistrations.set(staff.id, {
                    agentId: agent.agentId,
                    config: agent.mcpConfig
                });
            } catch (error) {
                logger.warn(`AgentOffice: failed to load agent for staff ${staff.id}: ${error}`);
            }
        }
    }

    private createStaffAgent(staffId: string, staff: Pick<StaffListItem, 'name' | 'title'>): Promise<CustomAgent> {
        return CustomAgent.loadFromPath(path.join(this.staffDirectory(staffId), 'agent'), {
            purpose: 'staff',
            agentName: `staff:${staffId}`,
            whenToUse: `${staff.name} — ${staff.title}`,
            skillBundleName: `staff:${staffId}`
        });
    }

    private async reloadStaffAgent(
        staffId: string,
        detail: StaffDetail,
        throwOnError: boolean
    ): Promise<CustomAgent | undefined> {
        const previous = this.staffAgents.get(staffId);
        this.staffAgents.delete(staffId);
        this.staffMcpRegistrations.delete(staffId);
        await previous?.dispose();

        let agent: CustomAgent | undefined;
        let loadError: unknown;
        if (detail.enabled) {
            try {
                agent = await this.createStaffAgent(staffId, detail);
                this.staffAgents.set(staffId, agent);
                this.staffMcpRegistrations.set(staffId, {
                    agentId: agent.agentId,
                    config: agent.mcpConfig
                });
            } catch (error) {
                loadError = error;
                logger.warn(`AgentOffice: failed to reload agent for staff ${staffId}: ${error}`);
            }
        }

        await this.syncAgentMcpServers();
        if (loadError && throwOnError) {
            throw new Error(
                t('agentoffice.error.agentLoadFailed', {
                    message: loadError instanceof Error ? loadError.message : String(loadError)
                })
            );
        }
        return agent;
    }

    private async ensureStaffAgent(staffId: string, detail: StaffDetail): Promise<CustomAgent> {
        const existing = this.staffAgents.get(staffId);
        if (existing) return existing;
        const loaded = await this.reloadStaffAgent(staffId, detail, true);
        if (!loaded) {
            throw new Error(t('agentoffice.error.agentUnavailable'));
        }
        return loaded;
    }

    private async refreshStaffAgentAfterMutation(staffId: string, detail?: StaffDetail): Promise<void> {
        try {
            const current = detail ?? (await this.callAgentOfficeWorker<StaffDetail>('getStaffDetail', staffId));
            await this.reloadStaffAgent(staffId, current, false);
        } catch (error) {
            logger.warn(`AgentOffice: failed to refresh agent for staff ${staffId}: ${error}`);
        }
    }

    private async removeStaffAgent(staffId: string): Promise<void> {
        const agent = this.staffAgents.get(staffId);
        this.staffAgents.delete(staffId);
        this.staffMcpRegistrations.delete(staffId);
        await agent?.dispose();
        await this.syncAgentMcpServers();
    }

    private async disposeStaffAgents(): Promise<void> {
        const agents = [...this.staffAgents.values()];
        this.staffAgents.clear();
        this.staffMcpRegistrations.clear();
        await Promise.allSettled(agents.map(async (agent) => await agent.dispose()));
    }

    private async syncAgentMcpServers(): Promise<void> {
        const mcpMgr = this.registry?.getApplication?.('mcpmgr') as McpMgrApplication | undefined;
        const registrations = [...this.customMcpRegistrations, ...this.staffMcpRegistrations.values()];
        if (mcpMgr) {
            try {
                await mcpMgr.replaceAgentServers(registrations);
            } catch (error) {
                logger.warn(`AgentOffice: failed to register agent MCP servers: ${error}`);
            }
        } else if (registrations.length > 0) {
            logger.warn('AgentOffice: MCPMgr is unavailable; agent MCP servers were not registered');
        }
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            { eventName: 'staffsChanged', eventDescription: t('agentoffice.event.staffsChanged') },
            { eventName: 'messagesChanged', eventDescription: t('agentoffice.event.messagesChanged') },
            { eventName: 'staffTaskChanged', eventDescription: t('agentoffice.event.staffTaskChanged') }
        ];
    }

    async beforeExit(): Promise<void> {
        this.schedulerStopping = true;
        if (this.triggerPollTimer) clearInterval(this.triggerPollTimer);
        this.triggerPollTimer = undefined;
        await this.disposeStaffAgents();
    }

    getProtocolHandlers(): ProtocolHandlerConfig[] {
        return [
            {
                scheme: AGENTOFFICE_SCHEME,
                privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
                handler: (request) => this.handleResourceRequest(request)
            }
        ];
    }

    getLocale(): string {
        return getLocale();
    }

    getLocalizedStrings(): Record<string, string> {
        const keys = [
            'agentoffice.tab.office',
            'agentoffice.tab.management',
            'agentoffice.searchStaff',
            'agentoffice.noStaff',
            'agentoffice.noStaffHint',
            'agentoffice.selectStaff',
            'agentoffice.noMessages',
            'agentoffice.messagePlaceholder',
            'agentoffice.send',
            'agentoffice.attach',
            'agentoffice.running',
            'agentoffice.disabled',
            'agentoffice.enabled',
            'agentoffice.newStaff',
            'agentoffice.importZip',
            'agentoffice.exportZip',
            'agentoffice.openStaffDirectory',
            'agentoffice.delete',
            'agentoffice.save',
            'agentoffice.cancel',
            'agentoffice.basic',
            'agentoffice.skills',
            'agentoffice.mcp',
            'agentoffice.security',
            'agentoffice.tasks',
            'agentoffice.nameLabel',
            'agentoffice.vendorLabel',
            'agentoffice.titleLabel',
            'agentoffice.specialtiesLabel',
            'agentoffice.instructionsLabel',
            'agentoffice.networkAccess',
            'agentoffice.directories',
            'agentoffice.addDirectory',
            'agentoffice.directoryPath',
            'agentoffice.directoryAccess',
            'agentoffice.removeDirectory',
            'agentoffice.noDirectories',
            'agentoffice.readOnly',
            'agentoffice.readWrite',
            'agentoffice.messagesStat',
            'agentoffice.tasksStat',
            'agentoffice.tokensStat',
            'agentoffice.hiredAt',
            'agentoffice.moveToTrash',
            'agentoffice.deletePermanently',
            'agentoffice.deleteWarning',
            'agentoffice.mcpExportWarning',
            'agentoffice.loading',
            'agentoffice.loadFailed',
            'agentoffice.operationFailed',
            'agentoffice.newStaffHint',
            'agentoffice.noTasks',
            'agentoffice.openTask',
            'agentoffice.noSkills',
            'agentoffice.back',
            'agentoffice.close',
            'agentoffice.copy',
            'agentoffice.copyPlain',
            'agentoffice.addSkill',
            'agentoffice.addSkillFromDirectory',
            'agentoffice.addSkillFromDirectoryHint',
            'agentoffice.addSkillFromZip',
            'agentoffice.addSkillFromZipHint',
            'agentoffice.batchImportSkills',
            'agentoffice.batchImportSkillsHint',
            'agentoffice.batchImportSelectHint',
            'agentoffice.batchImportComplete',
            'agentoffice.batchImportSummary',
            'agentoffice.noBatchSkillsFound',
            'agentoffice.skillSourceDirectory',
            'agentoffice.skillSourceZip',
            'agentoffice.addSkillFromUrl',
            'agentoffice.addSkillFromUrlHint',
            'agentoffice.skillUrlLabel',
            'agentoffice.skillUrlInvalid',
            'agentoffice.addInstalledSkills',
            'agentoffice.addInstalledSkillsHint',
            'agentoffice.addSelectedSkills',
            'agentoffice.skillAlreadyAdded',
            'agentoffice.noInstalledSkills',
            'agentoffice.skillIntroduction',
            'agentoffice.skillContent',
            'agentoffice.skillMetadata',
            'agentoffice.skillDirectory',
            'agentoffice.skillLicense',
            'agentoffice.skillCompatibility',
            'agentoffice.skillAllowedTools',
            'agentoffice.mcpJsonHint',
            'agentoffice.portrait',
            'agentoffice.changePortrait',
            'agentoffice.portraitEditorTitle',
            'agentoffice.portraitEditorHint',
            'agentoffice.portraitCropArea',
            'agentoffice.portraitChooseHint',
            'agentoffice.choosePortrait',
            'agentoffice.portraitZoom',
            'agentoffice.portraitFormatHint',
            'agentoffice.savePortrait',
            'agentoffice.portraitFileInvalid',
            'agentoffice.portraitFileTooLarge',
            'agentoffice.portraitLoadFailed',
            'agentoffice.enableStaff',
            'agentoffice.modelLabel',
            'agentoffice.modelGlobalDefault',
            'agentoffice.modelHint',
            'agentoffice.triggerIntervalLabel',
            'agentoffice.triggerIntervalHint',
            'agentoffice.triggerInterval.5m',
            'agentoffice.triggerInterval.10m',
            'agentoffice.triggerInterval.15m',
            'agentoffice.triggerInterval.30m',
            'agentoffice.triggerInterval.1h',
            'agentoffice.triggerInterval.never',
            'agentoffice.loadOlder',
            'agentoffice.mcpServersArray',
            'agentoffice.requiredFields',
            'agentoffice.fieldRequired',
            'agentoffice.optional',
            'agentoffice.mcpInvalidJson',
            'agentoffice.autoSaveSaving',
            'agentoffice.autoSaveSaved',
            'agentoffice.autoSaveInvalid',
            'agentoffice.autoSaveFailed',
            'agentoffice.taskStatus.waiting',
            'agentoffice.taskStatus.running',
            'agentoffice.taskStatus.stopped',
            'agentoffice.taskStatus.failed',
            'agentoffice.taskSource.user',
            'agentoffice.taskSource.scheduled',
            'agentoffice.ctrlEnterSend',
            'agentoffice.sendOptions'
        ];
        return Object.fromEntries(keys.map((key) => [key, t(key)]));
    }

    listStaffs() {
        return this.callAgentOfficeWorker('listStaffs');
    }

    getStaffDetail(staffId: string) {
        return this.callAgentOfficeWorker('getStaffDetail', staffId);
    }

    getHistoryMessagesForUI(staffId: string, query: HistoryQuery) {
        return this.callAgentOfficeWorker('getHistory', staffId, query);
    }

    listChatModels() {
        const data = Setting.getInstance().getData();
        return {
            default_model: data.default_model,
            models: data.models
                .filter((model) => model.model_type === 'chat')
                .map((model) => ({
                    alias: model.alias,
                    provider_name: model.provider_name,
                    model_name: model.model_name
                }))
        };
    }

    async createStaff(definition: StaffDefinitionInput) {
        const detail = await this.callAgentOfficeWorker<StaffDetail>(
            'createStaff',
            definition,
            t('agentoffice.defaultAgentsMd')
        );
        await this.refreshStaffAgentAfterMutation(detail.id, detail);
        return detail;
    }

    async updateStaff(staffId: string, input: StaffUpdateInput) {
        return await this.withStaffLock(staffId, async () => await this.updateStaffLocked(staffId, input));
    }

    private async updateStaffLocked(staffId: string, input: StaffUpdateInput) {
        if (input.enabled === false) await this.stopActiveStaffTasks(staffId);
        if (input.portrait_path && path.extname(input.portrait_path).toLowerCase() !== '.png') {
            throw new Error(t('agentoffice.error.portraitPngOnly'));
        }
        if (input.portrait_data_uri && input.portrait_data_uri.length > PORTRAIT_DATA_URI_MAX_LENGTH) {
            throw new Error(t('agentoffice.portraitFileTooLarge'));
        }
        if (input.portrait_data_uri && !/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(input.portrait_data_uri)) {
            throw new Error(t('agentoffice.error.portraitPngOnly'));
        }
        const detail = await this.callAgentOfficeWorker<StaffDetail>('updateStaff', staffId, input);
        if (
            input.definition !== undefined ||
            input.agents_md !== undefined ||
            input.mcp !== undefined ||
            input.enabled !== undefined
        ) {
            await this.refreshStaffAgentAfterMutation(staffId, detail);
        }
        return detail;
    }

    async importStaff(zipPath: string) {
        const detail = await this.callAgentOfficeWorker<StaffDetail>('importStaff', zipPath);
        await this.refreshStaffAgentAfterMutation(detail.id, detail);
        return detail;
    }

    exportStaff(staffId: string, zipPath: string) {
        return this.callAgentOfficeWorker('exportStaff', staffId, zipPath);
    }

    async openStaffDirectory(staffId: string): Promise<void> {
        await getPlatform().openPath(this.staffDirectory(staffId));
    }

    listSkills(staffId: string) {
        return this.callAgentOfficeWorker('listSkills', staffId);
    }

    async addSkill(staffId: string, sourcePath: string) {
        const added = await this.callAgentOfficeWorker<{ name: string }>('addSkill', staffId, sourcePath);
        await this.refreshStaffAgentAfterMutation(staffId);
        return added;
    }

    scanSkillSources(rootDirectory: string): Promise<StaffSkillImportCandidate[]> {
        return this.callAgentOfficeWorker('scanSkillSources', rootDirectory);
    }

    async addSkillSources(staffId: string, sourcePaths: string[]): Promise<StaffSkillBatchImportResult> {
        const result: StaffSkillBatchImportResult = { added: [], errors: [] };
        for (const sourcePath of [...new Set(sourcePaths)]) {
            try {
                const added = await this.callAgentOfficeWorker<{ name: string }>('addSkill', staffId, sourcePath);
                result.added.push({ path: sourcePath, name: added.name });
            } catch (error) {
                result.errors.push({
                    path: sourcePath,
                    message: error instanceof Error ? error.message : String(error)
                });
            }
        }
        if (result.added.length > 0) await this.refreshStaffAgentAfterMutation(staffId);
        return result;
    }

    async addSkillFromUrl(staffId: string, sourceUrl: string): Promise<{ name: string }> {
        let url: URL;
        try {
            url = new URL(sourceUrl.trim());
        } catch {
            throw new Error(t('agentoffice.error.skillUrlInvalid'));
        }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error(t('agentoffice.error.skillUrlInvalid'));

        const temporaryDirectory = fs.mkdtempSync(path.join(getTempDir(), 'agentoffice-skill-download-'));
        try {
            const response = await getPlatform().fetch(url, { redirect: 'follow' });
            if (!response.ok) {
                throw new Error(t('agentoffice.error.skillDownloadFailed', { status: String(response.status) }));
            }
            const declaredSize = Number(response.headers.get('content-length') || 0);
            if (Number.isFinite(declaredSize) && declaredSize > SKILL_DOWNLOAD_MAX_BYTES) {
                throw new Error(t('agentoffice.error.skillDownloadTooLarge'));
            }
            const archive = Buffer.from(await response.arrayBuffer());
            if (archive.byteLength > SKILL_DOWNLOAD_MAX_BYTES) {
                throw new Error(t('agentoffice.error.skillDownloadTooLarge'));
            }
            const archivePath = path.join(temporaryDirectory, 'skill.zip');
            fs.writeFileSync(archivePath, archive);
            const added = await this.callAgentOfficeWorker<{ name: string }>('addSkill', staffId, archivePath);
            await this.refreshStaffAgentAfterMutation(staffId);
            return added;
        } finally {
            fs.rmSync(temporaryDirectory, { recursive: true, force: true });
        }
    }

    async listInstalledSkills(staffId: string): Promise<InstalledSkillSummary[]> {
        const staffSkills = await this.callAgentOfficeWorker<Array<{ directory_name: string }>>('listSkills', staffId);
        const added = new Set(staffSkills.map((skill) => skill.directory_name));
        return SkillRegistry.listSkills().flatMap((skill) => {
            const installed = SkillRegistry.getSkillBody(skill.id);
            if (!installed?.skillDir) return [];
            const directoryName = path.basename(installed.skillDir);
            return [
                {
                    id: skill.id,
                    name: skill.name,
                    description: skill.description,
                    directory_name: directoryName,
                    already_added: added.has(directoryName)
                }
            ];
        });
    }

    async addInstalledSkills(staffId: string, skillIds: string[]): Promise<StaffSkillBatchImportResult> {
        const sourcePaths: string[] = [];
        const unavailable: StaffSkillBatchImportResult['errors'] = [];
        for (const skillId of [...new Set(skillIds)]) {
            const installed = SkillRegistry.getSkillBody(skillId);
            if (!installed?.skillDir) {
                unavailable.push({ path: skillId, message: t('agentoffice.error.installedSkillUnavailable') });
            } else {
                sourcePaths.push(installed.skillDir);
            }
        }
        const result = await this.addSkillSources(staffId, sourcePaths);
        result.errors.push(...unavailable);
        return result;
    }

    async deleteSkill(staffId: string, name: string) {
        const result = await this.callAgentOfficeWorker('deleteSkill', staffId, name);
        await this.refreshStaffAgentAfterMutation(staffId);
        return result;
    }

    async deleteStaff(staffId: string, mode: 'trash' | 'permanent'): Promise<void> {
        await this.withStaffLock(staffId, async () => await this.deleteStaffLocked(staffId, mode));
    }

    private async deleteStaffLocked(staffId: string, mode: 'trash' | 'permanent'): Promise<void> {
        await this.stopActiveStaffTasks(staffId);
        if (mode === 'permanent') {
            await this.callAgentOfficeWorker('deleteStaff', staffId);
            await this.removeStaffAgent(staffId);
            return;
        }
        const directory = this.staffDirectory(staffId);
        await getPlatform().trashItem(directory);
        await this.removeStaffAgent(staffId);
        this.sendEventToSubscribers('staffsChanged');
    }

    async sendMessage(staffId: string, input: SendStaffMessageInput): Promise<{ task_id: string }> {
        return await this.withStaffLock(staffId, async () => await this.sendMessageLocked(staffId, input));
    }

    private async sendMessageLocked(staffId: string, input: SendStaffMessageInput): Promise<{ task_id: string }> {
        const detail = await this.callAgentOfficeWorker<StaffDetail>('getStaffDetail', staffId);
        if (!detail.enabled) throw new Error(t('agentoffice.error.staffDisabled'));
        this.validateMessageInput(input);

        const taskManager = GlobalState.getInstance().taskManagerState;
        const scheduledTaskInProgress = Boolean(findRunningStaffTaskBySource(detail.tasks, taskManager, 'scheduled'));
        const selection = acquireStaffTaskForMessage(detail.tasks, taskManager, taskNameFor(input), (_task, key) => {
            this.suppressedTurns.add(key);
            this.invalidatedTurns.add(key);
        });
        const { task } = selection;
        const runtime = await this.configureStaffTaskTurn(staffId, detail, task, selection.reused);
        const prepared = await this.callAgentOfficeWorker<PreparedMessage>(
            'prepareUserMessage',
            staffId,
            task.task_id,
            input.text,
            input.attachments ?? [],
            input.image_data_uris ?? []
        );

        await this.callAgentOfficeWorker('appendMessage', staffId, prepared.message);

        const record = mergeStaffTaskRecord(
            detail.tasks.find((candidate) => candidate.task_id === task.task_id),
            task,
            prepared.message.id,
            new Date().toISOString()
        );
        await this.callAgentOfficeWorker('upsertTask', staffId, record);

        try {
            const prompt = buildTaskPrompt(
                prepared.message,
                runtime.recent,
                runtime.resourcesDirectory,
                scheduledTaskInProgress
            );
            await task.submitUserMessage(prompt, prepared.image_data_uris);
            if (task.getTurnGeneration() !== runtime.expectedGeneration) {
                throw new Error(t('agentoffice.error.turnGenerationMismatch'));
            }
            if (selection.interruptedTurnKey) {
                this.invalidatedTurns.delete(selection.interruptedTurnKey);
            }
            record.status = 'running';
            record.updated_at = new Date().toISOString();
            record.usage_summary = task.usage_summary;
            await this.callAgentOfficeWorker('upsertTask', staffId, record);
        } catch (error) {
            if (task.task_status === 'running') task.stop('system');
            record.status = 'stopped';
            record.updated_at = new Date().toISOString();
            await this.callAgentOfficeWorker('upsertTask', staffId, record);
            const errorMessage = await this.callAgentOfficeWorker<StaffMessage>(
                'appendAssistantMessage',
                staffId,
                task.task_id,
                t('agentoffice.error.taskStartFailed', {
                    message: error instanceof Error ? error.message : String(error)
                }),
                [],
                'error'
            );
            await this.linkMessageToTask(staffId, task.task_id, errorMessage.id);
            throw error;
        }

        const generation = task.getTurnGeneration();
        void this.monitorTaskTurn(staffId, task, record, generation, true);
        return { task_id: task.task_id };
    }

    private async configureStaffTaskTurn(
        staffId: string,
        detail: StaffDetail,
        task: TaskState,
        reused: boolean
    ): Promise<{
        expectedGeneration: number;
        memoryPath: string;
        recent: StaffMessage[];
        resourcesDirectory: string;
    }> {
        const taskManager = GlobalState.getInstance().taskManagerState;
        applyStaffModelToTask(task, detail.model);
        const workspace = await this.callAgentOfficeWorker<string>('ensureWorkspace', staffId);
        const memoryPath = path.join(workspace, 'MEMORY.md');
        const resourcesDirectory = path.join(this.staffDirectory(staffId), 'resources');
        const agent = await this.ensureStaffAgent(staffId, detail);
        const mode = agent.supportedModes().find((candidate) => candidate.id === agent.defaultModeId());
        if (!mode) throw new Error(t('agentoffice.error.agentModeUnavailable'));
        assignStaffAgentToTask(task, agent, mode);
        if (!reused) await taskManager.initHarness(task, workspace, mode);
        await applyStaffPermissionToTask(task, {
            workspace,
            resourcesDirectory,
            protectedDirectory: path.join(this.staffDirectory(staffId), 'protected'),
            permission: detail.permission
        });
        await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id));

        const recent = (
            await this.callAgentOfficeWorker<{
                messages: StaffMessage[];
            }>('getHistory', staffId, { mode: 'recent', limit: 10 })
        ).messages;
        const expectedGeneration = task.getTurnGeneration() + 1;
        await task.attachToolset(
            createAgentOfficeTaskToolset({
                sendReply: async (text, files, taskState) => {
                    const replyTask = taskState ?? task;
                    if (replyTask.task_id !== task.task_id || replyTask.getTurnGeneration() !== expectedGeneration) {
                        throw new Error(t('agentoffice.error.staleTurnReply'));
                    }
                    const turnKey = `${replyTask.task_id}:${expectedGeneration}`;
                    if (this.invalidatedTurns.has(turnKey)) {
                        throw new Error(t('agentoffice.error.staleTurnReply'));
                    }
                    const reply = await this.callAgentOfficeWorker<StaffMessage>(
                        'appendAssistantMessage',
                        staffId,
                        replyTask.task_id,
                        text,
                        files,
                        'message'
                    );
                    await this.linkMessageToTask(staffId, replyTask.task_id, reply.id);
                    this.repliedTurns.add(turnKey);
                },
                getHistory: async (query: HistoryQuery) =>
                    await this.callAgentOfficeWorker('getHistory', staffId, query)
            })
        );
        const basePrompt = await agent.createSystemPrompt(mode, task);
        task.setSystemPrompt(
            `${basePrompt}\n\n${interpolateAgentOfficePrompt(t('agentoffice.task.systemRule'), { memoryPath })}`
        );
        await task.hooks.noticeBeforeTaskStart(task);
        return { expectedGeneration, memoryPath, recent, resourcesDirectory };
    }

    private async pollScheduledTriggers(): Promise<void> {
        if (this.triggerPollRunning || this.schedulerStopping) return;
        this.triggerPollRunning = true;
        try {
            if (!this.schedulerRecovered) {
                await this.recoverStaffTaskRecords();
                this.schedulerRecovered = true;
            }
            const now = new Date().toISOString();
            const due = await this.callAgentOfficeWorker<DueStaffTrigger[]>('claimDueTriggers', now);
            await Promise.all(
                due.map(async (trigger) => {
                    try {
                        const created = await this.createScheduledTask(trigger);
                        if (created) return;
                    } catch (error) {
                        logger.warn(
                            `[agentoffice] failed to create scheduled task for staff ${trigger.staff_id}: ${error}`
                        );
                    }
                    await this.callAgentOfficeWorker('releaseTriggerClaim', trigger);
                })
            );
        } catch (error) {
            logger.warn(`[agentoffice] failed to poll scheduled staff triggers: ${error}`);
        } finally {
            this.triggerPollRunning = false;
        }
    }

    private async createScheduledTask(trigger: DueStaffTrigger): Promise<boolean> {
        const created = await this.withStaffLock(trigger.staff_id, async () => {
            const detail = await this.callAgentOfficeWorker<StaffDetail>('getStaffDetail', trigger.staff_id);
            if (!detail.enabled || this.schedulerStopping) return undefined;
            const task = GlobalState.getInstance().taskManagerState.createTask(undefined, {
                taskName: `${t('agentoffice.taskPrefix')} ${t('agentoffice.task.scheduledName')}`,
                internal: true
            });
            const record: StaffTaskRecord = {
                task_id: task.task_id,
                message_ids: [],
                status: 'waiting',
                source: 'scheduled',
                triggered_at: trigger.triggered_at,
                created_at: trigger.triggered_at,
                updated_at: trigger.triggered_at,
                usage_summary: task.usage_summary
            };
            try {
                await this.callAgentOfficeWorker('upsertTask', trigger.staff_id, record);
            } catch (error) {
                task.stop('system');
                throw error;
            }
            return { task, record };
        });
        if (!created) return false;
        this.enqueueScheduledTask(
            trigger.staff_id,
            created.task,
            created.record,
            async () => await this.runScheduledTask(trigger.staff_id, created.task, created.record)
        );
        return true;
    }

    private enqueueScheduledTask(
        staffId: string,
        task: TaskState,
        record: StaffTaskRecord,
        operation: () => Promise<void>
    ): void {
        if (this.scheduledTaskIds.has(task.task_id)) return;
        this.scheduledTaskIds.add(task.task_id);
        const previous = this.scheduledTaskQueues.get(staffId) ?? Promise.resolve();
        const queued = previous
            .catch(() => undefined)
            .then(operation)
            .catch(async (error) => {
                logger.warn(`[agentoffice] scheduled task ${task.task_id} failed: ${error}`);
                await this.settleFailedScheduledTask(staffId, task, record);
            })
            .finally(() => {
                this.scheduledTaskIds.delete(task.task_id);
                if (this.scheduledTaskQueues.get(staffId) === queued) {
                    this.scheduledTaskQueues.delete(staffId);
                }
            });
        this.scheduledTaskQueues.set(staffId, queued);
    }

    private async recoverStaffTaskRecords(): Promise<void> {
        const staffs = await this.callAgentOfficeWorker<StaffListItem[]>('listStaffs');
        const taskManager = GlobalState.getInstance().taskManagerState;
        for (const staff of staffs) {
            const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staff.id);
            for (const record of records) {
                if (!['running', 'waiting'].includes(record.status)) continue;
                const task = taskManager.getTask(record.task_id);
                if ((record.source ?? 'user') === 'scheduled' && task?.task_status === 'waiting') {
                    this.enqueueScheduledTask(
                        staff.id,
                        task,
                        record,
                        async () => await this.runScheduledTask(staff.id, task, record)
                    );
                    continue;
                }
                if ((record.source ?? 'user') === 'scheduled' && task?.task_status === 'running') {
                    this.enqueueScheduledTask(staff.id, task, record, async () => {
                        await this.monitorTaskTurn(staff.id, task, record, task.getTurnGeneration(), false);
                    });
                    continue;
                }
                if (task?.task_status === 'running') {
                    void this.monitorTaskTurn(staff.id, task, record, task.getTurnGeneration(), false);
                    continue;
                }
                await this.callAgentOfficeWorker('upsertTask', staff.id, {
                    ...record,
                    status: task?.task_status === 'failed' ? 'failed' : 'stopped',
                    updated_at: new Date().toISOString(),
                    usage_summary: task?.usage_summary ?? record.usage_summary
                } satisfies StaffTaskRecord);
            }
        }
    }

    private async settleFailedScheduledTask(
        staffId: string,
        task: TaskState,
        fallbackRecord: StaffTaskRecord
    ): Promise<void> {
        try {
            if (task.task_status === 'running' || task.task_status === 'waiting') task.stop('system');
            const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staffId);
            const record = records.find((candidate) => candidate.task_id === task.task_id) ?? fallbackRecord;
            if (record.status === 'failed') return;
            await this.callAgentOfficeWorker('upsertTask', staffId, {
                ...record,
                status: 'failed',
                updated_at: new Date().toISOString(),
                usage_summary: task.usage_summary
            } satisfies StaffTaskRecord);
        } catch (error) {
            logger.warn(`[agentoffice] failed to settle scheduled task ${task.task_id}: ${error}`);
        }
    }

    private async runScheduledTask(staffId: string, task: TaskState, originalRecord: StaffTaskRecord): Promise<void> {
        while (!this.schedulerStopping) {
            const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staffId);
            const runningUserTask = findRunningStaffTaskBySource(
                records,
                GlobalState.getInstance().taskManagerState,
                'user'
            );
            if (runningUserTask) {
                await runningUserTask.waitUntilFinished(undefined, true);
                continue;
            }

            const started = await this.withStaffLock(staffId, async () => {
                const latestRecords = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staffId);
                const latestRunningUserTask = findRunningStaffTaskBySource(
                    latestRecords,
                    GlobalState.getInstance().taskManagerState,
                    'user'
                );
                if (latestRunningUserTask) return { waitFor: latestRunningUserTask };
                const detail = await this.callAgentOfficeWorker<StaffDetail>('getStaffDetail', staffId);
                const record = latestRecords.find((candidate) => candidate.task_id === task.task_id) ?? originalRecord;
                if (!detail.enabled || this.schedulerStopping) {
                    task.stop('system');
                    await this.callAgentOfficeWorker('upsertTask', staffId, {
                        ...record,
                        status: 'stopped',
                        updated_at: new Date().toISOString()
                    } satisfies StaffTaskRecord);
                    return { cancelled: true as const };
                }

                try {
                    const runtime = await this.configureStaffTaskTurn(staffId, detail, task, false);
                    await task.submitUserMessage(buildScheduledTaskPrompt(runtime.recent, runtime.memoryPath));
                    if (task.getTurnGeneration() !== runtime.expectedGeneration) {
                        throw new Error(t('agentoffice.error.turnGenerationMismatch'));
                    }
                    const runningRecord: StaffTaskRecord = {
                        ...record,
                        status: 'running',
                        updated_at: new Date().toISOString(),
                        usage_summary: task.usage_summary
                    };
                    await this.callAgentOfficeWorker('upsertTask', staffId, runningRecord);
                    return { runningRecord, generation: task.getTurnGeneration() };
                } catch (error) {
                    if (task.task_status === 'running' || task.task_status === 'waiting') task.stop('system');
                    await this.callAgentOfficeWorker('upsertTask', staffId, {
                        ...record,
                        status: 'failed',
                        updated_at: new Date().toISOString(),
                        usage_summary: task.usage_summary
                    } satisfies StaffTaskRecord);
                    throw error;
                }
            });

            if ('waitFor' in started) {
                await started.waitFor.waitUntilFinished(undefined, true);
                continue;
            }
            if ('cancelled' in started) return;
            await this.monitorTaskTurn(staffId, task, started.runningRecord, started.generation, false);
            return;
        }

        if (task.task_status === 'waiting') task.stop('system');
        await this.callAgentOfficeWorker('upsertTask', staffId, {
            ...originalRecord,
            status: 'stopped',
            updated_at: new Date().toISOString()
        } satisfies StaffTaskRecord);
    }

    private async monitorTaskTurn(
        staffId: string,
        task: TaskState,
        record: StaffTaskRecord,
        generation: number,
        requireReply: boolean
    ): Promise<void> {
        const turnKey = `${task.task_id}:${generation}`;
        if (this.monitoredTurns.has(turnKey)) return;
        this.monitoredTurns.add(turnKey);
        try {
            await task.waitUntilFinished(undefined, true);
            const superseded = task.getTurnGeneration() !== generation;
            const interrupted = this.suppressedTurns.delete(turnKey) || superseded;
            if (superseded) return;
            const replied = this.repliedTurns.delete(turnKey);
            if (requireReply && !interrupted && !replied) {
                const noReplyMessage = await this.callAgentOfficeWorker<StaffMessage>(
                    'appendAssistantMessage',
                    staffId,
                    task.task_id,
                    t('agentoffice.error.noReply'),
                    [],
                    'error'
                );
                await this.linkMessageToTask(staffId, task.task_id, noReplyMessage.id);
            }
            const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staffId);
            const latestRecord = records.find((candidate) => candidate.task_id === task.task_id) ?? record;
            await this.callAgentOfficeWorker('upsertTask', staffId, {
                ...latestRecord,
                status: task.task_status,
                updated_at: new Date().toISOString(),
                usage_summary: task.usage_summary
            } satisfies StaffTaskRecord);
        } catch (error) {
            logger.warn(`[agentoffice] failed to monitor task ${task.task_id}: ${error}`);
        } finally {
            this.monitoredTurns.delete(turnKey);
            this.repliedTurns.delete(turnKey);
            this.suppressedTurns.delete(turnKey);
        }
    }

    private async stopActiveStaffTasks(staffId: string): Promise<void> {
        const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staffId);
        const manager = GlobalState.getInstance().taskManagerState;
        for (const record of records) {
            const task = manager.getTask(record.task_id);
            if (!task || !['running', 'waiting'].includes(task.task_status)) continue;
            const turnKey = `${task.task_id}:${task.getTurnGeneration()}`;
            this.suppressedTurns.add(turnKey);
            this.invalidatedTurns.add(turnKey);
            task.stop('system');
            await this.callAgentOfficeWorker('upsertTask', staffId, {
                ...record,
                status: 'stopped',
                updated_at: new Date().toISOString(),
                usage_summary: task.usage_summary
            } satisfies StaffTaskRecord);
        }
    }

    private async linkMessageToTask(staffId: string, taskId: string, messageId: string): Promise<void> {
        const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staffId);
        const record = records.find((candidate) => candidate.task_id === taskId);
        if (!record || record.message_ids.includes(messageId)) return;
        await this.callAgentOfficeWorker('upsertTask', staffId, {
            ...record,
            message_ids: [...record.message_ids, messageId],
            updated_at: new Date().toISOString()
        } satisfies StaffTaskRecord);
    }

    private async withStaffLock<T>(staffId: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.staffLocks.get(staffId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>((resolve) => {
            release = resolve;
        });
        const tail = previous.catch(() => undefined).then(() => current);
        this.staffLocks.set(staffId, tail);
        await previous.catch(() => undefined);
        try {
            return await operation();
        } finally {
            release();
            if (this.staffLocks.get(staffId) === tail) this.staffLocks.delete(staffId);
        }
    }

    private async callAgentOfficeWorker<T>(methodName: string, ...args: unknown[]): Promise<T> {
        return unwrapAgentOfficeCallResult<T>(
            await this.callWorker(methodName, ...args),
            t('agentoffice.operationFailed')
        );
    }

    private validateMessageInput(input: SendStaffMessageInput): void {
        if (!input.text?.trim() && !input.attachments?.length && !input.image_data_uris?.length) {
            throw new Error(t('agentoffice.error.messageRequired'));
        }
        for (const attachment of input.attachments ?? []) {
            if (!fs.existsSync(attachment.path) || !fs.statSync(attachment.path).isFile()) {
                throw new Error(t('agentoffice.error.attachmentMustBeFile'));
            }
        }
        for (const dataUri of input.image_data_uris ?? []) {
            if (!/^data:image\/[^;,]+;base64,/i.test(dataUri)) {
                throw new Error(t('agentoffice.error.imageDataUriOnly'));
            }
        }
    }

    private staffDirectory(staffId: string): string {
        if (!/^[0-9a-f-]{36}$/i.test(staffId)) throw new Error(t('agentoffice.error.invalidStaffId'));
        return path.join(this.getDataDirectory(), 'staffs', staffId);
    }

    private handleResourceRequest(request: { url: string }): Response {
        try {
            const url = new URL(request.url);
            if (url.hostname !== 'resource') return new Response('Not found', { status: 404 });
            const parts = url.pathname
                .split('/')
                .filter(Boolean)
                .map((part) => decodeURIComponent(part));
            const staffId = parts.shift();
            if (!staffId) return new Response('Not found', { status: 404 });
            const staffDirectory = this.staffDirectory(staffId);
            const requested = parts.join('/');
            const portraitRequest = requested === 'portrait';
            if (!portraitRequest && !requested.startsWith('resources/')) {
                return new Response('Not found', { status: 404 });
            }
            const filePath = portraitRequest
                ? path.join(staffDirectory, 'agent', 'portrait.png')
                : path.join(staffDirectory, requested);
            const allowedRoot = portraitRequest
                ? path.join(staffDirectory, 'agent')
                : path.join(staffDirectory, 'resources');
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(`${path.resolve(allowedRoot)}${path.sep}`)) {
                return new Response('Forbidden', { status: 403 });
            }
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                return new Response('Not found', { status: 404 });
            }
            return new Response(fs.readFileSync(resolved), {
                headers: { 'content-type': mimeTypeFor(resolved), 'cache-control': 'no-store' }
            });
        } catch {
            return new Response('Bad request', { status: 400 });
        }
    }
}
