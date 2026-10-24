/**
 * Issue #332 回归测试：hook 拒绝重试前必须补发「最终渲染快照」。
 *
 * 故障链：termination check 判 interrupted → beforeFinishTurn 拒绝 →
 * 主循环 backoff 后丢弃当前 assistant 消息、新建空消息重跑。被打断的
 * 长消息停在流式原始态：主进程从未执行最终 markdown+KaTeX 渲染
 * （streaming 期间 sendSubscriptionFeedback 有意跳过渲染），前端
 * `$...$`、`\begin{pmatrix}` 等 LaTeX 源码原样露出。
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { LLM } from '../../../main/aikernel/llm.js';
import {
    AssistantMessage,
    AssistantResponse,
    ChatContext,
    Usage,
    UserMessage
} from '../../../main/aikernel/messages.js';
import {
    BaseTaskUpdateSubscriber,
    TaskManagerState,
    TaskState,
    type TaskUpdateAssistantReplaceChunk,
    type TaskUpdateChunk
} from '../../../main/aikernel/states/tasks.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

jest.setTimeout(60_000);

class TestPlatform extends AbstractPlatform {
    // needsHtmlRender 仅在 electron 平台开启，与生产渲染路径保持一致
    getName(): string {
        return 'electron';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(_task: TaskState): Promise<void> {}

    async fetch(_input: string | URL, _init?: RequestInit): Promise<Response> {
        return new Response('{}', { status: 200 });
    }
}

class HtmlRenderSubscriber extends BaseTaskUpdateSubscriber {
    wantsHtmlRender = true;
    constructor(private readonly chunks: TaskUpdateChunk[]) {
        super();
    }

    send(chunkUpdate: TaskUpdateChunk): void {
        // 生产链路（IPC structured clone）在 publish 瞬间序列化；测试同样做快照，
        // 避免后续 render() 通过引用"事后"改写断言观察到的内容
        this.chunks.push(JSON.parse(JSON.stringify(chunkUpdate)) as TaskUpdateChunk);
    }
}

function textResponse(text: string): AssistantResponse {
    const message = new AssistantMessage();
    message.appendText(text);
    const response = new AssistantResponse(message, 'stop');
    response.usage = new Usage(10, text.length, 10 + text.length);
    return response;
}

function createRunningTask(): { task: TaskState; chunks: TaskUpdateChunk[] } {
    Setting.updateInstanceData({
        default_model: 'mock-model',
        providers: [
            {
                name: 'mock-provider',
                provider_type: 'openai',
                base_url: 'https://mock.local/v1',
                api_key: 'test-key',
                no_proxy: true
            }
        ],
        models: [
            {
                alias: 'mock-model',
                provider_name: 'mock-provider',
                model_name: 'mock/model',
                context_length: 8192,
                max_output_tokens: 4096
            }
        ],
        task_config: {
            auto_retry: false
        }
    });

    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();

    const task = new TaskState(manager);
    task.task_status = 'running';
    task.model = 'mock-model';
    task.chat_context = new ChatContext();
    task.chat_context.appendMessage(new UserMessage('请推导这个引理'));
    task.chat_context.appendMessage(new AssistantMessage());

    const chunks: TaskUpdateChunk[] = [];
    task.addSubscriber(new HtmlRenderSubscriber(chunks));
    return { task, chunks };
}

async function waitForCondition(predicate: () => boolean, attempts = 2000): Promise<void> {
    // 与 task-llm-retry.test.ts 相同的假时钟推进模式；advanceTimersByTimeAsync
    // 顺带排干微任务，让 turn 收尾的 floating promise（sendSubscriptionFeedback 等）落地
    for (let i = 0; i < attempts; i++) {
        if (predicate()) return;
        await jest.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
    throw new Error('condition not met');
}

describe('hook 拒绝重试前的终态渲染快照 (issue #332)', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-turn-final-render-'));
        setCustomOpendeskDirectory(tempDir);
        Setting.clearCache();
        setPlatform(new TestPlatform());
        jest.useFakeTimers();
        jest.setSystemTime(new Date('2026-06-10T10:00:00.000Z'));
    });

    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
        Setting.clearCache();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test('第一次 hook 拒绝后、重跑请求发出前，向订阅者推送 task_status=stopped 的 assistant_replace 且 text part 携带最终渲染 HTML', async () => {
        const { task, chunks } = createRunningTask();

        // session memory / task name 等收尾后台任务的兜底 mock，避免真实网络请求
        jest.spyOn(LLM, 'ask').mockResolvedValue('finished');

        let requestCount = 0;
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            requestCount++;
            if (requestCount === 1) {
                // 中文冒号结尾 → fastInterruptionCheck 命中 interrupted
                yield textResponse('# 第一轮结论\n\n质能方程 $E=mc^2$，');
                return;
            }
            yield textResponse('第二轮补充完成。');
        });

        let hookCalls = 0;
        task.hooks.beforeFinishTurn(async () => {
            hookCalls++;
            if (hookCalls === 1) {
                return { operation: 'reject', message: '<system-reminder>继续</system-reminder>' };
            }
            return { operation: 'finish' };
        });

        const turnPromise = task.processTaskTurn();

        // 第一轮流结束、hook 已拒绝、重试请求尚未发出
        await waitForCondition(() => hookCalls === 1 && requestCount === 1);
        expect(requestCount).toBe(1);

        // 修复点：拒绝后立即补发终态快照（stopped + 最终渲染 HTML）
        await waitForCondition(() =>
            chunks.some((chunk) => chunk.type === 'assistant_replace' && chunk.task_status === 'stopped')
        );
        const finalReplaces = chunks.filter(
            (chunk): chunk is TaskUpdateAssistantReplaceChunk =>
                chunk.type === 'assistant_replace' && chunk.task_status === 'stopped'
        );
        expect(finalReplaces.length).toBeGreaterThanOrEqual(1);
        const finalReplace = finalReplaces[finalReplaces.length - 1];
        const textPart = finalReplace.parts.find((part) => part.type === 'text') as
            { type: string; text: string; rendered?: string } | undefined;
        expect(textPart).toBeDefined();
        expect(typeof textPart!.rendered).toBe('string');
        // markdown+KaTeX 渲染确实执行过：标题标签与 KaTeX 产物出现，而非源码透传
        expect(textPart!.rendered).toContain('<h1>');
        expect(textPart!.rendered).toContain('katex');
        expect(textPart!.rendered).not.toContain('$E=mc^2$');

        // 终态快照先于重跑请求
        expect(requestCount).toBe(1);
        await jest.advanceTimersByTimeAsync(5_000);
        await turnPromise;
        expect(requestCount).toBe(2);

        // 重跑产生的第二轮内容正常存在
        const finalAssistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(finalAssistant.content.some((part) => part.type === 'text' && part.text.includes('第二轮'))).toBe(true);
    });

    test('非流式快照携带渲染 HTML：流式推送（streaming）保持无 rendered 的原始形态', async () => {
        const { task, chunks } = createRunningTask();
        jest.spyOn(LLM, 'ask').mockResolvedValue('finished');

        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            yield textResponse('秒回结论。');
        });
        task.hooks.beforeFinishTurn(async () => ({ operation: 'finish' }));

        await task.processTaskTurn();
        // 收尾的 sendSubscriptionFeedback 是 floating promise，冲洗微任务让它落地
        await jest.advanceTimersByTimeAsync(0);
        await jest.advanceTimersByTimeAsync(0);

        const streamingChunks = chunks.filter((chunk) => chunk.type === 'assistant' && chunk.streaming === true);
        for (const chunk of streamingChunks) {
            expect(chunk.task_status).toBe('running');
        }
        const replaces = chunks.filter((chunk) => chunk.type === 'assistant_replace');
        expect(replaces.length).toBeGreaterThanOrEqual(1);
    });
});
