import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { TaskState } from '../../aikernel/states/tasks.js';
import { getFileCompletions } from '../components/file-completions.js';
import path from 'path';
import fs from 'fs';

export function registerImportCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'import',
        description: '从 JSON 文件导入任务，用法：/import task <json文件路径>',
        getArgumentCompletions: (argPrefix: string) => {
            const parts = argPrefix.split(/\s+/);
            if (parts.length <= 1 && !argPrefix.includes(' ')) {
                const prefix = (parts[0] ?? '').toLowerCase();
                const options = [{ value: 'task', label: 'task', description: '导入任务 JSON 文件' }];
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
                    title: '导入失败',
                    message: '用法：/import task <json文件路径>\n例如：/import task ./my-task.json'
                });
                info.show();
                return;
            }
            const jsonPathRaw = trimmed.slice(5).trim();
            if (!jsonPathRaw) {
                const info = new InfoOverlay(tui, {
                    title: '导入失败',
                    message: '请指定要导入的 JSON 文件路径。\n用法：/import task <json文件路径>'
                });
                info.show();
                return;
            }
            const jsonPath = path.resolve(jsonPathRaw);
            if (!fs.existsSync(jsonPath)) {
                const info = new InfoOverlay(tui, {
                    title: '导入失败',
                    message: `文件不存在：${jsonPath}`
                });
                info.show();
                return;
            }
            try {
                const task = TaskState.load(jsonPath, tui.taskManagerState);
                task.task_id = crypto.randomUUID();
                tui.taskManagerState.tasks.push(task);
                tui.taskManagerState.save();
                tui.taskManagerState.publishTaskListUpdate();
                await tui.switchToTask(task);
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                const info = new InfoOverlay(tui, {
                    title: '导入失败',
                    message: `无法解析或加载任务 JSON：${message}`
                });
                info.show();
            }
        }
    });
}
