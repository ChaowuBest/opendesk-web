import { createWebLinkContextMenuItems } from '../../../renderer/utils/web-link-context-menu.js';
import { enUs } from '../../../locale/en-us.js';
import { zhCn } from '../../../locale/zh-cn.js';

describe('web link context menu', () => {
    const labels = {
        copyLink: zhCn['renderer.taskview.linkTag.copyLink'],
        openExternal: zhCn['renderer.taskview.linkTag.openExternal'],
        openInBrowser: zhCn['renderer.taskview.linkTag.openInBrowser']
    };

    test('matches the requested actions and localized labels', () => {
        const items = createWebLinkContextMenuItems('https://example.com/docs', labels, {
            copyLink: () => {},
            openExternal: () => {},
            openInBrowser: () => {}
        });

        expect(items.map(({ action, label }) => ({ action, label }))).toEqual([
            { action: 'copy-link', label: '复制链接地址' },
            { action: 'open-external', label: '用系统浏览器打开' },
            { action: 'open-browser', label: '在内置浏览器中打开' }
        ]);
        expect(enUs['renderer.taskview.linkTag.openExternal']).toBe('Open in System Browser');
    });

    test('runs each action with the validated URL', () => {
        const calls: string[] = [];
        const items = createWebLinkContextMenuItems(' https://example.com/docs ', labels, {
            copyLink: (url) => calls.push(`copy:${url}`),
            openExternal: (url) => calls.push(`external:${url}`),
            openInBrowser: (url) => calls.push(`browser:${url}`)
        });

        items.forEach((item) => item.run());

        expect(calls).toEqual([
            'copy:https://example.com/docs',
            'external:https://example.com/docs',
            'browser:https://example.com/docs'
        ]);
    });

    test('does not create menu items for unsupported schemes', () => {
        expect(
            createWebLinkContextMenuItems('javascript:alert(1)', labels, {
                copyLink: () => {},
                openExternal: () => {},
                openInBrowser: () => {}
            })
        ).toEqual([]);
    });
});
