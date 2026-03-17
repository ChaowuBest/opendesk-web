import type { OpenDeskTUI } from "../entry.js";
import { ConfirmOverlay, InfoOverlay } from "../components/notice.js";
import path from "path";
import fs from "fs";
import { logger } from "../../utils/logger.js";


export function registerExportCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: "export",
        description: "导出当前会话：/export html <文件名> 导出 HTML；/export json <文件名.json> 导出 JSON（可与 /import 兼容）",
        getArgumentCompletions: (argPrefix: string) => {
            const parts = argPrefix.split(/\s+/);
            if (parts.length <= 1 && !argPrefix.includes(" ")) {
                const prefix = (parts[0] ?? "").toLowerCase();
                const options = [
                    { value: "html", label: "html", description: "导出为 HTML 文件" },
                    { value: "json", label: "json", description: "导出为 JSON（可与 /import 兼容）" }
                ];
                if (!prefix) return options;
                return options.filter((o) => o.value.startsWith(prefix));
            }
            return null;
        },
        execute: async (args: string) => {
            if (!tui.activeTaskId) {
                logger.warn('No active task to export');
                return;
            }

            const task = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!task) {
                logger.warn('Task not found');
                return;
            }

            const trimmed = args.trim();
            const firstSpace = trimmed.indexOf(' ');
            const format = firstSpace === -1 ? trimmed.toLowerCase() : trimmed.slice(0, firstSpace).toLowerCase();
            let filePath = firstSpace === -1 ? "" : trimmed.slice(firstSpace).trim();

            if (format !== "html" && format !== "json") {
                const info = new InfoOverlay(tui, {
                    title: "导出",
                    message: "用法：/export html <文件名> 或 /export json <文件名.json>",
                    closeLabel: "确定"
                });
                info.show();
                return;
            }

            const doExportHtml = async (absolutePath: string) => {
                await tui.doExport(task, absolutePath);
            };

            const doExportJson = async (absolutePath: string) => {
                fs.writeFileSync(
                    absolutePath,
                    JSON.stringify(task.toJSON(), null, 4),
                    { encoding: 'utf8' }
                );
                logger.info(`Task exported to JSON: ${absolutePath}`);
                const info = new InfoOverlay(tui, {
                    title: "导出成功",
                    message: `任务已导出为 JSON：\n${absolutePath}`,
                    closeLabel: "确定"
                });
                info.show();
            };

            if (format === 'json') {
                if (!filePath) {
                    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                    filePath = `opendesk-task-${timestamp}.json`;
                    logger.info(`未指定文件名，将使用自动生成的文件名：${filePath}`);
                }
                if (!filePath.endsWith('.json')) {
                    filePath += '.json';
                }
                const absolutePath = path.resolve(tui.workspace, filePath);
                if (fs.existsSync(absolutePath)) {
                    const confirm = new ConfirmOverlay(tui, {
                        title: "文件已存在",
                        message: `文件 ${absolutePath} 已存在。是否覆盖？`,
                        confirmLabel: "覆盖",
                        cancelLabel: "取消"
                    });
                    confirm.show(() => {
                        doExportJson(absolutePath);
                    });
                } else {
                    await doExportJson(absolutePath);
                }
                return;
            }

            // format === 'html'
            if (!filePath) {
                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                filePath = `opendesk-session-${timestamp}.html`;
                logger.info(`未指定文件名，将使用自动生成的文件名：${filePath}`);
            }
            if (!filePath.endsWith('.html')) {
                filePath += '.html';
            }
            const absolutePath = path.resolve(tui.workspace, filePath);
            if (fs.existsSync(absolutePath)) {
                const confirm = new ConfirmOverlay(tui, {
                    title: "文件已存在",
                    message: `文件 ${absolutePath} 已存在。是否覆盖？`,
                    confirmLabel: "覆盖",
                    cancelLabel: "取消"
                });
                confirm.show(async () => {
                    await doExportHtml(absolutePath);
                });
            } else {
                await doExportHtml(absolutePath);
            }
        },
    });
}
