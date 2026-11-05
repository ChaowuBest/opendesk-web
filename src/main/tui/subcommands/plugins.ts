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

import type { Command } from 'commander';
import { randomUUID } from 'crypto';
import { useCliTransport, useConsoleTransport } from '../../utils/logger.js';
import {
    disposePluginHost,
    getPluginHost,
    initializePluginHost,
    reloadPluginHost,
    getPluginRuntimeEntry,
    setPluginOptions,
    setPluginGrantedCapabilities,
    OPENDESK_PLUGIN_CAPABILITIES,
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    listVisiblePlugins,
    isPluginEnabledFixed,
    setPluginEnabled,
    verifyInstalledPlugin,
    formatPluginInstallError,
    formatPluginUninstallError
} from '../../applications/pluginmgr/index.js';
import type { PluginCapability, PluginHostEntry } from '../../applications/pluginmgr/index.js';
import { resolvePluginDisplayName, resolvePluginLocalizedText } from '../../../../packages/plugin-sdk/src/index.js';
import { ToolResult } from '../../aikernel/tool.js';
import { getLocale, t } from '../../../locale/index.js';
import { setCustomOpendeskDirectory } from '../../utils/setting.js';
import process from 'process';
import fs from 'fs';
import path from 'path';

function applyGlobalOptions(command: Command): void {
    const configDirectory = command.optsWithGlobals().configDirectory;
    if (typeof configDirectory === 'string' && configDirectory) {
        setCustomOpendeskDirectory(configDirectory);
    }
}

function getWorkspaceOption(command: Command): string | undefined {
    const workspace = command.optsWithGlobals().workspace;
    return typeof workspace === 'string' && workspace ? workspace : undefined;
}

function resolveCommandWorkspace(command: Command): string | undefined {
    const workspace = getWorkspaceOption(command);
    if (!workspace) return undefined;
    const resolved = path.resolve(workspace);
    if (!fs.existsSync(resolved)) throw new Error(t('plugin.command.workspaceNotFound', { path: resolved }));
    return resolved;
}

function parseCapabilities(values: string[]): PluginCapability[] {
    const requested = values.flatMap((value) => value.split(',')).filter(Boolean);
    const invalid = requested.filter(
        (capability) => !OPENDESK_PLUGIN_CAPABILITIES.includes(capability as PluginCapability)
    );
    if (invalid.length > 0) throw new Error(t('plugin.security.capabilityInvalid', { value: invalid.join(',') }));
    return OPENDESK_PLUGIN_CAPABILITIES.filter((capability) => requested.includes(capability));
}

function printRuntimeStatus(entries: PluginHostEntry[], json: boolean): void {
    if (json) {
        // JSON 输出面向脚本消费，displayName / description 统一解析为当前语言的字符串
        const locale = getLocale();
        const payload = entries.map((entry) => {
            const { displayName, description, ...rest } = entry;
            const resolvedName = resolvePluginDisplayName(displayName, locale);
            const resolvedDescription = resolvePluginLocalizedText(description, locale);
            return {
                ...(resolvedName ? { displayName: resolvedName } : {}),
                ...(resolvedDescription ? { description: resolvedDescription } : {}),
                ...rest
            };
        });
        console.log(JSON.stringify(payload, null, 2));
        return;
    }
    if (entries.length === 0) {
        console.log(t('plugin.runtime.empty'));
        return;
    }
    console.log(t('plugin.runtime.title'));
    for (const entry of entries) {
        console.log(`  ${entry.id} [${t(`plugin.runtime.status.${entry.status}`)}] ${entry.origin}`);
        for (const diagnostic of entry.diagnostics) {
            const detail = diagnostic.detail ? `: ${diagnostic.detail}` : '';
            console.log(`    ${diagnostic.stage}/${diagnostic.code}${detail}`);
        }
    }
}

export function registerPluginsCommand(prog: Command): void {
    const pluginsCmd = prog.command('plugins').description(t('plugin.cli.description'));

    pluginsCmd
        .command('install <spec>')
        .description(t('plugin.install.description'))
        .action(async (spec: string) => {
            useCliTransport();
            useConsoleTransport();
            console.log(t('plugin.install.start', { spec }));
            const result = await installPlugin(spec);
            if (result.success) {
                console.log(`✓ ${t('plugin.install.successDetail', { name: result.id ?? spec })}`);
            } else {
                console.error(`✗ ${formatPluginInstallError(result)}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('uninstall <id>')
        .description(t('plugin.uninstall.description'))
        .option('--remove-data', t('plugin.uninstall.removeData.description'))
        .action(async (id: string, options: { removeData?: boolean }) => {
            useCliTransport();
            const removeData = options.removeData === true;
            const result = await uninstallPlugin(id, { removeData });
            if (result.success) {
                console.log(`✓ ${t('plugin.uninstall.successDetail', { name: id })}`);
                console.log(
                    removeData ? t('plugin.uninstall.dataRemoved', { id }) : t('plugin.uninstall.dataKept', { id })
                );
            } else {
                const error = formatPluginUninstallError(result.error, id);
                console.error(`✗ ${t('plugin.uninstall.failDetail', { error })}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('list')
        .description(t('plugin.list.description'))
        .action((_options: unknown, command: Command) => {
            applyGlobalOptions(command);
            const records = listVisiblePlugins();
            if (records.length === 0) {
                console.log(t('plugin.list.empty'));
            } else {
                console.log(t('plugin.list.title'));
                for (const r of records) {
                    const status = r.enabled
                        ? `✓ ${t('plugin.list.status.enabled')}`
                        : `✗ ${t('plugin.list.status.disabled')}`;
                    // 清单固定启停的插件在来源后标注「系统」，与 GUI/TUI 的锁定标记一致
                    const source = r.system
                        ? `${t(`plugin.list.source.${r.source}`)}·${t('plugin.center.systemTag')}`
                        : t(`plugin.list.source.${r.source}`);
                    console.log(
                        `  ${t('plugin.list.item', {
                            id: r.id,
                            spec: r.spec ?? r.path,
                            status,
                            source,
                            installedAt: r.installedAt ?? '-'
                        })}`
                    );
                }
            }
            process.exit(0);
        });

    pluginsCmd
        .command('enable <id>')
        .description(t('plugin.enable.description'))
        .action((id: string, _options: unknown, command: Command) => {
            applyGlobalOptions(command);
            if (isPluginEnabledFixed(id)) {
                console.error(`✗ ${t('plugin.enabledFixed', { id })}`);
                process.exit(1);
            }
            if (setPluginEnabled(id, true)) {
                console.log(`✓ ${t('plugin.enable.successDetail', { name: id })}`);
            } else {
                console.error(`✗ ${t('plugin.notFound', { id })}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('disable <id>')
        .description(t('plugin.disable.description'))
        .action((id: string, _options: unknown, command: Command) => {
            applyGlobalOptions(command);
            if (isPluginEnabledFixed(id)) {
                console.error(`✗ ${t('plugin.enabledFixed', { id })}`);
                process.exit(1);
            }
            if (setPluginEnabled(id, false)) {
                console.log(`✓ ${t('plugin.disable.successDetail', { name: id })}`);
            } else {
                console.error(`✗ ${t('plugin.notFound', { id })}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('status')
        .description(t('plugin.runtime.status.description'))
        .option('--json', t('plugin.runtime.json.description'))
        .action(async (options: { json?: boolean }, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            try {
                await initializePluginHost();
                printRuntimeStatus(getPluginHost().list(), options.json === true);
            } finally {
                await disposePluginHost();
            }
        });

    pluginsCmd
        .command('reload')
        .description(t('plugin.runtime.reload.description'))
        .option('--json', t('plugin.runtime.json.description'))
        .action(async (options: { json?: boolean }, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            try {
                await reloadPluginHost();
                const entries = getPluginHost().list();
                if (!options.json) console.log(t('plugin.runtime.reload.success'));
                printRuntimeStatus(entries, options.json === true);
            } finally {
                await disposePluginHost();
            }
        });

    pluginsCmd
        .command('commands')
        .description(t('plugin.command.list.description'))
        .action(async (_options: unknown, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            try {
                await initializePluginHost();
                const commands = getPluginHost().listCommands();
                if (commands.length === 0) {
                    console.log(t('plugin.command.empty'));
                    return;
                }
                for (const contribution of commands) {
                    console.log(`${contribution.definition.name}\t${contribution.definition.description}`);
                }
            } finally {
                await disposePluginHost();
            }
        });

    pluginsCmd
        .command('run <name> [args...]')
        .description(t('plugin.command.run.description'))
        .allowUnknownOption()
        .helpOption(false)
        .action(async (name: string, args: string[], _options: unknown, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            const effectiveWorkspace = resolveCommandWorkspace(command);
            try {
                await initializePluginHost();
                const contribution = getPluginHost()
                    .listCommands()
                    .find((candidate) => candidate.definition.name === name);
                if (!contribution) throw new Error(t('plugin.command.notFound', { name }));
                const outcome = await getPluginHost().runCommand(
                    contribution.id,
                    { raw: args.join(' '), argv: args },
                    {
                        workspace: effectiveWorkspace,
                        abort: new AbortController().signal
                    }
                );
                if (outcome.status === 'invalid_arguments') {
                    console.error(`${outcome.message}\n\n${outcome.usage}`);
                    process.exitCode = 1;
                    return;
                }
                if (outcome.status === 'help') {
                    console.log(outcome.text.trimEnd());
                    return;
                }
                const result = outcome.result;
                if (typeof result === 'string') console.log(result);
                else if (result) console.log(result.output);
            } finally {
                await disposePluginHost();
            }
        });

    pluginsCmd
        .command('tools')
        .description(t('plugin.tool.list.description'))
        .action(async (_options: unknown, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            try {
                await initializePluginHost();
                const tools = getPluginHost().listTools();
                if (tools.length === 0) {
                    console.log(t('plugin.tool.empty'));
                    return;
                }
                for (const contribution of tools) {
                    console.log(`${contribution.definition.name}\t${contribution.definition.description}`);
                }
            } finally {
                await disposePluginHost();
            }
        });

    pluginsCmd
        .command('call <name> [argsJson]')
        .description(t('plugin.tool.call.description'))
        .action(async (name: string, argsJson: string | undefined, _options: unknown, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            const workspace = getWorkspaceOption(command);
            try {
                await initializePluginHost();
                const contribution = getPluginHost()
                    .listTools()
                    .find((candidate) => candidate.definition.name === name);
                if (!contribution) throw new Error(t('plugin.tool.notFound', { name }));
                let input: unknown = {};
                if (argsJson) input = JSON.parse(argsJson) as unknown;
                const args = contribution.definition.parameters.parse(input);
                const callId = randomUUID();
                const before = await getPluginHost().trigger(
                    'tool.execute.before',
                    {
                        tool: contribution.definition.name,
                        taskId: 'plugin-cli',
                        callId,
                        workspace
                    },
                    {}
                );
                if (before.deny) {
                    throw new Error(before.deny.message ?? t('plugin.tool.denied', { name }));
                }
                const result = await contribution.definition.execute(
                    args,
                    {
                        taskId: 'plugin-cli',
                        workspace,
                        abort: new AbortController().signal
                    },
                    new ToolResult()
                );
                const after = await getPluginHost().trigger(
                    'tool.execute.after',
                    {
                        tool: contribution.definition.name,
                        taskId: 'plugin-cli',
                        callId,
                        workspace,
                        args
                    },
                    typeof result === 'string'
                        ? { status: 'success', result }
                        : {
                              status: 'success',
                              result: (result as { output: string }).output,
                              resultObject: (result as { resultObject?: object }).resultObject
                          }
                );
                console.log(after.result);
                if (after.resultObject) console.log(JSON.stringify(after.resultObject, null, 2));
            } finally {
                await disposePluginHost();
            }
        });

    pluginsCmd
        .command('config <id> [json]')
        .description(t('plugin.config.description'))
        .action((id: string, json: string | undefined, _options: unknown, command: Command) => {
            applyGlobalOptions(command);
            if (json === undefined) {
                console.log(JSON.stringify(getPluginRuntimeEntry(id)?.options ?? {}, null, 2));
                return;
            }
            const options = JSON.parse(json) as unknown;
            if (!options || typeof options !== 'object' || Array.isArray(options)) {
                throw new Error(t('plugin.config.objectRequired'));
            }
            setPluginOptions(id, options as Record<string, unknown>);
            console.log(t('plugin.config.saved', { id }));
        });

    pluginsCmd
        .command('permissions <id>')
        .description(t('plugin.security.permissions.description'))
        .action(async (id: string, _options: unknown, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            try {
                await initializePluginHost();
                const runtime = getPluginHost().get(id);
                const configured = getPluginRuntimeEntry(id)?.granted_capabilities;
                console.log(
                    JSON.stringify(
                        {
                            id,
                            requested: runtime?.requestedCapabilities ?? [],
                            granted: configured ?? runtime?.grantedCapabilities ?? null,
                            active: runtime?.capabilities ?? []
                        },
                        null,
                        2
                    )
                );
            } finally {
                await disposePluginHost();
            }
        });

    pluginsCmd
        .command('grant <id> <capabilities...>')
        .description(t('plugin.security.grant.description'))
        .action((id: string, capabilities: string[], _options: unknown, command: Command) => {
            applyGlobalOptions(command);
            const granted = parseCapabilities(capabilities);
            setPluginGrantedCapabilities(id, granted);
            console.log(t('plugin.security.grant.saved', { id, capabilities: granted.join(',') || '-' }));
        });

    pluginsCmd
        .command('revoke <id> <capabilities...>')
        .description(t('plugin.security.revoke.description'))
        .action((id: string, capabilities: string[], _options: unknown, command: Command) => {
            applyGlobalOptions(command);
            const revoked = parseCapabilities(capabilities);
            const current = getPluginRuntimeEntry(id)?.granted_capabilities ?? [...OPENDESK_PLUGIN_CAPABILITIES];
            const granted = current.filter((capability) => !revoked.includes(capability));
            setPluginGrantedCapabilities(id, granted);
            console.log(t('plugin.security.revoke.saved', { id, capabilities: revoked.join(',') }));
        });

    pluginsCmd
        .command('verify <id>')
        .description(t('plugin.security.verify.description'))
        .option('--json', t('plugin.runtime.json.description'))
        .action((id: string, options: { json?: boolean }, command: Command) => {
            applyGlobalOptions(command);
            const verification = verifyInstalledPlugin(id);
            if (!verification) throw new Error(t('plugin.security.verify.notFound', { id }));
            if (options.json) console.log(JSON.stringify(verification, null, 2));
            else {
                console.log(t('plugin.security.verify.integrity', { status: verification.integrityStatus }));
            }
            if (!verification.allowed) process.exitCode = 1;
        });

    pluginsCmd
        .command('doctor')
        .description(t('plugin.security.doctor.description'))
        .option('--json', t('plugin.runtime.json.description'))
        .action(async (options: { json?: boolean }, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            try {
                await initializePluginHost();
                const report = {
                    plugins: getPluginHost().list(),
                    installed: listInstalledPlugins().map((record) => verifyInstalledPlugin(record.id))
                };
                if (options.json) console.log(JSON.stringify(report, null, 2));
                else {
                    console.log(
                        t('plugin.security.doctor.summary', {
                            plugins: report.plugins.length,
                            installed: report.installed.length
                        })
                    );
                    for (const entry of report.plugins) {
                        console.log(`${entry.id}\t${t(`plugin.runtime.status.${entry.status}`)}`);
                    }
                }
            } finally {
                await disposePluginHost();
            }
        });
}
