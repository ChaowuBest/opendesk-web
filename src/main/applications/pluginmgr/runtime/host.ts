/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 */

import fs from 'fs';
import path from 'path';
import type { z } from 'zod';
import { REASONING_EFFORT_VALUES, type ToolDefinition } from '../../../aikernel/types/index.js';
import { getOpendeskDirectory } from '../../../utils/setting.js';
import { logger } from '../../../utils/logger.js';
import type {
    OpenDeskPlugin,
    PluginCapability,
    PluginCommandContext,
    PluginCommandDefinition,
    PluginCommandResult,
    PluginContext,
    PluginFailureMode,
    PluginApplicationEvent,
    PluginApplicationEventCallback,
    PluginApplicationEventFilter,
    PluginHookCallback,
    PluginHookMap,
    PluginHookName,
    PluginHookRegistrationOptions,
    PluginRegistration,
    PluginSkillDefinition,
    PluginMcpServerDefinition,
    PluginStaticContributions
} from '../../../../../packages/plugin-sdk/src/index.js';
import {
    OPENDESK_PLUGIN_API_VERSION,
    OPENDESK_PLUGIN_CAPABILITIES,
    OPENDESK_PLUGIN_HOOK_NAMES
} from '../../../../../packages/plugin-sdk/src/index.js';
import { comparePluginVersions } from '../discovery/manifest.js';
import { qualifyPluginToolName } from './tool-names.js';

export type PluginStatus = 'active' | 'error' | 'disabled';

export interface PluginDiagnostic {
    code: string;
    stage: 'resolve' | 'load' | 'validate' | 'setup' | 'hook' | 'mcp' | 'event' | 'dispose';
    detail?: string;
}

export interface PluginHostEntry {
    id: string;
    displayName?: string;
    version?: string;
    apiVersion: number;
    origin: string;
    failureMode: PluginFailureMode;
    status: PluginStatus;
    requestedCapabilities: PluginCapability[];
    grantedCapabilities: PluginCapability[];
    capabilities: PluginCapability[];
    integrity?: string;
    diagnostics: PluginDiagnostic[];
}

export interface ActivatePluginOptions {
    origin: string;
    configDir?: string;
    options?: Record<string, unknown>;
    grantedCapabilities?: PluginCapability[];
    hostVersion?: string;
    integrity?: string;
    pluginDir?: string;
    contributions?: PluginStaticContributions;
}

export interface RecordPluginErrorOptions extends ActivatePluginOptions {
    id: string;
    code: string;
    stage: PluginDiagnostic['stage'];
    detail?: string;
}

interface HookRecord<Name extends PluginHookName = PluginHookName> {
    pluginKey: string;
    pluginId: string;
    name: Name;
    callback: PluginHookCallback<Name>;
    failureMode: PluginFailureMode;
}

interface ToolRecord {
    pluginKey: string;
    pluginId: string;
    definition: ToolDefinition;
}

interface ContributionRecord<T> {
    id: string;
    pluginKey: string;
    pluginId: string;
    definition: T;
}

export interface VisiblePluginContribution<T> {
    id: string;
    pluginId: string;
    definition: T;
}

interface ActivePlugin extends PluginHostEntry {
    key: string;
    registrations: PluginRegistration[];
}

interface ApplicationEventRecord {
    pluginKey: string;
    pluginId: string;
    filter: PluginApplicationEventFilter;
    callback: PluginApplicationEventCallback;
}

class HostRegistration implements PluginRegistration {
    private disposed = false;

    constructor(private readonly disposeCallback: () => void | Promise<void>) {}

    async dispose(): Promise<void> {
        if (this.disposed) return;
        this.disposed = true;
        await this.disposeCallback();
    }
}

function normalizeToolName(pluginId: string, name: string): string {
    const trimmed = name.trim();
    if (trimmed.startsWith(`${pluginId}.`)) return trimmed;
    return `${pluginId}.${trimmed}`;
}

function validatePluginId(id: string): boolean {
    return /^[a-zA-Z][a-zA-Z0-9._-]*$/.test(id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isValidToolParameters(parameters: unknown): parameters is ToolDefinition['parameters'] {
    if (
        !parameters ||
        (typeof parameters !== 'object' && typeof parameters !== 'function') ||
        typeof (parameters as { safeParse?: unknown }).safeParse !== 'function' ||
        typeof (parameters as { toJSONSchema?: unknown }).toJSONSchema !== 'function'
    ) {
        return false;
    }
    try {
        const parseResult = (parameters as { safeParse(value: unknown): unknown }).safeParse(undefined);
        const jsonSchema = (parameters as { toJSONSchema(): unknown }).toJSONSchema();
        return (
            isRecord(parseResult) &&
            typeof parseResult.success === 'boolean' &&
            isRecord(jsonSchema) &&
            jsonSchema.type === 'object'
        );
    } catch {
        return false;
    }
}

function validatePluginToolDefinition(definition: unknown): asserts definition is ToolDefinition {
    if (!isRecord(definition)) throw new Error('plugin.tool_definition_invalid');

    const name = typeof definition.name === 'string' ? definition.name.trim() : '';
    if (!name) throw new Error('plugin.tool_name_invalid');
    if (typeof definition.description !== 'string' || !definition.description.trim()) {
        throw new Error(`plugin.tool_description_invalid:${name}`);
    }

    if (!isValidToolParameters(definition.parameters)) {
        throw new Error(`plugin.tool_parameters_invalid:${name}`);
    }

    if (typeof definition.execute !== 'function') throw new Error(`plugin.tool_execute_invalid:${name}`);
    if (
        definition.agentIds !== undefined &&
        (!Array.isArray(definition.agentIds) ||
            definition.agentIds.some((agentId) => typeof agentId !== 'string' || !agentId.trim()))
    ) {
        throw new Error(`plugin.tool_agent_ids_invalid:${name}`);
    }
    if (definition.serialExecution !== undefined && typeof definition.serialExecution !== 'boolean') {
        throw new Error(`plugin.tool_serial_execution_invalid:${name}`);
    }
    if (definition.getDeclaredPermissions !== undefined && typeof definition.getDeclaredPermissions !== 'function') {
        throw new Error(`plugin.tool_permissions_invalid:${name}`);
    }
    if (definition.stop !== undefined && typeof definition.stop !== 'function') {
        throw new Error(`plugin.tool_stop_invalid:${name}`);
    }
    if (definition.render !== undefined) {
        if (!isRecord(definition.render)) throw new Error(`plugin.tool_render_invalid:${name}`);
        if (definition.render.gui !== undefined && typeof definition.render.gui !== 'function') {
            throw new Error(`plugin.tool_render_gui_invalid:${name}`);
        }
        if (definition.render.cli !== undefined && typeof definition.render.cli !== 'function') {
            throw new Error(`plugin.tool_render_cli_invalid:${name}`);
        }
    }
}

function cloneValue<T>(value: T): T {
    try {
        return structuredClone(value);
    } catch {
        return value;
    }
}

function cloneHookOutput<Name extends PluginHookName>(
    name: Name,
    output: PluginHookMap[Name]['output']
): PluginHookMap[Name]['output'] {
    const candidate = { ...(output as Record<string, unknown>) };
    if (name === 'chat.headers') {
        candidate.headers = { ...((output as PluginHookMap['chat.headers']['output']).headers ?? {}) };
    } else if (name === 'tool.validate.before') {
        const before = output as PluginHookMap['tool.validate.before']['output'];
        candidate.args = cloneValue(before.args);
        candidate.deny = before.deny
            ? { ...before.deny, metadata: before.deny.metadata ? cloneValue(before.deny.metadata) : undefined }
            : undefined;
    } else if (name === 'tool.execute.before') {
        const before = output as PluginHookMap['tool.execute.before']['output'];
        candidate.deny = before.deny
            ? { ...before.deny, metadata: before.deny.metadata ? cloneValue(before.deny.metadata) : undefined }
            : undefined;
    } else if (name === 'tool.execute.after') {
        const after = output as PluginHookMap['tool.execute.after']['output'];
        candidate.resultObject = after.resultObject ? cloneValue(after.resultObject) : undefined;
    } else if (name === 'skill.load.before') {
        const before = output as PluginHookMap['skill.load.before']['output'];
        candidate.metadata = before.metadata ? cloneValue(before.metadata) : undefined;
    } else if (name === 'skill.install.before') {
        const before = output as PluginHookMap['skill.install.before']['output'];
        candidate.metadata = before.metadata ? cloneValue(before.metadata) : undefined;
    } else if (name === 'shell.env') {
        candidate.env = { ...(output as PluginHookMap['shell.env']['output']).env };
    } else if (name === 'shell.execute.before') {
        const before = output as PluginHookMap['shell.execute.before']['output'];
        candidate.args = cloneValue(before.args);
        candidate.deny = before.deny
            ? { ...before.deny, metadata: before.deny.metadata ? cloneValue(before.deny.metadata) : undefined }
            : undefined;
    } else if (name === 'shell.execute.after') {
        const after = output as PluginHookMap['shell.execute.after']['output'];
        candidate.resultObject = after.resultObject ? cloneValue(after.resultObject) : undefined;
    }
    return candidate as PluginHookMap[Name]['output'];
}

function commitHookOutput<Name extends PluginHookName>(
    output: PluginHookMap[Name]['output'],
    candidate: PluginHookMap[Name]['output']
): void {
    const target = output as Record<string, unknown>;
    const source = candidate as Record<string, unknown>;
    for (const key of Object.keys(target)) {
        if (!(key in source)) delete target[key];
    }
    Object.assign(target, source);
}

function validateHookOutput<Name extends PluginHookName>(name: Name, output: PluginHookMap[Name]['output']): void {
    if (name === 'skill.load.before' || name === 'skill.install.before') {
        const decision = (output as PluginHookMap['skill.load.before']['output']).operation;
        if (decision !== 'allow' && decision !== 'deny') throw new Error('plugin.skill_load_decision_invalid');
    }
    if (name === 'chat.headers') {
        const headers = output as PluginHookMap['chat.headers']['output'];
        if (
            !headers.headers ||
            typeof headers.headers !== 'object' ||
            Array.isArray(headers.headers) ||
            Object.values(headers.headers).some((value) => typeof value !== 'string')
        ) {
            throw new Error('plugin.chat_headers_invalid');
        }
    }
    if (name === 'chat.params') {
        const params = output as PluginHookMap['chat.params']['output'];
        if (params.reasoningEffort !== undefined && !REASONING_EFFORT_VALUES.includes(params.reasoningEffort)) {
            throw new Error('plugin.chat_params_reasoning_effort_invalid');
        }
        if (
            params.maxCompletionTokens !== undefined &&
            (!Number.isInteger(params.maxCompletionTokens) || params.maxCompletionTokens <= 0)
        ) {
            throw new Error('plugin.chat_params_max_completion_tokens_invalid');
        }
    }
    if (name === 'permission.ask') {
        const decision = (output as PluginHookMap['permission.ask']['output']).decision;
        if (!['ask', 'allow', 'deny'].includes(decision)) throw new Error('plugin.permission_decision_invalid');
    }
    if (name === 'shell.env') {
        const env = (output as PluginHookMap['shell.env']['output']).env;
        if (
            !env ||
            typeof env !== 'object' ||
            Array.isArray(env) ||
            Object.values(env).some((value) => value !== undefined && typeof value !== 'string')
        ) {
            throw new Error('plugin.shell_env_invalid');
        }
    }
    if (name === 'tool.definition') {
        const definition = output as PluginHookMap['tool.definition']['output'];
        if (typeof definition.description !== 'string' || !definition.description.trim()) {
            throw new Error('plugin.tool_definition_description_invalid');
        }
        if (!isValidToolParameters(definition.parameters)) {
            throw new Error('plugin.tool_definition_parameters_invalid');
        }
    }
}

export class PluginHookError extends Error {
    readonly cause: unknown;

    constructor(
        readonly pluginId: string,
        readonly hookName: PluginHookName,
        readonly failureMode: PluginFailureMode,
        cause: unknown
    ) {
        super(cause instanceof Error ? cause.message : String(cause));
        this.name = 'PluginHookError';
        this.cause = cause;
    }
}

export class PluginHost {
    private readonly entries = new Map<string, ActivePlugin>();
    private readonly hooks = new Map<PluginHookName, HookRecord[]>();
    private readonly tools = new Map<string, ToolRecord>();
    private readonly skills = new Map<string, ContributionRecord<PluginSkillDefinition>>();
    private readonly mcpServers = new Map<string, ContributionRecord<PluginMcpServerDefinition>>();
    private readonly commands = new Map<string, ContributionRecord<PluginCommandDefinition>>();
    private readonly applicationEvents: ApplicationEventRecord[] = [];
    private readonly mcpRemovalListeners = new Set<(id: string) => void | Promise<void>>();

    list(): PluginHostEntry[] {
        return Array.from(this.entries.values()).map((entry) => this.publicEntry(entry));
    }

    get(id: string): PluginHostEntry | undefined {
        const entry = this.entries.get(id);
        return entry ? this.publicEntry(entry) : undefined;
    }

    listTools(): Array<{ pluginId: string; definition: ToolDefinition }> {
        return Array.from(this.tools.values()).map((record) => ({
            pluginId: record.pluginId,
            definition: record.definition
        }));
    }

    listHooks(): Array<{ pluginId: string; name: PluginHookName; failureMode: PluginFailureMode }> {
        return Array.from(this.hooks.values()).flatMap((records) =>
            records.map((record) => ({
                pluginId: record.pluginId,
                name: record.name,
                failureMode: record.failureMode
            }))
        );
    }

    listSkills(): VisiblePluginContribution<PluginSkillDefinition>[] {
        return this.listContributions(this.skills);
    }

    listMcpServers(): VisiblePluginContribution<PluginMcpServerDefinition>[] {
        return this.listContributions(this.mcpServers);
    }

    listCommands(): VisiblePluginContribution<PluginCommandDefinition>[] {
        return this.listContributions(this.commands);
    }

    async runCommand(id: string, args: string, context: PluginCommandContext): Promise<PluginCommandResult> {
        const record = this.commands.get(id);
        if (!record) throw new Error('plugin.command_not_found');
        return await record.definition.execute(args, context);
    }

    publishApplicationEvent(event: PluginApplicationEvent): void {
        for (const record of [...this.applicationEvents]) {
            const entry = this.entries.get(record.pluginKey);
            if (!entry) continue;
            if (record.filter.application && record.filter.application !== event.application) continue;
            if (record.filter.event && record.filter.event !== event.event) continue;
            Promise.resolve()
                .then(() => record.callback({ ...event, args: cloneValue(event.args) }))
                .catch((error) => {
                    entry.diagnostics.push({
                        code: 'plugin.event_failed',
                        stage: 'event',
                        detail: error instanceof Error ? error.message : String(error)
                    });
                    logger.error(`Plugin application event failed: ${record.pluginId}`, error);
                });
        }
    }

    hasMcpServer(id: string): boolean {
        return this.mcpServers.has(id);
    }

    recordMcpError(id: string, error: unknown): void {
        const record = this.mcpServers.get(id);
        const entry = record ? this.entries.get(record.pluginKey) : undefined;
        entry?.diagnostics.push({
            code: 'plugin.mcp_connection_failed',
            stage: 'mcp',
            detail: error instanceof Error ? error.message : String(error)
        });
    }

    onMcpServerRemoved(listener: (id: string) => void | Promise<void>): () => void {
        this.mcpRemovalListeners.add(listener);
        return () => this.mcpRemovalListeners.delete(listener);
    }

    recordError(options: RecordPluginErrorOptions): PluginHostEntry {
        let id = options.id;
        let suffix = 2;
        while (this.entries.has(id)) {
            id = `${options.id}#${suffix++}`;
        }
        const entry: ActivePlugin = {
            key: id,
            id,
            apiVersion: OPENDESK_PLUGIN_API_VERSION,
            origin: options.origin,
            failureMode: 'open',
            status: 'error',
            requestedCapabilities: [],
            grantedCapabilities: [],
            capabilities: [],
            integrity: options.integrity,
            diagnostics: [
                {
                    code: options.code,
                    stage: options.stage,
                    detail: options.detail
                }
            ],
            registrations: []
        };
        return this.replaceEntry(entry);
    }

    async activate(plugin: OpenDeskPlugin, options: ActivatePluginOptions): Promise<PluginHostEntry> {
        const requestedCapabilities = [
            ...new Set(plugin.capabilities ?? OPENDESK_PLUGIN_CAPABILITIES)
        ] as PluginCapability[];
        const grantedCapabilities = [...new Set(options.grantedCapabilities ?? requestedCapabilities)].filter(
            (capability) => requestedCapabilities.includes(capability)
        ) as PluginCapability[];
        const entry: ActivePlugin = {
            key: plugin.id,
            id: plugin.id,
            displayName: plugin.displayName,
            version: plugin.version,
            apiVersion: plugin.apiVersion ?? OPENDESK_PLUGIN_API_VERSION,
            origin: options.origin,
            failureMode: plugin.failureMode === 'closed' ? 'closed' : 'open',
            status: 'active',
            requestedCapabilities,
            grantedCapabilities,
            capabilities: [],
            integrity: options.integrity,
            diagnostics: [],
            registrations: []
        };

        if (!validatePluginId(plugin.id)) {
            entry.status = 'error';
            entry.diagnostics.push({ code: 'plugin.invalid_id', stage: 'validate' });
            return this.replaceEntry(entry);
        }
        if (this.entries.has(entry.key)) {
            entry.status = 'error';
            entry.diagnostics.push({ code: 'plugin.duplicate_id', stage: 'validate' });
            return entry;
        }
        if (entry.apiVersion !== OPENDESK_PLUGIN_API_VERSION) {
            entry.status = 'error';
            entry.diagnostics.push({
                code: 'plugin.api_version_unsupported',
                stage: 'validate',
                detail: `${entry.apiVersion}`
            });
            return this.replaceEntry(entry);
        }
        if (plugin.minOpenDeskVersion && options.hostVersion) {
            const comparison = comparePluginVersions(options.hostVersion, plugin.minOpenDeskVersion);
            if (comparison === undefined || comparison < 0) {
                entry.status = 'error';
                entry.diagnostics.push({
                    code: 'plugin.opendesk_version_too_old',
                    stage: 'validate',
                    detail: `${options.hostVersion} < ${plugin.minOpenDeskVersion}`
                });
                return this.replaceEntry(entry);
            }
        }
        if (plugin.maxOpenDeskVersion && options.hostVersion) {
            const comparison = comparePluginVersions(options.hostVersion, plugin.maxOpenDeskVersion);
            if (comparison === undefined || comparison > 0) {
                entry.status = 'error';
                entry.diagnostics.push({
                    code: 'plugin.opendesk_version_too_new',
                    stage: 'validate',
                    detail: `${options.hostVersion} > ${plugin.maxOpenDeskVersion}`
                });
                return this.replaceEntry(entry);
            }
        }
        if (plugin.platforms && plugin.platforms.length > 0 && !plugin.platforms.includes(process.platform as any)) {
            entry.status = 'disabled';
            entry.diagnostics.push({
                code: 'plugin.platform_unsupported',
                stage: 'validate',
                detail: `${process.platform}`
            });
            return this.replaceEntry(entry);
        }
        const deniedCapabilities = requestedCapabilities.filter(
            (capability) => !grantedCapabilities.includes(capability)
        );
        if (deniedCapabilities.length > 0) {
            entry.status = 'disabled';
            entry.diagnostics.push({
                code: 'plugin.capability_not_granted',
                stage: 'validate',
                detail: deniedCapabilities.join(',')
            });
            return this.replaceEntry(entry);
        }

        let pluginOptions = options.options ?? {};
        if (plugin.configSchema) {
            const parsed = plugin.configSchema.safeParse(pluginOptions);
            if (!parsed.success || !parsed.data || typeof parsed.data !== 'object' || Array.isArray(parsed.data)) {
                entry.status = 'error';
                entry.diagnostics.push({
                    code: 'plugin.config_invalid',
                    stage: 'validate',
                    detail: parsed.success ? 'plugin.config_must_be_object' : parsed.error.message
                });
                return this.replaceEntry(entry);
            }
            pluginOptions = parsed.data as Record<string, unknown>;
        }

        this.entries.set(entry.key, entry);
        const context = this.createContext(entry, { ...options, options: pluginOptions });
        try {
            for (const skill of options.contributions?.skills ?? []) {
                context.skills.register(skill);
            }
            for (const server of options.contributions?.mcpServers ?? []) {
                context.mcps.registerServer(server);
            }
            const teardown = await plugin.setup(context);
            if (typeof teardown === 'function') {
                entry.registrations.push(new HostRegistration(teardown));
            } else if (teardown) {
                entry.registrations.push(teardown);
            }
        } catch (error) {
            await this.disposeRegistrations(entry);
            entry.status = 'error';
            entry.diagnostics.push({
                code: 'plugin.setup_failed',
                stage: 'setup',
                detail: error instanceof Error ? error.message : String(error)
            });
            logger.error(`Plugin setup failed: ${plugin.id}`, error);
        }
        return this.publicEntry(entry);
    }

    async deactivate(id: string): Promise<boolean> {
        const entry = this.entries.get(id);
        if (!entry) return false;
        await this.disposeRegistrations(entry);
        entry.status = 'disabled';
        this.entries.delete(entry.key);
        return true;
    }

    async dispose(): Promise<void> {
        const entries = Array.from(this.entries.values()).reverse();
        for (const entry of entries) {
            await this.deactivate(entry.id);
        }
    }

    async trigger<Name extends PluginHookName>(
        name: Name,
        input: PluginHookMap[Name]['input'],
        output: PluginHookMap[Name]['output']
    ): Promise<PluginHookMap[Name]['output']> {
        const records = (this.hooks.get(name) ?? []) as HookRecord<Name>[];
        for (const record of records) {
            const entry = this.entries.get(record.pluginKey);
            if (!entry) continue;
            const candidate = cloneHookOutput(name, output);
            try {
                await record.callback(input, candidate);
                validateHookOutput(name, candidate);
                commitHookOutput(output, candidate);
            } catch (error) {
                entry?.diagnostics.push({
                    code: 'plugin.hook_failed',
                    stage: 'hook',
                    detail: error instanceof Error ? error.message : String(error)
                });
                logger.error(`Plugin hook failed: ${record.pluginId}:${name}`, error);
                if (record.failureMode === 'closed') {
                    throw new PluginHookError(record.pluginId, name, record.failureMode, error);
                }
            }
        }
        return output;
    }

    private createContext(entry: ActivePlugin, options: ActivatePluginOptions): PluginContext {
        const addCapability = (capability: PluginCapability) => {
            if (!entry.requestedCapabilities.includes(capability)) {
                throw new Error(`plugin.capability_not_declared:${capability}`);
            }
            if (!entry.grantedCapabilities.includes(capability)) {
                throw new Error(`plugin.capability_not_granted:${capability}`);
            }
            if (!entry.capabilities.includes(capability)) entry.capabilities.push(capability);
        };
        const track = (registration: PluginRegistration) => {
            entry.registrations.push(registration);
            return registration;
        };

        return {
            pluginId: entry.id,
            pluginDir: path.resolve(options.pluginDir ?? options.configDir ?? getOpendeskDirectory()),
            configDir: options.configDir ?? getOpendeskDirectory(),
            options: Object.freeze({ ...(options.options ?? {}) }),
            hooks: {
                on: <Name extends PluginHookName>(
                    name: Name,
                    callback: PluginHookCallback<Name>,
                    hookOptions?: PluginHookRegistrationOptions
                ) => {
                    if (!(OPENDESK_PLUGIN_HOOK_NAMES as readonly string[]).includes(name)) {
                        throw new Error(`plugin.hook_unknown:${String(name)}`);
                    }
                    addCapability('hook');
                    if (typeof callback !== 'function') {
                        throw new Error(`plugin.hook_callback_invalid:${String(name)}`);
                    }
                    const record: HookRecord<Name> = {
                        pluginKey: entry.key,
                        pluginId: entry.id,
                        name,
                        callback,
                        failureMode: hookOptions?.failureMode ?? entry.failureMode
                    };
                    const records = this.hooks.get(name) ?? [];
                    records.push(record as HookRecord);
                    this.hooks.set(name, records);
                    return track(
                        new HostRegistration(() => {
                            const current = this.hooks.get(name) ?? [];
                            this.hooks.set(
                                name,
                                current.filter((candidate) => candidate !== record)
                            );
                        })
                    );
                }
            },
            tools: {
                register: <T extends z.ZodType>(definition: ToolDefinition<T>) => {
                    addCapability('tool');
                    validatePluginToolDefinition(definition);
                    const name = qualifyPluginToolName(entry.id, definition.name);
                    const collides = Array.from(this.tools.values()).some((record) => record.definition.name === name);
                    if (collides) {
                        throw new Error(`Plugin tool already registered: ${name}`);
                    }
                    const record: ToolRecord = {
                        pluginKey: entry.key,
                        pluginId: entry.id,
                        definition: { ...definition, name } as ToolDefinition
                    };
                    const toolKey = `${entry.key}:${name}`;
                    this.tools.set(toolKey, record);
                    return track(
                        new HostRegistration(() => {
                            if (this.tools.get(toolKey) === record) this.tools.delete(toolKey);
                        })
                    );
                }
            },
            skills: {
                register: (definition: PluginSkillDefinition) => {
                    this.validateNamedContribution('skill', definition.name, definition.description);
                    addCapability('skill');
                    if (typeof definition.body !== 'string') {
                        throw new Error(`plugin.skill_body_invalid:${definition.name}`);
                    }
                    const normalized = this.normalizeSkillDefinition(
                        definition,
                        path.resolve(options.pluginDir ?? options.configDir ?? getOpendeskDirectory())
                    );
                    return this.registerContribution(this.skills, entry, normalized, definition.name, track);
                }
            },
            mcps: {
                registerServer: (definition: PluginMcpServerDefinition) => {
                    this.validateNamedContribution('mcp', definition.name, definition.transport);
                    if (definition.transport === 'stdio' && !definition.command.trim()) {
                        throw new Error('Plugin MCP stdio command is required');
                    }
                    if (definition.transport !== 'stdio') {
                        new URL(definition.url);
                    }
                    addCapability('mcp');
                    return this.registerContribution(
                        this.mcpServers,
                        entry,
                        definition,
                        definition.name,
                        track,
                        async (id) => {
                            await Promise.allSettled(
                                Array.from(this.mcpRemovalListeners).map((listener) => listener(id))
                            );
                        }
                    );
                }
            },
            commands: {
                register: (definition: PluginCommandDefinition) => {
                    this.validateNamedContribution('command', definition.name, definition.description);
                    addCapability('command');
                    if (typeof definition.execute !== 'function') {
                        throw new Error(`plugin.command_execute_invalid:${definition.name}`);
                    }
                    const normalized = normalizeToolName(entry.id, definition.name);
                    return this.registerContribution(
                        this.commands,
                        entry,
                        { ...definition, name: normalized },
                        normalized,
                        track
                    );
                }
            },
            events: {
                onApplication: (filter: PluginApplicationEventFilter, callback: PluginApplicationEventCallback) => {
                    addCapability('event');
                    if (typeof callback !== 'function') throw new Error('plugin.event_callback_invalid');
                    const record: ApplicationEventRecord = {
                        pluginKey: entry.key,
                        pluginId: entry.id,
                        filter: { ...filter },
                        callback
                    };
                    this.applicationEvents.push(record);
                    return track(
                        new HostRegistration(() => {
                            const index = this.applicationEvents.indexOf(record);
                            if (index !== -1) this.applicationEvents.splice(index, 1);
                        })
                    );
                }
            }
        };
    }

    private listContributions<T>(records: Map<string, ContributionRecord<T>>): VisiblePluginContribution<T>[] {
        return Array.from(records.values()).map(({ id, pluginId, definition }) => ({ id, pluginId, definition }));
    }

    private validateNamedContribution(kind: string, name: string, description: string): void {
        if (!name.trim() || !/^[a-zA-Z][a-zA-Z0-9._-]*$/.test(name)) {
            throw new Error(`Plugin ${kind} name is invalid: ${name}`);
        }
        if (!description.trim()) throw new Error(`Plugin ${kind} description is required`);
    }

    private normalizeSkillDefinition(definition: PluginSkillDefinition, pluginDir: string): PluginSkillDefinition {
        if (!definition.directory) {
            return {
                ...definition,
                frontmatter: definition.frontmatter ? { ...definition.frontmatter } : undefined
            };
        }
        const normalizedRoot = path.resolve(pluginDir);
        const resolved = path.isAbsolute(definition.directory)
            ? path.resolve(definition.directory)
            : path.resolve(pluginDir, definition.directory);
        if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
            throw new Error('plugin.skill_directory_not_found');
        }
        const realRoot = fs.realpathSync(normalizedRoot);
        const realDirectory = fs.realpathSync(resolved);
        if (realDirectory !== realRoot && !realDirectory.startsWith(`${realRoot}${path.sep}`)) {
            throw new Error('plugin.skill_directory_outside_root');
        }
        return {
            ...definition,
            directory: realDirectory,
            frontmatter: definition.frontmatter ? { ...definition.frontmatter } : undefined
        };
    }

    private registerContribution<T>(
        records: Map<string, ContributionRecord<T>>,
        entry: ActivePlugin,
        definition: T,
        name: string,
        track: (registration: PluginRegistration) => PluginRegistration,
        afterRemove?: (id: string) => void | Promise<void>
    ): PluginRegistration {
        const collides = Array.from(records.values()).some(
            (record) => (record.definition as { name: string }).name === name
        );
        if (collides) throw new Error(`Plugin contribution already registered: ${name}`);
        const id = `${entry.key}:${name}`;
        const record: ContributionRecord<T> = {
            id,
            pluginKey: entry.key,
            pluginId: entry.id,
            definition
        };
        records.set(id, record);
        return track(
            new HostRegistration(async () => {
                if (records.get(id) !== record) return;
                records.delete(id);
                await afterRemove?.(id);
            })
        );
    }

    private async disposeRegistrations(entry: ActivePlugin): Promise<void> {
        const registrations = [...entry.registrations].reverse();
        entry.registrations.length = 0;
        for (const registration of registrations) {
            try {
                await registration.dispose();
            } catch (error) {
                entry.diagnostics.push({
                    code: 'plugin.dispose_failed',
                    stage: 'dispose',
                    detail: error instanceof Error ? error.message : String(error)
                });
                logger.error(`Plugin dispose failed: ${entry.id}`, error);
            }
        }
    }

    private replaceEntry(entry: ActivePlugin): PluginHostEntry {
        this.entries.set(entry.key, entry);
        return this.publicEntry(entry);
    }

    private publicEntry(entry: ActivePlugin): PluginHostEntry {
        const { key: _key, registrations: _registrations, ...result } = entry;
        void _key;
        void _registrations;
        return {
            ...result,
            capabilities: [...result.capabilities],
            diagnostics: [...result.diagnostics]
        };
    }
}

let applicationPluginHost: PluginHost | undefined;

export function getPluginHost(): PluginHost {
    applicationPluginHost ??= new PluginHost();
    return applicationPluginHost;
}
