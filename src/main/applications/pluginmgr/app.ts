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
import { getOpendeskDirectory } from '../../utils/setting.js';
import { disposePluginHost, initializePluginHost, reloadPluginHost } from './runtime/bootstrap.js';
import { discoverPlugins } from './discovery/discovery.js';
import { getPluginHost } from './runtime/host.js';
import { resolvePluginEntry } from './discovery/loader.js';
import { loadPluginContributions, readPluginManifest, type PluginManifest } from './discovery/manifest.js';
import {
    installPlugin,
    listInstalledPlugins,
    setPluginEnabled,
    uninstallPlugin,
    verifyInstalledPlugin
} from './management/manager.js';
import { setPluginGrantedCapabilities, setPluginOptions } from './management/policy.js';
import { listPluginRecords } from './management/registry.js';
import type { PluginCapability } from '../../../../packages/plugin/src/index.js';
import { getRuntimePluginDirectories } from './management/config.js';
import { getBuiltinPluginsDirectory, getPluginsDirectory } from './management/paths.js';
import { formatPluginInstallError } from './management/errors.js';
import { t } from './locale/index.js';
import { t as translate } from '../../../locale/index.js';
import { getManagePluginsSkill } from './skills.js';
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

    constructor() {
        super('pluginmgr');
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
            }
        ];
    }

    async getSkills(): Promise<Skill[]> {
        const managePluginsSkill = Skill.parseMd(getManagePluginsSkill());
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
        const ids = new Set([...runtimeById.keys(), ...records.map((record) => record.id), ...candidatesById.keys()]);
        return Array.from(ids)
            .sort()
            .map((id) => {
                const record = records.find((candidate) => candidate.id === id);
                const candidate = candidatesById.get(id);
                let skills = skillsByPlugin.get(id)?.map(({ definition }) => definition) ?? [];
                let mcpServers = mcpServersByPlugin.get(id)?.map(({ definition }) => definition) ?? [];
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
                        if (skills.length === 0 && mcpServers.length === 0) {
                            const contributions = loadPluginContributions(manifest, resolved.rootDir);
                            skills = contributions.skills ?? [];
                            mcpServers = contributions.mcpServers ?? [];
                        }
                    } catch {
                        // Runtime diagnostics already describe malformed or unavailable plugins.
                    }
                }
                return {
                    id,
                    source: record?.source ?? candidate?.source ?? 'local',
                    path: candidate?.spec ?? record?.path,
                    managed: record?.source === 'managed',
                    enabled: record?.enabled ?? true,
                    installedAt: record?.installedAt,
                    spec: record?.spec,
                    verification: record?.source === 'managed' ? verifyInstalledPlugin(id) : undefined,
                    runtime: runtimeById.get(id),
                    manifest: manifest
                        ? {
                              displayName: manifest.displayName,
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
                    }))
                };
            });
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
                result.error === 'plugin.uninstall_unmanaged'
                    ? translate('plugin.uninstall.unmanaged', { id })
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

    async beforeExit(): Promise<void> {
        await disposePluginHost();
    }
}
