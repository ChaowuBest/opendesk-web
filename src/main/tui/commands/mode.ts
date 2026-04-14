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

import type { OpenDeskTUI } from '../entry.js';
import type { AutocompleteItem } from '@mariozechner/pi-tui';
import { InfoOverlay } from '../components/notice.js';
import chalk from 'chalk';

export function registerModeCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'mode',
        description: '查看或切换运行模式 (Shift+Tab)',

        getArgumentCompletions: (argPrefix: string): AutocompleteItem[] | null => {
            const modes = tui.getSupportedModes();
            const items: AutocompleteItem[] = modes
                .filter((m) => m.id.startsWith(argPrefix) || m.name.toLowerCase().startsWith(argPrefix.toLowerCase()))
                .map((m) => ({
                    value: m.id,
                    label: `${m.icon} ${m.name}`,
                    description: m.description
                }));
            return items.length > 0 ? items : null;
        },

        execute: (args: string) => {
            const trimmed = args.trim().toLowerCase();
            if (!trimmed) {
                const modes = tui.getSupportedModes();
                const currentMode = tui.activeMode;
                const lines = modes.map((m) => {
                    const active = m.id === currentMode.id ? chalk.hex(m.color)(' ● ') : '   ';
                    return `${active}${m.icon} ${chalk.bold(m.name)} - ${m.description}`;
                });
                const info = new InfoOverlay(tui, {
                    title: '运行模式',
                    message: lines.join('\n') + '\n\n' + chalk.dim('使用 /mode <name> 或 Shift+Tab 切换模式'),
                    closeLabel: '确定'
                });
                info.show();
                return;
            }

            if (tui.setMode(trimmed)) {
                const mode = tui.activeMode;
                const info = new InfoOverlay(tui, {
                    title: '模式已切换',
                    message: `${mode.icon} 已切换到 ${chalk.bold(mode.name)} 模式\n${mode.description}`,
                    closeLabel: '确定'
                });
                info.show();
            } else {
                const modes = tui.getSupportedModes();
                const validIds = modes.map((m) => m.id).join(', ');
                const info = new InfoOverlay(tui, {
                    title: '无效的模式',
                    message: `未找到模式 "${trimmed}"\n可用模式: ${validIds}`,
                    closeLabel: '确定'
                });
                info.show();
            }
        }
    });
}
