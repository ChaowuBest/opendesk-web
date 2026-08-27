import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { definePlugin } from '../../../../packages/plugin-sdk/src/index.js';
import { AssistantMessage, UserMessage } from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { disposePluginHost, initializePluginHost } from '../../../main/applications/pluginmgr/runtime/bootstrap.js';
import { setRuntimePluginDirectories } from '../../../main/applications/pluginmgr/management/config.js';
import { getPluginHost } from '../../../main/applications/pluginmgr/runtime/host.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';

describe('conversation.review plugin hook', () => {
    let configDirectory: string;

    beforeEach(async () => {
        configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-conversation-review-'));
        setCustomOpendeskDirectory(configDirectory);
        setRuntimePluginDirectories([]);
        Setting.clearCache();
        await initializePluginHost();
    });

    afterEach(async () => {
        await disposePluginHost();
        setRuntimePluginDirectories([]);
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
                    ctx.hooks.on('conversation.review', (input) => {
                        received = input;
                    });
                }
            }),
            { origin: 'test:conversation-review-observer' }
        );

        const task = new TaskState(new TaskManagerState());
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
                    ctx.hooks.on('conversation.review', () => {
                        calls++;
                    });
                }
            }),
            { origin: 'test:internal-review-observer' }
        );

        const task = new TaskState(new TaskManagerState());
        task.markAsInternal();
        task.chat_context.appendMessage(new UserMessage('internal task'));
        await task.hooks.noticeOnTaskReview({ task, startMessageIndex: 0 });

        expect(calls).toBe(0);
    });
});
