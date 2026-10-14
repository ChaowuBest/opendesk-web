/**
 * 用户消息气泡右键菜单与 Web 链接右键菜单的分发优先级回归。
 *
 * task-view 元素层通过事件代理提供 Web 链接专用右键菜单（复制链接地址 /
 * 用系统浏览器打开 / 在内置浏览器中打开）；chatHistory 分发器中的用户
 * 消息气泡菜单与选中文本菜单均通过 stopPropagation 拦截事件。若分发器
 * 未将链接命中（a[href]）置于这两类菜单之前，气泡内的链接会被消息菜单
 * 抢占，链接专用菜单整体失效。
 */

import { readFileSync } from 'fs';

const source = readFileSync(new URL('../../../renderer/components/taskview.js', import.meta.url), 'utf8');

function chatHistoryDispatchSource(): string {
    const start = source.indexOf("chatHistory.addEventListener('contextmenu'");
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf('chatHistory.addEventListener', start + 1);
    return source.slice(start, end === -1 ? undefined : end);
}

describe('chatHistory context menu dispatch', () => {
    test('链接命中优先于用户气泡菜单，气泡内链接不会被消息菜单拦截', () => {
        const dispatch = chatHistoryDispatchSource();
        const linkCheck = dispatch.indexOf("e.target.closest('a[href]')");
        const bubbleCheck = dispatch.indexOf("e.target.closest('.od-user-msg')");
        expect(linkCheck).toBeGreaterThan(-1);
        expect(bubbleCheck).toBeGreaterThan(linkCheck);
        // 链接命中时直接放行给 task-view 层的链接菜单，不执行 preventDefault
        expect(dispatch.slice(linkCheck, bubbleCheck)).toContain('return;');
    });

    test('链接命中同样优先于选中文本菜单', () => {
        const dispatch = chatHistoryDispatchSource();
        const linkCheck = dispatch.indexOf("e.target.closest('a[href]')");
        const selectionCheck = dispatch.indexOf('window.getSelection()?.toString()');
        expect(selectionCheck).toBeGreaterThan(-1);
        expect(selectionCheck).toBeGreaterThan(linkCheck);
    });

    test('task-view 元素层保留 Web 链接右键菜单的事件代理', () => {
        expect(source).toContain("this.addEventListener('contextmenu', this._handleLinkContextMenu)");
        expect(source).toContain('_handleLinkContextMenu(e)');
        expect(source).toContain('createWebLinkContextMenuItems(');
    });
});
