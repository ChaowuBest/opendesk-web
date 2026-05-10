import type { OpenDeskTUI } from '../entry.js';
import { logger } from '../../utils/logger.js';
import { t } from '../../../locale/index.js';
import { inspectContextForDiagnostics } from '../../aikernel/context/inspect.js';
import { analyzeContextDiagnostics } from '../../aikernel/context/analyze.js';
import { generateContextSuggestions } from '../../aikernel/context/suggestions.js';
import { formatContextDiagnosticsReport } from '../../aikernel/context/format.js';
import { openContextVisualPage, openContextDataPage } from '../components/context.js';

function resolveActiveTask(tui: OpenDeskTUI) {
    if (tui.activeTaskId) {
        const task = tui.taskManagerState.getTask(tui.activeTaskId);
        if (task) {
            return task;
        }
    }

    return tui.taskView.taskState;
}

export function registerContextCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'context',
        description: t('context.description'),
        execute: async (args: string) => {
            const trimmedArgs = args.trim().toLowerCase();
            const showRawData = trimmedArgs.split(/\s+/).includes('--data');
            const task = resolveActiveTask(tui);
            if (!task) {
                tui.showTextPage(t('context.title'), t('context.no.task'));
                return;
            }

            if (tui.activeTaskId && tui.taskManagerState.getTask(tui.activeTaskId) === undefined) {
                tui.showTextPage(t('context.title'), t('context.task.not.found'));
                return;
            }

            try {
                const inspection = await inspectContextForDiagnostics(task.chat_context, task.model ?? tui.model, {
                    taskId: task.task_id,
                    autoCompactState: task.auto_compact_state,
                    toolResultReplacementState: task.tool_result_replacement_state,
                    readonlyOnly: true,
                    enableMicrocompact: true,
                    enableSessionMemoryCompact: false,
                    enableToolResultBudget: true,
                    microcompactState: task.microcompact_state,
                    microcompactRequestKind: 'view_only',
                    microcompactTaskRole: task.parent_id === null ? 'main' : 'subtask'
                });

                const report = analyzeContextDiagnostics({
                    chatContext: task.chat_context,
                    inspection,
                    modelName: task.model ?? tui.model
                });
                const suggestions = generateContextSuggestions(report);
                if (showRawData) {
                    openContextDataPage(tui, report, suggestions);
                } else {
                    openContextVisualPage(tui, report, suggestions);
                }
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                logger.error(`context diagnostics failed: ${message}`);
                tui.showTextPage(t('context.title'), `${t('context.fail')}\n${message}`);
            }
        }
    });
}
