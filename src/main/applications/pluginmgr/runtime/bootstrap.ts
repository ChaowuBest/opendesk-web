/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { GlobalHooks, MAX_HOOK_PRIORITY } from '../../../aikernel/hooks.js';
import { GlobalState } from '../../../aikernel/states/global.js';
import { AgentRegistry } from '../../../aikernel/agents/registry.js';
import type { ApplicationAgents } from '../../../aikernel/agents/registry.js';
import type { AgentDefinition } from '../../../aikernel/types/agent.js';
import { SkillRegistry } from '../../../aikernel/skill.js';
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
    runPluginTaskReview,
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
import { disposePluginRegistryProvider, initializePluginRegistryProvider } from './registry-providers.js';
import { ApplicationRegistry } from '../../registry.js';

let initialization: Promise<void> | undefined;
let disposeApplicationEventBridge: (() => void) | undefined;
let disposeAikernelHooks: (() => void)[] = [];

/** 宿主变更操作的串行队列：全量重载与单插件差量启停互斥，避免并发 dispose/initialize */
let hostOperation: Promise<unknown> = Promise.resolve();

function serializeHostOperation<T>(task: () => Promise<T>): Promise<T> {
    const next = hostOperation.then(task, task);
    hostOperation = next.then(
        () => undefined,
        () => undefined
    );
    return next;
}

function notifyPluginSkillsChanged(): void {
    const application = ApplicationRegistry.getApplication('skillmgr') as
        { notifyExternalSkillsChanged?: (bundleName: string) => void } | undefined;
    if (application?.notifyExternalSkillsChanged) {
        application.notifyExternalSkillsChanged(PLUGIN_SKILL_BUNDLE);
    } else {
        ApplicationRegistry.dispatchEvent('skillmgr', 'skillsChanged');
    }
}

function notifyPluginMcpRegistriesChanged(): void {
    // MCP registry tabs are rendered in a long-lived widget. Notify that widget
    // only after the plugin host has finished reloading and its provider snapshot
    // is ready to be queried.
    ApplicationRegistry.dispatchEvent('mcpmgr', 'registriesChanged');
}

interface ResolvedCandidate extends PluginCandidate {
    id: string;
    requireDeclaration?: boolean;
    blockedCode?: string;
    blockedDetail?: string;
}

/**
 * 收集当前应加载的插件候选。
 * @param recordConflicts 是否把发现冲突记入宿主诊断。差量路径重复调用同一发现逻辑时
 *   关闭该项，避免同一冲突在诊断里累积成多条记录。
 */
function configuredCandidates(recordConflicts = true): ResolvedCandidate[] {
    const configDir = getOpendeskDirectory();
    const config = getPluginManagerConfig();
    const discovery = discoverPlugins({
        configDirectory: configDir,
        externalPaths: config.externalPaths,
        pluginDirectories: getRuntimePluginDirectories()
    });
    const host = getPluginHost();
    if (recordConflicts) {
        for (const conflict of discovery.conflicts) {
            host.recordError({
                id: conflict.id,
                origin: configDir,
                code: 'plugin.discovery_conflict',
                stage: 'resolve',
                detail: conflict.paths.join(', ')
            });
        }
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
        agents: agents.map((definition) => {
            // 目录装载的 agent 定义（ExternalAgentDefinition）携带安装位置，
            // 交给 PluginAgent 在 system prompt 中声明；内联注册的定义则无此字段
            const location =
                'location' in definition && typeof definition.location === 'string' ? definition.location : undefined;
            return new PluginAgent(definition, location);
        })
    }));
    await AgentRegistry.replacePluginAgents(sources);
}

async function initialize(): Promise<void> {
    // 让缺少 node_modules 的插件也能从宿主解析到 Plugin SDK（鸿蒙等平台不执行 npm install）
    registerSdkPackageMapping();
    initializePluginContributions();
    initializePluginMcpProvider();
    initializePluginRegistryProvider();
    disposeAikernelHooks.forEach((dispose) => dispose());
    disposeAikernelHooks = [];
    disposeAikernelHooks.push(
        GlobalHooks.beforeChatModelRequest(
            async (ctx) => {
                const input: PluginChatRequestInput = {
                    taskId: ctx.task?.task_id,
                    workspace: ctx.task?.getWorkspace() || undefined,
                    model: {
                        modelAlias: ctx.model.model_name,
                        modelName: ctx.model.model_name,
                        modelType: ctx.model.getModelType(),
                        provider: {
                            baseUrl: ctx.model.base_url,
                            providerType: ctx.model.getProviderType(),
                            providerName: ctx.model.getProviderName()
                        }
                    }
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
        GlobalHooks.onTaskReview(async ({ task, startMessageIndex }) => {
            if (task.parent_id !== null || task.internal === true) return;
            await runPluginTaskReview(task, startMessageIndex);
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

/**
 * 加载单个插件候选。
 * @returns 加载失败时返回失败原因码，成功（含平台不匹配等正常跳过）时返回 undefined
 */
async function loadCandidate(
    host: ReturnType<typeof getPluginHost>,
    candidate: ResolvedCandidate,
    baseDirectory: string
): Promise<string | undefined> {
    if (candidate.blockedCode) {
        host.recordError({
            id: candidate.id,
            origin: candidate.origin,
            integrity: candidate.integrity,
            code: candidate.blockedCode,
            stage: 'validate',
            detail: candidate.blockedDetail
        });
        return candidate.blockedCode;
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
            return 'plugin.platform_unsupported';
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
        return undefined;
    } catch (error) {
        if (candidate.requireDeclaration && isMissingDeclaration(error)) return 'plugin.entry_not_declared';
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
        return detail.startsWith('plugin.') ? detail : 'plugin.load_failed';
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
    disposePluginRegistryProvider();
    await getPluginHost().dispose();
    await disposePluginMcpRuntime();
    await AgentRegistry.unloadPluginAgents();
    disposePluginContributions();
    disposeApplicationEventBridge?.();
    disposeApplicationEventBridge = undefined;
    initialization = undefined;
}

export function reloadPluginHost(): Promise<void> {
    return serializeHostOperation(() => reloadPluginHostInternal());
}

/** 未序列化的全量重载内核：供已持有串行队列的调用方（差量启停的回退路径）使用 */
async function reloadPluginHostInternal(): Promise<void> {
    await disposePluginHost();
    await initializePluginHost();
    notifyPluginSkillsChanged();
    notifyPluginMcpRegistriesChanged();
    await refreshTaskToolsets();
}

/** 仅刷新已完全加载任务的工具集，使其感知插件配置变化 */
async function refreshTaskToolsets(): Promise<void> {
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

/**
 * 单个插件启停的差量应用：只卸载（禁用）或加载（启用）目标插件，其他插件
 * 实例与注册贡献原样保留，避免全量 reload 导致所有插件一起重启。
 *
 * MCP server 贡献的断连/连接由 mcp.ts 的 onMcpServerRemoved 监听与
 * notifyPluginMcpServersChanged 增量处理；渠道类插件的运行时同步由调用方
 * （pluginmgr.setEnabled）广播 pluginsChanged 事件，channelmgr 据插件 id 差量完成。
 *
 * @throws 启用目标插件但加载失败（完整性校验不通过 / 入口缺失 / 平台不支持等）时
 *   抛出失败原因码，避免调用方把未生效的启用当成成功
 */
export function applyPluginEnabledChange(id: string, enabled: boolean): Promise<void> {
    return serializeHostOperation(() => applyPluginEnabledChangeInternal(id, enabled));
}

async function applyPluginEnabledChangeInternal(id: string, enabled: boolean): Promise<void> {
    await initializePluginHost();
    if (enabled) {
        const candidate = configuredCandidates(false).find((entry) => entry.id === id);
        if (!candidate) {
            // 目标插件已不可发现（如安装目录被删除），按语义回退为全量重载
            await reloadPluginHostInternal();
            return;
        }
        // 重复启用（运行时已有同名实例）时跳过，保持幂等
        if (!getPluginHost().get(id)) {
            const failure = await loadCandidate(getPluginHost(), candidate, getOpendeskDirectory());
            if (failure) throw new Error(failure);
            // host.activate 对校验/setup 失败只返回 error/disabled 条目而不抛错，这里统一按失败上报；
            // 同时清掉失败条目，否则下次启用会被上面的幂等判断短路
            if (getPluginHost().get(id)?.status !== 'active') {
                await getPluginHost().deactivate(id);
                throw new Error('plugin.activate_failed');
            }
        }
    } else {
        // 重复禁用（运行时无实例）时无需操作，保持幂等
        await getPluginHost().deactivate(id);
    }
    await syncPluginAgentsWithRegistry();
    notifyPluginMcpServersChanged();
    // 插件技能经 SkillRegistry 的 provider 缓存输出，差量启停后按 bundle 定向失效
    SkillRegistry.getInstance().clearCache(PLUGIN_SKILL_BUNDLE);
    notifyPluginSkillsChanged();
    notifyPluginMcpRegistriesChanged();
    await refreshTaskToolsets();
}
