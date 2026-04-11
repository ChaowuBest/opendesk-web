import type { OpenDeskTUI } from '../entry.js';
import { ConfirmOverlay, InfoOverlay, ProgressOverlay } from '../components/notice.js';
import { TaskManagerState } from '../../aikernel/states/tasks.js';
import { logger } from '../../utils/logger.js';

export function registerRecoverCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'recover',
        description: '恢复数据（子命令: tasks）',
        execute: async (args: string) => {
            const subCommand = args.trim().toLowerCase();
            if (subCommand === 'tasks') {
                executeRecoverTasks(tui);
            } else {
                const info = new InfoOverlay(tui, {
                    title: '用法提示',
                    message: '可用的子命令:\n\n  /recover tasks  - 从任务文件重建任务列表',
                    closeLabel: '确定'
                });
                info.show();
            }
        },
        getArgumentCompletions: (argPrefix: string) => {
            const subCommands = [{ value: 'tasks', label: 'tasks', description: '从任务文件重建任务列表' }];
            return subCommands
                .filter((sc) => sc.value.startsWith(argPrefix))
                .map((sc) => ({
                    value: sc.value,
                    label: sc.label,
                    description: sc.description
                }));
        }
    });
}

function executeRecoverTasks(tui: OpenDeskTUI): void {
    const confirm = new ConfirmOverlay(tui, {
        title: '重建任务列表',
        message:
            '此操作将基于磁盘上扫描到的所有任务文件重建任务列表。\n' +
            '当前内存中的任务列表将被覆盖。\n\n' +
            '确定要继续吗？',
        confirmLabel: '重建',
        cancelLabel: '取消'
    });

    confirm.show(() => {
        const progress = new ProgressOverlay(tui, {
            title: '重建任务列表',
            message: '正在扫描任务文件并重建任务列表...'
        });
        progress.show();

        setTimeout(() => {
            try {
                const recovered = TaskManagerState.rebuildTaskListFromDirectory();
                progress.hide();

                if (recovered && recovered.tasks.length > 0) {
                    tui.taskManagerState.tasks = recovered.tasks;
                    for (const task of tui.taskManagerState.tasks) {
                        task.task_manager_state = tui.taskManagerState;
                    }
                    tui.taskManagerState.save();
                    tui.taskManagerState.publishTaskListUpdate();

                    tui.clearActiveTask();

                    logger.info(`/recover tasks: ${recovered.tasks.length} task(s) recovered`);
                    const info = new InfoOverlay(tui, {
                        title: '重建完成',
                        message: `成功恢复了 ${recovered.tasks.length} 个任务。`,
                        closeLabel: '确定'
                    });
                    info.show();
                } else {
                    const info = new InfoOverlay(tui, {
                        title: '重建结果',
                        message: '未找到任何可恢复的任务文件。',
                        closeLabel: '确定'
                    });
                    info.show();
                }
            } catch (err) {
                progress.hide();
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`/recover tasks failed: ${msg}`);
                const info = new InfoOverlay(tui, {
                    title: '重建失败',
                    message: `重建任务列表时发生错误：${msg}`,
                    closeLabel: '确定'
                });
                info.show();
            }
        }, 50);
    });
}
