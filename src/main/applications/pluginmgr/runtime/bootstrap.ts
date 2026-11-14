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
import { loadPlugin } from '../discovery/loader.js';
import { declaresManifestControlFields } from '../discovery/manifest.js';
import { OPENDESK_RUNTIME_VERSION } from '../../../utils/version.js';
import { discoverPlugins, verifyPluginRecord, type DiscoveredPluginCandidate } from '../discovery/discovery.js';
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
    runPluginTaskReview
} from './hooks.js';
import { applyPluginToolDefinitions } from './tool-provider.js';
import { PluginAgent } from './agent.js';
import { disposePluginContributions, initializePluginContributions, PLUGIN_SKILL_BUNDLE } from './contributions.js';
import { registerPluginSkillServerResync, syncPluginSkillServers } from './skill-mcp.js';
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

/**
 * 安装落盘的独立串行队列。
 *
 * 安装会把 staging 目录提交到 `plugins/<id>`，两个并发安装可能互相踩踏；但安装耗时
 * （npm install / 解压）远高于其它插件操作，不能占用 `hostOperation`——否则一次慢安装
 * 会把期间所有插件启停与重载都堵住。
 */
let installOperation: Promise<unknown> = Promise.resolve();

function serializeInstallOperation<T>(task: () => Promise<T>): Promise<T> {
    const next = installOperation.then(task, task);
    installOperation = next.then(
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

interface ResolvedCandidate extends DiscoveredPluginCandidate {
    requireDeclaration?: boolean;
    blockedCode?: string;
    blockedDetail?: string;
}

/** 按当前配置发现全部插件候选（默认内置目录 / 附加插件目录 / plugins 目录） */
function discoverConfiguredPlugins(): ReturnType<typeof discoverPlugins> {
    return discoverPlugins({ configDirectory: getOpendeskDirectory() });
}

/**
 * 收集当前应加载的插件候选。
 * @param recordConflicts 是否把发现冲突记入宿主诊断。差量路径重复调用同一发现逻辑时
 *   关闭该项，避免同一冲突在诊断里累积成多条记录。
 */
function configuredCandidates(recordConflicts = true): ResolvedCandidate[] {
    const configDir = getOpendeskDirectory();
    const discovery = discoverConfiguredPlugins();
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
    return discovery.candidates.map((candidate) => resolveCandidate(candidate, configDir));
}

/** 为单个发现结果补齐完整性校验信息（仅对记录了基线的插件做哈希） */
function resolveCandidate(candidate: DiscoveredPluginCandidate, configDir: string): ResolvedCandidate {
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
}

/**
 * 只解析目标插件的候选（差量路径用）。
 *
 * 与 configuredCandidates 的区别是不对其它已安装插件做完整性哈希：差量操作只关心一个
 * 插件，没必要为整个 plugins 目录重算 sha256。
 */
function findCandidate(id: string): ResolvedCandidate | undefined {
    const hit = discoverConfiguredPlugins().candidates.find((candidate) => candidate.id === id);
    return hit ? resolveCandidate(hit, getOpendeskDirectory()) : undefined;
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
    // 注册全局 worker 崩溃重启后的内部 MCP server 重同步（幂等），随后完成首次全量登记
    registerPluginSkillServerResync();
    await syncPluginSkillServers();
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
    // 清单固定禁用的内置插件（system: true + enabled: false）不属于加载失败，静默跳过；
    // 它与用户开关无关，pluginmgr 也不允许把它打开。
    if (!candidate.enabled) {
        logger.info(`Skipping OpenDesk plugin fixed as disabled: ${candidate.id}`);
        return undefined;
    }
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
        // system/enabled 只对内置插件生效：后装插件声明这两个字段时告警并忽略
        if (candidate.source !== 'builtin' && declaresManifestControlFields(loaded.manifest)) {
            logger.warn(
                `Ignoring "system"/"enabled" in plugin manifest: ${candidate.id} (only builtin plugins can fix their enabled state)`
            );
        }
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
            resources: loaded.resources,
            source: candidate.source
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
    try {
        // 与差量路径不同，这里 agents / MCP 服务器已由 initialize 同步过，
        // 只补齐技能与工具集，避免重复 dispose + 重建插件 Agent
        notifyPluginSkillsChanged();
        notifyPluginMcpRegistriesChanged();
        await refreshTaskToolsets();
    } catch (error) {
        // 收尾 best-effort：实例此时已全部重建，刷新失败不该让调用方以为重载失败
        logger.warn('Plugin registries refresh failed after reload', error);
    }
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
        const candidate = findCandidate(id);
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
    await syncPluginDerivedRegistriesSafely(enabled ? 'enable' : 'disable');
}

/**
 * 单插件变更后的差量收尾：原地刷新由插件派生的注册表，不重启任何插件实例。
 *
 * 全量 reload 会重新 import 并 setup 所有插件（内置渠道插件尤其重），在卸载这类
 * 交互中会把主进程阻塞数秒，所以能差量就不要全量。
 */
async function syncPluginDerivedRegistries(): Promise<void> {
    await syncPluginAgentsWithRegistry();
    // 差量启停/安装/卸载后同步插件技能的内部 MCP server（全量 replace，随插件移除而移除）
    await syncPluginSkillServers();
    notifyPluginMcpServersChanged();
    // 插件技能经 SkillRegistry 的 provider 缓存输出，差量启停后按 bundle 定向失效
    SkillRegistry.getInstance().clearCache(PLUGIN_SKILL_BUNDLE);
    notifyPluginSkillsChanged();
    notifyPluginMcpRegistriesChanged();
    await refreshTaskToolsets();
}

/**
 * 差量收尾的 best-effort 版本：收尾失败只记日志，不改变主操作的成败判断。
 *
 * 收尾发生在实例已经加载/释放之后，此刻抛错会反过来改写主操作的结果：成功路径被报成失败
 * （用户会重复安装/卸载），失败路径会掩盖真正的原因（目录被占用、内置插件不可卸载等）。
 * 两种都会让注册表、运行时与用户的认知不一致。
 */
async function syncPluginDerivedRegistriesSafely(operation: string): Promise<void> {
    try {
        await syncPluginDerivedRegistries();
    } catch (error) {
        logger.warn(`Plugin derived registry sync failed after ${operation}`, error);
    }
}

export interface PluginUninstallOutcome {
    success: boolean;
    error?: string;
}

/**
 * 单个插件卸载的差量应用。
 *
 * 顺序很关键：插件运行时可能长期占用自身目录（MCP 子进程 cwd、sqlite、动态 import 的
 * 文件句柄），因此必须先释放目标插件再删除磁盘文件；随后只按差量刷新派生注册表，其他
 * 插件实例保持运行——避免此前 dispose + reload 导致的全量重启与主进程卡顿。
 *
 * 能否卸载由调用方在外层先行检查（`resolveUninstallTarget`），这里再兜住删除失败与异常：
 * 删除没成功就把刚释放的实例装回去，保证运行时与磁盘状态一致。
 *
 * @param remove 实际的删除动作（由 management 层提供）
 */
export function applyPluginUninstall<T extends PluginUninstallOutcome>(
    id: string,
    remove: () => Promise<T>
): Promise<T> {
    return serializeHostOperation(async () => {
        await initializePluginHost();
        // 未在运行（已禁用 / 本就没加载）时没有实例可释放，失败后也就无需装回
        const released = await getPluginHost().deactivate(id);
        let result: T;
        try {
            result = await remove();
        } catch (error) {
            if (released) await restoreReleasedPlugin(id, error);
            await syncPluginDerivedRegistriesSafely('uninstall');
            throw error;
        }
        if (!result.success && released) await restoreReleasedPlugin(id);
        await syncPluginDerivedRegistriesSafely('uninstall');
        return result;
    });
}

/**
 * 把刚释放的插件装回去。
 *
 * 装不回来通常意味着磁盘上的插件目录已经被替换/删除，此时运行实例无法恢复，必须留日志，
 * 否则表现为"插件凭空消失"而调用侧只看到一次普通的失败提示。
 *
 * 只在确实释放过实例时调用：插件本来就没在运行（已禁用、加载失败等）时装不回去是常态，
 * 记一条 warn 只会误导排查。
 */
async function restoreReleasedPlugin(id: string, cause?: unknown): Promise<void> {
    if (await loadCandidateById(id)) return;
    logger.warn(`OpenDesk plugin was released but could not be restored: ${id}`, cause);
}

/** 按 id 加载当前可发现的候选插件；返回是否真的加载成功（被禁用/已删除时为 false） */
async function loadCandidateById(id: string): Promise<boolean> {
    const candidate = findCandidate(id);
    if (!candidate) return false;
    const failure = await loadCandidate(getPluginHost(), candidate, getOpendeskDirectory());
    return failure === undefined;
}

/**
 * 覆盖安装前判断目标 id 的运行实例是否应该提前释放。
 *
 * 内置插件不能被覆盖安装，没必要（也不应该）先把它拆掉再装回来；归档 / npm 源在安装前
 * 拿不到 id（`targetId` 为 undefined），只能装完再释放。
 */
function releasableTargetId(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return findCandidate(id)?.source === 'builtin' ? undefined : id;
}

export interface PluginInstallOutcome {
    success: boolean;
    id?: string;
}

/**
 * 单个插件安装的差量应用。
 *
 * 覆盖安装必须先释放旧实例：插件运行时会占用自身目录（动态 import 的模块文件、MCP 子进程
 * cwd 等），Windows 下直接替换目录会 rename 失败。因此在调用 `install` 之前先按
 * `targetId` 释放（本地目录源可以在安装前解析出 id）。
 *
 * 落盘动作（npm install / 解压）不占用插件宿主的串行队列：它可能耗时数十秒，期间启停、
 * 重载等其他插件操作不应被阻塞。并发安装之间用独立的互斥串行。
 *
 * 安装失败会把被释放的旧实例装回去；安装成功只加载目标插件，其他插件实例不重启。
 */
export function applyPluginInstall<T extends PluginInstallOutcome>(
    targetId: string | undefined,
    install: () => Promise<T>
): Promise<T> {
    return serializeInstallOperation(async () => {
        const released = await serializeHostOperation(async () => {
            await initializePluginHost();
            const releasable = releasableTargetId(targetId);
            if (!releasable) return undefined;
            // 只有真的拆掉了实例才需要（也才可能）装回去
            return (await getPluginHost().deactivate(releasable)) ? releasable : undefined;
        });
        let result: T;
        try {
            result = await install();
        } catch (error) {
            if (released) {
                await serializeHostOperation(async () => {
                    await restoreReleasedPlugin(released, error);
                    await syncPluginDerivedRegistriesSafely('install failure');
                });
            }
            throw error;
        }
        const installedId = result.success ? result.id : undefined;
        await serializeHostOperation(async () => {
            if (!installedId) {
                // 安装失败：磁盘内容通常未变，把刚释放的旧实例装回去
                if (released) await restoreReleasedPlugin(released);
                await syncPluginDerivedRegistriesSafely('install failure');
                return;
            }
            // 归档 / npm 源先前无法解析 id，这里补一次释放（新装时是无操作）
            await getPluginHost().deactivate(installedId);
            await loadCandidateById(installedId);
            // 装出来的 id 与预先解析的不一致（源未声明 id 时会退化成用目录名推断）时，
            // 说明刚才释放的是另一个插件，必须装回去，否则它会凭空从运行时消失
            if (released && released !== installedId) await restoreReleasedPlugin(released);
            await syncPluginDerivedRegistriesSafely('install');
        });
        return result;
    });
}
