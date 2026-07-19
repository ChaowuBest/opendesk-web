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
import { t } from '../../../locale/index.js';

export function registerForkCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'fork',
        description: t('fork.description'),
        execute: async () => {
            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: t('fork.fail'),
                    message: t('fork.fail.no.task'),
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                const info = new InfoOverlay(tui, {
                    title: t('fork.fail'),
                    message: t('fork.fail.not.found'),
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            const forkedTask = currentTask.fork();
            tui.switchToTask(forkedTask);

            const info = new InfoOverlay(tui, {
                title: t('fork.success'),
                message: t('fork.success.detail'),
                closeLabel: t('common.close')
            });
            info.show();
        }
    });
}
