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

test('执行中的终端卡片在 shell 标签左侧显示运行中转圈', () => {
    const html = renderTerminalToolCall('bash', call())!;
    const indicator = html.indexOf('terminal-tool-running');
    expect(indicator).toBeGreaterThan(-1);
    // 位置：标题文本之后、shell 标签之前（用户要求放在胶囊左侧）
    expect(indicator).toBeGreaterThan(html.indexOf('Run command'));
    expect(indicator).toBeLessThan(html.indexOf('terminal-shell-tag-bash'));
    // 空元素的 role="status" 播报不可靠，改用可命名图形
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="执行中"');
});

test('已有部分输出但仍在执行时转圈不消失', () => {
    // live tick 每 200ms 就把当前输出写回 result：转圈只认 status，不能跟着 result 一起消失
    const partial = call();
    partial.result = 'building...\n';
    const html = renderTerminalToolCall('bash', partial)!;
    expect(html).toContain('terminal-tool-running');
    expect(html).toContain('terminal-tool-output');
});

test('尚未开始执行（pending）的卡片不显示运行中转圈', () => {
    const pending = call();
    pending.status = 'pending';
    expect(renderTerminalToolCall('bash', pending)!).not.toContain('terminal-tool-running');
});

test('命令结束（有输出）后不再显示运行中转圈', () => {
    const done = call();
    done.status = 'success';
    done.result = 'hello';
    const html = renderTerminalToolCall('bash', done)!;
    expect(html).not.toContain('terminal-tool-running');
});
