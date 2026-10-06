import { jest } from '@jest/globals';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { AssistantMessage, TextMessagePart } from '../../../main/aikernel/messages.js';
import { BaseTaskUpdateSubscriber, TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { setRenderWorkspace } from '../../../main/utils/marked-file-link.js';

function createTask(workspace: string): TaskState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    const task = new TaskState(manager);
    task.workspace = workspace;
    manager.tasks.push(task);
    return task;
}

class HtmlSubscriber extends BaseTaskUpdateSubscriber {
    override wantsHtmlRender = true;
    override send(): void {}
}

const ANSWER_TEXT = '[setting.ts](src/main/utils/setting.ts#L1256-L1266)';

function expectedPreview(workspace: string): string {
    return `data-open-preview="${path.join(workspace, 'src', 'main', 'utils', 'setting.ts')}"`;
}

describe('file pill rendering keeps task workspace context', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pill-ws-'));
        fs.mkdirSync(path.join(workspace, 'src', 'main', 'utils'), { recursive: true });
        fs.writeFileSync(path.join(workspace, 'src', 'main', 'utils', 'setting.ts'), 'export {};');
    });

    afterEach(() => {
        setRenderWorkspace(null);
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    test('assistant message replace renders text parts under the task workspace', async () => {
        const task = createTask(workspace);
        task.chat_context.messages.push(new AssistantMessage([new TextMessagePart(ANSWER_TEXT)]));
        task.addSubscriber(new HtmlSubscriber());
        jest.spyOn(task, 'needsHtmlRender', 'get').mockReturnValue(true);

        await task.sendSubscriptionFeedback();

        const part = task.chat_context.lastMessage()!.content[0] as TextMessagePart;
        expect(part.rendered).toContain(expectedPreview(workspace));
    });

    test('subscription feedback renders a non-streaming text part under the task workspace', async () => {
        const task = createTask(workspace);
        // 文本 part 后又追加了新 part（如 tool_call）：再次推送早期 part 时
        // sendSubscriptionFeedback 走 last_part.render() 分支，同样需要 workspace 上下文
        task.task_status = 'running';
        task.chat_context.messages.push(
            new AssistantMessage([new TextMessagePart(ANSWER_TEXT), new TextMessagePart('tail')])
        );
        task.addSubscriber(new HtmlSubscriber());
        jest.spyOn(task, 'needsHtmlRender', 'get').mockReturnValue(true);

        await task.sendSubscriptionFeedback(0);

        const part = task.chat_context.lastMessage()!.content[0] as TextMessagePart;
        expect(part.rendered).toContain(expectedPreview(workspace));
    });

    test('task.render() re-renders a persisted cache that lacks workspace provenance', async () => {
        const task = createTask(workspace);
        // 模拟历史版本落盘的 rendered：渲染时没有 workspace 上下文，相对路径被解析到进程 CWD
        const part = TextMessagePart.assign({
            type: 'text',
            text: ANSWER_TEXT,
            rendered: `<button data-open-preview="/src/main/utils/setting.ts">setting.ts</button>`
        });
        task.chat_context.messages.push(new AssistantMessage([part]));

        await task.render();

        expect(part.rendered).toContain(expectedPreview(workspace));
        expect(part.rendered).not.toContain('"/src/main/utils/setting.ts"');
    });
});
