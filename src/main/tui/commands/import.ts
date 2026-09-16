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
import { importTaskEntries, prepareTaskImport } from '../../aikernel/task/transfer.js';
import { TaskTransferError } from '../../utils/task-bundle.js';
import { getFileCompletions, expandPath } from '../components/file-completions.js';
import path from 'path';
import fs from 'fs';
import { t } from '../../../locale/index.js';

export function registerImportCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'import',
        description: t('import.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const parts = argPrefix.split(/\s+/);
            if (parts.length <= 1 && !argPrefix.includes(' ')) {
                const prefix = (parts[0] ?? '').toLowerCase();
                const options = [{ value: 'task', label: 'task', description: t('import.task.description') }];
                if (!prefix) return options;
                return options.filter((o) => o.value.startsWith(prefix));
            }
            if (parts[0] === 'task' && argPrefix.includes(' ')) {
                const pathQuery = argPrefix.slice(argPrefix.indexOf(' ') + 1);
                return getFileCompletions(tui.workspace, pathQuery, {
                    valuePrefix: 'task ',
                    extensions: ['.json']
                });
            }
            return null;
        },
        execute: async (args: string) => {
            const trimmed = args.trim();
            if (!trimmed.startsWith('task ') && trimmed !== 'task') {
                const info = new InfoOverlay(tui, {
                    title: t('import.fail'),
                    message: t('import.usage')
                });
                info.show();
                return;
            }
            const jsonPathRaw = trimmed.slice(5).trim();
            if (!jsonPathRaw) {
                const info = new InfoOverlay(tui, {
                    title: t('import.fail'),
                    message: t('import.no.path')
                });
                info.show();
                return;
            }
            const jsonPath = path.resolve(expandPath(jsonPathRaw));
            if (!fs.existsSync(jsonPath)) {
                const info = new InfoOverlay(tui, {
                    title: t('import.fail'),
                    message: `${t('import.file.not.exist')}${jsonPath}`
                });
                info.show();
                return;
            }
            try {
                const entries = await prepareTaskImport(jsonPath, tui.taskManagerState);
                const result = await importTaskEntries(
                    entries,
                    entries.map((entry) => entry.id),
                    tui.taskManagerState,
                    typeof entries[0]?.json?.workspace === 'string' ? entries[0].json.workspace : tui.workspace
                );
                if (!result.imported.length)
                    throw new TaskTransferError(
                        result.failed[0]?.error === 'writeFailed' ? 'writeFailed' : 'invalidTask'
                    );
                const initializedTask = tui.taskManagerState.getTask(result.imported[0].taskId);
                if (!initializedTask) {
                    throw new Error(t('context.task.not.found'));
                }
                await tui.switchToTask(initializedTask);
                if (result.failed.length) {
                    new InfoOverlay(tui, {
                        title: t('taskTransfer.import'),
                        message: t('taskTransfer.importResult', {
                            imported: result.imported.length,
                            failed: result.failed.length,
                            skipped: result.skipped
                        })
                    }).show();
                }
            } catch (err) {
                const message =
                    err instanceof TaskTransferError
                        ? t(`taskTransfer.error.${err.code}`)
                        : err instanceof Error
                          ? err.message
                          : String(err);
                const info = new InfoOverlay(tui, {
                    title: t('import.fail'),
                    message: `${t('import.parse.fail')}${message}`
                });
                info.show();
            }
        }
    });
}
