import type { OpenDeskTUI } from '../entry.js';
import { InfoOverlay } from '../components/notice.js';
import { GoalController } from '../../aikernel/goal/controller.js';
import { GoalService } from '../../aikernel/goal/service.js';
import { t } from '../../../locale/index.js';

const GOAL_SUBCOMMANDS = ['status', 'edit', 'pause', 'resume', 'clear'];

function showInfo(tui: OpenDeskTUI, titleKey: string, message: string): void {
    const info = new InfoOverlay(tui, {
        title: t(titleKey),
        message,
        closeLabel: t('common.close'),
        fullWidth: true
    });
    info.show();
}

function showHelp(tui: OpenDeskTUI): void {
    showInfo(tui, 'goal.help.title', t('goal.help'));
}

function getCurrentTask(tui: OpenDeskTUI) {
    if (!tui.activeTaskId) return undefined;
    return tui.taskManagerState.getTask(tui.activeTaskId);
}

function formatStatus(task: ReturnType<typeof getCurrentTask>): string {
    if (!task) return t('goal.error.no_task');
    const view = GoalController.getStatus(task);
    if (!view.summary) return t('goal.status.none');
    const lines = [
        t('goal.status.goal', { status: view.summary.status, revision: view.summary.revision }),
        t('goal.status.objective', { objective: view.summary.objective }),
        t('goal.status.pending', { pending: view.summary.pendingContinuation ? t('goal.yes') : t('goal.no') })
    ];
    if (view.attempts !== undefined) {
        lines.push(t('goal.status.attempts', { attempts: view.attempts, maxAttempts: view.maxAttempts ?? '-' }));
    }
    if (view.lastEvaluationStatus) {
        lines.push(
            t('goal.status.last_evaluation', {
                status: view.lastEvaluationStatus,
                at: view.lastEvaluationAt ?? '-'
            })
        );
    }
    return lines.join('\n');
}

function showResult(tui: OpenDeskTUI, result: { ok: boolean; messageKey?: string; errorCode?: string }): void {
    if (result.ok) return;
    if (result.messageKey === 'goal.help') {
        showHelp(tui);
        return;
    }
    showInfo(tui, 'goal.error.title', t(result.messageKey ?? 'goal.error.unknown'));
}

function followStartedGoalTask(
    tui: OpenDeskTUI,
    task: ReturnType<typeof getCurrentTask>,
    result: { ok: boolean; startedScheduler?: boolean }
): void {
    if (result.ok && result.startedScheduler && task) {
        tui.followRunningTask(task);
    }
}

export function registerGoalCommand(tui: OpenDeskTUI): void {
    tui.commandRegistry.register({
        name: 'goal',
        description: t('goal.description'),
        getArgumentCompletions: (argPrefix: string) => {
            const trimmed = argPrefix.trim();
            if (argPrefix.includes(' ') && !argPrefix.endsWith(' ')) return [];
            return GOAL_SUBCOMMANDS.filter((cmd) => cmd.startsWith(trimmed)).map((cmd) => ({
                value: cmd,
                label: cmd,
                description: t(`goal.completion.${cmd}`)
            }));
        },
        execute: async (args: string) => {
            if (args.trim().length === 0) {
                showHelp(tui);
                return;
            }

            const trimmed = args.trim();
            const firstSpace = trimmed.indexOf(' ');
            const subcommand = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
            const rest = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1);
            const isGoalSubcommand = GOAL_SUBCOMMANDS.includes(subcommand);

            let task = getCurrentTask(tui);
            if (!task && !isGoalSubcommand) {
                await tui.createNewTask();
                task = getCurrentTask(tui);
            }
            if (!task) {
                showInfo(tui, 'goal.error.title', t('goal.error.no_task'));
                return;
            }

            if (subcommand === 'status') {
                showInfo(tui, 'goal.status.title', formatStatus(task));
                return;
            }
            if (subcommand === 'edit') {
                const result = await GoalService.edit(task, rest, 'tui');
                showResult(tui, result);
                followStartedGoalTask(tui, task, result);
                return;
            }
            if (subcommand === 'pause') {
                const result = await GoalService.pause(task, rest.trim() || undefined, 'tui');
                showResult(tui, result);
                return;
            }
            if (subcommand === 'resume') {
                const result = await GoalService.resume(task, { source: 'tui' });
                showResult(tui, result);
                followStartedGoalTask(tui, task, result);
                return;
            }
            if (subcommand === 'clear') {
                const result = await GoalService.clear(task, 'tui');
                showResult(tui, result);
                return;
            }

            const result = await GoalService.create(task, { objective: trimmed, source: 'tui' });
            showResult(tui, result);
            followStartedGoalTask(tui, task, result);
        }
    });
}
