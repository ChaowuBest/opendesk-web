/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import { z } from 'zod';
import type { Command } from 'commander';
import path from 'path';
import { BaseApplication, type EventDecl } from '../base.js';
import { Skill } from '../../aikernel/skill.js';
import { BaseToolset } from '../../aikernel/tool.js';
import { registerPluginsCommand } from '../../tui/subcommands/plugins.js';
import { getOpendeskDirectory, Setting } from '../../utils/setting.js';
import { GlobalState } from '../../aikernel/states/global.js';
import { disposePluginHost, initializePluginHost, reloadPluginHost } from './runtime/bootstrap.js';
import { discoverPlugins } from './discovery/discovery.js';
import { getPluginHost } from './runtime/host.js';
import { pluginCommandAcceptsArgs } from './runtime/command-arguments.js';
import { getPluginToolLocalName } from './runtime/tool-names.js';
import { resolvePluginEntry } from './discovery/loader.js';
import { loadPluginResources, readPluginManifest, type PluginManifest } from './discovery/manifest.js';
import {
    installPlugin,
    listInstalledPlugins,
    setPluginEnabled,
    uninstallPlugin,
    verifyInstalledPlugin
} from './management/manager.js';
import { setPluginGrantedCapabilities, setPluginOptions } from './management/policy.js';
import { listPluginRecords } from './management/registry.js';
import type { PluginCapability, PluginPlatform } from '../../../../packages/plugin-sdk/src/index.js';
import { getRuntimePluginDirectories } from './management/config.js';
import { getBuiltinPluginsDirectory, getPluginsDirectory } from './management/paths.js';
import { formatPluginInstallError } from './management/errors.js';
import { t } from './locale/index.js';
import { t as translate, getLocale } from '../../../locale/index.js';
import { MANAGE_PLUGINS_SKILL } from './skills.js';
import {
    GetPluginDetailsTool,
    InstallPluginTool,
    ListPluginsTool,
    ReloadPluginsTool,
    SetPluginEnabledTool,
    UninstallPluginTool
} from './tools.js';

const PluginMgrConfigSchema = z.object({
    externalPaths: z.array(z.string()).default([])
});

export class PluginMgrApplication extends BaseApplication {
    static bundleName = 'pluginmgr';

    private unsubscribeAppearanceChanged: (() => void) | undefined;

    constructor() {
        super('pluginmgr');
        // 插件激活/停用会修改外观覆盖，转发为 appearanceChanged 事件供渲染进程热更新；
        // 本地化名称按当前界面语言解析后下发
        this.unsubscribeAppearanceChanged = getPluginHost().onAppearanceChanged(() => {
            this.emitEvent('appearanceChanged', getPluginHost().listAppearance(getLocale())).catch(() => {});
        });
    }

    getName(): string {
        return t('app.name');
    }

    static getConfigSchema(): z.ZodObject<any> {
        return PluginMgrConfigSchema;
    }

    static registerCliSubcommands(prog: Command): void {
        registerPluginsCommand(prog);
    }

    toJSON(): Record<string, unknown> {
        return {
            ...super.toJSON(),
            source: 'system',
            removable: false,
            active: true
        };
    }

    async getSupportedEvents(): Promise<EventDecl[]> {
        return [
            {
                eventName: 'pluginsChanged',
                eventDescription: t('app.event.pluginsChanged')
            },
            {
                eventName: 'appearanceChanged',
                eventDescription: t('app.event.appearanceChanged')
            }
        ];
    }

    async getSkills(): Promise<Skill[]> {
        const managePluginsSkill = Skill.parseMd(MANAGE_PLUGINS_SKILL);
        const toolset = new BaseToolset('plugin-management');
        toolset.addTool(new ListPluginsTool(this));
        toolset.addTool(new GetPluginDetailsTool(this));
        toolset.addTool(new InstallPluginTool(this));
        toolset.addTool(new UninstallPluginTool(this));
        toolset.addTool(new SetPluginEnabledTool(this));
        toolset.addTool(new ReloadPluginsTool(this));
        managePluginsSkill.toolsets = [toolset];
        return [managePluginsSkill];
    }

    async list() {
        await initializePluginHost();
        const runtimeById = new Map(
            getPluginHost()
                .list()
                .map((entry) => [entry.id, entry])
        );
        const configDirectory = getOpendeskDirectory();
        const builtinDirectory = getBuiltinPluginsDirectory();
        const records = listPluginRecords();
        const discovery = discoverPlugins({
            configDirectory,
            externalPaths:
                (this.getConfig() as z.output<typeof PluginMgrConfigSchema> | undefined)?.externalPaths ?? [],
            pluginDirectories: getRuntimePluginDirectories()
        });
        const candidatesById = new Map(discovery.candidates.map((candidate) => [candidate.id, candidate]));
        const skillsByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listSkills']>>();
        for (const skill of getPluginHost().listSkills()) {
            const contributions = skillsByPlugin.get(skill.pluginId) ?? [];
            contributions.push(skill);
            skillsByPlugin.set(skill.pluginId, contributions);
        }
        const mcpServersByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listMcpServers']>>();
        for (const server of getPluginHost().listMcpServers()) {
            const contributions = mcpServersByPlugin.get(server.pluginId) ?? [];
            contributions.push(server);
            mcpServersByPlugin.set(server.pluginId, contributions);
        }
        const toolsByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listTools']>>();
        for (const tool of getPluginHost().listTools()) {
            const contributions = toolsByPlugin.get(tool.pluginId) ?? [];
            contributions.push(tool);
            toolsByPlugin.set(tool.pluginId, contributions);
        }
        const hooksByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listHooks']>>();
        for (const hook of getPluginHost().listHooks()) {
            const contributions = hooksByPlugin.get(hook.pluginId) ?? [];
            if (!contributions.some((candidate) => candidate.name === hook.name)) contributions.push(hook);
            hooksByPlugin.set(hook.pluginId, contributions);
        }
        const agentsByPlugin = new Map<string, ReturnType<ReturnType<typeof getPluginHost>['listAgents']>>();
        for (const agent of getPluginHost().listAgents()) {
            const contributions = agentsByPlugin.get(agent.pluginId) ?? [];
            contributions.push(agent);
            agentsByPlugin.set(agent.pluginId, contributions);
        }
        const browserHintsByPlugin = new Map<
            string,
            ReturnType<ReturnType<typeof getPluginHost>['listBrowserHintPrefixes']>
        >();
        for (const hint of getPluginHost().listBrowserHintPrefixes()) {
            const contributions = browserHintsByPlugin.get(hint.pluginId) ?? [];
            contributions.push(hint);
            browserHintsByPlugin.set(hint.pluginId, contributions);
        }
        const ids = new Set([...runtimeById.keys(), ...records.map((record) => record.id), ...candidatesById.keys()]);
        return Array.from(ids)
            .sort()
            .map((id) => {
                const record = records.find((candidate) => candidate.id === id);
                const candidate = candidatesById.get(id);
                // 'managed' 仅存在于旧版注册表数据中，对外统一归为 local。
                const rawSource = record?.source ?? candidate?.source ?? 'local';
                const source = rawSource === 'managed' ? 'local' : rawSource;
                let skills = skillsByPlugin.get(id)?.map(({ definition }) => definition) ?? [];
                let mcpServers = mcpServersByPlugin.get(id)?.map(({ definition }) => definition) ?? [];
                let agents = agentsByPlugin.get(id)?.map(({ definition }) => definition) ?? [];
                let manifest: PluginManifest | undefined;
                const rootDirectory =
                    record?.source === 'builtin' ? builtinDirectory : getPluginsDirectory(configDirectory);
                const spec =
                    candidate?.spec ??
                    (record
                        ? path.isAbsolute(record.path)
                            ? record.path
                            : path.resolve(rootDirectory, record.path)
                        : undefined);
                if (spec) {
                    try {
                        const resolved = resolvePluginEntry(spec, configDirectory);
                        manifest = readPluginManifest(resolved.entry, resolved.rootDir);
                        if (skills.length === 0 && mcpServers.length === 0 && agents.length === 0) {
                            const resources = loadPluginResources(manifest, resolved.rootDir);
                            skills = resources.skills ?? [];
                            mcpServers = resources.mcpServers ?? [];
                            agents = resources.agents ?? [];
                        }
                    } catch {
                        // Runtime diagnostics already describe malformed or unavailable plugins.
                    }
                }
                // 平台不匹配的插件仅在加载时记录警告（见 bootstrap），不出现在已安装插件列表。
                if (manifest?.platforms?.length && !manifest.platforms.includes(process.platform as PluginPlatform)) {
                    return undefined;
                }
                return {
                    id,
                    source,
                    path: candidate?.spec ?? record?.path,
                    removable: source !== 'builtin' && source !== 'external',
                    enabled: record?.enabled ?? true,
                    installedAt: record?.installedAt,
                    spec: record?.spec,
                    verification: record ? verifyInstalledPlugin(id) : undefined,
                    runtime: runtimeById.get(id),
                    manifest: manifest
                        ? {
                              displayName: manifest.displayName,
                              description: manifest.description,
                              version: manifest.version,
                              apiVersion: manifest.apiVersion,
                              capabilities: manifest.capabilities
                          }
                        : undefined,
                    skills: skills.map((definition) => ({
                        name: definition.name,
                        description: definition.description,
                        directory: definition.directory,
                        userInvocable: definition.userInvocable,
                        modelInvocable: definition.modelInvocable
                    })),
                    mcpServers: mcpServers.map((definition) => ({
                        name: definition.name,
                        transport: definition.transport,
                        command: definition.transport === 'stdio' ? definition.command : undefined,
                        cwd: definition.transport === 'stdio' ? definition.cwd : undefined,
                        url: definition.transport === 'stdio' ? undefined : definition.url
                    })),
                    tools: (toolsByPlugin.get(id) ?? []).map(({ pluginId, definition }) => ({
                        name: getPluginToolLocalName(pluginId, definition.name),
                        description: definition.description
                    })),
                    hooks: (hooksByPlugin.get(id) ?? []).map(({ name }) => ({ name })),
                    browserHints: (browserHintsByPlugin.get(id) ?? []).map(({ urlPrefix }) => ({ urlPrefix })),
                    agents: agents.map((definition) => ({
                        name: definition.name,
                        whenToUse: definition.whenToUse,
                        dispatchable: definition.dispatchable,
                        body: definition.body
                    }))
                };
            })
            .filter((entry) => entry !== undefined);
    }

    async reload(id?: string) {
        await reloadPluginHost();
        this.emitEvent('pluginsChanged', { operation: 'reload', id }).catch(() => {});
        return await this.list();
    }

    async install(spec: string) {
        const result = await installPlugin(spec);
        if (!result.success) throw new Error(formatPluginInstallError(result));
        await reloadPluginHost();
        this.emitEvent('pluginsChanged', { operation: 'install', id: result.id }).catch(() => {});
        return result;
    }

    async uninstall(id: string) {
        await disposePluginHost();
        const result = await uninstallPlugin(id);
        await reloadPluginHost();
        if (!result.success) {
            const message =
                result.error === 'plugin.uninstall_builtin'
                    ? translate('plugin.uninstall.builtin', { id })
                    : result.error === 'plugin.uninstall_external'
                      ? translate('plugin.uninstall.external', { id })
                      : result.error;
            throw new Error(message);
        }
        this.emitEvent('pluginsChanged', { operation: 'uninstall', id }).catch(() => {});
        return result;
    }

    async setEnabled(id: string, enabled: boolean) {
        const config = this.getConfig() as z.output<typeof PluginMgrConfigSchema> | undefined;
        if (
            !setPluginEnabled(id, enabled, {
                externalPaths: config?.externalPaths ?? [],
                pluginDirectories: getRuntimePluginDirectories()
            })
        ) {
            throw new Error(translate('plugin.notFound', { id }));
        }
        await reloadPluginHost();
        this.emitEvent('pluginsChanged', { operation: enabled ? 'enable' : 'disable', id }).catch(() => {});
        return await this.list();
    }

    async setOptions(id: string, options: Record<string, unknown>) {
        const entry = setPluginOptions(id, options);
        await reloadPluginHost();
        this.emitEvent('pluginsChanged', { operation: 'configure', id }).catch(() => {});
        return entry;
    }

    async setGrantedCapabilities(id: string, capabilities: PluginCapability[]) {
        const entry = setPluginGrantedCapabilities(id, capabilities);
        await reloadPluginHost();
        this.emitEvent('pluginsChanged', { operation: 'permissions', id }).catch(() => {});
        return entry;
    }

    /** 当前插件生效的应用外观覆盖，供渲染进程（侧边栏品牌区等）读取；名称按当前界面语言解析 */
    async getAppearance() {
        await initializePluginHost();
        return getPluginHost().listAppearance(getLocale());
    }

    async doctor() {
        await initializePluginHost();
        return {
            runtime: getPluginHost().list(),
            installed: listInstalledPlugins().map((record) => verifyInstalledPlugin(record.id)),
            discovery: discoverPlugins({
                externalPaths:
                    (this.getConfig() as z.output<typeof PluginMgrConfigSchema> | undefined)?.externalPaths ?? []
            })
        };
    }

    async listCommandsForUI() {
        await initializePluginHost();
        return getPluginHost()
            .listCommands()
            .map(({ definition }) => ({
                name: definition.name,
                description: definition.description,
                acceptsArgs: pluginCommandAcceptsArgs(definition)
            }));
    }

    async runCommandForUI(name: string, rawArgs: string, taskId?: string) {
        await initializePluginHost();
        const contribution = getPluginHost()
            .listCommands()
            .find((candidate) => candidate.definition.name === name);
        if (!contribution) throw new Error(translate('plugin.command.notFound', { name }));
        const task = taskId ? GlobalState.getInstance().taskManagerState.getTask(taskId) : undefined;
        return await getPluginHost().runCommand(
            contribution.id,
            { raw: typeof rawArgs === 'string' ? rawArgs : '' },
            {
                taskId: task?.task_id,
                workspace: task?.getWorkspace() || Setting.getInstance().getEffectiveWorkspace(),
                abort: task?.getAbortSignal() ?? new AbortController().signal
            }
        );
    }

    async beforeExit(): Promise<void> {
        this.unsubscribeAppearanceChanged?.();
        this.unsubscribeAppearanceChanged = undefined;
        await disposePluginHost();
    }
}
