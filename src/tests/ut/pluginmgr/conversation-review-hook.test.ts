import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import { AssistantMessage, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { disposePluginHost, initializePluginHost } from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
import { setRuntimePluginsDirectories } from '../../../main/applications/pluginmgr/management/paths.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

const managers: TaskManagerState[] = [];

function createManager(): TaskManagerState {
    const manager = new TaskManagerState();
    managers.push(manager);
    return manager;
}

describe('task.review plugin hook', () => {
    let configDirectory: string;

    beforeEach(async () => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-conversation-review-'));
        setCustomOpendeskDirectory(configDirectory);
        setRuntimePluginsDirectories('');
        Setting.clearCache();
        await initializePluginHost();
    });

    afterEach(async () => {
        for (const manager of managers) {
            await manager.flushAllPendingSaves();
        }
        managers.length = 0;
        await disposePluginHost();
        setRuntimePluginsDirectories('');
        Setting.clearCache();
        setCustomOpendeskDirectory(undefined);
        fs.rmSync(configDirectory, { recursive: true, force: true });
    });

    test('reviews visible user and assistant text from the requested message index', async () => {
        let received: unknown;
        await getPluginHost().activate(
            definePlugin({
                id: 'conversation-review-observer',
                capabilities: ['hook'],
                setup(ctx) {
                    ctx.hooks.on('task.review', (input) => {
                        received = input;
                    });
                }
            }),
            { origin: 'test:conversation-review-observer' }
        );

        const task = new TaskState(createManager());
        task.chat_context.appendMessage(new UserMessage('before review range'));
        const internal = new UserMessage('internal instruction');
        internal.internal = true;
        task.chat_context.appendMessage(internal);
        task.chat_context.appendMessage(new UserMessage('review this question'));
        const assistant = new AssistantMessage();
        assistant.appendReasoningContent('hidden reasoning');
        assistant.appendText('visible answer');
        task.chat_context.appendMessage(assistant);

        await task.hooks.noticeOnTaskReview({ task, startMessageIndex: 1 });

        expect(received).toEqual({
            taskId: task.task_id,
            messages: [
                { role: 'user', content: 'review this question' },
                { role: 'assistant', content: 'visible answer' }
            ]
        });
    });

    test('does not review internal tasks', async () => {
        let calls = 0;
        await getPluginHost().activate(
            definePlugin({
                id: 'internal-review-observer',
                capabilities: ['hook'],
                setup(ctx) {
                    ctx.hooks.on('task.review', () => {
                        calls++;
                    });
                }
            }),
            { origin: 'test:internal-review-observer' }
        );

        const task = new TaskState(createManager());
        task.markAsInternal();
        task.chat_context.appendMessage(new UserMessage('internal task'));
        await task.hooks.noticeOnTaskReview({ task, startMessageIndex: 0 });

        expect(calls).toBe(0);
    });
});
