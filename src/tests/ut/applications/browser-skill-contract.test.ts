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
});
