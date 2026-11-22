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
import os from 'os';
import path from 'path';
import { BaseApplication, type EventDecl, type ProtocolHandlerConfig } from '../base.js';
import { GlobalState } from '../../aikernel/states/global.js';
import type { TaskManagerState, TaskState } from '../../aikernel/states/tasks.js';
import { getPlatform } from '../../../platforms/base.js';
import { getLocale } from '../../../locale/index.js';
import { t as appT } from './locale/index.js';
import { logger } from '../../utils/logger.js';
import {
    getOpendeskDirectory,
    getTaskArtifactDirectory,
    getTaskDirectory,
    getArtifactDirectory,
    Setting
} from '../../utils/setting.js';
import { getTempDir } from '../../utils/temp.js';
import { createAgentOfficeTaskToolset } from './tools.js';
import { createStaffPermissionEnforcer } from './permission.js';
import { skillRegistry } from '../skillmgr/utils/skill-registry.js';
import AgentOfficeWorker from './worker.js';
import { normalizeStaffLocalService, unwrapAgentOfficeCallResult, type StaffLocalService } from './common.js';
import { StaffLocalServiceManager, type LocalServiceRuntime } from './local-service.js';
import type { StoredServiceCertificate } from './service-cert.js';
import { CustomAgent } from './custom-agent.js';
import { recordAgentOfficeStartup, type StartupPhaseStatus } from './startup-timing.js';
import type { AgentMcpRegistration, McpMgrApplication } from '../mcpmgr/app.js';
import type { AgentDecl, ModeDecl } from '../../aikernel/agents/common.js';
import { AgentRegistry } from '../../aikernel/agents/registry.js';
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
    StaffStartupInfo,
    StaffTaskSource,
    StaffTaskRecord,
    StaffUpdateInput
} from './common.js';
import { isAgentFlowEnabled } from './flow/feature.js';
import { projectFlowConversationContext, queryFlowHistory, type FlowHistorySnapshot } from './flow/context.js';
import { flowTaskExtension } from './flow/task-extension.js';
import type { FlowReadingBatch, FlowReadingClaim, FlowReadingState } from './flow/reading-common.js';
import {
    AgentFlowIdSchema,
    AgentFlowListFilterSchema,
    AgentFlowMemberIdsSchema,
    AgentFlowMessageHistoryQuerySchema,
    AgentFlowRevisionSchema,
    AgentFlowTaskIdSchema,
    CreateAgentFlowInputSchema,
    parseAgentFlowInput,
    SendAgentFlowMessageInputSchema,
    UpdateAgentFlowPatchSchema,
    type AgentFlowListFilter,
    type AgentFlowDetail,
    type AgentFlowMessage,
    type AgentFlowMessageHistoryQuery,
    type CreateAgentFlowInput,
    type PreparedAgentFlowUserMessage,
    type SendAgentFlowMessageInput,
    type UpdateAgentFlowPatch
} from './flow/common.js';
import { parseFlowMentions } from './flow/routing/mentions.js';
import { FlowReadingScheduler, FLOW_USER_DEBOUNCE_MS, type FlowReadingTarget } from './flow/scheduler.js';
import { FlowSerialQueue } from './flow/routing/queue.js';

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
    return interpolateAgentOfficePrompt(appT('agentoffice.task.prompt'), {
        resourcesDirectory,
        recent: JSON.stringify(recent, null, 2),
        current: JSON.stringify(current, null, 2),
        scheduledTaskNotice: scheduledTaskInProgress ? appT('agentoffice.task.scheduledInProgress') : ''
    });
}

function buildScheduledTaskPrompt(recent: StaffMessage[], memoryPath: string): string {
    return interpolateAgentOfficePrompt(appT('agentoffice.task.scheduledPrompt'), {
        recent: JSON.stringify(recent, null, 2),
        memoryPath
    });
}

export function buildFlowTaskPrompt(
    snapshot: FlowHistorySnapshot,
    staff: Pick<StaffDetail, 'name' | 'title' | 'specialties' | 'agents_md'>,
    unreadMessageIds: readonly string[],
    resourcesDirectory: string,
    referencedTaskContext?: FlowReferencedTaskContext
): string {
    const context = projectFlowConversationContext(snapshot, unreadMessageIds);
    const values: Record<string, string> = {
        flowName: snapshot.flow.name,
        flowGoal: snapshot.flow.goal,
        staffConfiguration: JSON.stringify({
            name: staff.name,
            title: staff.title,
            specialties: staff.specialties,
            instructions: staff.agents_md
        }),
        resourcesDirectory,
        referencedTaskContext: JSON.stringify(referencedTaskContext ?? null),
        history: JSON.stringify(context)
    };
    return appT('agentoffice.flow.task.prompt').replace(/\$\{(\w+)\}/g, (match, key: string) => values[key] ?? match);
}

export interface FlowReferencedTaskContext {
    taskFilePath: string;
    artifactsDirectory: string;
}

export function getFlowReferencedTaskContext(message?: AgentFlowMessage): FlowReferencedTaskContext | undefined {
    if (!message?.taskId) return undefined;
    return {
        taskFilePath: path.join(getTaskDirectory(), `${message.taskId}.json`),
        artifactsDirectory: getTaskArtifactDirectory(message.taskId, false)
    };
}

export function createFlowReplyHandler(options: {
    flowId: string;
    staffId: string;
    task: Pick<TaskState, 'task_id' | 'getTurnGeneration'>;
    expectedGeneration: number;
    visibleMessages?: readonly AgentFlowMessage[];
    isInvalidated: (turnKey: string) => boolean;
    recordReply: (
        flowId: string,
        staffId: string,
        taskId: string,
        text: string | undefined,
        files: string[],
        replyToMessageId?: string
    ) => Promise<string>;
    markReplied: (turnKey: string, messageId: string) => void;
}): (text: string | undefined, files: string[], taskState?: TaskState, replyTo?: string) => Promise<void> {
    return async (text, files, taskState, replyTo) => {
        const replyTask = taskState ?? options.task;
        if (
            replyTask.task_id !== options.task.task_id ||
            replyTask.getTurnGeneration() !== options.expectedGeneration
        ) {
            throw new Error(appT('agentoffice.error.staleTurnReply'));
        }
        const turnKey = `${replyTask.task_id}:${options.expectedGeneration}`;
        if (options.isInvalidated(turnKey)) throw new Error(appT('agentoffice.error.staleTurnReply'));
        const referenced =
            replyTo === undefined
                ? undefined
                : options.visibleMessages?.find(
                      (message) =>
                          message.flowId === options.flowId &&
                          message.sequence !== undefined &&
                          `m${message.sequence}` === replyTo
                  );
        if (replyTo !== undefined && !referenced) {
            throw new Error(appT('agentoffice.flow.error.invalidReplyReference'));
        }
        const messageId = await options.recordReply(
            options.flowId,
            options.staffId,
            replyTask.task_id,
            text,
            files,
            referenced?.id
        );
        options.markReplied(turnKey, messageId);
    };
}

function taskNameFor(input: SendStaffMessageInput): string {
    const text = input.text?.trim();
    const fallback = input.attachments
        ?.map((attachment) => attachment.name || path.basename(attachment.path))
        .join(', ');
    return `${appT('agentoffice.taskPrefix')} ${text || fallback || appT('agentoffice.attachmentMessage')}`;
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
        additionalReadDirectories?: string[];
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
    private readonly deletedFlowTaskIds = new Set<string>();
    private readonly staffAgents = new Map<string, CustomAgent>();
    private readonly staffMcpRegistrations = new Map<string, AgentMcpRegistration>();
    private readonly scheduledTaskQueues = new Map<string, Promise<void>>();
    private readonly scheduledTaskIds = new Set<string>();
    private readonly flowQueue = new FlowSerialQueue();
    private flowRecoveryPromise?: Promise<void>;
    private flowReadingScheduler?: FlowReadingScheduler;
    private flowReadingTimer?: ReturnType<typeof setInterval>;
    private flowUserWakeTimer?: ReturnType<typeof setTimeout>;
    private customMcpRegistrations: AgentMcpRegistration[] = [];
    private triggerPollTimer?: ReturnType<typeof setInterval>;
    private triggerPollRunning = false;
    private schedulerRecovered = false;
    private schedulerStopping = false;
    private localService?: StaffLocalServiceManager;
    private localServiceRestoreDone = false;
    private localServiceRestoreTimer?: ReturnType<typeof setTimeout>;

    constructor() {
        super('agentoffice');
    }

    getName(): string {
        return appT('app.name');
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
        if (isAgentFlowEnabled()) {
            this.flowReadingScheduler = new FlowReadingScheduler({
                now: () => Date.now(),
                targets: async (now) => {
                    await this.ensureFlowReadingRecovered();
                    return this.callAgentOfficeWorker<FlowReadingTarget[]>('collectFlowReadingTargets', now);
                },
                start: async (target, trigger) =>
                    (await this.startFlowReading(target.flowId, target.staffId, trigger)).status,
                error: (target, error) =>
                    logger.warn(`[agentoffice] group reading ${target?.flowId ?? 'poll'}: ${String(error)}`)
            });
            this.flowReadingTimer = setInterval(() => void this.flowReadingScheduler?.tick(), 1000);
            this.flowReadingTimer.unref?.();
        }
        // 应用注册即恢复已开启的本地网络服务，无需等用户打开办公室界面
        void this.restoreLocalServices();
    }

    /**
     * 加载用户 Custom Agent 和 Staff Agent。两类 Agent 都进入 AgentRegistry，
     * Staff 通过 dispatchable=false 避免被主 Agent 派发。
     */
    async getAgents(): Promise<AgentDecl[]> {
        const startedAt = performance.now();
        let ready = false;
        let agentCount = 0;
        try {
            await this.disposeStaffAgents();
            const agentsDirectory = path.join(getOpendeskDirectory(), 'agents');
            const agents: CustomAgent[] = [];

            if (fs.existsSync(agentsDirectory)) {
                const entries = fs.readdirSync(agentsDirectory, { withFileTypes: true });
                // 自定义 agent 目录彼此独立，并行加载避免数量多时串行磁盘 IO 拖慢启动
                const loaded = await Promise.all(
                    entries
                        .filter((entry) => entry.isDirectory())
                        .map(async (entry) => {
                            const agentDirectory = path.join(agentsDirectory, entry.name);
                            try {
                                return await CustomAgent.loadFromPath(agentDirectory, {
                                    applicationBundleName: this.bundleName
                                });
                            } catch (error) {
                                logger.warn(
                                    `AgentOffice: failed to load custom agent from ${agentDirectory}: ${error}`
                                );
                                return undefined;
                            }
                        })
                );
                agents.push(...loaded.filter((agent): agent is CustomAgent => Boolean(agent)));
            } else {
                logger.info(`AgentOffice: custom agents directory not found: ${agentsDirectory}`);
            }

            this.customMcpRegistrations = agents.map((agent) => ({
                agentId: agent.agentId,
                config: agent.mcpConfig
            }));
            await this.loadStaffAgents();
            const mcpStartedAt = performance.now();
            let mcpReady = false;
            try {
                mcpReady = await this.syncAgentMcpServers();
            } finally {
                recordAgentOfficeStartup('agents.mcp', mcpStartedAt, mcpReady ? 'ready' : 'failed');
            }
            const result = [...agents, ...this.staffAgents.values()];
            agentCount = result.length;
            ready = true;
            return result;
        } finally {
            recordAgentOfficeStartup('agents.construct', startedAt, ready ? 'ready' : 'failed', {
                agents: agentCount
            });
        }
    }

    private agentsLoadedPromise?: Promise<void>;

    async ensureLoaded(): Promise<void> {
        if (this.agentsLoadedPromise) return this.agentsLoadedPromise;
        this.agentsLoadedPromise = this.doEnsureLoaded();
        return this.agentsLoadedPromise;
    }

    private async doEnsureLoaded(): Promise<void> {
        try {
            const agents = await this.getAgents();
            const registrationStartedAt = performance.now();
            let registered = 0;
            try {
                for (const agent of agents) {
                    await AgentRegistry.replaceApplicationAgent(this.bundleName, agent);
                    registered++;
                }
            } finally {
                recordAgentOfficeStartup(
                    'agents.register',
                    registrationStartedAt,
                    registered === agents.length ? 'ready' : 'failed',
                    { registered, agents: agents.length }
                );
            }
            if (agents.length > 0) {
                logger.info(`AgentRegistry: registered ${agents.length} agent(s) from agentoffice (lazy)`);
            }
        } catch (error) {
            logger.error(`AgentOffice: ensureLoaded failed: ${error}`);
        }
    }

    private async loadStaffAgents(): Promise<void> {
        const listStartedAt = performance.now();
        let staffs: StaffStartupInfo[] = [];
        let listed = false;
        try {
            staffs = await this.callAgentOfficeWorker<StaffStartupInfo[]>('listStaffStartupInfo');
            listed = true;
        } catch (error) {
            logger.warn(`AgentOffice: failed to list staff agents: ${error}`);
            return;
        } finally {
            recordAgentOfficeStartup('staff.metadata', listStartedAt, listed ? 'ready' : 'failed', {
                staffs: staffs.length
            });
        }

        // staff agent 互不依赖，并行构建，避免 staff 多时逐个读取磁盘
        const tasks: Promise<void>[] = [];
        const constructionStartedAt = performance.now();
        let failed = 0;
        for (const staff of staffs) {
            if (!staff.enabled) continue;
            tasks.push(
                (async () => {
                    try {
                        const agent = await this.createStaffAgent(staff.id, staff);
                        // 初始加载期间该 staff 可能已被 reloadStaffAgent 刷新：丢弃本次结果。
                        // SkillProvider 注册发生在构造函数中，落败实例的后构造可能已覆盖胜者的
                        // 同名注册，故先 dispose 落败实例（registry 按实例身份注销，非当前注册者
                        // 时为 no-op），再由胜者重新断言注册，保证两种构造次序都收敛到胜者。
                        const current = this.staffAgents.get(staff.id);
                        if (current) {
                            await agent.dispose();
                            current.reassertSkillProviderRegistration();
                            return;
                        }
                        this.staffAgents.set(staff.id, agent);
                        this.staffMcpRegistrations.set(staff.id, {
                            agentId: agent.agentId,
                            config: agent.mcpConfig
                        });
                    } catch (error) {
                        failed++;
                        logger.warn(`AgentOffice: failed to load agent for staff ${staff.id}: ${error}`);
                    }
                })()
            );
        }
        await Promise.all(tasks);
        recordAgentOfficeStartup('staff.construct', constructionStartedAt, failed ? 'partial' : 'ready', {
            attempted: tasks.length,
            loaded: this.staffAgents.size,
            failed
        });
    }

    private createStaffAgent(staffId: string, staff: Pick<StaffListItem, 'name' | 'title'>): Promise<CustomAgent> {
        return CustomAgent.loadFromPath(path.join(this.staffDirectory(staffId), 'agent'), {
            applicationBundleName: this.bundleName,
            purpose: 'staff',
            agentName: `staff:${staffId}`,
            whenToUse: `${staff.name} — ${staff.title}`,
            skillBundleName: `staff:${staffId}`,
            additionalSystemPrompt: (taskContext) => {
                const task = GlobalState.getInstance().taskManagerState.getTask(taskContext.task_id);
                if (task && flowTaskExtension(task).state) return appT('agentoffice.flow.task.systemRule');
                return interpolateAgentOfficePrompt(appT('agentoffice.task.systemRule'), {
                    memoryPath: path.join(taskContext.getWorkspace(), 'MEMORY.md')
                });
            }
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
        if (agent) {
            await AgentRegistry.replaceApplicationAgent(this.bundleName, agent);
        } else {
            await AgentRegistry.removeApplicationAgent(this.bundleName, `staff:${staffId}`);
        }
        if (loadError && throwOnError) {
            throw new Error(
                appT('agentoffice.error.agentLoadFailed', {
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
            throw new Error(appT('agentoffice.error.agentUnavailable'));
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
        await AgentRegistry.removeApplicationAgent(this.bundleName, `staff:${staffId}`);
        await this.syncAgentMcpServers();
    }

    private async disposeStaffAgents(): Promise<void> {
        const agents = [...this.staffAgents.values()];
        this.staffAgents.clear();
        this.staffMcpRegistrations.clear();
        await Promise.allSettled(agents.map(async (agent) => await agent.dispose()));
    }

    private async syncAgentMcpServers(): Promise<boolean> {
        const mcpMgr = this.registry?.getApplication?.('mcpmgr') as McpMgrApplication | undefined;
        const registrations = [...this.customMcpRegistrations, ...this.staffMcpRegistrations.values()];
        if (mcpMgr) {
            try {
                await mcpMgr.replaceAgentServers(registrations);
                return true;
            } catch (error) {
                logger.warn(`AgentOffice: failed to register agent MCP servers: ${error}`);
                return false;
            }
        } else if (registrations.length > 0) {
            logger.warn('AgentOffice: MCPMgr is unavailable; agent MCP servers were not registered');
            return false;
        }
        return true;
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        const events = [
            { eventName: 'staffsChanged', eventDescription: appT('agentoffice.event.staffsChanged') },
            { eventName: 'messagesChanged', eventDescription: appT('agentoffice.event.messagesChanged') },
            { eventName: 'staffTaskChanged', eventDescription: appT('agentoffice.event.staffTaskChanged') },
            { eventName: 'localServiceChanged', eventDescription: appT('agentoffice.event.localServiceChanged') }
        ];
        if (isAgentFlowEnabled()) {
            events.push({ eventName: 'flowsChanged', eventDescription: appT('agentoffice.flow.event.changed') });
            events.push({ eventName: 'flowReadingChanged', eventDescription: appT('agentoffice.flow.reading.event') });
            events.push({
                eventName: 'flowMessagesChanged',
                eventDescription: appT('agentoffice.flow.event.messagesChanged')
            });
        }
        return events;
    }

    async beforeExit(): Promise<void> {
        this.schedulerStopping = true;
        this.flowReadingScheduler?.stop();
        if (this.flowReadingTimer) clearInterval(this.flowReadingTimer);
        if (this.flowUserWakeTimer) clearTimeout(this.flowUserWakeTimer);
        this.flowReadingTimer = undefined;
        this.flowUserWakeTimer = undefined;
        if (this.triggerPollTimer) clearInterval(this.triggerPollTimer);
        this.triggerPollTimer = undefined;
        if (this.localServiceRestoreTimer) clearTimeout(this.localServiceRestoreTimer);
        this.localServiceRestoreTimer = undefined;
        await this.getLocalService().stopAll();
        await this.disposeStaffAgents();
    }

    /**
     * 主进程事件出口：registry 会把 worker 事件路由到这里，办公室 UI 的订阅也走这里。
     * 本地网络服务借同一入口感知消息/员工变化，向网页客户端推送 SSE。
     */
    override sendEventToSubscribers(eventName: string, ...args: unknown[]): void {
        super.sendEventToSubscribers(eventName, ...args);
        if (eventName === 'messagesChanged') {
            this.getLocalService().notifyMessagesChanged(String(args[0] ?? ''));
        } else if (eventName === 'staffsChanged') {
            void this.getLocalService().notifyStaffsChanged();
        }
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
            'agentoffice.messagePlaceholder.ctrlEnter',
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
            'agentoffice.deleteMessage',
            'agentoffice.deleteMessagePart.text',
            'agentoffice.deleteMessagePart.image',
            'agentoffice.deleteMessagePart.video',
            'agentoffice.deleteMessagePart.audio',
            'agentoffice.deleteMessagePart.file',
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
            'agentoffice.localService',
            'agentoffice.localServiceHint',
            'agentoffice.localServiceAddress',
            'agentoffice.localServicePort',
            'agentoffice.localServiceRunning',
            'agentoffice.localServiceStopped',
            'agentoffice.localServiceCopy',
            'agentoffice.localServiceCopied',
            'agentoffice.localServicePortInvalid',
            'agentoffice.localServiceLocalhost',
            'agentoffice.localServiceHttps',
            'agentoffice.localServiceHttpsHint',
            'agentoffice.localServiceAllowIframe',
            'agentoffice.localServiceAllowIframeHint',
            'agentoffice.localServiceChatUrl',
            'agentoffice.localServiceManageUrl',
            'agentoffice.localServiceUserToken',
            'agentoffice.localServiceManageToken',
            'agentoffice.localServiceUserTokenHint',
            'agentoffice.localServiceTokenGenerate',
            'agentoffice.localServiceManageTokenRequired',
            'agentoffice.localServiceHideStaffInfo',
            'agentoffice.localServiceHideStaffInfoHint',
            'agentoffice.openInBrowser',
            'agentoffice.localServiceApplying',
            'agentoffice.modelLabel',
            'agentoffice.modelGlobalDefault',
            'agentoffice.modelHint',
            'agentoffice.modelShort',
            'agentoffice.metaSkills',
            'agentoffice.onboardDays',
            'agentoffice.staffPanelTitle',
            'agentoffice.allStaff',
            'agentoffice.staffPanelFooter',
            'agentoffice.statsSection',
            'agentoffice.profileSection',
            'agentoffice.you',
            'agentoffice.noStaffFound',
            'agentoffice.enableStaffHint',
            'agentoffice.networkAccessHint',
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
            'agentoffice.sendOptions',
            'agentoffice.flow.reading.event',
            'agentoffice.flow.reading.loading',
            'agentoffice.flow.reading.count',
            'agentoffice.flow.reading.denominator',
            'agentoffice.flow.reading.unread',
            'agentoffice.flow.reading.reading',
            'agentoffice.flow.reading.read',
            'agentoffice.flow.reading.failed',
            'agentoffice.flow.reading.active',
            'agentoffice.flow.reading.disabled',
            'agentoffice.flow.reading.missing',
            'agentoffice.flow.reading.left',
            'agentoffice.flow.reading.settings',
            'agentoffice.flow.reading.immediate',
            'agentoffice.flow.reading.aligned',
            'agentoffice.flow.reading.period',
            'agentoffice.flow.reading.minutes',
            'agentoffice.flow.reading.next',
            'agentoffice.flow.reading.noTimer',
            'agentoffice.flow.reading.retry',
            'agentoffice.flow.reading.retryHint',
            'agentoffice.flow.reading.busy',
            'agentoffice.flow.tab',
            'agentoffice.flow.search',
            'agentoffice.flow.filterStatus',
            'agentoffice.flow.filter.active',
            'agentoffice.flow.filter.paused',
            'agentoffice.flow.filter.archived',
            'agentoffice.flow.filter.all',
            'agentoffice.flow.status.active',
            'agentoffice.flow.status.paused',
            'agentoffice.flow.status.archived',
            'agentoffice.flow.empty',
            'agentoffice.flow.new',
            'agentoffice.flow.newHint',
            'agentoffice.flow.name',
            'agentoffice.flow.goal',
            'agentoffice.flow.members',
            'agentoffice.flow.memberCount',
            'agentoffice.flow.missingMemberCount',
            'agentoffice.flow.memberMissing',
            'agentoffice.flow.revision',
            'agentoffice.flow.archive',
            'agentoffice.flow.archiveWarning',
            'agentoffice.flow.delete',
            'agentoffice.flow.deleteWarning',
            'agentoffice.flow.required',
            'agentoffice.flow.saved',
            'agentoffice.flow.chat',
            'agentoffice.flow.settings',
            'agentoffice.flow.chatEmpty',
            'agentoffice.flow.messagePlaceholder',
            'agentoffice.flow.sender.user',
            'agentoffice.flow.sender.system',
            'agentoffice.flow.retryable',
            'agentoffice.flow.sending',
            'agentoffice.taskSource.flow',
            'agentoffice.flow.message.quote',
            'agentoffice.flow.message.delete',
            'agentoffice.flow.message.deleteWarning',
            'agentoffice.flow.message.deletedReference',
            'agentoffice.error.noReply'
        ];
        return Object.fromEntries(keys.map((key) => [key, appT(key)]));
    }

    listStaffs() {
        return this.callAgentOfficeWorker('listStaffs');
    }

    getFlowFeatureState(): { enabled: boolean } {
        return { enabled: isAgentFlowEnabled() };
    }

    listFlows(filter: AgentFlowListFilter = {}) {
        return this.callAgentOfficeWorker('listFlows', parseAgentFlowInput(AgentFlowListFilterSchema, filter));
    }

    getFlow(flowId: string) {
        return this.callAgentOfficeWorker('getFlow', parseAgentFlowInput(AgentFlowIdSchema, flowId));
    }

    getFlowMessageHistory(flowId: string, query: AgentFlowMessageHistoryQuery) {
        return this.callAgentOfficeWorker(
            'getFlowMessageHistory',
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowMessageHistoryQuerySchema, query)
        );
    }

    deleteFlowMessage(flowId: string, messageId: string): Promise<AgentFlowMessage> {
        const parsedFlowId = parseAgentFlowInput(AgentFlowIdSchema, flowId);
        const parsedMessageId = parseAgentFlowInput(AgentFlowIdSchema, messageId);
        return this.flowQueue.run(parsedFlowId, async () => {
            const message = await this.callAgentOfficeWorker<AgentFlowMessage | undefined>(
                'getFlowMessage',
                parsedFlowId,
                parsedMessageId
            );
            if (!message) throw new Error(appT('agentoffice.flow.error.messageNotFound'));
            if (message.sender.type === 'staff' && message.taskId) {
                await this.callAgentOfficeWorker('invalidateFlowReadingTask', parsedFlowId, message.taskId);
                this.deletedFlowTaskIds.add(message.taskId);
                const manager = GlobalState.getInstance().taskManagerState;
                const task = manager.getTask(message.taskId);
                if (task) {
                    this.invalidatedTurns.add(`${task.task_id}:${task.getTurnGeneration()}`);
                    manager.removeTask(message.taskId);
                }
                await this.callAgentOfficeWorker('deleteStaffTaskRecord', message.sender.id, message.taskId);
            }
            return await this.callAgentOfficeWorker<AgentFlowMessage>(
                'deleteFlowMessage',
                parsedFlowId,
                parsedMessageId
            );
        });
    }

    sendFlowMessage(
        flowId: string,
        input: SendAgentFlowMessageInput
    ): Promise<{ message_id: string; task_id?: string; task_ids?: string[] }> {
        const parsedFlowId = parseAgentFlowInput(AgentFlowIdSchema, flowId);
        const parsedInput = parseAgentFlowInput(SendAgentFlowMessageInputSchema, input);
        this.validateMessageInput({
            text: parsedInput.text,
            attachments: parsedInput.attachments,
            image_data_uris: parsedInput.imageDataUris
        });
        return this.flowQueue.run(
            parsedFlowId,
            async () => await this.sendFlowMessageLocked(parsedFlowId, parsedInput)
        );
    }

    private async sendFlowMessageLocked(
        flowId: string,
        input: SendAgentFlowMessageInput
    ): Promise<{ message_id: string }> {
        const flow = await this.callAgentOfficeWorker<AgentFlowDetail>('getFlow', flowId);
        const prepared = await this.callAgentOfficeWorker<PreparedAgentFlowUserMessage>(
            'prepareFlowUserMessage',
            flowId,
            {
                ...input,
                mentions: parseFlowMentions(input.text, flow)
            }
        );
        if (prepared.created) {
            this.flowReadingScheduler?.notifyUser(flowId);
            if (!this.flowUserWakeTimer && !this.schedulerStopping) {
                this.flowUserWakeTimer = setTimeout(() => {
                    this.flowUserWakeTimer = undefined;
                    void this.flowReadingScheduler?.tick();
                }, FLOW_USER_DEBOUNCE_MS);
                this.flowUserWakeTimer.unref?.();
            }
        }
        return { message_id: prepared.message.id };
    }

    async debugStartFlowReading(flowId: string, staffId: string, retryOfBatchId?: string) {
        this.assertFlowReadingDebug();
        const started = await this.startFlowReading(flowId, staffId, 'manual', undefined, retryOfBatchId);
        return { status: started.status, batchId: started.batchId, taskId: started.taskId };
    }

    async debugGetFlowReadingState(flowId: string) {
        this.assertFlowReadingDebug();
        await this.ensureFlowReadingRecovered();
        return this.callAgentOfficeWorker<FlowReadingState>(
            'getFlowReadingState',
            parseAgentFlowInput(AgentFlowIdSchema, flowId)
        );
    }

    async getFlowReadingView(flowId: string) {
        await this.ensureFlowReadingRecovered();
        return this.callAgentOfficeWorker('getFlowReadingView', parseAgentFlowInput(AgentFlowIdSchema, flowId));
    }

    setFlowReadingInterval(flowId: string, staffId: string, intervalMinutes: number) {
        return this.callAgentOfficeWorker(
            'setFlowReadingInterval',
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowIdSchema, staffId),
            intervalMinutes
        );
    }

    async retryFlowReading(flowId: string, staffId: string, batchId: string) {
        const result = await this.startFlowReading(
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowIdSchema, staffId),
            'manual',
            undefined,
            parseAgentFlowInput(AgentFlowIdSchema, batchId)
        );
        return { status: result.status };
    }

    private assertFlowReadingDebug(): void {
        if (process.env.OPENDESK_AGENT_FLOW_READING_DEBUG !== '1')
            throw new Error(appT('agentoffice.flow.error.readingDebugDisabled'));
    }

    private async startFlowReading(
        flowId: string,
        staffId: string,
        trigger: FlowReadingBatch['trigger'],
        prepared?: PreparedAgentFlowUserMessage,
        retryOfBatchId?: string
    ): Promise<{
        status: string;
        batchId?: string;
        taskId?: string;
        completion: Promise<void>;
    }> {
        parseAgentFlowInput(AgentFlowIdSchema, flowId);
        parseAgentFlowInput(AgentFlowIdSchema, staffId);
        await this.ensureFlowReadingRecovered();
        return this.withStaffLock(staffId, async () => {
            const manager = GlobalState.getInstance().taskManagerState;
            const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staffId);
            const busy = records.some((record) => {
                const task = manager.getTask(record.task_id);
                return task && ['running', 'waiting'].includes(task.task_status);
            });
            if (busy) return { status: 'busy', completion: Promise.resolve() };
            const detail = await this.callAgentOfficeWorker<StaffDetail>('getStaffDetail', staffId);
            const claim = await this.callAgentOfficeWorker<FlowReadingClaim>(
                'claimFlowReading',
                flowId,
                staffId,
                trigger,
                prepared?.message.id,
                retryOfBatchId
            );
            if (claim.status !== 'claimed' || !claim.batch || !claim.snapshot) {
                return {
                    status: claim.status,
                    batchId: claim.batch?.batchId,
                    taskId: claim.batch?.flowId === flowId ? claim.batch.taskId : undefined,
                    completion: Promise.resolve()
                };
            }
            const batch = claim.batch;
            const snapshot = claim.snapshot;
            let task: TaskState | undefined;
            let bound = false;
            try {
                if (this.schedulerStopping) throw new Error(appT('agentoffice.flow.error.readingUnavailable'));
                task = manager.createTask(undefined, {
                    taskName: appT('agentoffice.flow.task.readingName', {
                        name: snapshot.flow.name,
                        staff: detail.name
                    }),
                    internal: true
                });
                task.model = detail.model;
                const configuredModel = Setting.getInstance().getData().default_model;
                const model = task.model || (typeof configuredModel === 'string' ? configuredModel : '');
                if (!model) throw new Error(appT('agentoffice.flow.error.readingModelRequired'));
                // Attach identity synchronously before any save/await, so an unbound Task can be reconciled after a crash.
                flowTaskExtension(task).configure({
                    flowId,
                    staffId,
                    batchId: batch.batchId,
                    generation: task.getTurnGeneration() + 1,
                    model
                });
                await this.callAgentOfficeWorker('bindFlowReadingTask', flowId, batch.batchId, task.task_id);
                bound = true;
                const quotedUserMessage = snapshot.messages
                    .slice()
                    .reverse()
                    .find(
                        (message) =>
                            message.sender.type === 'user' &&
                            batch.unreadMessageIds.includes(message.id) &&
                            message.replyToMessageId
                    );
                const referencedTaskContext = getFlowReferencedTaskContext(
                    prepared?.referencedMessage ??
                        snapshot.messages.find((message) => message.id === quotedUserMessage?.replyToMessageId)
                );
                const runtime = await this.configureFlowTaskTurn(
                    snapshot.flow,
                    staffId,
                    detail,
                    task,
                    snapshot,
                    referencedTaskContext,
                    batch
                );
                await manager.flushAllPendingSaves();
                await this.callAgentOfficeWorker('assertFlowReadingRunning', flowId, batch.batchId, task.task_id);
                const submitted = await task.submitUserMessage(
                    buildFlowTaskPrompt(
                        snapshot,
                        detail,
                        batch.unreadMessageIds,
                        runtime.resourcesDirectory,
                        referencedTaskContext
                    ),
                    { imageDataUris: prepared?.imageDataUris }
                );
                if (submitted.status !== 'ok' || task.getTurnGeneration() !== runtime.expectedGeneration)
                    throw new Error(appT('agentoffice.error.turnGenerationMismatch'));
                return {
                    status: 'started',
                    batchId: batch.batchId,
                    taskId: task.task_id,
                    completion: this.monitorFlowReading(batch, task, runtime.expectedGeneration)
                };
            } catch (error) {
                if (task) {
                    flowTaskExtension(task).onTurnIterationFailed(
                        error instanceof Error ? error.message : String(error)
                    );
                    if (['running', 'waiting'].includes(task.task_status)) task.stop('system');
                }
                try {
                    // Binding may have committed even when the subsequent worker record write failed.
                    const persisted = await this.callAgentOfficeWorker<FlowReadingState>('getFlowReadingState', flowId);
                    const current = persisted.batches.find((entry) => entry.batchId === batch.batchId);
                    bound = Boolean(task && current?.taskId === task.task_id);
                    await this.callAgentOfficeWorker(
                        'settleFlowReading',
                        flowId,
                        batch.batchId,
                        bound ? task?.task_id : undefined,
                        task && flowTaskExtension(task).state?.outcome === 'cancelled' ? 'cancelled' : 'failed',
                        error instanceof Error ? error.message : String(error),
                        task?.usage_summary
                    );
                } finally {
                    if (task && !bound && manager.getTask(task.task_id)) manager.removeTask(task.task_id);
                }
                throw error;
            }
        });
    }

    private async monitorFlowReading(batch: FlowReadingBatch, task: TaskState, generation: number): Promise<void> {
        const key = task.task_id + ':' + generation;
        this.monitoredTurns.add(key);
        try {
            await flowTaskExtension(task).waitUntilSettled();
            if (this.deletedFlowTaskIds.has(task.task_id)) return;
            if (!GlobalState.getInstance().taskManagerState.getTask(task.task_id)) {
                await this.callAgentOfficeWorker('invalidateFlowReadingTask', batch.flowId, task.task_id);
                return;
            }
            const state = flowTaskExtension(task).state;
            const status =
                state?.outcome === 'completed' && task.getTurnGeneration() === generation
                    ? 'completed'
                    : state?.outcome === 'cancelled'
                      ? 'cancelled'
                      : 'failed';
            task.persistLater();
            await GlobalState.getInstance().taskManagerState.flushAllPendingSaves();
            await this.callAgentOfficeWorker(
                'settleFlowReading',
                batch.flowId,
                batch.batchId,
                task.task_id,
                status,
                state?.failure,
                task.usage_summary
            );
            // Recheck pending events after releasing the batch; the configured mode controls staff-message wakeups.
            void this.flowReadingScheduler?.tick();
        } catch (error) {
            logger.warn('[agentoffice] failed to settle reading batch ' + batch.batchId + ': ' + String(error));
        } finally {
            this.monitoredTurns.delete(key);
            this.repliedTurns.delete(key);
        }
    }

    private ensureFlowReadingRecovered(): Promise<void> {
        if (this.flowRecoveryPromise) return this.flowRecoveryPromise;
        this.flowRecoveryPromise = this.recoverFlowReadings().catch((error) => {
            this.flowRecoveryPromise = undefined;
            throw error;
        });
        return this.flowRecoveryPromise;
    }

    private async recoverFlowReadings(): Promise<void> {
        if (!isAgentFlowEnabled()) return;
        const states = await this.callAgentOfficeWorker<FlowReadingState[]>('listFlowReadingStates');
        const manager = GlobalState.getInstance().taskManagerState;
        for (const state of states) {
            if (state.deleting) continue;
            for (const saved of state.batches) {
                let batch = saved;
                if (batch.taskDeletedAt) continue;
                let task = batch.taskId ? manager.getTask(batch.taskId) : undefined;
                if (!task && batch.status === 'pending' && !batch.taskId) {
                    task = manager.tasks
                        .filter((entry) => entry.internal)
                        .map((entry) => manager.getTask(entry.task_id))
                        .find((entry) => {
                            const turn = entry ? flowTaskExtension(entry).state : undefined;
                            return (
                                turn?.batchId === batch.batchId &&
                                turn.flowId === batch.flowId &&
                                turn.staffId === batch.staffId
                            );
                        });
                    if (task)
                        batch = await this.callAgentOfficeWorker<FlowReadingBatch>(
                            'bindFlowReadingTask',
                            state.flowId,
                            batch.batchId,
                            task.task_id
                        );
                }
                if (!['pending', 'running'].includes(batch.status)) {
                    if (batch.taskId && !task) {
                        await this.callAgentOfficeWorker('invalidateFlowReadingTask', state.flowId, batch.taskId);
                        continue;
                    }
                    await this.callAgentOfficeWorker(
                        'settleFlowReading',
                        state.flowId,
                        batch.batchId,
                        batch.taskId,
                        batch.status,
                        batch.failure,
                        task?.usage_summary
                    );
                    continue;
                }
                const turn = task ? flowTaskExtension(task).state : undefined;
                const matched =
                    turn?.batchId === batch.batchId && turn.flowId === batch.flowId && turn.staffId === batch.staffId;
                if (task && matched && task.task_status === 'running' && turn.outcome === 'running') {
                    void this.monitorFlowReading(batch, task, task.getTurnGeneration());
                    continue;
                }
                const status =
                    matched && turn.outcome === 'completed'
                        ? 'completed'
                        : matched && turn.outcome === 'cancelled'
                          ? 'cancelled'
                          : 'failed';
                await this.callAgentOfficeWorker(
                    'settleFlowReading',
                    state.flowId,
                    batch.batchId,
                    batch.taskId,
                    status,
                    turn?.failure ??
                        (status === 'failed' ? appT('agentoffice.flow.error.interruptedReading') : undefined),
                    task?.usage_summary
                );
            }
        }
    }

    createFlow(input: CreateAgentFlowInput) {
        return this.callAgentOfficeWorker('createFlow', parseAgentFlowInput(CreateAgentFlowInputSchema, input));
    }

    updateFlow(flowId: string, expectedRevision: number, patch: UpdateAgentFlowPatch) {
        return this.callAgentOfficeWorker(
            'updateFlow',
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowRevisionSchema, expectedRevision),
            parseAgentFlowInput(UpdateAgentFlowPatchSchema, patch)
        );
    }

    setFlowMembers(flowId: string, expectedRevision: number, memberIds: string[]) {
        return this.callAgentOfficeWorker(
            'setFlowMembers',
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowRevisionSchema, expectedRevision),
            parseAgentFlowInput(AgentFlowMemberIdsSchema, memberIds)
        );
    }

    archiveFlow(flowId: string, expectedRevision: number) {
        return this.callAgentOfficeWorker(
            'archiveFlow',
            parseAgentFlowInput(AgentFlowIdSchema, flowId),
            parseAgentFlowInput(AgentFlowRevisionSchema, expectedRevision)
        );
    }

    async deleteFlow(flowId: string, expectedRevision: number): Promise<void> {
        const id = parseAgentFlowInput(AgentFlowIdSchema, flowId);
        const revision = parseAgentFlowInput(AgentFlowRevisionSchema, expectedRevision);
        const activeIds = await this.callAgentOfficeWorker<string[]>('prepareFlowDeletion', id, revision);
        const taskManager = GlobalState.getInstance().taskManagerState;
        for (const taskId of activeIds) {
            const task = taskManager.getTask(taskId);
            if (!task) continue;
            this.deletedFlowTaskIds.add(taskId);
            this.invalidatedTurns.add(`${taskId}:${task.getTurnGeneration()}`);
            if (task.task_status === 'running' || task.task_status === 'waiting') task.stop('system');
        }
        return this.flowQueue.run(id, async () => {
            const rootIds = await this.callAgentOfficeWorker<string[]>('prepareFlowDeletion', id, revision);
            const manager = GlobalState.getInstance().taskManagerState;
            const taskIds = new Set(rootIds);
            // A crash can leave a Task with durable group identity before bindTask recorded ownership.
            for (const entry of manager.tasks) {
                if (!entry.internal) continue;
                const task = manager.getTask(entry.task_id);
                if (task && flowTaskExtension(task).state?.flowId === id) taskIds.add(entry.task_id);
            }
            let changed = true;
            while (changed) {
                changed = false;
                for (const task of manager.tasks) {
                    if (task.parent_id && taskIds.has(task.parent_id) && !taskIds.has(task.task_id)) {
                        taskIds.add(task.task_id);
                        changed = true;
                    }
                }
            }
            // Persist the complete deletion scope before removing tasks, so a failed cleanup can be retried.
            await this.callAgentOfficeWorker('rememberFlowTasks', id, [...taskIds]);
            for (const taskId of taskIds) {
                parseAgentFlowInput(AgentFlowTaskIdSchema, taskId);
                this.deletedFlowTaskIds.add(taskId);
                const task = manager.getTask(taskId);
                if (task) {
                    this.invalidatedTurns.add(`${taskId}:${task.getTurnGeneration()}`);
                    if (task.task_status === 'running' || task.task_status === 'waiting') task.stop('system');
                }
            }
            for (const taskId of taskIds) {
                if (manager.getTask(taskId)) manager.removeTask(taskId);
                // Task cleanup logs filesystem failures; retry explicitly and propagate them before deleting the group.
                this.deleteFlowTaskFiles(taskId);
            }
            await this.callAgentOfficeWorker('deleteFlow', id, revision);
        });
    }

    private deleteFlowTaskFiles(taskId: string): void {
        const id = parseAgentFlowInput(AgentFlowTaskIdSchema, taskId);
        const taskRoot = path.resolve(getTaskDirectory());
        const artifactRoot = path.resolve(getArtifactDirectory());
        const artifactPath = path.resolve(getTaskArtifactDirectory(id, false));
        if (path.dirname(artifactPath) !== artifactRoot) throw new Error(appT('agentoffice.flow.error.invalidInput'));
        fs.rmSync(path.join(taskRoot, `${id}.json`), { force: true });
        fs.rmSync(artifactPath, { recursive: true, force: true });
        const legacyRoot = path.join(taskRoot, 'artifacts');
        if (!fs.existsSync(legacyRoot)) return;
        for (const name of fs.readdirSync(legacyRoot)) {
            if (!name.startsWith(`${id}_`)) continue;
            const target = path.resolve(legacyRoot, name);
            if (path.dirname(target) !== legacyRoot) throw new Error(appT('agentoffice.flow.error.invalidInput'));
            fs.rmSync(target, { recursive: true, force: true });
        }
    }

    getStaffDetail(staffId: string) {
        return this.callAgentOfficeWorker('getStaffDetail', staffId);
    }

    getHistoryMessagesForUI(staffId: string, query: HistoryQuery) {
        return this.callAgentOfficeWorker('getHistory', staffId, query);
    }

    deleteStaffMessage(staffId: string, messageId: string) {
        return this.callAgentOfficeWorker('deleteMessage', staffId, messageId);
    }

    deleteStaffMessagePart(staffId: string, messageId: string, partIndex: number) {
        return this.callAgentOfficeWorker('deleteMessagePart', staffId, messageId, partIndex);
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

    private getLocalService(): StaffLocalServiceManager {
        if (!this.localService) {
            this.localService = new StaffLocalServiceManager({
                getStaffDetail: (staffId) => this.callAgentOfficeWorker<StaffDetail>('getStaffDetail', staffId),
                getHistory: (staffId, query) => this.callAgentOfficeWorker('getHistory', staffId, query),
                sendMessage: (staffId, input) => this.sendMessage(staffId, input),
                getResourceFilePath: (staffId, requested) => this.resolveStaffResourcePath(staffId, requested),
                getLocale: () => getLocale(),
                readServiceCertificate: (staffId) => this.readServiceCertificate(staffId),
                writeServiceCertificate: (staffId, certificate) => this.writeServiceCertificate(staffId, certificate),
                updateStaffProfile: (staffId, input) => this.updateStaff(staffId, input),
                listStaffSkills: (staffId) => this.callAgentOfficeWorker('listSkills', staffId),
                deleteStaffSkill: (staffId, name) => this.deleteSkill(staffId, name),
                addStaffSkill: (staffId, zipPath) => this.addSkill(staffId, zipPath),
                addStaffSkillFromUrl: (staffId, sourceUrl) => this.addSkillFromUrl(staffId, sourceUrl),
                listChatModelSummaries: () => this.listChatModels(),
                onStateChange: (staffId, runtime) => {
                    void this.emitEvent('localServiceChanged', staffId, runtime).catch(() => undefined);
                }
            });
        }
        return this.localService;
    }

    private serviceCertificatePath(staffId: string): string {
        return path.join(this.staffDirectory(staffId), 'protected', 'local-service-cert.json');
    }

    private readServiceCertificate(staffId: string): StoredServiceCertificate | null {
        try {
            const filePath = this.serviceCertificatePath(staffId);
            if (!fs.existsSync(filePath)) return null;
            const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<StoredServiceCertificate>;
            if (
                typeof parsed.host !== 'string' ||
                typeof parsed.key !== 'string' ||
                typeof parsed.cert !== 'string' ||
                !parsed.key.includes('PRIVATE KEY') ||
                !parsed.cert.includes('CERTIFICATE')
            ) {
                return null;
            }
            return { host: parsed.host, key: parsed.key, cert: parsed.cert };
        } catch {
            return null;
        }
    }

    private writeServiceCertificate(staffId: string, certificate: StoredServiceCertificate): void {
        const filePath = this.serviceCertificatePath(staffId);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        // 私钥落盘限制为仅当前用户可读写（Windows 会忽略 mode，风险可接受：目录在用户数据目录内）
        fs.writeFileSync(filePath, `${JSON.stringify(certificate, null, 4)}\n`, { encoding: 'utf8', mode: 0o600 });
    }

    /** 应用注册即恢复已开启的本地网络服务；启动早期 global worker 可能未就绪，按 5s 退避重试 */
    private async restoreLocalServices(attempt = 0): Promise<void> {
        if (this.schedulerStopping || this.localServiceRestoreDone) return;
        const startedAt = performance.now();
        let status: StartupPhaseStatus = 'failed';
        let listed = 0;
        let restored = 0;
        try {
            const staffs = await this.callAgentOfficeWorker<StaffStartupInfo[]>('listStaffStartupInfo');
            listed = staffs.length;
            for (const staff of staffs) {
                if (!staff.enabled || !staff.local_service?.enabled) continue;
                await this.getLocalService().apply(staff.id, staff.local_service);
                restored++;
            }
            this.localServiceRestoreDone = true;
            status = 'ready';
        } catch (error) {
            const maxAttempts = 12;
            if (attempt >= maxAttempts) {
                logger.warn(
                    `AgentOffice: gave up restoring local web services after ${maxAttempts} attempts: ${error}`
                );
                return;
            }
            this.localServiceRestoreTimer = setTimeout(() => void this.restoreLocalServices(attempt + 1), 5000);
            this.localServiceRestoreTimer.unref?.();
            status = 'retry';
        } finally {
            recordAgentOfficeStartup('services.restore', startedAt, status, { attempt, listed, restored });
        }
    }

    getLocalServiceInfo(staffId: string): Promise<{ config: StaffLocalService; runtime: LocalServiceRuntime }> {
        return this.callAgentOfficeWorker<StaffDetail>('getStaffDetail', staffId).then((detail) => ({
            config: detail.local_service ?? normalizeStaffLocalService(undefined),
            runtime: this.getLocalService().getRuntime(staffId)
        }));
    }

    /**
     * 用系统默认浏览器打开该员工本地网络服务的指定入口（chat / manage），
     * 地址按已保存的令牌配置自动补上 token 参数；服务未启动时抛出本地化错误
     */
    async openServiceInBrowser(staffId: string, target: 'chat' | 'manage' = 'chat'): Promise<void> {
        const runtime = this.getLocalService().getRuntime(staffId);
        if (!runtime.listening || !runtime.url) {
            throw new Error(appT('agentoffice.localServiceStopped'));
        }
        const detail = await this.callAgentOfficeWorker<StaffDetail>('getStaffDetail', staffId);
        const config = normalizeStaffLocalService(detail.local_service);
        const token = target === 'manage' ? config.manage_token : config.user_token;
        const url = `${runtime.url}/${target}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        await getPlatform().openExternal(url);
    }

    listLocalAddresses(): Array<{ address: string; name: string }> {
        const result: Array<{ address: string; name: string }> = [
            { address: '127.0.0.1', name: appT('agentoffice.localServiceLocalhost') }
        ];
        const seen = new Set(['127.0.0.1']);
        for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
            for (const address of addresses ?? []) {
                if (address.family !== 'IPv4' || address.internal || seen.has(address.address)) continue;
                seen.add(address.address);
                result.push({ address: address.address, name });
            }
        }
        return result;
    }

    /** 员工停启/配置变化后，把本地服务收敛到与最新配置一致的状态 */
    private async syncLocalServiceAfterUpdate(staffId: string, detail: StaffDetail): Promise<void> {
        try {
            const desired =
                detail.enabled && detail.local_service?.enabled
                    ? detail.local_service
                    : { ...normalizeStaffLocalService(undefined), enabled: false };
            await this.getLocalService().apply(staffId, desired);
        } catch (error) {
            logger.warn(`AgentOffice: failed to sync local service for staff ${staffId}: ${error}`);
        }
    }

    async createStaff(definition: StaffDefinitionInput) {
        const detail = await this.callAgentOfficeWorker<StaffDetail>(
            'createStaff',
            definition,
            appT('agentoffice.defaultAgentsMd')
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
            throw new Error(appT('agentoffice.error.portraitPngOnly'));
        }
        if (input.portrait_data_uri && input.portrait_data_uri.length > PORTRAIT_DATA_URI_MAX_LENGTH) {
            throw new Error(appT('agentoffice.portraitFileTooLarge'));
        }
        if (input.portrait_data_uri && !/^data:image\/png;base64,[a-z0-9+/]+={0,2}$/i.test(input.portrait_data_uri)) {
            throw new Error(appT('agentoffice.error.portraitPngOnly'));
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
        // 停用员工或调整服务配置时同步本地网络服务；员工停用后服务必须一并停止
        if (input.local_service !== undefined || input.enabled !== undefined) {
            await this.syncLocalServiceAfterUpdate(staffId, detail);
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
            throw new Error(appT('agentoffice.error.skillUrlInvalid'));
        }
        if (!['http:', 'https:'].includes(url.protocol)) throw new Error(appT('agentoffice.error.skillUrlInvalid'));

        const temporaryDirectory = fs.mkdtempSync(path.join(getTempDir(), 'agentoffice-skill-download-'));
        try {
            const response = await getPlatform().fetch(url, { redirect: 'follow' });
            if (!response.ok) {
                throw new Error(appT('agentoffice.error.skillDownloadFailed', { status: String(response.status) }));
            }
            const declaredSize = Number(response.headers.get('content-length') || 0);
            if (Number.isFinite(declaredSize) && declaredSize > SKILL_DOWNLOAD_MAX_BYTES) {
                throw new Error(appT('agentoffice.error.skillDownloadTooLarge'));
            }
            const archive = Buffer.from(await response.arrayBuffer());
            if (archive.byteLength > SKILL_DOWNLOAD_MAX_BYTES) {
                throw new Error(appT('agentoffice.error.skillDownloadTooLarge'));
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
        return skillRegistry.listSkills().flatMap((skill) => {
            const installed = skillRegistry.getSkillBody(skill.id);
            if (!installed?.skillDir) return [];
            const directoryName = path.basename(installed.skillDir);
            return [
                {
                    id: skill.id,
                    name: String(skill.name ?? ''),
                    description: String(skill.description ?? ''),
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
            const installed = skillRegistry.getSkillBody(skillId);
            if (!installed?.skillDir) {
                unavailable.push({ path: skillId, message: appT('agentoffice.error.installedSkillUnavailable') });
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
        await this.getLocalService().stop(staffId);
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
        if (!detail.enabled) throw new Error(appT('agentoffice.error.staffDisabled'));
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
            await task.submitUserMessage(prompt, { imageDataUris: prepared.image_data_uris });
            if (task.getTurnGeneration() !== runtime.expectedGeneration) {
                throw new Error(appT('agentoffice.error.turnGenerationMismatch'));
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
                appT('agentoffice.error.taskStartFailed', {
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
        const mode = agent.getDefaultMode();
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
                        throw new Error(appT('agentoffice.error.staleTurnReply'));
                    }
                    const turnKey = `${replyTask.task_id}:${expectedGeneration}`;
                    if (this.invalidatedTurns.has(turnKey)) {
                        throw new Error(appT('agentoffice.error.staleTurnReply'));
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
        await task.rebuildSystemPrompt();
        await task.hooks.noticeBeforeTaskStart({ task });
        return { expectedGeneration, memoryPath, recent, resourcesDirectory };
    }

    private async configureFlowTaskTurn(
        flow: AgentFlowDetail,
        staffId: string,
        detail: StaffDetail,
        task: TaskState,
        snapshot: FlowHistorySnapshot,
        referencedTaskContext?: FlowReferencedTaskContext,
        batch?: FlowReadingBatch
    ): Promise<{
        expectedGeneration: number;
        recent: AgentFlowMessage[];
        resourcesDirectory: string;
    }> {
        const taskManager = GlobalState.getInstance().taskManagerState;
        applyStaffModelToTask(task, detail.model);
        const workspace = await this.callAgentOfficeWorker<string>('ensureWorkspace', staffId);
        const staffResourcesDirectory = path.join(this.staffDirectory(staffId), 'resources');
        const resourcesDirectory = path.join(this.getDataDirectory(), 'flows', flow.id, 'resources');
        const agent = await this.ensureStaffAgent(staffId, detail);
        const mode = agent.getDefaultMode();
        assignStaffAgentToTask(task, agent, mode);
        await taskManager.initHarness(task, workspace, mode);
        await applyStaffPermissionToTask(task, {
            workspace,
            resourcesDirectory: staffResourcesDirectory,
            additionalReadDirectories: [
                resourcesDirectory,
                ...(referencedTaskContext
                    ? [referencedTaskContext.taskFilePath, referencedTaskContext.artifactsDirectory]
                    : [])
            ],
            protectedDirectory: path.join(this.staffDirectory(staffId), 'protected'),
            permission: detail.permission
        });
        await task.harnessContext.grantTaskArtifactAccess(getTaskArtifactDirectory(task.task_id));

        const recent = snapshot.messages;
        const expectedGeneration = task.getTurnGeneration() + 1;
        const configuredModel = Setting.getInstance().getData().default_model;
        const model = task.model || (typeof configuredModel === 'string' ? configuredModel : '');
        if (!model) throw new Error(appT('agentoffice.flow.error.readingModelRequired'));
        flowTaskExtension(task).configure({
            flowId: flow.id,
            staffId,
            batchId: batch?.batchId,
            generation: expectedGeneration,
            model
        });
        await task.attachToolset(
            createAgentOfficeTaskToolset({
                flowReply: true,
                sendReply: createFlowReplyHandler({
                    flowId: flow.id,
                    staffId,
                    task,
                    expectedGeneration,
                    visibleMessages: snapshot.messages,
                    isInvalidated: (turnKey) =>
                        this.invalidatedTurns.has(turnKey) || flowTaskExtension(task).state?.outcome !== 'running',
                    recordReply: async (targetFlowId, targetStaffId, taskId, text, files, replyToMessageId) => {
                        if (batch) {
                            const result = await this.callAgentOfficeWorker<{ messageId: string }>(
                                'appendFlowReadingReply',
                                targetFlowId,
                                batch.batchId,
                                taskId,
                                text,
                                files,
                                replyToMessageId
                            );
                            return result.messageId;
                        }
                        const reply = await this.callAgentOfficeWorker<AgentFlowMessage>(
                            'appendFlowStaffMessage',
                            targetFlowId,
                            targetStaffId,
                            taskId,
                            text,
                            files,
                            'message',
                            replyToMessageId
                        );
                        await this.linkMessageToTask(targetStaffId, taskId, reply.id);
                        return reply.id;
                    },
                    markReplied: (turnKey) => this.repliedTurns.add(turnKey)
                }),
                getHistory: async (query: HistoryQuery) => {
                    const current = await this.callAgentOfficeWorker<FlowHistorySnapshot>(
                        'getFlowHistorySnapshot',
                        flow.id
                    );
                    const effectiveIds = new Set(current.messages.map((message) => message.id));
                    return queryFlowHistory(
                        { ...snapshot, messages: snapshot.messages.filter((message) => effectiveIds.has(message.id)) },
                        query
                    );
                }
            })
        );
        await task.rebuildSystemPrompt();
        await task.hooks.noticeBeforeTaskStart({ task });
        return { expectedGeneration, recent, resourcesDirectory };
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
                taskName: `${appT('agentoffice.taskPrefix')} ${appT('agentoffice.task.scheduledName')}`,
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
        await this.ensureFlowReadingRecovered();
        const staffs = await this.callAgentOfficeWorker<StaffListItem[]>('listStaffs');
        const taskManager = GlobalState.getInstance().taskManagerState;
        for (const staff of staffs) {
            const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staff.id);
            for (const record of records) {
                if (record.flow_batch_id || !['running', 'waiting'].includes(record.status)) continue;
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
                    if (record.source === 'flow' && record.flow_id) {
                        void this.monitorFlowTaskTurn(record.flow_id, staff.id, task, record, task.getTurnGeneration());
                        continue;
                    }
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
                        throw new Error(appT('agentoffice.error.turnGenerationMismatch'));
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

            // 三个返回分支的对象字面量联合后，未参与该分支的字段会以 `xxx?: undefined` 形式存在，
            // 因此 `'waitFor' in started` 不足以排除 undefined；需再判真值才能安全取到 TaskState
            if ('waitFor' in started && started.waitFor) {
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
                    appT('agentoffice.error.noReply'),
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

    private async monitorFlowTaskTurn(
        flowId: string,
        staffId: string,
        task: TaskState,
        record: StaffTaskRecord,
        generation: number
    ): Promise<void> {
        const turnKey = `${task.task_id}:${generation}`;
        if (this.monitoredTurns.has(turnKey)) return;
        this.monitoredTurns.add(turnKey);
        try {
            await task.waitUntilFinished(undefined, true);
            if (this.deletedFlowTaskIds.has(task.task_id)) return;
            const superseded = task.getTurnGeneration() !== generation;
            if (superseded) return;
            this.repliedTurns.delete(turnKey);
            const outcome = flowTaskExtension(task).state?.outcome;
            const status = outcome === 'completed' ? 'succeeded' : outcome === 'cancelled' ? 'cancelled' : 'failed';
            const records = await this.callAgentOfficeWorker<StaffTaskRecord[]>('readTasks', staffId);
            const latestRecord = records.find((candidate) => candidate.task_id === task.task_id) ?? record;
            await this.callAgentOfficeWorker('upsertTask', staffId, {
                ...latestRecord,
                status,
                updated_at: new Date().toISOString(),
                usage_summary: task.usage_summary
            } satisfies StaffTaskRecord);
        } catch (error) {
            logger.warn(`[agentoffice] failed to monitor Flow task ${task.task_id}: ${error}`);
        } finally {
            this.monitoredTurns.delete(turnKey);
            this.repliedTurns.delete(turnKey);
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
            appT('agentoffice.operationFailed')
        );
    }

    private validateMessageInput(input: SendStaffMessageInput): void {
        if (!input.text?.trim() && !input.attachments?.length && !input.image_data_uris?.length) {
            throw new Error(appT('agentoffice.error.messageRequired'));
        }
        for (const attachment of input.attachments ?? []) {
            if (!fs.existsSync(attachment.path) || !fs.statSync(attachment.path).isFile()) {
                throw new Error(appT('agentoffice.error.attachmentMustBeFile'));
            }
        }
        for (const dataUri of input.image_data_uris ?? []) {
            if (!/^data:image\/[^;,]+;base64,/i.test(dataUri)) {
                throw new Error(appT('agentoffice.error.imageDataUriOnly'));
            }
        }
    }

    private staffDirectory(staffId: string): string {
        if (!/^[0-9a-f-]{36}$/i.test(staffId)) throw new Error(appT('agentoffice.error.invalidStaffId'));
        return path.join(this.getDataDirectory(), 'staffs', staffId);
    }

    private handleResourceRequest(request: { url: string }): Response {
        try {
            const url = new URL(request.url);
            if (url.hostname === 'flow-resource') {
                const parts = url.pathname
                    .split('/')
                    .filter(Boolean)
                    .map((part) => decodeURIComponent(part));
                const flowId = parts.shift();
                if (!flowId || !AgentFlowIdSchema.safeParse(flowId).success) {
                    return new Response('Not found', { status: 404 });
                }
                const requested = parts.join('/');
                if (!/^resources\/[0-9a-f-]{36}(?:\.[a-z0-9]{1,16})?$/i.test(requested)) {
                    return new Response('Not found', { status: 404 });
                }
                const allowedRoot = path.join(this.getDataDirectory(), 'flows', flowId, 'resources');
                const resolved = path.resolve(path.join(this.getDataDirectory(), 'flows', flowId, requested));
                if (!resolved.startsWith(`${path.resolve(allowedRoot)}${path.sep}`)) {
                    return new Response('Forbidden', { status: 403 });
                }
                if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
                    return new Response('Not found', { status: 404 });
                }
                return new Response(fs.readFileSync(resolved), {
                    headers: { 'content-type': mimeTypeFor(resolved), 'cache-control': 'no-store' }
                });
            }
            if (url.hostname !== 'resource') return new Response('Not found', { status: 404 });
            const parts = url.pathname
                .split('/')
                .filter(Boolean)
                .map((part) => decodeURIComponent(part));
            const staffId = parts.shift();
            if (!staffId) return new Response('Not found', { status: 404 });
            const resolved = this.resolveStaffResourcePath(staffId, parts.join('/'));
            if (!resolved) return new Response('Not found', { status: 404 });
            return new Response(fs.readFileSync(resolved), {
                headers: { 'content-type': mimeTypeFor(resolved), 'cache-control': 'no-store' }
            });
        } catch {
            return new Response('Bad request', { status: 400 });
        }
    }

    /**
     * 校验员工资源请求路径并解析为可下发的文件绝对路径；
     * agentoffice:// 协议与本地网络服务的 HTTP 接口共用这一份越权防护：
     * 仅允许 portrait 与 resources/ 前缀，且解析结果必须落在对应目录内。
     */
    private resolveStaffResourcePath(staffId: string, requested: string): string | null {
        try {
            const portraitRequest = requested === 'portrait';
            if (!portraitRequest && !requested.startsWith('resources/')) return null;
            const staffDirectory = this.staffDirectory(staffId);
            const filePath = portraitRequest
                ? path.join(staffDirectory, 'agent', 'portrait.png')
                : path.join(staffDirectory, requested);
            const allowedRoot = portraitRequest
                ? path.join(staffDirectory, 'agent')
                : path.join(staffDirectory, 'resources');
            const resolved = path.resolve(filePath);
            if (!resolved.startsWith(`${path.resolve(allowedRoot)}${path.sep}`)) return null;
            if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
            return resolved;
        } catch {
            return null;
        }
    }
}
