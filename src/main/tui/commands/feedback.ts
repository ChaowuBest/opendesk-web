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

import path from 'path';
import type { OpenDeskTUI } from '../entry.js';
import { t } from '../../../locale/index.js';
import { submitFeedback } from '../../utils/feedback.js';
import { getPlatform } from '../../../platforms/base.js';
import { getLogDirectory, getTaskDirectory } from '../../utils/setting.js';
import { getLogFilename } from '../../utils/logger.js';
import { FeedbackWidget, type FeedbackSubmitter, type FeedbackTaskOption } from '../components/feedback.js';

/** Bug 表单任务下拉最多展示的任务数，与 GUI FEEDBACK_TASK_OPTION_LIMIT 对齐 */
export const TASK_OPTION_LIMIT = 10;

/**
 * 构建反馈表单的任务下拉候选项：排除自动化任务（internal，与 GUI 侧边栏口径一致）、
 * 按活动时间降序、最多取 TASK_OPTION_LIMIT 个。任务名为空时回退为「未命名任务」。
 */
export function buildFeedbackTaskOptions(taskManagerState: OpenDeskTUI['taskManagerState']): FeedbackTaskOption[] {
    return taskManagerState.tasks
        .filter((task) => task.internal !== true)
        .map((task) => ({
            taskId: task.task_id,
            name: (task.task_name ?? '').trim() || t('renderer.sidebar.unnamedTask'),
            updatedAt: Number(taskManagerState.getTask(task.task_id)?.updated_at ?? 0)
        }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, TASK_OPTION_LIMIT)
        .map(({ updatedAt: _unused, ...rest }) => rest);
}

function registerFeedbackCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'feedback',
        description: t('cli.feedback.description'),
        source: 'OpenDesk TUI',
        execute: () => {
            const submitter: FeedbackSubmitter = async (submission) => {
                const result = await submitFeedback(submission, {
                    fetchImpl: (input, init) => getPlatform().fetch(input as string | URL, init),
                    resolveLogPath: () => path.join(getLogDirectory(), getLogFilename()),
                    resolveTaskPath: (taskId) => path.join(getTaskDirectory(), `${taskId}.json`),
                    onWarn: (message) => console.warn(message),
                    onInfo: () => {}
                });
                return result.ok
                    ? { status: 'ok', id: result.id ?? null }
                    : { status: 'error', message: result.message };
            };

            const tasks: FeedbackTaskOption[] = buildFeedbackTaskOptions(tui.taskManagerState);

            const widget = new FeedbackWidget(tui, {
                submitter,
                tasks,
                currentTaskId: tui.activeTaskId ?? null
            });
            widget.show();
        }
    });
}

export { registerFeedbackCommand };
