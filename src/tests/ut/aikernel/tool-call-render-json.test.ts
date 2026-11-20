import { ToolCall, ToolCallMessagePart } from '../../../main/aikernel/messages.js';
import { BaseTool } from '../../../main/aikernel/tool.js';
import { serializeTaskUpdateForRender } from '../../../main/aikernel/task/update-render.js';
import { z } from 'zod';

describe('ToolCall GUI render payload', () => {
    test('uses the mainline rendered card and excludes raw arguments and results', () => {
        const call = new ToolCall(0, 'call-1', 'terminal-executeZsh', '{"command":"npm test"}');
        call.args_object = { command: 'npm test' };
        call.result = '6 passed';
        call.status = 'success';
        call.rendered = '<details class="terminal-tool">terminal result</details>';

        // 无 tool 实例（未解析）时推送协议名作为显示名
        expect(call.toRenderJSON()).toEqual({
            index: 0,
            id: 'call-1',
            tool_name: 'terminal-executeZsh',
            display_name: 'terminal-executeZsh',
            status: 'success',
            rendered: '<details class="terminal-tool">terminal result</details>'
        });
        expect(call.toRenderJSON()).not.toHaveProperty('args_string');
        expect(call.toRenderJSON()).not.toHaveProperty('args_object');
        expect(call.toRenderJSON()).not.toHaveProperty('result');
    });

    test('supports legacy task data with missing arguments', () => {
        const call = new ToolCall(0, 'call-legacy', 'Legacy', '{}');
        (call as any).args_string = undefined;

        expect(call.toRenderJSON()).toEqual({
            index: 0,
            id: 'call-legacy',
            tool_name: 'Legacy',
            display_name: 'Legacy',
            status: 'pending',
            rendered: undefined
        });
    });

    test('serializes whether a live tool call requires user attention', () => {
        const call = new ToolCall(0, 'call-attention', 'loginChannel', '{}');
        const tool = new BaseTool('loginChannel', 'Login', z.object({}));
        tool.requiresUserAttention = () => true;
        call.setTool(tool);

        expect(call.toRenderJSON()).toMatchObject({
            id: 'call-attention',
            requires_user_attention: true
        });
    });

    test.each([
        ['standard UI marker', { ui: { requiresUserAttention: true } }],
        ['QR code', { phase: 'qr_code', verification_url: 'https://example.com/verify' }],
        [
            'OAuth device authorization',
            {
                phase: 'awaiting_authorization',
                verification_uri: 'https://example.com/device',
                user_code: 'ABCD-EFGH'
            }
        ],
        [
            'QR polling with retained artifacts',
            {
                phase: 'polling',
                verification_url: 'https://example.com/verify',
                qr_ascii: 'QR'
            }
        ]
    ])('falls back to structured %s state without a tool instance', (_caseName, resultObject) => {
        const call = new ToolCall(0, 'call-fallback', 'legacyAuthorize', '{}');
        call.status = 'running';
        call.result_object = resultObject;

        expect(call.requiresUserAttention()).toBe(true);
        expect(call.toRenderJSON()).toMatchObject({ requires_user_attention: true });
    });

    test('does not infer attention from generic polling or completed calls', () => {
        const polling = new ToolCall(0, 'call-polling', 'backgroundJob', '{}');
        polling.status = 'running';
        polling.result_object = { phase: 'polling', progress: 50 };
        const completed = new ToolCall(0, 'call-complete', 'legacyAuthorize', '{}');
        completed.status = 'success';
        completed.result_object = { ui: { requiresUserAttention: true } };

        expect(polling.requiresUserAttention()).toBe(false);
        expect(completed.requiresUserAttention()).toBe(false);
    });

    test('a structured false marker suppresses heuristic inference', () => {
        const call = new ToolCall(0, 'call-marker-false', 'legacyAuthorize', '{}');
        call.status = 'running';
        call.result_object = {
            ui: { requiresUserAttention: false },
            phase: 'qr_code',
            verification_url: 'https://example.com/verify'
        };

        expect(call.requiresUserAttention()).toBe(false);
    });

    test('an explicit false attention decision suppresses fallback inference', () => {
        const call = new ToolCall(0, 'call-explicit-false', 'authorize', '{}');
        call.status = 'running';
        call.result_object = { ui: { requiresUserAttention: true } };
        const tool = new BaseTool('authorize', 'Authorize', z.object({}));
        tool.requiresUserAttention = () => false;
        call.setTool(tool);

        expect(call.requiresUserAttention()).toBe(false);
        expect(call.toRenderJSON()).not.toHaveProperty('requires_user_attention');
    });

    test('serializes live Electron updates with the complete mainline tool-card snapshot', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executeZsh', '{"command":"npm test"}');
        call.result = 'live result';
        const part = new ToolCallMessagePart();
        part.toolcalls.push(call);
        part.rendered = '<div class="terminal-tool">mainline terminal card</div>';

        const update = serializeTaskUpdateForRender({
            type: 'assistant',
            task_id: 'task-1',
            task_status: 'running',
            message_id: 'message-1',
            last_part_index: 0,
            last_part: part
        });
        const tool = (update as any).last_part.toolcalls[0];

        expect(tool).not.toHaveProperty('args_string');
        expect(tool).not.toHaveProperty('result');
        expect((update as any).last_part.rendered).toBe('<div class="terminal-tool">mainline terminal card</div>');
    });

    /**
     * 回归：终端 live tick 的增量字段必须进入 IPC payload。
     *
     * 背景：渲染端 patchToolCallCards 有「携带 outputDelta 时只追加文本」的
     * 快路径（taskview.js），但 ToolCall.toRenderJSON 曾经不导出 outputDelta/outputReset，
     * 导致该分支在生产链路中永远不可达：每个 200ms tick 都退化为
     * 「重新解析整份 part HTML + 整体重写输出区」，超长输出下持续占用渲染进程主线程。
     */
    test('live 终端 tick 的 toolcall 载荷携带 outputDelta / outputReset', () => {
        const call = new ToolCall(0, 'call-live', 'terminal-executePwsh', '{"command":"npm run build"}');
        call.status = 'running';
        call.result = 'line1\n';
        call.outputDelta = 'line2\n';
        call.outputReset = true;

        const part = new ToolCallMessagePart();
        part.toolcalls.push(call);
        part.rendered = '<div class="terminal-tool">card</div>';

        const update = serializeTaskUpdateForRender({
            type: 'assistant',
            task_id: 'task-1',
            task_status: 'running',
            message_id: 'message-1',
            last_part_index: 0,
            last_part: part
        }) as any;
        const tool = update.last_part.toolcalls[0];

        expect(tool.outputDelta).toBe('line2\n');
        expect(tool.outputReset).toBe(true);
        // 原始大字段仍然不外泄
        expect(tool).not.toHaveProperty('result');
        expect(tool).not.toHaveProperty('args_string');
    });

    test('非 live 的 toolcall 载荷不携带增量字段（历史/终态载荷不膨胀）', () => {
        const call = new ToolCall(0, 'call-done', 'terminal-executePwsh', '{"command":"npm run build"}');
        call.status = 'success';
        call.result = 'done';

        const part = new ToolCallMessagePart();
        part.toolcalls.push(call);
        part.rendered = '<div class="terminal-tool">card</div>';

        const update = serializeTaskUpdateForRender({
            type: 'assistant',
            task_id: 'task-1',
            task_status: 'running',
            message_id: 'message-1',
            last_part_index: 0,
            last_part: part
        }) as any;

        expect(update.last_part.toolcalls[0]).not.toHaveProperty('outputDelta');
        expect(update.last_part.toolcalls[0]).not.toHaveProperty('outputReset');
    });
});
