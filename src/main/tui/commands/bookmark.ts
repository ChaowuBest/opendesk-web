import type { OpenDeskTUI } from "../entry.js";
import { InfoOverlay } from "../components/notice.js";
import { BookmarkList } from "../components/bookmarklist.js";
import { logger } from "../../utils/logger.js";


export function registerBookmarkCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "bookmark",
        description: "管理任务书签，用法：/bookmark add|list|remove",
        getArgumentCompletions: (argPrefix: string) => {
            const options = ['add', 'list', 'remove'];
            return options
                .filter(opt => opt.startsWith(argPrefix.toLowerCase()))
                .map(opt => ({
                    value: opt,
                    label: opt,
                    description: opt === 'add' ? '将当前任务添加到书签' :
                                opt === 'list' ? '列出所有书签任务' :
                                '移除当前任务的书签'
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
                        title: "添加书签失败",
                        message: "没有活跃的任务",
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
                if (!currentTask) {
                    const info = new InfoOverlay(tui, {
                        title: "添加书签失败",
                        message: "未找到当前任务",
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                if (currentTask.bookmark_path) {
                    const info = new InfoOverlay(tui, {
                        title: "添加书签失败",
                        message: "当前任务已在书签中",
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                currentTask.setBookmark('/');
                const info = new InfoOverlay(tui, {
                    title: "添加书签成功",
                    message: `任务"${currentTask.task_name || '未命名任务'}"已添加到书签`,
                    closeLabel: "确定"
                });
                info.show();
                return;
            }

            if (subCommand === 'remove') {
                if (!tui.activeTaskId) {
                    const info = new InfoOverlay(tui, {
                        title: "移除书签失败",
                        message: "没有活跃的任务",
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
                if (!currentTask) {
                    const info = new InfoOverlay(tui, {
                        title: "移除书签失败",
                        message: "未找到当前任务",
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                if (!currentTask.bookmark_path) {
                    const info = new InfoOverlay(tui, {
                        title: "移除书签失败",
                        message: "当前任务不在书签中",
                        closeLabel: "确定"
                    });
                    info.show();
                    return;
                }

                const taskName = currentTask.task_name || '未命名任务';
                currentTask.removeBookmark();
                const info = new InfoOverlay(tui, {
                    title: "移除书签成功",
                    message: `任务"${taskName}"已从书签中移除`,
                    closeLabel: "确定"
                });
                info.show();
                return;
            }

            logger.warn('用法：/bookmark add|list|remove');
        },
    });
}
