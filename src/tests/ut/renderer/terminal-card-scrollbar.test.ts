import { describe, expect, it } from '@jest/globals';
import fs from 'fs';
import { ToolCall } from '../../../main/aikernel/messages.js';
import { renderTerminalToolCall } from '../../../main/applications/terminal/shells/common.js';
import { declaration, ruleBody } from './cssRules.js';

/**
 * 终端工具卡片的滚动条与折行契约：
 * 1. 滚动区滚动条纵向 width、横向 height 都要给，只写 width 时横向滚动条会退回
 *    系统默认粗细（约 15px），比纵向的 4px 粗一大截（用户反馈「横向进度条太粗」）；
 * 2. 命令回显行必须允许超长 token 折行，否则长 PATH 之类会把卡片撑出横向溢出，
 *    滚动区凭空多出一条横向滚动条（滚动条本身只是症状）；
 * 3. 命令回显行同时要保留多行命令的换行，且模板缩进空白不能被 pre-wrap 渲染出来。
 */

const customCss = fs.readFileSync(new URL('../../../renderer/styles/custom.css', import.meta.url), 'utf8');
const themeDarkCss = fs.readFileSync(new URL('../../../renderer/theme/theme-dark.css', import.meta.url), 'utf8');

const DETAIL_SCROLLBAR = "[class*='overflow-y-auto']::-webkit-scrollbar";
const DETAIL_SCROLLBAR_SELECTORS = [
    `.od-inline-toolcall-container details ${DETAIL_SCROLLBAR}`,
    `#taskview-chat-history details ${DETAIL_SCROLLBAR}`
];

function toolCall(status: ToolCall['status'], result?: string, command = 'echo hi'): ToolCall {
    const value = new ToolCall(0, 'id', 'execute', '{}');
    value.args_object = { command, description: 'Run command' };
    value.status = status;
    value.result = result;
    return value;
}

describe('终端工具卡片滚动条', () => {
    it('纵向与横向滚动条同粗', () => {
        const body = ruleBody(customCss, 'details.terminal-tool .terminal-tool-scroll::-webkit-scrollbar');
        expect(declaration(body, 'width')).toBe('4px');
        expect(declaration(body, 'height')).toBe('4px');
    });

    it('工具调用详情卡片的滚动条结构属性在浅色文件统一定义，且横竖同粗', () => {
        for (const selector of DETAIL_SCROLLBAR_SELECTORS) {
            const body = ruleBody(customCss, selector);
            expect(declaration(body, 'width')).toBe('4px');
            expect(declaration(body, 'height')).toBe('4px');
        }
    });

    it('深色文件只覆盖颜色，不重复定义滚动条结构属性', () => {
        for (const selector of DETAIL_SCROLLBAR_SELECTORS) {
            expect(() => ruleBody(themeDarkCss, `html[data-theme='dark'] ${selector}`)).toThrow();
            const thumb = ruleBody(themeDarkCss, `html[data-theme='dark'] ${selector}-thumb`);
            expect(declaration(thumb, 'background')).toBe('rgba(255, 255, 255, 0.18)');
        }
    });

    it('命令回显行保留换行并折行，路径行只折行', () => {
        const command = ruleBody(customCss, 'details.terminal-tool .terminal-tool-command');
        expect(declaration(command, 'white-space')).toBe('pre-wrap');
        expect(declaration(command, 'word-break')).toBe('break-all');
        const pathLine = ruleBody(customCss, 'details.terminal-tool .terminal-tool-path');
        expect(declaration(pathLine, 'word-break')).toBe('break-all');
        expect(declaration(pathLine, 'white-space')).toBeUndefined();
    });

    it('运行中转圈与侧边栏 sb-running-spinner 同款：品牌红描边 + 同一条旋转动画', () => {
        const spinner = ruleBody(customCss, '.terminal-tool-running');
        expect(declaration(spinner, 'border-top-color')).toBe('#c94c40');
        expect(declaration(spinner, 'animation')).toContain('sb-spinner');
        // 12px 与标题文本同高，不撑高 summary 行（shell 标签胶囊本身约 18px）
        expect(declaration(spinner, 'width')).toBe('12px');
        expect(declaration(spinner, 'height')).toBe('12px');
    });

    it('运行中转圈在深色主题下换中性白轨道，避免淡红轨道隐入深色卡片底', () => {
        const dark = ruleBody(themeDarkCss, "html[data-theme='dark'] .terminal-tool-running");
        expect(declaration(dark, 'border-color')).toBe('rgba(255, 255, 255, 0.18)');
        expect(declaration(dark, 'border-top-color')).toBe('#e0685c');
    });
});

describe('终端工具卡片命令回显渲染', () => {
    it('执行中与执行完成两种状态都带折行钩子', () => {
        const running = renderTerminalToolCall('bash', toolCall('running'))!;
        const finished = renderTerminalToolCall('bash', toolCall('success', 'hi'))!;
        expect(running).toContain('terminal-tool-command');
        expect(finished).toContain('terminal-tool-command');
        // 折行钩子必须落在滚动区内部的命令块上，而不是卡片外层
        expect(finished.indexOf('terminal-tool-command')).toBeGreaterThan(finished.indexOf('terminal-tool-scroll'));
    });

    it('命令块内部不留模板缩进空白，多行命令原样保留换行', () => {
        const command = 'first line\nsecond line';
        const html = renderTerminalToolCall('bash', toolCall('running', undefined, command))!;
        const inner = html.match(/<div class="terminal-tool-command[^"]*">([\s\S]*?)<\/div>/)?.[1];
        // pre-wrap 会把模板缩进原样渲染成前导空格，因此命令块内容必须紧贴标签
        expect(inner).toBe(`<span class="text-gray-400 select-none">$ </span>${command}`);
    });
});
