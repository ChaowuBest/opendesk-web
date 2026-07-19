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
import { UndoOverlay, getUndoableUserMessages } from '../components/undo.js';
import { t } from '../../../locale/index.js';

export function registerUndoCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'undo',
        description: t('undo.description'),
        getArgumentCompletions: () => [],
        execute: async () => {
            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.no.session')
                });
                info.show();
                return;
            }

            const task = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!task) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.task.notfound')
                });
                info.show();
                return;
            }

            const userMessages = getUndoableUserMessages(task);
            if (userMessages.length === 0) {
                const info = new InfoOverlay(tui, {
                    title: t('undo.fail'),
                    message: t('undo.error.no.messages')
                });
                info.show();
                return;
            }

            new UndoOverlay(tui, task).show();
        }
    });
}
