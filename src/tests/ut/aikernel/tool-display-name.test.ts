import { z } from 'zod';
import { resolveToolDisplayName } from '../../../common/tool-display-name.js';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { BaseTool, BaseToolset } from '../../../main/aikernel/tool.js';
import { DefaultToolCallView } from '../../../main/tui/components/toolcall.js';
import { setRuntimeLocale } from '../../../locale/index.js';

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('tool display names', () => {
    beforeAll(() => setRuntimeLocale('zh-CN'));
    afterAll(() => setRuntimeLocale(null));

    test('uses an existing localized title in GUI and TUI default renderers', async () => {
        const tool = new BaseTool('globFiles', 'Find files', z.object({}), 'filemgr.glob.name');
        const call = new ToolCall(0, 'call-1', 'globFiles', '{}');
        call.setTool(tool);

        expect(call.display_name_key).toBe('filemgr.glob.name');
        expect(call.toRenderJSON()).toMatchObject({
            tool_name: 'globFiles',
            display_name_key: 'filemgr.glob.name'
        });
        expect(await call.render()).toContain('模式匹配');
        expect(stripAnsi(new DefaultToolCallView(call).render(80).join('\n'))).toContain('模式匹配');
    });

    test('keeps custom tool rendering authoritative', async () => {
        const tool = new BaseTool('custom-tool', 'Custom tool', z.object({}), 'filemgr.glob.name');
        tool.renderToolCall = async () => '<div>Custom title</div>';
        const call = new ToolCall(0, 'call-2', 'custom-tool', '{}');
        call.setTool(tool);

        expect(await call.render()).toBe('<div>Custom title</div>');
    });

    test('applies an existing title when the tool is registered', async () => {
        const tool = new BaseTool('addMemory', 'Add memory', z.object({}));
        new BaseToolset('memory').addTool(tool);
        const call = new ToolCall(0, 'call-memory', 'addMemory', '{}');
        call.setTool(tool);

        expect(call.display_name_key).toBe('tools.memory.add.name');
        expect(await call.render()).toContain('添加记忆');
        expect(stripAnsi(new DefaultToolCallView(call).render(80).join('\n'))).toContain('添加记忆');
    });

    test('keeps the mainline protocol name when no existing title is available', () => {
        expect(resolveToolDisplayName('plugin-opaqueOperation', undefined, (key) => key)).toBe(
            'plugin-opaqueOperation'
        );
    });
});
