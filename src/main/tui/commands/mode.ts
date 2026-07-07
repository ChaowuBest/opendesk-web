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
import type { AutocompleteItem } from '../pi-tui.js';
import { InfoOverlay } from '../components/notice.js';
import chalk from 'chalk';
import { t } from '../../../locale/index.js';

export function registerModeCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'mode',
        description: t('mode.description'),

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

        execute: async (args: string) => {
            const trimmed = args.trim().toLowerCase();
            if (!trimmed) {
                return;
            }

            if (!(await tui.setMode(trimmed))) {
                const modes = tui.getSupportedModes();
                const validIds = modes.map((m) => m.id).join(', ');
                const info = new InfoOverlay(tui, {
                    title: t('mode.invalid'),
                    message: `${t('mode.not.found')}${trimmed}"\n${t('mode.available')}${validIds}`,
                    closeLabel: t('common.close')
                });
                info.show();
            }
        }
    });
}
