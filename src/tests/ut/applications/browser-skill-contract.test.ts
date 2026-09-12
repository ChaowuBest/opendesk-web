import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { BROWSER_SKILL } from '../../../main/applications/browser/skills.js';

const browserToolsSource = readFileSync(
    new URL('../../../main/applications/browser/tools.ts', import.meta.url),
    'utf8'
);

describe('browser use interaction contract', () => {
    test('documents the required iframe exploration and nested-ref workflow', () => {
        expect(BROWSER_SKILL).toContain('### iframe 页面');
        expect(BROWSER_SKILL).toContain('explore(iframeRef)');
        expect(BROWSER_SKILL).toContain('e5-e3');
        expect(BROWSER_SKILL).toContain('pressKey.iframeRef');
        expect(BROWSER_SKILL).toContain('页面或 iframe 导航后重新调用 `snapshot`');
    });

    test('does not promise that navigation always changes the foreground UI', () => {
        expect(browserToolsSource).toContain('后续及后台任务保持静默');
        expect(browserToolsSource).toContain('不改变用户当前布局或标签');
        expect(browserToolsSource).not.toContain('浏览器会自动切换到前台显示');
    });

    test('documents that browser input must not take focus from the user', () => {
        expect(BROWSER_SKILL).toContain('不主动切换窗口、任务或输入焦点');
        expect(BROWSER_SKILL).toContain('仅当目标 webview 本来就拥有焦点时');
    });

    test('documents the canonical CallSkillTool invocation with explicit toolName', () => {
        // 弱模型容易漏掉 CallSkillTool 的 toolName 字段（真实故障 task_mtvpprvf_91ts），
        // 文档中的调用示例必须以 CallSkillTool 完整参数结构书写，而非内部工具的函数式伪调用
        expect(BROWSER_SKILL).toContain('CallSkillTool 的真实调用参数结构书写');
        expect(BROWSER_SKILL).toContain('"bundleName": "browser"');
        expect(BROWSER_SKILL).toContain('"skillName": "use-browser"');
        // 所有内部工具示例都必须带显式 toolName
        for (const toolName of ['click', 'type', 'trigger', 'uploadFile']) {
            expect(BROWSER_SKILL).toContain(`"toolName": "${toolName}"`);
        }
        // 不得再出现内部工具的函数式调用示例（会诱导模型漏掉 toolName）
        expect(BROWSER_SKILL).not.toMatch(/^\s*click\(\{|\n\s*click\(\{/);
        expect(BROWSER_SKILL).not.toMatch(/\n\s*uploadFile\(\{/);
    });
});
