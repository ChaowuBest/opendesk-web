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
import { getLocale, t } from '../../../locale/index.js';
import {
    resolvePluginDisplayName,
    resolvePluginLocalizedText,
    type PluginDisplayName,
    type PluginLocalizedText
} from '../../../../packages/plugin-sdk/src/index.js';

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
    removable?: boolean;
    enabled?: boolean;
    manifest?: {
        displayName?: PluginDisplayName;
        description?: PluginLocalizedText;
        version?: string;
        apiVersion?: number;
        capabilities?: string[];
    };
    runtime?: {
        displayName?: PluginDisplayName;
        description?: PluginLocalizedText;
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

/** 按当前语言解析插件显示名：runtime 优先，其次 manifest，最后回退插件 ID */
function resolvedDisplayName(plugin: PluginView): string {
    const locale = getLocale();
    return (
        resolvePluginDisplayName(plugin.runtime?.displayName, locale) ??
        resolvePluginDisplayName(plugin.manifest?.displayName, locale) ??
        plugin.id
    );
}

/** 将 view 中 manifest/runtime 声明的本地化字段（displayName / description）就地解析为当前语言的字符串 */
function withResolvedLocalizedFields(plugin: PluginView): PluginView {
    const locale = getLocale();
    const asString = (value?: PluginDisplayName | PluginLocalizedText) =>
        value === undefined ? undefined : resolvePluginLocalizedText(value, locale);
    return {
        ...plugin,
        manifest: plugin.manifest
            ? {
                  ...plugin.manifest,
                  displayName: asString(plugin.manifest.displayName),
                  description: asString(plugin.manifest.description)
              }
            : undefined,
        runtime: plugin.runtime
            ? {
                  ...plugin.runtime,
                  displayName: asString(plugin.runtime.displayName),
                  description: asString(plugin.runtime.description)
              }
            : undefined
    };
}

function summarizePlugin(plugin: PluginView): Record<string, unknown> {
    const locale = getLocale();
    return {
        id: plugin.id,
        displayName: resolvedDisplayName(plugin),
        description:
            resolvePluginLocalizedText(plugin.runtime?.description, locale) ??
            resolvePluginLocalizedText(plugin.manifest?.description, locale),
        source: plugin.source,
        removable: plugin.removable ?? false,
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

const PluginSourceSchema = z.enum(['builtin', 'local', 'external']);
const ListPluginsArgsSchema = z.object({
    source: PluginSourceSchema.optional().describe('Optional plugin source filter'),
    enabled: z.boolean().optional().describe('Optional enabled-state filter')
});

export class ListPluginsTool extends BaseTool<typeof ListPluginsArgsSchema> {
    constructor(private readonly pluginApp: PluginManagementApplication) {
        super(
            'listPlugins',
            'List discovered OpenDesk plugins with their source, version, enabled state and runtime status.',
            ListPluginsArgsSchema,
            'tools.pluginmgr.listPlugins.name'
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
            GetPluginDetailsArgsSchema,
            'tools.pluginmgr.getPluginDetails.name'
        );
        this.setExecutor(this.get.bind(this));
    }

    getDeclaredPermissions(args: z.output<typeof GetPluginDetailsArgsSchema>): PermissionRequest[] {
        return [{ resourceType: 'plugin', action: 'read', resourcePath: args.id }];
    }

    private async get(args: z.output<typeof GetPluginDetailsArgsSchema>): Promise<string> {
        const plugin = asPluginViews(await this.pluginApp.list()).find((entry) => entry.id === args.id);
        if (!plugin) throw new Error(t('plugin.notFound', { id: args.id }));
        return serialize({ plugin: withResolvedLocalizedFields(plugin) });
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
            'Install an OpenDesk plugin into the plugins directory from a local directory, TGZ, URL or npm package spec.',
            InstallPluginArgsSchema,
            'tools.pluginmgr.installPlugin.name'
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
    id: z.string().trim().min(1).describe('Plugin ID')
});

export class UninstallPluginTool extends BaseTool<typeof UninstallPluginArgsSchema> {
    constructor(private readonly pluginApp: PluginManagementApplication) {
        super(
            'uninstallPlugin',
            'Uninstall an OpenDesk plugin by ID. Builtin and external plugins cannot be uninstalled.',
            UninstallPluginArgsSchema,
            'tools.pluginmgr.uninstallPlugin.name'
        );
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
        super(
            'setPluginEnabled',
            'Enable or disable a discovered OpenDesk plugin.',
            SetPluginEnabledArgsSchema,
            'tools.pluginmgr.setPluginEnabled.name'
        );
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
            ReloadPluginsArgsSchema,
            'tools.pluginmgr.reloadPlugins.name'
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
