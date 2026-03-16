import type { OpenDeskTUI } from "../entry.js";
import { logger } from "../../utils/logger.js";


export function registerStopCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "stop",
        description: "停止当前正在执行的任务",
        execute: async () => {
            if (!tui.activeTaskId) {
                logger.warn('没有活跃的任务');
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn('未找到当前任务');
                return;
            }

            if (currentTask.task_status !== 'running') {
                logger.warn('当前任务不在运行中');
                return;
            }

            currentTask.stop();
            tui.inputArea.statusBar.stopTimer();
            tui.inputArea.setStatus('idle');
            tui.inputArea.clearMessageQueue();
            logger.info('任务已停止');
            tui.tui.requestRender();
        },
    });
}
