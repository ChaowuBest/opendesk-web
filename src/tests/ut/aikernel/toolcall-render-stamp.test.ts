import { describe, expect, test } from '@jest/globals';
import { ToolCall } from '../../../main/aikernel/messages.js';

/**
 * ToolCall.render 的 data-toolcall-id 根标识契约：
 *
 * 渲染端按 toolcall 粒度做增量卡片更新（taskview 的 patchToolCallCards）
 * 需要在 DOM 中按 id 定位新旧卡片。终端工具的卡片根节点自带该属性；其余工具的
 * 渲染结果统一由 ToolCall.render 包裹补齐。缺少标识时渲染端无法定位卡片，
 * 只能把整条消息退回全量渲染（写大文件时每个流式快照都会重置同消息终端卡片的滚动条）。
 */
describe('ToolCall.render 卡片根标识', () => {
    test('自定义渲染结果缺少标识时用无样式 div 包裹补齐', async () => {
        const call = new ToolCall(0, 'call-1', 'writeFile', '{}');
        (call as any).tool = {
            renderToolCall: async () => '<div class="od-inline-toolcall-container">card</div>'
        };
        const html = await call.render();
        expect(html).toBe('<div data-toolcall-id="call-1"><div class="od-inline-toolcall-container">card</div></div>');
    });

    test('根节点已自带 data-toolcall-id（终端卡片）时不重复包裹', async () => {
        const call = new ToolCall(0, 'call-2', 'terminal-executePwsh', '{}');
        (call as any).tool = {
            renderToolCall: async () =>
                '<details data-toolcall-id="call-2" class="terminal-tool" open><summary>cmd</summary></details>'
        };
        const html = await call.render();
        expect(html.startsWith('<details')).toBe(true);
        expect(html.match(/data-toolcall-id=/g)).toHaveLength(1);
    });

    test('默认渲染（无自定义工具）同样带标识', async () => {
        const call = new ToolCall(0, 'call-3', 'someTool', '{}');
        const html = await call.render();
        expect(html).toContain('<div data-toolcall-id="call-3">');
    });

    test('错误渲染同样带标识', async () => {
        const call = new ToolCall(0, 'call-4', 'someTool', '{}');
        call.status = 'error';
        call.result = 'boom';
        const html = await call.render();
        expect(html).toContain('<div data-toolcall-id="call-4">');
        expect(html).toContain('boom');
    });
});
