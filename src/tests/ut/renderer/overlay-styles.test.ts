import { expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { OVERLAY_CSS } from '../../../common/overlay-styles.js';

const titlebarCss = () => readFileSync(path.resolve(process.cwd(), 'src/renderer/styles/titlebar.css'), 'utf-8');
const customCss = () => readFileSync(path.resolve(process.cwd(), 'src/renderer/styles/custom.css'), 'utf-8');

test('window-level overlays inset to the content rect instead of the window rect', () => {
    const root = OVERLAY_CSS.match(/\.od-overlay-root\s*{[^}]*}/)?.[0] ?? '';
    expect(root).toMatch(/inset:\s*var\(--od-overlay-inset/);
    expect(root).toMatch(/border-radius:\s*var\(--od-overlay-radius/);
});

test('local overlays keep covering their panel shell without the window inset', () => {
    const local = OVERLAY_CSS.match(/\.od-overlay\.od-overlay-local\s*{[^}]*}/)?.[0] ?? '';
    expect(local).toMatch(/position:\s*absolute/);
    expect(local).toMatch(/inset:\s*0/);
});

test('native dialog backdrops stay transparent so the scrim owns the dimming', () => {
    const backdrop = OVERLAY_CSS.match(/dialog\.od-overlay::backdrop\s*{[^}]*}/)?.[0] ?? '';
    expect(backdrop).toMatch(/background:\s*transparent/);
    // 暗色规则不得再命中 dialog，否则遮罩会铺满视口、盖住 Linux 阴影边距
    expect(OVERLAY_CSS).not.toMatch(/[^:]dialog\.od-overlay::backdrop\s*{\s*background:\s*rgb/);
});

test('confirm-modal overlays inset to the content rect for direct-class callers', () => {
    // 设置面板 / 侧栏任务信息 / 反馈弹窗直接创建 .od-confirm-modal-overlay，
    // 定位必须在 MODAL_CSS 内自足，否则 window-rounded 下会铺满窗口矩形
    const modalCss = readFileSync(path.resolve(process.cwd(), 'src/renderer/components/confirmModal.ts'), 'utf-8');
    const block = modalCss.match(/\.od-confirm-modal-overlay\s*{[^}]*}/)?.[0] ?? '';
    expect(block).toMatch(/position:\s*fixed/);
    expect(block).toMatch(/inset:\s*var\(--od-overlay-inset/);
    expect(block).toMatch(/border-radius:\s*var\(--od-overlay-radius/);
    expect(block).toMatch(/z-index:\s*99999/);
});

test('window-rounded maps the overlay inset and radius to the shadow margin', () => {
    const css = titlebarCss();
    expect(css).toMatch(/--od-overlay-inset:\s*var\(--od-window-margin\)/);
    expect(css).toMatch(/--od-overlay-radius:\s*var\(--od-window-radius\)/);
});

test('body-level backdrops in custom.css follow the same inset variables', () => {
    const css = customCss();
    for (const selector of ['.shortcut-help-backdrop', '.agent-input-lightbox-overlay']) {
        const block = css.match(new RegExp('\\' + selector + '\\s*{[^}]*}'))?.[0] ?? '';
        expect(block).toContain(selector);
        expect(block).toMatch(/inset:\s*var\(--od-overlay-inset/);
        expect(block).toMatch(/border-radius:\s*var\(--od-overlay-radius/);
    }
});

test('body-mounted component backdrops follow the same inset variables', () => {
    // 只有以 body 为包含块的遮罩需要内缩：#app-root 自带 transform 与阴影边距内缩，
    // 其内部（含 Shadow DOM 组件）的 fixed 遮罩天然落在内容矩形，无需变量。
    const bodyMounted: { file: string; selector: string }[] = [
        { file: 'src/renderer/components/workspacePicker.ts', selector: '.od-ws-picker-overlay' }
    ];
    for (const { file, selector } of bodyMounted) {
        const source = readFileSync(path.resolve(process.cwd(), file), 'utf-8');
        const block = source.match(new RegExp('\\' + selector + '\\s*{[^}]*}'))?.[0] ?? '';
        expect(block).toContain(selector);
        expect(block).toMatch(/position:\s*fixed/);
        expect(block).toMatch(/inset:\s*var\(--od-overlay-inset/);
        expect(block).toMatch(/border-radius:\s*var\(--od-overlay-radius/);
    }
});
