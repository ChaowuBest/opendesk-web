/**
 * 续跑等待回归测试：hook 拒绝后的终态渲染快照不得提前唤醒 waitUntilFinished。
 *
 * 故障链（!621 / b03d6241b 引入）：beforeFinishTurn 拒绝 → 退避重试前补发
 * 快照，chunk 硬编码 task_status='stopped' → waitUntilFinished 的 settle
 * 判定不区分 chunk 类型，等待者在退避期间被提前释放 → headless 导出退出
 * （exit=0、任务停留 running），续跑轮次丢失。
 *
 * 修复后快照携带真实任务状态与 finalized 标记：等待者只在真实的 stopped
 * 状态迁移（turn 收尾）时被唤醒。
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
    type TaskUpdateChunk
} from '../../../main/aikernel/states/tasks.js';
import { Setting, setCustomOpendeskDirectory } from '../../../main/utils/setting.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

jest.setTimeout(60_000);

class TestPlatform extends AbstractPlatform {
    // 与 turn-final-render.test.ts 相同的测试平台：needsHtmlRender 走生产渲染路径
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

class CollectingSubscriber extends BaseTaskUpdateSubscriber {
    constructor(private readonly chunks: TaskUpdateChunk[]) {
        super();
    }

    send(chunkUpdate: TaskUpdateChunk): void {
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
    task.chat_context.appendMessage(new UserMessage('请继续分析'));
    task.chat_context.appendMessage(new AssistantMessage());

    const chunks: TaskUpdateChunk[] = [];
    task.addSubscriber(new CollectingSubscriber(chunks));
    return { task, chunks };
}

async function waitForCondition(predicate: () => boolean, attempts = 2000): Promise<void> {
    for (let i = 0; i < attempts; i++) {
        if (predicate()) return;
        await jest.advanceTimersByTimeAsync(0);
        await Promise.resolve();
    }
    throw new Error('condition not met');
}

describe('hook 拒绝退避期间 waitUntilFinished 的唤醒时机', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-wait-finalized-'));
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

    test('退避期间终态快照不唤醒等待者，重试轮执行后由真实 stopped 唤醒', async () => {
        const { task, chunks } = createRunningTask();

        // session memory / task name 等收尾后台任务的兜底 mock，避免真实网络请求
        jest.spyOn(LLM, 'ask').mockResolvedValue('finished');

        let requestCount = 0;
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* () {
            requestCount++;
            if (requestCount === 1) {
                yield textResponse('第一轮分析，');
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

        // 与 headless CLI（tui/headless.ts）一致的调用方式：默认参数，
        // 仅依赖携带 task_status='stopped' 的 chunk 唤醒
        let settled = false;
        const waitPromise = task
            .waitUntilFinished(async () => {})
            .then(() => {
                settled = true;
            });

        const turnPromise = task.processTaskTurn();

        // 第一轮流结束、hook 已拒绝、进入 5 秒退避（重试请求尚未发出）
        await waitForCondition(() => hookCalls === 1 && requestCount === 1);
        // 终态快照已发布
        await waitForCondition(() => chunks.some((chunk) => chunk.type === 'assistant_replace'));
        await jest.advanceTimersByTimeAsync(0);

        // 修复点：快照发布后、退避结束前，等待者不得被唤醒
        expect(settled).toBe(false);

        // 退避结束 → 重试轮执行 → turn 正常收尾 → 等待者由真实 stopped 唤醒
        await jest.advanceTimersByTimeAsync(5_000);
        await turnPromise;
        await waitForCondition(() => settled === true);
        await waitPromise;
        expect(requestCount).toBe(2);

        // 重试轮内容正常存在
        const finalAssistant = task.chat_context.lastMessage() as AssistantMessage;
        expect(finalAssistant.content.some((part) => part.type === 'text' && part.text.includes('第二轮'))).toBe(true);
    });
});
