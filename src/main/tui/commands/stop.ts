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

import type { OpenDeskTUI } from '../entry.js';
import { AssistantMessage } from '../../aikernel/messages.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';
import { GoalService } from '../../aikernel/goal/service.js';

export function registerStopCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'stop',
        description: t('stop.description'),
        execute: async () => {
            if (!tui.activeTaskId) {
                logger.warn('No active task');
                return;
            }

            const currentTask = tui.taskManagerState.getTask(tui.activeTaskId);
            if (!currentTask) {
                logger.warn('Current task not found');
                return;
            }

            if (currentTask.goal_state?.status === 'active') {
                const wasRunning = currentTask.task_status === 'running';
                const result = await GoalService.stopActiveGoal(currentTask, 'tui');
                if (!result.ok) {
                    logger.warn(`Failed to stop active goal: ${result.errorCode ?? result.messageKey ?? 'unknown'}`);
                    return;
                }
                tui.inputArea.statusBar.stopTimer();
                tui.inputArea.setStatus('idle');
                if (wasRunning) {
                    tui.inputArea.clearMessageQueue();
                }
                logger.info('Active goal paused by stop command');
                tui.tui.requestRender();
                return;
            }

            if (currentTask.task_status !== 'running') {
                logger.warn('Current task is not running');
                return;
            }

            const lastMessage = currentTask.chat_context.lastMessage();
            if (lastMessage instanceof AssistantMessage) {
                const content = Array.isArray(lastMessage.content) ? lastMessage.content : [];
                for (const part of content) {
                    if (part?.type === 'tool_call') {
                        const toolcalls = Array.isArray(part.toolcalls) ? part.toolcalls : [];
                        for (const tc of toolcalls) {
                            if (!tc) continue;
                            if (tc.tool && tc.status === 'running') {
                                try {
                                    await tc.tool.stop();
                                } catch (e) {
                                    logger.warn(`Failed to stop tool ${tc.tool_name}: ${e}`);
                                }
                            }
                        }
                    }
                }
            }

            currentTask.stop();
            tui.inputArea.statusBar.stopTimer();
            tui.inputArea.setStatus('idle');
            tui.inputArea.clearMessageQueue();
            logger.info('Task stopped');
            tui.tui.requestRender();
        }
    });
}
