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

import { z } from 'zod';
import { t } from '../../../locale/index.js';

import { BaseTool } from '../../aikernel/tool.js';
import type { PermissionRequest } from '../../aikernel/types/index.js';

interface PluginManagementApplication {
    list(): Promise<unknown>;
    install(spec: string): Promise<unknown>;
    uninstall(id: string): Promise<unknown>;
    setEnabled(id: string, enabled: boolean): Promise<unknown>;
    reload(id?: string): Promise<unknown>;
}

interface PluginView {
    id: string;
    source?: string;
    managed?: boolean;
    enabled?: boolean;
    manifest?: {
        displayName?: string;
        version?: string;
        apiVersion?: number;
        capabilities?: string[];
    };
    runtime?: {
        displayName?: string;
        version?: string;
        apiVersion?: number;
        status?: string;
        capabilities?: string[];
    };
    [key: string]: unknown;
}

function isPluginView(value: unknown): value is PluginView {
    return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

function asPluginViews(value: unknown): PluginView[] {
    return Array.isArray(value) ? value.filter(isPluginView) : [];
}

function summarizePlugin(plugin: PluginView): Record<string, unknown> {
    return {
        id: plugin.id,
        displayName: plugin.manifest?.displayName ?? plugin.runtime?.displayName ?? plugin.id,
        source: plugin.source,
        managed: plugin.managed ?? false,
        enabled: plugin.enabled ?? true,
        version: plugin.manifest?.version ?? plugin.runtime?.version,
        apiVersion: plugin.manifest?.apiVersion ?? plugin.runtime?.apiVersion,
        capabilities: plugin.manifest?.capabilities ?? plugin.runtime?.capabilities ?? [],
        status: plugin.runtime?.status ?? (plugin.enabled === false ? 'disabled' : 'discovered')
    };
}

function serialize(value: unknown): string {
    return JSON.stringify(value ?? null);
}

const PluginSourceSchema = z.enum(['builtin', 'managed', 'local', 'external']);
const ListPluginsArgsSchema = z.object({
    source: PluginSourceSchema.optional().describe('Optional plugin source filter'),
    enabled: z.boolean().optional().describe('Optional enabled-state filter')
});

export class ListPluginsTool extends BaseTool<typeof ListPluginsArgsSchema> {
    constructor(private readonly pluginApp: PluginManagementApplication) {
        super(
            'listPlugins',
            'List discovered OpenDesk plugins with their source, version, enabled state and runtime status.',
            ListPluginsArgsSchema
        );
        this.setExecutor(this.list.bind(this));
    }

    getDeclaredPermissions(): PermissionRequest[] {
        return [{ resourceType: 'plugin', action: 'read', resourcePath: '**' }];
    }

    private async list(args: z.output<typeof ListPluginsArgsSchema>): Promise<string> {
        const plugins = asPluginViews(await this.pluginApp.list())
            .filter((plugin) => args.source === undefined || plugin.source === args.source)
            .filter((plugin) => args.enabled === undefined || (plugin.enabled ?? true) === args.enabled)
            .map(summarizePlugin);
        return serialize({ plugins });
    }
}

const GetPluginDetailsArgsSchema = z.object({
    id: z.string().trim().min(1).describe('Plugin ID')
});

export class GetPluginDetailsTool extends BaseTool<typeof GetPluginDetailsArgsSchema> {
    constructor(private readonly pluginApp: PluginManagementApplication) {
        super(
            'getPluginDetails',
            'Get one OpenDesk plugin including its manifest, Skills, MCP servers, capabilities and verification state.',
            GetPluginDetailsArgsSchema
        );
        this.setExecutor(this.get.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof GetPluginDetailsArgsSchema>): PermissionRequest[] {
        return [{ resourceType: 'plugin', action: 'read', resourcePath: args.id }];
    }

    private async get(args: z.output<typeof GetPluginDetailsArgsSchema>): Promise<string> {
        const plugin = asPluginViews(await this.pluginApp.list()).find((entry) => entry.id === args.id);
        if (!plugin) throw new Error(t('plugin.notFound', { id: args.id }));
        return serialize({ plugin });
    }
}

const InstallPluginArgsSchema = z.object({
    spec: z
        .string()
        .trim()
        .min(1)
        .describe('OpenDesk plugin source: local directory, TGZ path, URL, or npm package spec')
});

export class InstallPluginTool extends BaseTool<typeof InstallPluginArgsSchema> {
    constructor(private readonly pluginApp: PluginManagementApplication) {
        super(
            'installPlugin',
            'Install a managed OpenDesk plugin from a local directory, TGZ, URL or npm package spec.',
            InstallPluginArgsSchema
        );
        this.serialExecution = true;
        this.setExecutor(this.install.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof InstallPluginArgsSchema>): PermissionRequest[] {
        return [
            { resourceType: 'plugin', action: 'write', resourcePath: args.spec },
            { resourceType: 'plugin', action: 'execute', resourcePath: args.spec }
        ];
    }

    private async install(args: z.output<typeof InstallPluginArgsSchema>): Promise<string> {
        return serialize(await this.pluginApp.install(args.spec));
    }
}

const UninstallPluginArgsSchema = z.object({
    id: z.string().trim().min(1).describe('Managed plugin ID')
});

export class UninstallPluginTool extends BaseTool<typeof UninstallPluginArgsSchema> {
    constructor(private readonly pluginApp: PluginManagementApplication) {
        super('uninstallPlugin', 'Uninstall a managed OpenDesk plugin by ID.', UninstallPluginArgsSchema);
        this.serialExecution = true;
        this.setExecutor(this.uninstall.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof UninstallPluginArgsSchema>): PermissionRequest[] {
        return [{ resourceType: 'plugin', action: 'write', resourcePath: args.id }];
    }

    private async uninstall(args: z.output<typeof UninstallPluginArgsSchema>): Promise<string> {
        return serialize(await this.pluginApp.uninstall(args.id));
    }
}

const SetPluginEnabledArgsSchema = z.object({
    id: z.string().trim().min(1).describe('Plugin ID'),
    enabled: z.boolean().describe('Enable with true or disable with false')
});

export class SetPluginEnabledTool extends BaseTool<typeof SetPluginEnabledArgsSchema> {
    constructor(private readonly pluginApp: PluginManagementApplication) {
        super('setPluginEnabled', 'Enable or disable a discovered OpenDesk plugin.', SetPluginEnabledArgsSchema);
        this.serialExecution = true;
        this.setExecutor(this.setEnabled.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof SetPluginEnabledArgsSchema>): PermissionRequest[] {
        const permissions: PermissionRequest[] = [{ resourceType: 'plugin', action: 'write', resourcePath: args.id }];
        if (args.enabled) {
            permissions.push({ resourceType: 'plugin', action: 'execute', resourcePath: args.id });
        }
        return permissions;
    }

    private async setEnabled(args: z.output<typeof SetPluginEnabledArgsSchema>): Promise<string> {
        await this.pluginApp.setEnabled(args.id, args.enabled);
        return serialize({ success: true, id: args.id, enabled: args.enabled });
    }
}

const ReloadPluginsArgsSchema = z.object({});

export class ReloadPluginsTool extends BaseTool<typeof ReloadPluginsArgsSchema> {
    constructor(private readonly pluginApp: PluginManagementApplication) {
        super(
            'reloadPlugins',
            'Rediscover and reload all OpenDesk plugins, including external and runtime plugin directories.',
            ReloadPluginsArgsSchema
        );
        this.serialExecution = true;
        this.setExecutor(this.reload.bind(this));
    }

    getDeclaredPermissions(): PermissionRequest[] {
        return [{ resourceType: 'plugin', action: 'execute', resourcePath: '**' }];
    }

    private async reload(): Promise<string> {
        const plugins = asPluginViews(await this.pluginApp.reload());
        return serialize({ success: true, plugins: plugins.map(summarizePlugin) });
    }
}
