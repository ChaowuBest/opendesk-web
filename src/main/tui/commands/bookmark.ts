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
import { BookmarkList } from '../components/bookmarklist.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

export function registerBookmarkCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'bookmark',
        description: t('bookmark.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const options = ['add', 'list', 'remove'];
            return options
                .filter((opt) => opt.startsWith(argPrefix.toLowerCase()))
                .map((opt) => ({
                    value: opt,
                    label: opt,
                    description:
                        opt === 'add'
                            ? t('bookmark.add.description')
                            : opt === 'list'
                              ? t('bookmark.list.description')
                              : t('bookmark.remove.description')
                }));
        },
        execute: async (args: string) => {
            const subCommand = args.trim().toLowerCase();

            if (subCommand === 'list') {
                const bookmarkList = new BookmarkList(tui);
                bookmarkList.show();
                return;
            }

            if (subCommand === 'add') {
                if (!tui.activeTaskId) {
                    const info = new InfoOverlay(tui, {
                        title: t('bookmark.add.fail'),
                        message: t('bookmark.add.fail.no.task'),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
                if (!currentTask) {
                    const info = new InfoOverlay(tui, {
                        title: t('bookmark.add.fail'),
                        message: t('bookmark.add.fail.not.found'),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                if (currentTask.bookmark_path) {
                    const info = new InfoOverlay(tui, {
                        title: t('bookmark.add.fail'),
                        message: t('bookmark.add.fail.already.exists'),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                currentTask.setBookmark('/');
                const taskName = currentTask.task_name || t('bookmark.unnamed.task');
                const info = new InfoOverlay(tui, {
                    title: t('bookmark.add.success'),
                    message: `${t('bookmark.add.success.detail')}${taskName}"${t('bookmark.add.success.suffix')}`,
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            if (subCommand === 'remove') {
                if (!tui.activeTaskId) {
                    const info = new InfoOverlay(tui, {
                        title: t('bookmark.remove.fail'),
                        message: t('bookmark.remove.fail.no.task'),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
                if (!currentTask) {
                    const info = new InfoOverlay(tui, {
                        title: t('bookmark.remove.fail'),
                        message: t('bookmark.remove.fail.not.found'),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                if (!currentTask.bookmark_path) {
                    const info = new InfoOverlay(tui, {
                        title: t('bookmark.remove.fail'),
                        message: t('bookmark.remove.fail.not.in'),
                        closeLabel: t('common.close')
                    });
                    info.show();
                    return;
                }

                const taskName = currentTask.task_name || t('bookmark.unnamed.task');
                currentTask.removeBookmark();
                const info = new InfoOverlay(tui, {
                    title: t('bookmark.remove.success'),
                    message: `${t('bookmark.remove.success.detail')}${taskName}"${t('bookmark.remove.success.suffix')}`,
                    closeLabel: t('common.close')
                });
                info.show();
                return;
            }

            logger.warn('Usage: /bookmark add|list|remove');
        }
    });
}
