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
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerRenameCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'rename',
        description: t('rename.usage'),
        execute: async (args: string) => {
            const newName = args.trim();
            if (!newName) {
                logger.warn(t('rename.usage'));
                return;
            }

            // 无活跃任务时，预设任务名称（新任务创建时会自动使用）
            if (!tui.activeTaskId) {
                tui.pendingTaskName = newName;
                logger.info(`${t('rename.preset')}${newName}`);
                tui.syncTaskName();
                tui.tui.requestRender();
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn(t('rename.task.not.found'));
                return;
            }

            currentTask.rename(newName);
            logger.info(`${t('rename.success')}${newName}`);
            tui.syncTaskName();
            tui.tui.requestRender();
        }
    });
}
