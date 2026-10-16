import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@jest/globals';

// 胶囊悬浮窗（pill 模式）左侧的红色转圈（.spin）曾因 _renderCollapsed 每次
// summary 推送都清空重建整个胶囊视图，导致 spin 元素的 CSS 动画不断从 0° 重启，
// 视觉上"红色线条不画圈、一直停在固定角度闪烁"。
// 回归：胶囊仅展示运行/完成计数，计数未变化时应跳过重建（与 _renderList 的
// _listSignature 签名保护同款机制），保持转圈动画连续。

const widgetSource = readFileSync(
    new URL('../../../renderer/components/task-status-widget.js', import.meta.url),
    'utf8'
);

describe('task status widget collapsed view signature guard', () => {
    test('_renderCollapsed 基于运行/完成计数计算重建签名', () => {
        const body = widgetSource.slice(widgetSource.indexOf('_renderCollapsed() {'));
        expect(body).toContain('const signature = `${running}|${completed}`;');
    });

    test('签名未变化且已有子元素时跳过重建，避免 spin 动画重启', () => {
        const body = widgetSource.slice(widgetSource.indexOf('_renderCollapsed() {'));
        expect(body).toContain(
            'if (signature === this._collapsedSignature && this._collapsedView.children.length > 0)'
        );
        expect(body).toContain('return;');
    });

    test('签名在清空重建前落盘，且类属性已初始化', () => {
        expect(widgetSource).toContain("this._collapsedSignature = '';");
        const body = widgetSource.slice(widgetSource.indexOf('_renderCollapsed() {'));
        expect(body.indexOf('this._collapsedSignature = signature;')).toBeLessThan(
            body.indexOf("this._collapsedView.textContent = '';")
        );
    });
});
