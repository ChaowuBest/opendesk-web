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
import { InfoOverlay } from '../components/notice.js';
import { QuickPassHelper } from '../../utils/quickpass.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerQuickpassCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'quickpass',
        description: t('quickpass.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const options = [
                {
                    value: 'config base',
                    label: 'config base',
                    description: t('quickpass.config.base.description')
                },
                { value: 'config all', label: 'config all', description: t('quickpass.config.all.description') }
            ];
            const prefix = argPrefix.trimEnd().toLowerCase();
            return options.filter((opt) => opt.value.startsWith(prefix));
        },
        execute: async (args: string) => {
            const parts = args.trim().split(/\s+/);
            const subCommand = (parts[0] || '').toLowerCase();
            const subArg = (parts[1] || '').toLowerCase();

            if (subCommand === 'config') {
                if (subArg === 'base') {
                    try {
                        const quickpass = QuickPassHelper.exportBaseConfig();
                        const info = new InfoOverlay(tui, {
                            title: t('quickpass.base.title'),
                            message: `${t('quickpass.base.message')}${quickpass}`,
                            closeLabel: t('quickpass.close'),
                            fullWidth: true
                        });
                        info.show();
                    } catch (err: unknown) {
                        const info = new InfoOverlay(tui, {
                            title: t('quickpass.base.fail'),
                            message: `${t('quickpass.base.fail.detail')}${err instanceof Error ? err.message : String(err)}`
                        });
                        info.show();
                    }
                } else if (subArg === 'all') {
                    try {
                        const quickpass = QuickPassHelper.exportAllConfig();
                        const info = new InfoOverlay(tui, {
                            title: t('quickpass.all.title'),
                            message: `${t('quickpass.all.message')}${quickpass}`,
                            closeLabel: t('quickpass.close'),
                            fullWidth: true
                        });
                        info.show();
                    } catch (err: unknown) {
                        const info = new InfoOverlay(tui, {
                            title: t('quickpass.all.fail'),
                            message: `${t('quickpass.all.fail.detail')}${err instanceof Error ? err.message : String(err)}`
                        });
                        info.show();
                    }
                } else {
                    logger.warn('Usage: /quickpass config base|all');
                }
            } else {
                logger.warn('Usage: /quickpass config base|all');
            }
        }
    });
}
