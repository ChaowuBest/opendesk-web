/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { GlobalHooks, MAX_HOOK_PRIORITY } from '../../../aikernel/hooks.js';
import { GlobalState } from '../../../aikernel/states/global.js';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import { getPluginHost } from './host.js';
import { loadPlugin, OPENDESK_RUNTIME_VERSION, type PluginCandidate } from '../discovery/loader.js';
import { getPluginManagerConfig, getRuntimePluginDirectories } from '../management/config.js';
import { discoverPlugins, verifyPluginRecord } from '../discovery/discovery.js';
import { getPluginRecord } from '../management/registry.js';
import {
    runPluginAfterToolCall,
    runPluginBeforeToolCall,
    runPluginChatHeaders,
    runPluginChatMessage,
    runPluginChatMessagesTransform,
    runPluginChatParams,
    runPluginAfterSkillLoad,
    runPluginBeforeSkillLoad,
    runPluginPermissionAsk,
    runPluginShellEnv
} from './hooks.js';
import { applyPluginToolDefinitions } from './tool-provider.js';
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
        if (!candidate.managed) return candidate;
        const record = getPluginRecord(candidate.id, configDir);
        if (!record) return candidate;
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

async function initialize(): Promise<void> {
    initializePluginContributions();
    initializePluginMcpProvider();
    disposeAikernelHooks.forEach((dispose) => dispose());
    disposeAikernelHooks = [];
    disposeAikernelHooks.push(
        GlobalHooks.registerChatHeaders(
            async (input, output) => {
                output.headers = await runPluginChatHeaders(input, output.headers);
            },
            { onError: 'throw' }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.registerChatParams(
            async (input, output) => {
                Object.assign(output, await runPluginChatParams(input, output));
            },
            { onError: 'throw' }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.registerChatMessage(
            async (input, output) => {
                output.text = await runPluginChatMessage(input, output.text);
            },
            { onError: 'throw' }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.registerChatMessagesTransform(
            async (input, context) => {
                return await runPluginChatMessagesTransform(input, context);
            },
            { onError: 'throw' }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.registerBeforeSkillLoad(
            async (context) => {
                return await runPluginBeforeSkillLoad(context);
            },
            { onError: 'throw' }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.registerAfterSkillLoad(async (context) => {
            await runPluginAfterSkillLoad(context);
        })
    );
    disposeAikernelHooks.push(
        GlobalHooks.registerToolCallInterceptor(async (task, toolCall, args) => {
            return await runPluginBeforeToolCall(task, toolCall, args);
        })
    );
    disposeAikernelHooks.push(
        GlobalHooks.afterToolCall(
            async (task, toolCall) => {
                await runPluginAfterToolCall(task, toolCall);
            },
            { priority: MAX_HOOK_PRIORITY }
        )
    );
    disposeAikernelHooks.push(
        GlobalHooks.registerToolDefinitions(async (toolsets, task) => {
            await applyPluginToolDefinitions(toolsets, task);
        })
    );
    disposeAikernelHooks.push(
        GlobalHooks.registerPermissionAsk(
            async (task, input, output) => {
                output.decision = await runPluginPermissionAsk(task, input);
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
        await host.activate(loaded.plugin, {
            origin: candidate.origin,
            configDir: getOpendeskDirectory(),
            options: candidate.options,
            grantedCapabilities: candidate.grantedCapabilities,
            hostVersion: OPENDESK_RUNTIME_VERSION,
            integrity: candidate.integrity,
            pluginDir: loaded.rootDir,
            contributions: loaded.contributions
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
    const refreshes = await Promise.allSettled(
        globalState.taskManagerState.tasks.map(async (task) => {
            await task.refreshToolsets();
        })
    );
    for (let index = 0; index < refreshes.length; index++) {
        const result = refreshes[index];
        if (result.status === 'rejected') {
            logger.error(
                `Failed to refresh tools after plugin reload: ${globalState.taskManagerState.tasks[index]?.task_id}`,
                result.reason
            );
        }
    }
}
