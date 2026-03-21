import type { OpenDeskTUI } from "../entry.js";
import { InfoOverlay } from "../components/notice.js";
import { logger } from "../../utils/logger.js";


export function registerRevertCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "revert",
        description: "回退当前会话中的最近 N 条消息，默认 1 条",
        getArgumentCompletions: (argPrefix: string) => {
            const prefix = argPrefix.trim();
            if (!prefix) {
                return [
                    { value: "1", label: "1", description: "回退最近 1 条消息" },
                    { value: "2", label: "2", description: "回退最近 2 条消息" },
                    { value: "3", label: "3", description: "回退最近 3 条消息" },
                ];
            }
            return null;
        },
        execute: async (args: string) => {
            const trimmed = args.trim();
            const count = trimmed === "" ? 1 : Number(trimmed);

            if (isNaN(count) || !Number.isInteger(count)) {
                const info = new InfoOverlay(tui, {
                    title: "回退失败",
                    message: `参数必须是一个整数，例如：/revert 2`,
                });
                info.show();
                return;
            }

            if (count < 1) {
                const info = new InfoOverlay(tui, {
                    title: "回退失败",
                    message: `回退数量必须大于 0，当前输入：${count}`,
                });
                info.show();
                return;
            }

            if (!tui.activeTaskId) {
                const info = new InfoOverlay(tui, {
                    title: "回退失败",
                    message: "当前没有活跃的会话，请先开始一个对话。",
                });
                info.show();
                return;
            }

            const task = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!task) {
                const info = new InfoOverlay(tui, {
                    title: "回退失败",
                    message: "未找到当前任务。",
                });
                info.show();
                return;
            }

            const messages = task.chat_context.messages;
            if (messages.length === 0) {
                const info = new InfoOverlay(tui, {
                    title: "回退失败",
                    message: "当前会话中没有可回退的消息。",
                });
                info.show();
                return;
            }

            if (count > messages.length) {
                const info = new InfoOverlay(tui, {
                    title: "回退失败",
                    message: `当前会话只有 ${messages.length} 条消息，无法回退 ${count} 条。`,
                });
                info.show();
                return;
            }

            const removed = messages.splice(messages.length - count, count);
            tui.taskManagerState.save();

            tui.taskView.clearMessages();
            tui.taskView.rebuildFromHistory();
            tui.tui.requestRender();

            const roles = removed.map(m => (m as any).role === "user" ? "用户" : "助手");
            logger.info(`/revert: 已回退 ${count} 条消息 (${roles.join(", ")})`);

            const info = new InfoOverlay(tui, {
                title: "回退成功",
                message: `已回退最近 ${count} 条消息。`,
                closeLabel: "确定",
            });
            info.show();
        },
    });
}
