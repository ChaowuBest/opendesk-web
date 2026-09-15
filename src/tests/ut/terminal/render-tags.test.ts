import { afterAll, beforeAll, expect, test } from '@jest/globals';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { renderTerminalToolCall } from '../../../main/applications/terminal/shells/common.js';
import { setRuntimeLocale } from '../../../locale/index.js';

// 系统语言随环境变化（CI 为英文），固定 zh-CN 使文案断言确定
beforeAll(() => {
    setRuntimeLocale('zh-CN');
});

afterAll(() => {
    setRuntimeLocale(null);
});

function call(description = 'Run command') {
    const value = new ToolCall(0, 'id', 'execute', '{}');
    value.args_object = { command: 'echo hello', description };
    value.status = 'running';
    return value;
}

test.each([
    ['powershell', false, ['terminal-shell-tag-powershell'], []],
    ['bash', false, ['terminal-shell-tag-bash'], []],
    ['zsh', false, ['terminal-shell-tag-zsh'], []],
    ['powershell', true, ['terminal-shell-tag-powershell', 'terminal-shell-tag-sandbox'], ['沙箱']]
])('renders shell and sandbox tags in the terminal card header', (kind, sandboxed, classes, text) => {
    const html = renderTerminalToolCall(kind, call(), sandboxed)!;
    for (const className of classes) expect(html).toContain(className);
    for (const label of text) expect(html).toContain(label);
    expect(html.indexOf('terminal-shell-tag')).toBeGreaterThan(html.indexOf('Run command'));
    expect(html.indexOf('terminal-shell-tag')).toBeLessThan(html.indexOf('terminal-tool-chevron'));
});

test('escapes terminal descriptions while keeping the badge visible', () => {
    const html = renderTerminalToolCall('bash', call('<script>alert(1)</script>'))!;
    expect(html).not.toContain('<script>');
    expect(html).toContain('terminal-shell-tag-bash');
});
