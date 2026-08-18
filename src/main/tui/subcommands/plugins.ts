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
import { useCliTransport, useConsoleTransport } from '../../utils/logger.js';
import {
    getPluginRuntimeEntry,
    setPluginOptions,
    setPluginGrantedCapabilities,
    OPENDESK_PLUGIN_CAPABILITIES,
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    setPluginEnabled,
    verifyInstalledPlugin,
    formatPluginInstallError
} from '../../applications/pluginmgr/index.js';
import type { PluginCapability } from '../../applications/pluginmgr/index.js';
import { t } from '../../../locale/index.js';
import { setCustomOpendeskDirectory } from '../../utils/setting.js';
import process from 'process';

function applyGlobalOptions(command: Command): void {
    const configDirectory = command.optsWithGlobals().configDirectory;
    if (typeof configDirectory === 'string' && configDirectory) {
        setCustomOpendeskDirectory(configDirectory);
    }
}

function parseCapabilities(values: string[]): PluginCapability[] {
    const requested = values.flatMap((value) => value.split(',')).filter(Boolean);
    const invalid = requested.filter(
        (capability) => !OPENDESK_PLUGIN_CAPABILITIES.includes(capability as PluginCapability)
    );
    if (invalid.length > 0) throw new Error(t('plugin.security.capabilityInvalid', { value: invalid.join(',') }));
    return OPENDESK_PLUGIN_CAPABILITIES.filter((capability) => requested.includes(capability));
}

export function registerPluginsCommand(prog: Command): void {
    const pluginsCmd = prog.command('plugins').description(t('plugin.cli.description'));

    pluginsCmd
        .command('install <spec>')
        .description(t('plugin.install.description'))
        .action(async (spec: string, command: Command) => {
            useCliTransport();
            useConsoleTransport();
            applyGlobalOptions(command);
            console.log(t('plugin.install.start', { spec }));
            const result = await installPlugin(spec);
            if (result.success) {
                console.log(`✓ ${t('plugin.install.successDetail', { id: result.id ?? spec })}`);
            } else {
                console.error(`✗ ${formatPluginInstallError(result)}`);
                process.exitCode = 1;
            }
        });

    pluginsCmd
        .command('uninstall <id>')
        .description(t('plugin.uninstall.description'))
        .action(async (id: string, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            const result = await uninstallPlugin(id);
            if (result.success) {
                console.log(`✓ ${t('plugin.uninstall.successDetail', { id })}`);
            } else {
                console.error(`✗ ${t('plugin.uninstall.failDetail', { error: result.error ?? '-' })}`);
                process.exitCode = 1;
            }
        });

    pluginsCmd
        .command('list')
        .description(t('plugin.list.description'))
        .action((command: Command) => {
            applyGlobalOptions(command);
            const records = listInstalledPlugins();
            if (records.length === 0) {
                console.log(t('plugin.list.empty'));
                return;
            }
            console.log(t('plugin.list.title'));
            for (const record of records) {
                const status = record.enabled
                    ? `✓ ${t('plugin.list.status.enabled')}`
                    : `✗ ${t('plugin.list.status.disabled')}`;
                console.log(
                    `  ${t('plugin.list.item', {
                        id: record.id,
                        spec: record.spec ?? record.path,
                        status,
                        installedAt: record.installedAt ?? '-'
                    })}`
                );
            }
        });

    pluginsCmd
        .command('enable <id>')
        .description(t('plugin.enable.description'))
        .action((id: string, command: Command) => {
            applyGlobalOptions(command);
            if (setPluginEnabled(id, true)) {
                console.log(`✓ ${t('plugin.enable.successDetail', { id })}`);
            } else {
                console.error(`✗ ${t('plugin.notFound', { id })}`);
                process.exitCode = 1;
            }
        });

    pluginsCmd
        .command('disable <id>')
        .description(t('plugin.disable.description'))
        .action((id: string, command: Command) => {
            applyGlobalOptions(command);
            if (setPluginEnabled(id, false)) {
                console.log(`✓ ${t('plugin.disable.successDetail', { id })}`);
            } else {
                console.error(`✗ ${t('plugin.notFound', { id })}`);
                process.exitCode = 1;
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
            else console.log(t('plugin.security.verify.integrity', { status: verification.integrityStatus }));
            if (!verification.allowed) process.exitCode = 1;
        });

    pluginsCmd
        .command('doctor')
        .description(t('plugin.security.doctor.description'))
        .option('--json', t('plugin.runtime.json.description'))
        .action((options: { json?: boolean }, command: Command) => {
            useCliTransport();
            applyGlobalOptions(command);
            const installed = listInstalledPlugins().map((record) => verifyInstalledPlugin(record.id));
            const report = { installed };
            if (options.json) {
                console.log(JSON.stringify(report, null, 2));
                return;
            }
            console.log(t('plugin.security.doctor.summary', { plugins: 0, installed: installed.length }));
        });
}
