import { type Component, Box, Text } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { OpenDeskTUI } from '../entry.js';
import { defaultSelectListTheme } from '../theme.js';
import { SelectTable, type SelectRow } from './selecttable.js';
import { InfoOverlay } from './notice.js';
import { logger } from '../../utils/logger.js';
import type { TaskState } from '../../aikernel/states/tasks.js';
import type { ChatMessage, UserMessage } from '../../aikernel/messages.js';
import { getLocale, t } from '../../../locale/index.js';

export interface UndoMessageEntry {
    message: UserMessage;
    ordinal: number;
}

export function getUndoableUserMessages(task: TaskState): UndoMessageEntry[] {
    const entries: UndoMessageEntry[] = [];

    task.chat_context.messages.forEach((message) => {
        if (message.role !== 'user' || (message as UserMessage).internal === true) {
            return;
        }
        entries.push({
            message: message as UserMessage,
            ordinal: entries.length + 1
        });
    });

    return entries;
}

function getUserMessagePreview(message: UserMessage): string {
    const text = getUserMessageDraftText(message).trim();
    if (text.length > 0) {
        return text;
    }

    const attachmentCount = message.content.filter((part) => part.type === 'file' || part.type === 'image_url').length;
    if (attachmentCount > 0) {
        return t('undo.overlay.preview.attachments', { count: attachmentCount });
    }

    return t('undo.overlay.preview.empty');
}

export function getUserMessageDraftText(message: UserMessage): string {
    return message.rawText || message.getPlainText();
}

function formatUserMessageTime(timestamp: number): string {
    try {
        return new Intl.DateTimeFormat(getLocale(), {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        }).format(new Date(timestamp));
    } catch {
        return '';
    }
}

export class UndoOverlay implements Component {
    private readonly openDeskTUI: OpenDeskTUI;
    private readonly taskId: string;
    private readonly table: SelectTable;
    private readonly headerText: Text;
    private readonly footerText: Text;
    private box: Box;
    private executing = false;

    constructor(openDeskTUI: OpenDeskTUI, task: TaskState) {
        this.openDeskTUI = openDeskTUI;
        this.taskId = task.task_id;

        const entries = getUndoableUserMessages(task);
        const rows = this.buildRows(entries);
        this.table = new SelectTable(rows, this.getMaxVisibleRows(rows.length), defaultSelectListTheme);
        this.table.setColumnStrechFactors([0, 4, 1]);
        this.table.setAlignments(['right', 'left', 'right']);
        this.selectInitialRow(rows.length);
        this.table.onSelect = (messageId) => {
            void this.execute(messageId);
        };
        this.table.onCancel = () => {
            this.close();
        };

        this.headerText = new Text(this.buildHeader());
        this.footerText = new Text(chalk.dim(t('undo.overlay.footer')));
        this.box = this.buildBox();
    }

    private selectInitialRow(rowCount: number): void {
        const index = Math.max(0, rowCount - 1);
        const innerList = this.table.innerList as any;
        if (typeof innerList.setSelectedIndex === 'function') {
            innerList.setSelectedIndex(index);
        } else {
            innerList.selectedIndex = index;
        }
    }

    private buildRows(entries: UndoMessageEntry[]): SelectRow[] {
        return entries.map(({ message, ordinal }) => ({
            labels: [
                String(ordinal),
                getUserMessagePreview(message),
                message.timestamp ? formatUserMessageTime(message.timestamp) : ''
            ],
            value: message.message_id
        }));
    }

    private buildBox(): Box {
        const box = new Box(1, 1);
        box.setBgFn((text: string) => chalk.bgHex('#2d2d2d').hex('#e0e0e0')(text));
        box.addChild(this.headerText);
        box.addChild(this.table);
        box.addChild(this.footerText);
        return box;
    }

    private buildHeader(): string {
        return ` ${chalk.bold(t('undo.overlay.title'))}  ${chalk.dim(t('undo.overlay.action.rewind'))}`;
    }

    private getMaxVisibleRows(rowCount: number): number {
        const available = this.openDeskTUI.tui.terminal.rows - 12;
        return Math.max(1, Math.min(rowCount, Math.max(5, Math.min(20, available))));
    }

    private close(): void {
        const restored = this.openDeskTUI.closeInputPrompt(this);
        this.openDeskTUI.focusAfterInputPromptClose(restored);
    }

    private async execute(messageId: string): Promise<void> {
        if (this.executing) {
            return;
        }

        this.executing = true;
        const task = this.openDeskTUI.taskManagerState.getTask(this.taskId);
        if (!task) {
            this.close();
            new InfoOverlay(this.openDeskTUI, {
                title: t('undo.fail'),
                message: t('undo.error.task.notfound')
            }).show();
            return;
        }

        const messageIndex = task.chat_context.messages.findIndex(
            (message) => message.role === 'user' && message.message_id === messageId
        );
        if (messageIndex === -1) {
            this.close();
            new InfoOverlay(this.openDeskTUI, {
                title: t('undo.fail'),
                message: t('undo.error.message.notfound')
            }).show();
            return;
        }
        const selectedMessage = task.chat_context.messages[messageIndex] as UserMessage;
        const draftText = getUserMessageDraftText(selectedMessage);
        const redoSnapshot: ChatMessage[] = task.chat_context.messages.slice(messageIndex);
        this.close();

        try {
            const result = await task.rewindToUserMessage(messageId, {
                resubmit: false,
                source: 'tui'
            });
            if (redoSnapshot.length > 0) {
                if (!this.openDeskTUI.undoStacks.has(task.task_id)) {
                    this.openDeskTUI.undoStacks.set(task.task_id, []);
                }
                this.openDeskTUI.undoStacks.get(task.task_id)!.push(redoSnapshot);
            }
            this.openDeskTUI.followRunningTask(task);
            this.openDeskTUI.inputArea.input.setText(draftText);
            this.openDeskTUI.focusInputAreaIfAvailable();
            this.openDeskTUI.tui.requestRender();
            logger.info(
                `/undo: rewound to user message ${messageId}, removed ${result.removedCount} messages and restored it to input`
            );
        } catch (err) {
            new InfoOverlay(this.openDeskTUI, {
                title: t('undo.fail'),
                message: t('undo.error.operation.failed', {
                    error: err instanceof Error ? err.message : String(err)
                })
            }).show();
        }
    }

    invalidate(): void {
        this.box.invalidate();
    }

    render(width: number): string[] {
        return this.box.render(width);
    }

    handleInput(keyData: string): void {
        this.table.handleInput(keyData);
        this.openDeskTUI.tui.requestRender();
    }

    show(): void {
        if (this.openDeskTUI.deferInputPromptIfBlockedByMode(() => this.show())) {
            return;
        }

        this.openDeskTUI.inputArea.showPromptWidget(this);
        this.openDeskTUI.hasOpenOverlay = true;
        this.openDeskTUI.tui.setFocus(this);
    }
}
