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
    installPlugin,
    uninstallPlugin,
    listInstalledPlugins,
    setPluginEnabled,
    resetOpenClawShim,
    loadPlugins
} from '../../aikernel/plugins/index.js';
import process from 'process';

export function registerPluginsCommand(prog: Command): void {
    const pluginsCmd = prog.command('plugins').description('插件管理');

    pluginsCmd
        .command('install <spec>')
        .description('安装插件 (npm 包名、路径或 .tgz 文件 URL)')
        .action(async (spec: string) => {
            useCliTransport();
            useConsoleTransport();
            console.log(`正在安装插件: ${spec} ...`);
            const result = await installPlugin(spec);
            if (result.success) {
                console.log(`✓ 插件安装成功: ${result.id}`);
            } else {
                console.error(`✗ 插件安装失败: ${result.error}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('uninstall <id>')
        .description('卸载插件')
        .action(async (id: string) => {
            useCliTransport();
            const result = await uninstallPlugin(id);
            if (result.success) {
                console.log(`✓ 插件已卸载: ${id}`);
            } else {
                console.error(`✗ 插件卸载失败: ${result.error}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('list')
        .description('列出已安装的插件')
        .action(() => {
            const records = listInstalledPlugins();
            if (records.length === 0) {
                console.log('暂无已安装的插件');
            } else {
                console.log('已安装的插件:');
                for (const r of records) {
                    const status = r.enabled ? '✓ enabled' : '✗ disabled';
                    console.log(`  ${r.id} (${r.npmSpec}) [${status}] installed: ${r.installedAt}`);
                }
            }
            process.exit(0);
        });

    pluginsCmd
        .command('enable <id>')
        .description('启用插件')
        .action((id: string) => {
            if (setPluginEnabled(id, true)) {
                console.log(`✓ 插件已启用: ${id}`);
            } else {
                console.error(`✗ 未找到插件: ${id}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('disable <id>')
        .description('禁用插件')
        .action((id: string) => {
            if (setPluginEnabled(id, false)) {
                console.log(`✓ 插件已禁用: ${id}`);
            } else {
                console.error(`✗ 未找到插件: ${id}`);
                process.exit(1);
            }
            process.exit(0);
        });

    pluginsCmd
        .command('reset-openclaw-shim')
        .description('删除并重新生成 openclaw 兼容层 (用于调试)')
        .action(() => {
            useCliTransport();
            useConsoleTransport();
            console.log('正在重置 openclaw shim...');
            const result = resetOpenClawShim();
            if (result.success) {
                console.log('✓ openclaw shim 已重新生成');
            } else {
                console.error(`✗ 重置失败: ${result.error}`);
                process.exit(1);
            }
            process.exit(0);
        });
}
