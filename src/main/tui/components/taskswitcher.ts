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

import { type Component, Box, Text, SelectList, matchesKey } from "@mariozechner/pi-tui";
import { defaultSelectListTheme } from "../theme";
import { OpenDeskTUI } from "../entry";
import { TaskState } from "../../states/tasks";
import { SelectTable, type SelectRow } from "./selecttable";
import { ConfirmOverlay } from "./notice";

import chalk from "chalk";


export class TaskSwitcher implements Component {
    private openDeskTUI: OpenDeskTUI;
    private table: SelectTable;
    private header: Text;
    private footer: Text;
    private container: Box;
    private hideHandle?: { hide: () => void };

    getTasks(): TaskState[] {
        return [...this.openDeskTUI.taskManagerState.tasks];
    }

    constructor(openDeskTUI: OpenDeskTUI) {
        this.openDeskTUI = openDeskTUI;

        const rows = this.buildRows();
        this.header = new Text(chalk.bold('☰ 切换任务'));
        this.footer = new Text(chalk.dim('  Enter 切换  │  Delete/Backspace 删除  │  Esc 关闭'));
        this.table = new SelectTable(rows, Math.min(rows.length, 15), defaultSelectListTheme);
        this.table.setColumnStrechFactors([1, 0, 0]);
        this.table.setAlignments(['left', 'right', 'right']);
        this.container = new Box(1, 1);
        this.container.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        this.container.addChild(this.header);
        this.container.addChild(this.table);
        this.container.addChild(this.footer);
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

    private getSelectedTaskId(): string | undefined {
        const item = this.table.innerList.getSelectedItem();
        return item?.value;
    }

    private rebuildTable() {
        const rows = this.buildRows();
        if (rows.length === 0) {
            this.close();
            return;
        }
        this.table.innerRows = rows.map(row => ({ ...row, label: '' }));
        this.table.innerList = new SelectList(
            this.table.innerRows,
            Math.min(rows.length, 15),
            defaultSelectListTheme,
        );

        this.table.innerList.onSelect = (item) => {
            this.table.onSelect?.(item.value);
        };
        this.table.innerList.onCancel = () => {
            this.table.onCancel?.();
        };

        // Force column width recalculation
        (this.table as any).lastWidth = 0;
    }

    private deleteSelectedTask() {
        const taskId = this.getSelectedTaskId();
        if (!taskId) return;

        const task = this.openDeskTUI.taskManagerState.getTask(taskId);
        if (!task) return;

        if (task.task_status === 'running') {
            task.stop();
        }

        const isActiveTask = this.openDeskTUI.getActiveTaskId() === taskId;

        this.openDeskTUI.taskManagerState.removeTask(taskId);

        if (isActiveTask) {
            this.openDeskTUI.clearActiveTask();
        }

        this.rebuildTable();
        this.openDeskTUI.tui.requestRender();
    }

    invalidate(): void {
        this.container.invalidate();
    }

    render(width: number): string[] {
        return this.container.render(width);
    }

    handleInput(keyData: string): void {
        // Delete / Backspace -> 删除选中的任务
        if (matchesKey(keyData, 'delete') || matchesKey(keyData, 'backspace')) {
            const taskId = this.getSelectedTaskId();
            if (!taskId) return;
            const task = this.openDeskTUI.taskManagerState.getTask(taskId);
            const taskName = task?.task_name || '未命名任务';

            const confirm = new ConfirmOverlay(this.openDeskTUI, {
                title: "删除任务",
                message: `确定要删除任务「${taskName}」吗？此操作不可恢复。`,
                confirmLabel: "删除",
                cancelLabel: "取消",
            });
            confirm.show(
                () => {
                    this.deleteSelectedTask();
                    if (this.getTasks().length > 0) {
                        this.openDeskTUI.hasOpenOverlay = true;
                        this.openDeskTUI.tui.setFocus(this);
                    }
                },
                () => {
                    this.openDeskTUI.hasOpenOverlay = true;
                    this.openDeskTUI.tui.setFocus(this);
                },
            );
            return;
        }
        // Esc -> 关闭
        if (matchesKey(keyData, 'escape')) {
            this.close();
            return;
        }
        // Enter -> 切换任务
        if (matchesKey(keyData, 'enter')) {
            const taskId = this.getSelectedTaskId();
            if (taskId) {
                this.close();
                const task = this.openDeskTUI.taskManagerState.getTask(taskId);
                if (task) {
                    this.openDeskTUI.switchToTask(task);
                }
            }
            return;
        }
        // 其余按键（上下翻页等）转发给 SelectTable
        this.table.handleInput(keyData);
    }

    private close() {
        if (this.hideHandle) {
            this.hideHandle.hide();
        }
        this.openDeskTUI.hasOpenOverlay = false;
        this.openDeskTUI.tui.setFocus(this.openDeskTUI.inputArea.input);
    }

    show() {
        if (this.getTasks().length === 0) return;
        this.hideHandle = this.openDeskTUI.tui.showOverlay(this, {
            width: "80%",
            maxHeight: "80%",
            anchor: "center",
        });

        this.openDeskTUI.hasOpenOverlay = true;
        // 焦点设到自身，使 handleInput 能拦截自定义按键
        this.openDeskTUI.tui.setFocus(this);

        this.table.onSelect = (taskID: string) => {
            this.close();
            const task = this.openDeskTUI.taskManagerState.getTask(taskID);
            if (task) {
                this.openDeskTUI.switchToTask(task);
            }
        };

        this.table.onCancel = () => {
            this.close();
        };
    }
}