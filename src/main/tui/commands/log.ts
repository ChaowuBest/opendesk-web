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
import { t } from '../../../locale/index.js';

export function registerLogCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'log',
        description: t('log.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const options = ['off', 'last', 'all'];
            return options
                .filter((opt) => opt.startsWith(argPrefix.toLowerCase()))
                .map((opt) => ({
                    value: opt,
                    label: opt,
                    description:
                        opt === 'off'
                            ? t('log.off.description')
                            : opt === 'last'
                              ? t('log.last.description')
                              : t('log.all.description')
                }));
        },
        execute: async (args: string) => {
            const modeArg = args.trim().toLowerCase();
            if (modeArg === 'off' || modeArg === 'last' || modeArg === 'all') {
                tui.logPanel.setMode(modeArg);
            } else {
                tui.logPanel.setMode('off');
            }
        }
    });
}
