import fs from 'fs';
import os from 'os';
import path from 'path';
import { jest } from '@jest/globals';
import { z } from 'zod';
import { AnthropicAdapter } from '../../../main/aikernel/adapters/anthropic.js';
import { OpenAIAdapter } from '../../../main/aikernel/adapters/openai.js';
import { LLM } from '../../../main/aikernel/llm.js';
import {
    AssistantMessage,
    AssistantResponse,
    ToolCall,
    ToolCallMessagePart,
    UserMessage
} from '../../../main/aikernel/messages.js';
import { TaskManagerState, TaskState } from '../../../main/aikernel/states/tasks.js';
import { serializeTask } from '../../../main/aikernel/task/serializer.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { AbstractPlatform, setPlatform } from '../../../platforms/base.js';

class TestPlatform extends AbstractPlatform {
    getName(): string {
        return 'test';
    }

    getEffectiveWorkspace(): string {
        return process.cwd();
    }

    async initPlatformHarness(_task: TaskState): Promise<void> {}

    async fetch(_input: string | URL, _init?: RequestInit): Promise<Response> {
        return new Response('{}', { status: 200 });
    }
}

function createManager(): TaskManagerState {
    const manager = new TaskManagerState();
    manager.save = jest.fn();
    manager.publishTaskListUpdate = jest.fn();
    manager.moveTaskToEnd = jest.fn();
    return manager;
}

function createSubmitTask(): TaskState {
    const task = new TaskState(createManager(), null);
    task.task_name = 'existing task';
    task.markCompacted();
    jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
    jest.spyOn(task, 'processTaskTurn').mockResolvedValue();
    return task;
}

describe('TaskState active TailCard sections', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('maintains an isolated ordered map with defensive list copies', () => {
        const manager = createManager();
        const first = new TaskState(manager);
        const second = new TaskState(manager);
        first._dirty = false;

        expect(first.listFrontendTailCardSections()).toEqual([]);
        first.setFrontendTailCardSection('a', 'first');
        first.setFrontendTailCardSection('b', 'second');
        first.setFrontendTailCardSection('a', 'updated');
        expect(first.listFrontendTailCardSections()).toEqual([
            { id: 'a', content: 'updated' },
            { id: 'b', content: 'second' }
        ]);

        const listed = first.listFrontendTailCardSections();
        listed[0].content = 'mutated';
        listed.push({ id: 'c', content: 'third' });
        expect(first.listFrontendTailCardSections()).toEqual([
            { id: 'a', content: 'updated' },
            { id: 'b', content: 'second' }
        ]);

        first.removeFrontendTailCardSection('missing');
        first.removeFrontendTailCardSection('a');
        first.setFrontendTailCardSection('a', 'last');
        expect(first.listFrontendTailCardSections()).toEqual([
            { id: 'b', content: 'second' },
            { id: 'a', content: 'last' }
        ]);
        expect(second.listFrontendTailCardSections()).toEqual([]);
        expect(first._dirty).toBe(false);
        expect(manager.save).not.toHaveBeenCalled();
        expect(manager.publishTaskListUpdate).not.toHaveBeenCalled();
    });

    test('rejects exact empty strings without trimming whitespace or changing state', () => {
        const task = new TaskState(createManager());
        task.setFrontendTailCardSection('existing', 'value');

        expect(() => task.setFrontendTailCardSection('', 'content')).toThrow(new TypeError('id must not be empty'));
        expect(() => task.setFrontendTailCardSection('id', '')).toThrow(new TypeError('content must not be empty'));
        expect(task.listFrontendTailCardSections()).toEqual([{ id: 'existing', content: 'value' }]);

        task.setFrontendTailCardSection(' ', '\n');
        expect(task.listFrontendTailCardSections()).toEqual([
            { id: 'existing', content: 'value' },
            { id: ' ', content: '\n' }
        ]);
    });

    test('new child tasks do not inherit parent state', () => {
        const manager = createManager();
        const parent = new TaskState(manager);
        manager.tasks.push(parent);
        parent.setFrontendTailCardSection('knowledge-mode', 'parent state');

        const child = manager.createSubTask(parent.task_id);

        expect(child.listFrontendTailCardSections()).toEqual([]);
        child.setFrontendTailCardSection('knowledge-mode', 'child state');
        expect(parent.listFrontendTailCardSections()).toEqual([{ id: 'knowledge-mode', content: 'parent state' }]);
    });

    test('dynamically composes current non-empty sections after EvidenceCard', async () => {
        const task = new TaskState(createManager());
        task.setFrontendTailCardSection('knowledge-mode', 'first knowledge prompt');
        task.setFrontendTailCardSection('renderer-context', 'second runtime prompt');

        const initial = await task.hooks.buildTailcards({
            task,
            chatContext: task.chat_context,
            requestType: 'streamComplete'
        });

        expect(initial).toContain('## Section: task-tail-card-sections');
        expect(initial).toContain('first knowledge prompt\n\nsecond runtime prompt');

        task.setFrontendTailCardSection('knowledge-mode', 'updated knowledge prompt');
        task.removeFrontendTailCardSection('renderer-context');
        const updated = await task.hooks.buildTailcards({
            task,
            chatContext: task.chat_context,
            requestType: 'streamComplete'
        });
        expect(updated).toContain('updated knowledge prompt');
        expect(updated).not.toContain('second runtime prompt');

        task.removeFrontendTailCardSection('knowledge-mode');
        expect(
            await task.hooks.buildTailcards({
                task,
                chatContext: task.chat_context,
                requestType: 'streamComplete'
            })
        ).toBeUndefined();
    });
});

describe('TaskState TailCard request projection', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('submitting a real user message never materializes TailCard content in history', async () => {
        const task = createSubmitTask();
        task.setFrontendTailCardSection('knowledge-mode', 'request-only knowledge prompt');

        await task.submitUserMessage('real message');

        expect(task.chat_context.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
        expect((task.chat_context.messages[0] as UserMessage).getPlainText()).toBe('real message');
        expect(JSON.stringify(task.chat_context.toJSON())).not.toContain('request-only knowledge prompt');
    });

    test('public internal-turn wrapper remains independent from active TailCard state', async () => {
        const task = new TaskState(createManager());
        const feedback = jest.spyOn(task, 'sendSubscriptionFeedback').mockResolvedValue();
        jest.spyOn(task, 'buildToolsets').mockResolvedValue([]);
        const processTurn = jest.spyOn(task, 'processTaskTurn').mockResolvedValue();

        await task.appendInternalUserMessage('legacy wrapper');
        expect(feedback).toHaveBeenCalledTimes(1);
        expect((task.chat_context.messages[0] as UserMessage).internal).toBe(true);

        task.setFrontendTailCardSection('knowledge-mode', 'must not enter history');
        await task.startInternalTurn({
            prompt: 'scheduler prompt',
            rawText: '/scheduler',
            source: 'test',
            metadata: { origin: { source: 'system' } }
        });

        expect(task.chat_context.messages.map((message) => message.role)).toEqual(['user', 'user', 'assistant']);
        expect((task.chat_context.messages[1] as UserMessage).getPlainText()).toBe('scheduler prompt');
        expect((task.chat_context.messages[1] as UserMessage).rawText).toBe('/scheduler');
        expect(JSON.stringify(task.chat_context.toJSON())).not.toContain('must not enter history');
        expect(processTurn).toHaveBeenCalledTimes(1);
    });

    test('reads the latest TailCard Map on each production in a real tool loop', async () => {
        setPlatform(new TestPlatform());
        const manager = createManager();
        const toolset = new BaseToolset('test');
        const tool = new BaseTool('inspect', 'Inspect a deterministic fixture', z.object({}));
        const task = new TaskState(manager, null);
        const execute = jest.fn(async () => {
            task.setFrontendTailCardSection('knowledge-mode', 'knowledge prompt for second production');
            return 'deterministic tool result';
        });
        tool.setExecutor(execute);
        toolset.addTool(tool);
        manager.toolsetProvider = {
            listAvailableToolsets: async () => [toolset]
        };

        task.task_name = 'tool loop task';
        task.setFrontendTailCardSection('knowledge-mode', 'knowledge prompt for first production');
        const requestTails: Array<string | undefined> = [];
        const snapshots: Array<{ openai: object[]; anthropic: { messages: object[] } }> = [];
        let requestCount = 0;
        jest.spyOn(LLM, 'streamComplete').mockImplementation(async function* (chatContext, _model, options) {
            requestTails.push(options?.requestTailText);
            snapshots.push({
                openai: OpenAIAdapter.buildMessages(chatContext, false, options),
                anthropic: AnthropicAdapter.buildMessages(chatContext, false, options)
            });
            requestCount++;
            if (requestCount === 1) {
                const message = new AssistantMessage();
                const part = new ToolCallMessagePart();
                part.push(new ToolCall(0, 'test-call', 'test-inspect', '{}'));
                message.appendToolCallPart(part);
                yield new AssistantResponse(message, 'tool_calls');
                return;
            }
            const message = new AssistantMessage();
            message.appendText('final answer');
            yield new AssistantResponse(message, 'stop');
        });

        const finished = task.waitUntilFinished();
        await task.submitUserMessage('real tool-loop question');
        await finished;

        expect(execute).toHaveBeenCalledTimes(1);
        expect(requestTails).toHaveLength(2);
        expect(requestTails[0]).toContain('knowledge prompt for first production');
        expect(requestTails[0]).not.toContain('knowledge prompt for second production');
        expect(requestTails[1]).toContain('knowledge prompt for second production');
        expect(requestTails[1]).not.toContain('knowledge prompt for first production');

        for (const projection of snapshots) {
            const openai = JSON.stringify(projection.openai);
            expect(openai).toContain('real tool-loop question');
            expect(openai).toContain('[OpenDesk Internal Request Tail]');
            expect(openai.indexOf('real tool-loop question')).toBeLessThan(
                openai.indexOf('[OpenDesk Internal Request Tail]')
            );
            expect(JSON.stringify(projection.anthropic)).toContain('[OpenDesk Internal Request Tail]');
        }
        expect(JSON.stringify(snapshots[1].openai)).toContain('deterministic tool result');
        expect(JSON.stringify(snapshots[1].anthropic)).toContain('deterministic tool result');
        expect(JSON.stringify(task.chat_context.toJSON())).not.toContain('knowledge prompt for first production');
        expect(JSON.stringify(task.chat_context.toJSON())).not.toContain('knowledge prompt for second production');
        expect(task.chat_context.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    });
});

describe('TaskState TailCard section lifecycle', () => {
    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('does not serialize, load, or fork active sections', () => {
        const manager = createManager();
        const task = new TaskState(manager);
        task.task_status = 'stopped';
        task.chat_context.appendMessage(new UserMessage('real message'));
        task.setFrontendTailCardSection('knowledge-mode', 'opaque /workspace/source');

        const serialized = serializeTask(task) as Record<string, unknown>;
        expect(JSON.stringify(serialized)).not.toContain('opaque /workspace/source');
        expect(serialized).not.toHaveProperty('activeTailCardSections');

        const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'opendesk-tail-card-section-'));
        const taskPath = path.join(tempDirectory, `${task.task_id}.json`);
        fs.writeFileSync(taskPath, JSON.stringify(serialized), 'utf8');
        try {
            const loaded = TaskState.load(taskPath, manager);
            expect(loaded.listFrontendTailCardSections()).toEqual([]);
        } finally {
            fs.rmSync(tempDirectory, { recursive: true, force: true });
        }

        manager.tasks.push(task);
        const forked = task.fork();
        expect(forked.listFrontendTailCardSections()).toEqual([]);
        forked.setFrontendTailCardSection('knowledge-mode', 'fork value');
        expect(task.listFrontendTailCardSections()).toEqual([
            { id: 'knowledge-mode', content: 'opaque /workspace/source' }
        ]);
    });
});
