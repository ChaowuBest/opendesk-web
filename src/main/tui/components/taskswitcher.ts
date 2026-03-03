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

import { type Component, Box, Text } from "@mariozechner/pi-tui";
import { defaultSelectListTheme } from "../theme";
import { OpenDeskTUI } from "../entry";
import { TaskState } from "../../states/tasks";
import { SelectTable, type SelectRow } from "./selecttable";

import chalk from "chalk";


export class TaskSwitcher implements Component {
    private openDeskTUI: OpenDeskTUI;
    private table: SelectTable;
    private header: Text;
    private container: Box;

    getTasks(): TaskState[] {
        return [...this.openDeskTUI.taskManagerState.tasks];
    }

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;

        const rows = this.buildRows();
        this.header = new Text(chalk.bold('☰ 切换任务'));
        this.table = new SelectTable(rows, Math.min(rows.length, 15), defaultSelectListTheme);
        this.table.setColumnStrechFactors([1, 0, 0]);
        this.table.setAlignments(['left', 'right', 'right']);
        this.container = new Box(1, 1);
        this.container.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.container.addChild(this.header);
        this.container.addChild(this.table);
    }

    /**
     * 格式化时间显示
     * - 小于1小时显示 "xx 分钟前"
     * - 否则显示 "yyyy-mm-dd hh:mm"
     */
    private formatLastMessageTime(date: Date | undefined): string {
        if (!date) return '';

        const now = new Date();
        const diffMs = now.getTime() - date.getTime();
        const diffMinutes = Math.floor(diffMs / (1000 * 60));

        if (diffMinutes < 60) {
            return `${diffMinutes} 分钟前`;
        }

        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');

        return `${year}-${month}-${day} ${hours}:${minutes}`;
    }

    /**
     * 构建表格行数据
     */
    private buildRows(): SelectRow[] {
        const statusIcons: Record<string, string> = {
            running: '🏃 执行中',
            waiting: '⏳ 等待中',
            stopped: '🟢 已完成',
            failed: '🔴 已中断',
        };

        return this.getTasks().reverse().map(t => {
            const name = t.task_name || '未命名任务';
            const status = statusIcons[t.task_status] ?? t.task_status;
            // 对于已完成/停止的任务使用 finished_at，对于运行中的任务使用 started_at
            const timeStr = this.formatLastMessageTime(t.finished_at || t.started_at);

            return {
                labels: [name, timeStr, status],
                value: t.task_id,
            };
        });
    }

    invalidate(): void {
        this.container.invalidate();
    }

    render(width: number): string[] {
        return this.container.render(width);
    }

    show() {
        if (this.getTasks().length === 0) return;
        const handle = this.openDeskTUI.tui.showOverlay(this, {
            width: "80%",
            maxHeight: "80%",
            anchor: "center",
        });

        // 标记有 overlay 打开
        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this.table);

        this.table.onSelect = (taskID: string) => {
            handle.hide();
            // 标记 overlay 关闭
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
            const task = this.openDeskTUI.taskManagerState.getTask(taskID);
            if (task) {
                this.openDeskTUI.switchToTask(task);
            }
        };

        this.table.onCancel = () => {
            handle.hide();
            // 标记 overlay 关闭
            this.openDeskTUI.hasOpenOverlay = false;
            this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
        };
    }
}