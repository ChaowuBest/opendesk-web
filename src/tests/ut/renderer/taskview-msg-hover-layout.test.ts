import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * 消息工具栏（时间戳 + hover 菜单）的几何契约。
 *
 * 1. 聊天历史（#taskview-chat-history）只在纵向滚动：overflow-y: auto 会把横向一并算成
 *    auto，任何越出左右的子元素都会撑出横向滚动条，滚动条占位又把内容顶掉几个像素。
 *    绝对定位的浮层即使不可见，也照样把几何尺寸算进滚动范围。
 * 2. 悬停展开标签不能挤宽按钮，否则按钮在鼠标下面位移，点不准。
 */
const customCss = () => readFileSync(path.resolve(process.cwd(), 'src/renderer/styles/custom.css'), 'utf-8');

/** 取规则块：选择器必须从行首开始，避免命中更长的组合选择器。 */
const ruleBlock = (css: string, selector: string) =>
    css.match(new RegExp('(?:^|\\n)' + selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*{[^}]*}'))?.[0] ?? '';

describe('消息悬停标签', () => {
    test('标签绝对定位在按钮下方，不参与按钮宽度计算', () => {
        const label = ruleBlock(customCss(), '.od-msg-action-label');

        expect(label).toMatch(/position:\s*absolute/);
        expect(label).toMatch(/top:\s*calc\(100% \+ 2px\)/);
        // 绝对定位元素的 shrink-to-fit 宽度受「按钮宽度 - left」限制，必须取内容宽度才不会被裁字
        expect(label).toMatch(/width:\s*max-content/);
        // 从左向右揭示的展开动画
        expect(label).toMatch(/clip-path:\s*inset\(0 100% 0 0\)/);
    });

    test('助手消息的标签以按钮中心居中（按钮只是一枚图标，标签总是更宽）', () => {
        const label = ruleBlock(customCss(), '.od-msg-action-label');

        // 助手消息的工具栏在左侧，左侧留了导航空间，居中不会越界
        expect(label).toMatch(/left:\s*50%/);
        expect(label).toMatch(/translate:\s*-50% 0/);
    });

    test('用户消息的标签贴着按钮右缘，不会越出聊天区右边界', () => {
        const label = ruleBlock(customCss(), '.od-user-msg-container .od-msg-action-label');

        // 用户消息的工具栏贴着聊天区右缘：仍按按钮中心居中时，长文案的右半边会越出
        // 聊天区右边界（绝对定位标签即使不可见也计入滚动范围），撑出横向滚动条后
        // 又立刻收回，表现为鼠标划过时整个显示区域跳一下
        expect(label).toMatch(/right:\s*0/);
        expect(label).toMatch(/left:\s*auto/);
        expect(label).toMatch(/translate:\s*0 0/);
    });

    test('悬停按钮不再靠加宽自身来展示标签', () => {
        const hoverLabel = ruleBlock(customCss(), '.od-msg-action-btn:hover .od-msg-action-label');

        expect(hoverLabel).toMatch(/clip-path:\s*inset\(0 0 0 0\)/);
        // 回归点：曾经用 max-width 从 0 撑到 88px，会把按钮挤宽导致点不准
        expect(hoverLabel).not.toMatch(/max-width/);
    });

    test('编辑态标签回到按钮内布局，并撤掉居中位移', () => {
        const pinned = ruleBlock(
            customCss(),
            '.od-msg-hover-menu--pinned .od-msg-action-btn--send-again .od-msg-action-label'
        );

        expect(pinned).toMatch(/position:\s*static/);
        // 回到 flex 流后如果还留着 -50% 位移，文案会被整体左移出按钮
        expect(pinned).toMatch(/translate:\s*none/);
        // 浮出层的揭示裁切对静态标签没有意义，留着会把文字裁掉
        expect(pinned).toMatch(/clip-path:\s*none/);
        // 回到按钮内就得自己裁剪：超长文案不能溢出按钮右缘（消息悬停时菜单的
        // overflow 会放开，溢出会直接变成聊天区的横向滚动条）
        expect(pinned).toMatch(/overflow:\s*hidden/);
    });

    test('工具栏给浮出的标签留出高度，标签不会压住下方内容', () => {
        const row = ruleBlock(customCss(), '.od-msg-meta-row');

        // 助手消息的工具栏下紧跟 usage 胶囊（mt-3），用户消息下紧跟下一块内容：
        // 没有这块留白时标签会压在它们身上。标签顶在按钮下方 2px、高约 14px，留白必须不小于它
        const paddingBottom = Number(row.match(/padding-bottom:\s*(\d+)px/)?.[1] ?? 0);
        expect(paddingBottom).toBeGreaterThanOrEqual(16);
    });
});

describe('悬停菜单不会撑出横向滚动条', () => {
    test('悬停菜单收起时立刻收回 overflow，收缩过程不会溢出菜单右边界', () => {
        const menu = ruleBlock(customCss(), '.od-msg-hover-menu');

        // max-width 收起动画期间若 overflow 还是 visible，按钮会溢出到聊天区右缘外
        expect(menu).toMatch(/overflow 0s step-start/);
        expect(menu).toMatch(/transition-behavior:[^;]*allow-discrete/);
    });

    test('展开态等宽度动画结束后才放开 overflow，避免裁掉浮出的标签', () => {
        const expanded = ruleBlock(customCss(), '.od-assistant-msg-container:hover .od-msg-hover-menu');

        expect(expanded).toMatch(/overflow:\s*visible/);
        expect(expanded).toMatch(/overflow 0s step-end 0\.2s/);
    });

    test('reasoning 气泡的宽度上限跟随消息块，而不是视口', () => {
        const bubble = ruleBlock(customCss(), '.reasoning-bubble');

        expect(bubble).not.toMatch(/100vw/);
        expect(bubble).toMatch(/max-width:\s*calc\(100% - 10px\)/);
        // padding 16px 18px + border 必须算进这个上限，否则又超出 38px
        expect(bubble).toMatch(/box-sizing:\s*border-box/);
    });
});
