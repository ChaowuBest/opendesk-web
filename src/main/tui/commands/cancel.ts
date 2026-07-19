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

export function registerCancelCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'cancel',
        description: t('cancel.description'),
        execute: async () => {
            tui.inputArea.clearMessageQueue();
            if (tui.activeTaskId) {
                const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
                if (currentTask) {
                    currentTask.message_queue = tui.inputArea.getQueueSnapshot();
                }
            }
        }
    });
}
