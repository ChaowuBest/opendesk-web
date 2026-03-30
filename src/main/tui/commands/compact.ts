import type { OpenDeskTUI } from "../entry.js";
import { InfoOverlay } from "../components/notice.js";
import { logger } from "../../utils/logger.js";


export function registerCompactCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "compact",
        description: "手动压缩当前任务的上下文",
        execute: async () => {
            if (tui.taskView.isCompacting) {
                return;
            }

            if (!tui.activeTaskId) {
                logger.warn('没有活跃的任务');
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn('未找到当前任务');
                return;
            }

            try {
                await tui.taskView.performCompactWithAnimation();
                tui.taskManagerState.save();

                tui.taskView.clearMessages();
                tui.taskView.rebuildFromHistory();
                tui.tui.requestRender();

                const info = new InfoOverlay(tui, {
                    title: "上下文压缩",
                    message: "上下文已成功压缩。压缩效果将在下次对话时体现。",
                    closeLabel: "确定"
                });
                info.show();
            } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                logger.error(`上下文压缩失败: ${msg}`);
                const info = new InfoOverlay(tui, {
                    title: "压缩失败",
                    message: `上下文压缩过程中发生错误：${msg}`,
                    closeLabel: "确定"
                });
                info.show();
            }
        },
    });
}
