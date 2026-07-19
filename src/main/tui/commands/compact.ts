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
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerCompactCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'compact',
        description: t('compact.description'),
        execute: async () => {
            if (tui.taskView.isCompacting) {
                return;
            }

            if (!tui.activeTaskId) {
                logger.warn(t('compact.no.task'));
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn(t('compact.task.not.found'));
                return;
            }

            try {
                const compacted = await tui.taskView.performCompactWithAnimation();
                if (!compacted) {
                    throw new Error(tui.taskView.lastCompactErrorMessage ?? 'Context compact failed');
                }
                currentTask._dirty = true;
                tui.taskManagerState.save();

                tui.taskView.clearMessages();
                tui.taskView.rebuildFromHistory();
                tui.tui.requestRender();

                const info = new InfoOverlay(tui, {
                    title: t('compact.title'),
                    message: t('compact.success'),
                    closeLabel: t('common.close')
                });
                info.show();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`Compact failed: ${msg}`);
                const info = new InfoOverlay(tui, {
                    title: t('compact.fail'),
                    message: `${t('compact.fail.detail')}${msg}`,
                    closeLabel: t('common.close')
                });
                info.show();
            }
        }
    });
}
