import type { OpenDeskTUI } from '../entry.js';
import { AssistantMessage } from '../../aikernel/messages.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';

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
