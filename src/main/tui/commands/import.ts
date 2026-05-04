import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { TaskState } from '../../aikernel/states/tasks.js';
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
                const task = TaskState.load(jsonPath, tui.taskManagerState);
                task.task_id = crypto.randomUUID();
                task._dirty = true;
                tui.taskManagerState.tasks.push(task);
                tui.taskManagerState.save();
                tui.taskManagerState.publishTaskListUpdate();
                await tui.switchToTask(task);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const info = new InfoOverlay(tui, {
                    title: t('import.fail'),
                    message: `${t('import.parse.fail')}${message}`
                });
                info.show();
            }
        }
    });
}
