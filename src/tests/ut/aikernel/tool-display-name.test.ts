import { z } from 'zod';
import { humanizeToolName, resolveToolDisplayName } from '../../../common/tool-display-name.js';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { BaseTool } from '../../../main/aikernel/tool.js';
import { DefaultToolCallView } from '../../../main/tui/components/toolcall.js';
import { setRuntimeLocale } from '../../../locale/index.js';

function stripAnsi(value: string): string {
    return value.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('tool display names', () => {
    beforeAll(() => setRuntimeLocale('zh-CN'));
    afterAll(() => setRuntimeLocale(null));

    test('uses tool-owned localization metadata in GUI and TUI default renderers', async () => {
        const tool = new BaseTool(
            'terminal-executeZsh',
            'Run a command',
            z.object({}),
            'tools.terminal.executeZsh.name'
        );
        const call = new ToolCall(0, 'call-1', 'terminal-executeZsh', '{}');
        call.setTool(tool);

        expect(call.display_name_key).toBe('tools.terminal.executeZsh.name');
        expect(call.toRenderJSON()).toMatchObject({
            tool_name: 'terminal-executeZsh',
            display_name_key: 'tools.terminal.executeZsh.name'
        });
        expect(await call.render()).toContain('执行 Zsh 命令');
        expect(stripAnsi(new DefaultToolCallView(call).render(80).join('\n'))).toContain('执行 Zsh 命令');
    });

    test('keeps custom tool rendering authoritative', async () => {
        const tool = new BaseTool('custom-tool', 'Custom tool', z.object({}), 'tools.terminal.executeZsh.name');
        tool.renderToolCall = async () => '<div>Custom title</div>';
        const call = new ToolCall(0, 'call-2', 'custom-tool', '{}');
        call.setTool(tool);

        expect(await call.render()).toBe('<div>Custom title</div>');
    });

    test('uses the concise localized title for Bash commands', async () => {
        const tool = new BaseTool(
            'terminal-executeBash',
            'Run a command',
            z.object({}),
            'tools.terminal.executeBash.name'
        );
        const call = new ToolCall(0, 'call-bash', 'terminal-executeBash', '{}');
        call.setTool(tool);

        expect(await call.render()).toContain('执行命令');
        expect(stripAnsi(new DefaultToolCallView(call).render(80).join('\n'))).toContain('执行命令');
    });

    test('humanizes unknown protocol names when no localized title is available', () => {
        expect(humanizeToolName('terminal-executePowerShell')).toBe('terminal / execute Power Shell');
        expect(resolveToolDisplayName('plugin-opaqueOperation', undefined, (key) => key)).toBe(
            'plugin / opaque Operation'
        );
    });
});
