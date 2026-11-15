/**
 * Copyright (c) 2026 The OpenDesk Team
 * OpenDesk is licensed under Mulan PSL v2.
 * You can use this software according to the terms and conditions of the Mulan PSL v2.
 * You may obtain a copy of Mulan PSL v2 at: http://license.coscl.org.cn/MulanPSL2
 * THIS SOFTWARE IS PROVIDED ON AN "AS IS" BASIS, WITHOUT WARRANTIES OF ANY KIND,
 * EITHER EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO NON-INFRINGEMENT,
 * MERCHANTABILITY OR FIT FOR A PARTICULAR PURPOSE.
 * See the Mulan PSL v2 for more details.
 */

import { describe, expect, it, jest } from '@jest/globals';
import { parseGenUiPayload, type GenUiPayload } from '../../../common/genui/protocol.js';
import { SAMPLE_PROPS } from './fixtures.js';

const { AskUiTool, ShowUiTool, createGenUiTools } = await import('../../../main/aikernel/interaction/genui.js');
type GenUiProvider = import('../../../main/aikernel/interaction/genui.js').GenUiProvider;
type GenUiRequest = import('../../../main/aikernel/interaction/genui.js').GenUiRequest;

function toolCall(overrides: Record<string, unknown>) {
    return {
        index: 0,
        id: 'call_1',
        tool_name: 'showUI',
        args_string: '',
        args_object: {},
        status: 'success',
        ...overrides
    } as any;
}

function readPayload(html: string | undefined): GenUiPayload | null {
    const match = html?.match(/data-genui="([^"]*)"/);
    if (!match) return null;
    const decoded = match[1]
        .replace(/&quot;/g, '"')
        .replace(/&#039;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&');
    return parseGenUiPayload(decoded);
}

class FakeProvider implements GenUiProvider {
    requests: GenUiRequest[] = [];
    private resolvers: ((value: any) => void)[] = [];
    cancelCurrent = jest.fn(() => {
        for (const resolve of this.resolvers.splice(0)) resolve({ cancelled: true });
    });

    request(request: GenUiRequest) {
        this.requests.push(request);
        return new Promise<any>((resolve) => this.resolvers.push(resolve));
    }

    answer(response: unknown) {
        this.resolvers.shift()?.({ response });
    }
}

describe('showUI', () => {
    const tool = new ShowUiTool();

    it('exposes an object schema with the display components', () => {
        const schema = tool.getJsonSchema();
        expect(schema.type).toBe('object');
        expect(schema.properties.component.enum).toEqual([
            'data-table',
            'chart',
            'comparison-card',
            'link-preview',
            'spec-sheet'
        ]);
        expect(schema.required).toEqual(['component', 'props']);
        expect(tool.description).toContain('### data-table');
        expect(tool.description).not.toContain('9007199254740991');
    });

    it('validates props against the component schema', () => {
        const ok = tool.validateArgs({ component: 'chart', props: SAMPLE_PROPS.chart });
        expect(ok.success).toBe(true);
        expect(ok.success && ok.data.props.value).toBe('12840');

        const bad = tool.validateArgs({ component: 'chart', props: { label: 'x', value: '1', points: [1] } });
        expect(bad).toEqual({
            success: false,
            error: expect.stringContaining('组件 chart 的参数不合法：\nprops.points:')
        });
        expect(tool.validateArgs({ component: 'option-list', props: {} }).success).toBe(false);
    });

    it('repairs props passed as a JSON string', () => {
        const result = tool.validateArgs({
            component: 'spec-sheet',
            props: JSON.stringify(SAMPLE_PROPS['spec-sheet'])
        });
        expect(result).toMatchObject({ success: true, repaired: true });
    });

    it('returns a short result without echoing the data', async () => {
        const result = await tool.execute({ component: 'data-table', props: SAMPLE_PROPS['data-table'] } as any);
        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({ shown: true, component: 'data-table' });
    });

    it('renders a placeholder carrying the validated payload', async () => {
        const html = await tool.renderToolCall(
            toolCall({ args_object: { component: 'chart', title: '<b>日活</b>', props: SAMPLE_PROPS.chart } })
        );
        expect(html).toContain('class="od-genui"');
        expect(html).toContain('data-genui-id="call_1"');
        expect(html).toContain('&lt;b&gt;日活&lt;/b&gt;');
        expect(readPayload(html)).toEqual({
            id: 'call_1',
            mode: 'show',
            component: 'chart',
            title: '<b>日活</b>',
            props: { ...SAMPLE_PROPS.chart, value: '12840' },
            status: 'success'
        });
    });

    it('falls back to the generic tool row while args are incomplete', async () => {
        expect(await tool.renderToolCall(toolCall({ status: 'pending', args_object: { component: 'chart' } }))).toBe(
            undefined
        );
        expect(await tool.renderToolCall(toolCall({ args_object: { component: 'nope', props: {} } }))).toBe(undefined);
    });
});

describe('askUI', () => {
    const args = { component: 'option-list', title: '发布到哪里？', props: SAMPLE_PROPS['option-list'] };

    it('is only available in interactive modes and needs attention while waiting', () => {
        const tool = new AskUiTool();
        expect(tool.isAvailable({ getAgentMode: () => ({ interactive: false }) } as any)).toBe(false);
        expect(tool.isAvailable({ getAgentMode: () => ({}) } as any)).toBe(true);
        expect(tool.requiresUserAttention(toolCall({ status: 'running' }))).toBe(true);
        expect(tool.requiresUserAttention(toolCall({ status: 'success' }))).toBe(false);
    });

    it('publishes a request id, waits for the user and returns a summary', async () => {
        const provider = new FakeProvider();
        const [, tool] = createGenUiTools(provider);
        const updates: unknown[] = [];
        const running = tool.execute(
            args as any,
            (result) => updates.push(result.result_object),
            { task_id: 'task-1', task_name: '发布', getAgentMode: () => ({}) } as any,
            toolCall({ id: 'call_9', tool_name: 'askUI' })
        );
        await Promise.resolve();
        expect(provider.requests).toHaveLength(1);
        const request = provider.requests[0];
        expect(request).toMatchObject({
            taskId: 'task-1',
            taskName: '发布',
            toolCallId: 'call_9',
            component: 'option-list',
            title: '发布到哪里？'
        });
        expect(request.requestId).toMatch(/^genui-[0-9a-f-]{36}$/);
        // 渲染进程靠这次更新拿到 requestId
        expect(updates).toEqual([{ genui: { requestId: request.requestId } }]);

        provider.answer({ selected: ['prod'] });
        const result = await running;
        expect(result.status).toBe('success');
        expect(JSON.parse(result.result)).toEqual({
            component: 'option-list',
            response: { selected: ['prod'] },
            summary: '用户选择：生产环境'
        });
        expect(result.result_object).toEqual({ genui: { response: { selected: ['prod'] } } });
    });

    it('reports cancellation and cancels through the provider', async () => {
        const provider = new FakeProvider();
        const [, tool] = createGenUiTools(provider);
        const running = tool.execute(args as any, undefined, undefined, toolCall({ tool_name: 'askUI' }));
        await Promise.resolve();
        await tool.stop();
        expect(provider.cancelCurrent).toHaveBeenCalled();
        const result = await running;
        expect(JSON.parse(result.result)).toMatchObject({ cancelled: true });
        expect(result.result_object).toEqual({ genui: { cancelled: true } });
    });

    it('fails without a provider', async () => {
        const result = await new AskUiTool().execute(args as any);
        expect(result.status).toBe('error');
    });

    it('renders the request id while running and the response afterwards', async () => {
        const tool = new AskUiTool();
        const running = readPayload(
            await tool.renderToolCall(
                toolCall({
                    tool_name: 'askUI',
                    status: 'running',
                    args_object: args,
                    result_object: { genui: { requestId: 'genui-1' } }
                })
            )
        );
        expect(running).toMatchObject({ mode: 'ask', status: 'running', requestId: 'genui-1' });

        const done = readPayload(
            await tool.renderToolCall(
                toolCall({
                    tool_name: 'askUI',
                    status: 'success',
                    args_object: args,
                    result_object: { genui: { response: { selected: ['prod'] } } }
                })
            )
        );
        expect(done).toMatchObject({ status: 'success', response: { selected: ['prod'] } });
        expect(done).not.toHaveProperty('requestId');

        // 历史消息里只剩结果文本时也能还原回执
        const restored = readPayload(
            await tool.renderToolCall(
                toolCall({
                    tool_name: 'askUI',
                    status: 'success',
                    args_object: args,
                    result: JSON.stringify({ cancelled: true })
                })
            )
        );
        expect(restored).toMatchObject({ cancelled: true });
    });
});
