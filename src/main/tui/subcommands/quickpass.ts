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
import { QuickPassHelper } from '../../utils/quickpass.js';
import process from 'process';

export function registerQuickpassCommand(prog: Command): void {
    const qpCmd = prog.command('quickpass').description('快捷口令导入/导出');

    qpCmd
        .command('export')
        .description('导出设置口令')
        .option('--base', '导出基础设置口令（不含应用配置）')
        .option('--all', '导出全部设置口令（含应用配置）')
        .action((opts: { base?: boolean; all?: boolean }) => {
            if (!opts.base && !opts.all) {
                console.error('请指定 --base 或 --all');
                process.exit(1);
            }
            try {
                if (opts.base) {
                    const quickpass = QuickPassHelper.exportBaseConfig();
                    console.log(quickpass);
                } else if (opts.all) {
                    const quickpass = QuickPassHelper.exportAllConfig();
                    console.log(quickpass);
                }
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`导出失败：${message}`);
                process.exit(1);
            }
            process.exit(0);
        });

    qpCmd
        .command('import <quickpass>')
        .description('导入快捷口令')
        .action((quickpass: string) => {
            const cleaned = quickpass.trim().replace(/[\r\n]+/g, '');
            try {
                const { name, hasApplications } = QuickPassHelper.importConfig(cleaned);
                const scope = hasApplications ? '全部设置（含应用配置）' : '基础设置（不含应用配置）';
                console.log(`✓ 口令导入成功：「${name}」`);
                console.log(`  导入范围：${scope}`);
            } catch (err: unknown) {
                const message = err instanceof Error ? err.message : String(err);
                console.error(`✗ 口令导入失败：${message}`);
                process.exit(1);
            }
            process.exit(0);
        });
}
