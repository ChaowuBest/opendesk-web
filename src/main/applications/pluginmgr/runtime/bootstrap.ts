/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { GlobalHooks, MAX_HOOK_PRIORITY } from '../../../aikernel/hooks.js';
import { GlobalState } from '../../../aikernel/states/global.js';
import { AgentRegistry } from '../../../aikernel/agents/registry.js';
import type { ApplicationAgents } from '../../../aikernel/agents/registry.js';
import type { AgentDefinition } from '../../../aikernel/types/agent.js';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import { getPluginHost } from './host.js';
import type { PluginChatRequestInput, PluginPlatform } from '../../../../../packages/plugin-sdk/src/index.js';
import { registerSdkPackageMapping } from './package-mapping.js';
import { loadPlugin, OPENDESK_RUNTIME_VERSION, type PluginCandidate } from '../discovery/loader.js';
import { getPluginManagerConfig, getRuntimePluginDirectories } from '../management/config.js';
import { discoverPlugins, verifyPluginRecord } from '../discovery/discovery.js';
import { getPluginRecord } from '../management/registry.js';
import {
    runPluginAfterToolCall,
    runPluginBeforeToolCall,
    runPluginBeforeToolCallValidate,
    runPluginChatHeaders,
    runPluginChatParams,
    runPluginAfterSkillLoad,
    runPluginBeforeSkillLoad,
    runPluginBeforePermissionAsk,
    runPluginShellEnv
} from './hooks.js';
import { applyPluginToolDefinitions } from './tool-provider.js';
import { PluginAgent } from './agent.js';
import { disposePluginContributions, initializePluginContributions, PLUGIN_SKILL_BUNDLE } from './contributions.js';
import {
    disposePluginMcpProvider,
    disposePluginMcpRuntime,
    initializePluginMcpProvider,
    notifyPluginMcpServersChanged
} from './mcp.js';
import { ApplicationRegistry } from '../../registry.js';

let initialization: Promise<void> | undefined;
let disposeApplicationEventBridge: (() => void) | undefined;
let disposeAikernelHooks: (() => void)[] = [];

function notifyPluginSkillsChanged(): void {
    const application = ApplicationRegistry.getApplication('skillmgr') as
        | { notifyExternalSkillsChanged?: (bundleName: string) => void }
        | undefined;
    if (application?.notifyExternalSkillsChanged) {
        application.notifyExternalSkillsChanged(PLUGIN_SKILL_BUNDLE);
    } else {
        ApplicationRegistry.dispatchEvent('skillmgr', 'skillsChanged');
    }
}

interface ResolvedCandidate extends PluginCandidate {
    id: string;
    requireDeclaration?: boolean;
    blockedCode?: string;
    blockedDetail?: string;
}

function configuredCandidates(): ResolvedCandidate[] {
    const configDir = getOpendeskDirectory();
    const config = getPluginManagerConfig();
    const discovery = discoverPlugins({
        configDirectory: configDir,
        externalPaths: config.externalPaths,
        pluginDirectories: getRuntimePluginDirectories()
    });
    const host = getPluginHost();
    for (const conflict of discovery.conflicts) {
        host.recordError({
            id: conflict.id,
            origin: configDir,
            code: 'plugin.discovery_conflict',
            stage: 'resolve',
            detail: conflict.paths.join(', ')
        });
    }
    return discovery.candidates.map((candidate) => {
        if (candidate.source === 'builtin') {
            return {
                ...candidate,
                requireDeclaration: true
            };
        }
        // Only plugins with a recorded integrity snapshot are verified; hand-placed
        // plugins have no baseline and load without an integrity gate.
        const record = getPluginRecord(candidate.id, configDir);
        if (!record?.integrity) return candidate;
        const verification = verifyPluginRecord(record, configDir);
        return {
            ...candidate,
            requireDeclaration: true,
            integrity: verification.actualIntegrity,
            blockedCode: verification.allowed ? undefined : 'plugin.integrity_mismatch',
            blockedDetail: verification.allowed
                ? undefined
                : `${verification.expectedIntegrity ?? '-'} != ${verification.actualIntegrity ?? '-'}`
        };
    });
}

function isMissingDeclaration(error: unknown): boolean {
    return error instanceof Error && error.message === 'plugin.entry_not_declared';
}

/**
 * 将所有已激活插件贡献的 agent 按插件分组注册到 AIKernel。
 * 以插件 id 作为作用域，完整 agentId 为 `<插件 id>:<agent 名>`。
 */
async function syncPluginAgentsWithRegistry(): Promise<void> {
    const grouped = new Map<string, AgentDefinition[]>();
    for (const { pluginId, definition } of getPluginHost().listAgents()) {
        const agents = grouped.get(pluginId) ?? [];
        agents.push(definition);
        grouped.set(pluginId, agents);
    }
    const sources: ApplicationAgents[] = Array.from(grouped, ([bundleName, agents]) => ({
        bundleName,
        agents: agents.map((definition) => new PluginAgent(definition))
    }));
    await AgentRegistry.replacePluginAgents(sources);
}

async function initialize(): Promise<void> {
    // 让缺少 node_modules 的插件也能从宿主解析到 Plugin SDK（鸿蒙等平台不执行 npm install）
    registerSdkPackageMapping();
    initializePluginContributions();
    initializePluginMcpProvider();
    disposeAikernelHooks.forEach((dispose) => dispose());
    disposeAikernelHooks = [];
    disposeAikernelHooks.push(
        GlobalHooks.beforeChatModelRequest(
            async (ctx) => {
                const input: PluginChatRequestInput = {
                    taskId: ctx.task?.task_id,
                    workspace: ctx.task?.getWorkspace() || undefined,
                    modelAlias: ctx.model.model_name
                };
                ctx.options.extraHeaders = await runPluginChatHeaders(input, ctx.options.extraHeaders ?? {});
                const pluginParams = await runPluginChatParams(input, {
                    reasoningEffort: ctx.options.reasoningEffort,
                    maxCompletionTokens: ctx.options.maxCompletionTokens
                });
                Object.assign(ctx.options, {
                    reasoningEffort: pluginParams.reasoningEffort,
                    maxCompletionTokens: pluginParams.maxCompletionTokens
                });
            },
            { onError: 'throw' }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.beforeSkillLoad(
            async (ctx) => {
                return await runPluginBeforeSkillLoad(ctx);
            },
            { onError: 'throw' }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.afterSkillLoad(async (ctx) => {
            await runPluginAfterSkillLoad(ctx);
        })
    );
    disposeAikernelHooks.push(
        GlobalHooks.beforeToolCallValidate(async ({ task, toolCall }) => {
            return await runPluginBeforeToolCallValidate(task, toolCall);
        })
    );
    disposeAikernelHooks.push(
        GlobalHooks.beforeToolCall(async ({ task, toolCall }) => {
            return await runPluginBeforeToolCall(task, toolCall);
        })
    );
    disposeAikernelHooks.push(
        GlobalHooks.afterToolCall(
            async ({ task, toolCall }) => {
                await runPluginAfterToolCall(task, toolCall);
            },
            { priority: MAX_HOOK_PRIORITY }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.afterToolsetBuild(async ({ toolsets, task }) => {
            await applyPluginToolDefinitions(toolsets, task);
        })
    );
    disposeAikernelHooks.push(
        GlobalHooks.beforePermissionAsk(
            async ({ task, toolCall, permissions, action }) => {
                action.decision = await runPluginBeforePermissionAsk(task, {
                    tool: toolCall.tool_name,
                    callId: toolCall.id,
                    permissions
                });
            },
            { onError: 'throw' }
        )
    );
    disposeApplicationEventBridge ??= ApplicationRegistry.onApplicationEvent((application, event, args) => {
        getPluginHost().publishApplicationEvent({ application, event, args });
    });
    const host = getPluginHost();
    const configDir = getOpendeskDirectory();
    const candidates = configuredCandidates();
    for (const candidate of candidates) {
        await loadCandidate(host, candidate, configDir);
    }
    await syncPluginAgentsWithRegistry();
    notifyPluginMcpServersChanged();
}

async function loadCandidate(
    host: ReturnType<typeof getPluginHost>,
    candidate: ResolvedCandidate,
    baseDirectory: string
): Promise<void> {
    if (candidate.blockedCode) {
        host.recordError({
            id: candidate.id,
            origin: candidate.origin,
            integrity: candidate.integrity,
            code: candidate.blockedCode,
            stage: 'validate',
            detail: candidate.blockedDetail
        });
        return;
    }
    try {
        const loaded = await loadPlugin(candidate, baseDirectory, {
            requireDeclaration: candidate.requireDeclaration
        });
        // 平台不匹配属于正常跳过场景：记录警告即可，不进入运行时与已安装插件列表。
        const platforms = loaded.plugin.platforms;
        if (platforms && platforms.length > 0 && !platforms.includes(process.platform as PluginPlatform)) {
            logger.warn(
                `Skipping OpenDesk plugin: ${candidate.id} (unsupported platform ${process.platform}, declared: ${platforms.join(', ')})`
            );
            return;
        }
        await host.activate(loaded.plugin, {
            origin: candidate.origin,
            configDir: getOpendeskDirectory(),
            options: candidate.options,
            grantedCapabilities: candidate.grantedCapabilities,
            hostVersion: OPENDESK_RUNTIME_VERSION,
            integrity: candidate.integrity,
            pluginDir: loaded.rootDir,
            resources: loaded.resources
        });
    } catch (error) {
        if (candidate.requireDeclaration && isMissingDeclaration(error)) return;
        const detail = error instanceof Error ? error.message : String(error);
        const stage =
            detail === 'plugin.entry_not_found' || detail === 'plugin.entry_outside_root' ? 'resolve' : 'load';
        host.recordError({
            id: candidate.id,
            origin: candidate.origin,
            integrity: candidate.integrity,
            code: detail.startsWith('plugin.') ? detail : 'plugin.load_failed',
            stage,
            detail
        });
        logger.error(`Failed to load OpenDesk plugin: ${candidate.spec}`, error);
    }
}

export function initializePluginHost(): Promise<void> {
    initialization ??= initialize();
    return initialization;
}

export async function disposePluginHost(): Promise<void> {
    disposeAikernelHooks.forEach((dispose) => dispose());
    disposeAikernelHooks = [];
    disposePluginMcpProvider();
    await getPluginHost().dispose();
    await disposePluginMcpRuntime();
    await AgentRegistry.unloadPluginAgents();
    disposePluginContributions();
    disposeApplicationEventBridge?.();
    disposeApplicationEventBridge = undefined;
    initialization = undefined;
}

export async function reloadPluginHost(): Promise<void> {
    await disposePluginHost();
    await initializePluginHost();
    notifyPluginSkillsChanged();
    const globalState = GlobalState.getCurrentInstance();
    if (!globalState) return;
    // 仅刷新已完全加载（正在使用/运行）任务的工具集。懒加载任务未在内存中运行，
    // 其 toolsets 为空，下一次被实际使用时 buildToolsets 会按最新插件配置重建，
    // 无需在此刻强制 ensureLoaded() 触发全量磁盘读取（否则会批量打印
    // "chat_context accessed on not-fully-loaded task" 防御性加载警告）。
    const fullyLoadedTasks = globalState.taskManagerState.tasks.filter((task) => task._fullyLoaded);
    const refreshes = await Promise.allSettled(
        fullyLoadedTasks.map(async (task) => {
            await task.refreshToolsets();
        })
    );
    for (let index = 0; index < refreshes.length; index++) {
        const result = refreshes[index];
        if (result.status === 'rejected') {
            logger.error(
                `Failed to refresh tools after plugin reload: ${fullyLoadedTasks[index]?.task_id}`,
                result.reason
            );
        }
    }
}
