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

import type { AutocompleteItem } from '@earendil-works/pi-tui';
import type { OpenDeskTUI } from '../entry.js';
import type { OutputDisplayLevel } from '../display.js';
import { t } from '../../../locale/index.js';

const DISPLAY_COMMAND_LEVELS = ['minimal', 'verbose'] as const;

function parseDisplayCommandLevel(value: string): OutputDisplayLevel | undefined {
    if (value === 'minimal') return 'minimal';
    if (value === 'verbose') return 'verbose';
    return undefined;
}

export function registerDisplayCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'display',
        description: t('display.command.description'),
        getArgumentCompletions: (prefix: string): AutocompleteItem[] =>
            DISPLAY_COMMAND_LEVELS.filter((level) => level.startsWith(prefix.trim().toLowerCase())).map((level) => ({
                value: level,
                label: level,
                description: t(`display.level.${level}`)
            })),
        execute: async (args: string) => {
            const level = parseDisplayCommandLevel(args.trim().toLowerCase());
            if (!level) {
                tui.showTextPage(t('display.command.title'), t('display.command.usage'));
                return;
            }
            tui.setOutputDisplayLevel(level, { persist: true });
        }
    });
}
