import type { OpenDeskTUI } from "../entry.js";
import { logger } from "../../utils/logger.js";


export function registerRenameCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "rename",
        description: "重命名当前任务，用法：/rename <新名称>",
        execute: async (args: string) => {
            if (!tui.activeTaskId) {
                logger.warn('没有活跃的任务');
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn('未找到当前任务');
                return;
            }

            const newName = args.trim();
            if (!newName) {
                logger.warn('请提供新的任务名称，用法：/rename <新名称>');
                return;
            }

            currentTask.rename(newName);
            logger.info(`任务已重命名为: ${newName}`);
            tui.tui.requestRender();
        },
    });
}
